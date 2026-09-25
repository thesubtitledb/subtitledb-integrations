using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Subtitles;
using MediaBrowser.Model.Providers;
using Microsoft.Extensions.Logging;
using SubtitleDb.Core;

namespace SubtitleDb.Jellyfin
{
    /// <summary>
    /// Subtitles from the SubtitleDB open index, inside Jellyfin.
    /// </summary>
    /// <remarks>
    /// Jellyfin asks for one language at a time and decides what to do with the
    /// answer, so this plugin has no language settings of its own: the ones under
    /// Dashboard, Playback, Subtitles are the ones it uses.
    /// </remarks>
    public class SubtitleDbSubtitleProvider : ISubtitleProvider, IHasOrder
    {
        private static readonly Regex ImdbId = new Regex(@"^tt\d{6,9}$", RegexOptions.Compiled);

        private readonly ILogger<SubtitleDbSubtitleProvider> _logger;
        private readonly IHttpClientFactory _http;
        private readonly IServiceProvider? _services;

        public SubtitleDbSubtitleProvider(
            ILogger<SubtitleDbSubtitleProvider> logger,
            IHttpClientFactory httpClientFactory,
            IServiceProvider? services = null)
        {
            _logger = logger;
            _http = httpClientFactory;
            // The library manager is looked up when a search needs it, not taken here,
            // so this provider never becomes part of how the library manager is built.
            _services = services;
        }

        public string Name => "SubtitleDB";

        public IEnumerable<VideoContentType> SupportedMediaTypes =>
            new[] { VideoContentType.Episode, VideoContentType.Movie };

        /// <summary>
        /// After the providers a user had to make an account for. Not a judgement:
        /// they had to work for those, and this one costs them nothing.
        /// </summary>
        public int Order => 10;

        public async Task<IEnumerable<RemoteSubtitleInfo>> Search(
            SubtitleSearchRequest request,
            CancellationToken cancellationToken)
        {
            var language = Languages.ToCode(request.Language)
                ?? Languages.ToCode(request.TwoLetterISOLanguageName);
            var options = new MatchOptions
            {
                Languages = language == null ? new List<string>() : new List<string> { language },
                // Jellyfin converts nothing: what it stores beside the video is what
                // its player has to parse, so the list is what it can actually render.
                Formats = new List<string> { "srt", "ass", "ssa", "sub", "vtt" },
                Limit = MatchOptions.PerLanguageFrom(Plugin.Instance?.Configuration?.PerLanguage),
            };

            var hint = HintFrom(request, SeriesImdbFor(request));
            try
            {
                var found = await Finder
                    .FindAsync(Client(), hint, options, cancellationToken)
                    .ConfigureAwait(false);

                var candidates = found.Candidates.AsEnumerable();
                if (request.IsPerfectMatch)
                {
                    // Jellyfin asks this when it is about to download without anyone
                    // looking. Only a subtitle recorded against this exact release is
                    // safe to hand it: anything else is a guess, unattended.
                    candidates = candidates.Where(IsSameRelease);
                }

                _logger.LogDebug(
                    "SubtitleDB: {Count} candidates for {Path} at rung {Tier}, {Unrenderable} unrenderable, {Wrong} for another episode",
                    found.Candidates.Count,
                    request.MediaPath,
                    found.Tier,
                    found.Unrenderable,
                    found.WrongEpisode);

                return candidates.Select(c => Describe(c, Name)).ToList();
            }
            catch (SubtitleDbException err)
            {
                // A provider that throws here is one Jellyfin stops asking. Nothing
                // found is the honest answer to "the index did not have it".
                _logger.LogWarning(err, "SubtitleDB: search failed for {Path}", request.MediaPath);
                return Array.Empty<RemoteSubtitleInfo>();
            }
        }

        public async Task<SubtitleResponse> GetSubtitles(string id, CancellationToken cancellationToken)
        {
            if (!long.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var subtitleId))
            {
                throw new ArgumentException("not a SubtitleDB id: " + id, nameof(id));
            }

            var client = Client();
            // by-subid resolves the file to the bundle it sits in and carries the file
            // itself, with the download_url. The leaf subtitles/:id route is gone.
            var bundle = await client.BySubidAsync(subtitleId, cancellationToken).ConfigureAwait(false);
            var row = bundle.Subtitle;
            if (row == null || string.IsNullOrWhiteSpace(row.DownloadUrl))
            {
                throw new SubtitleDbException("subtitle " + id + " has no file");
            }

            // The published URL, not one rebuilt from the id: it redirects to wherever
            // the file lives today, and that address is not ours to keep.
            var bytes = await client.DownloadAsync(row.DownloadUrl!, cancellationToken).ConfigureAwait(false);

            return new SubtitleResponse
            {
                // The stored format, whatever the extension says. A file saved as .srt
                // that is really ASS renders as a screen of tag soup.
                Format = row.Format ?? "srt",
                Language = Languages.ToAlpha3(row.Language),
                IsHearingImpaired = row.HearingImpaired,
                Stream = new MemoryStream(bytes),
            };
        }

        /// <summary>
        /// The IMDb id of the series an episode belongs to, from Jellyfin's library.
        /// The request carries the episode's own ids and not the series', and an
        /// episode scraped from TVDB or TMDB often has no IMDb id of its own.
        /// </summary>
        private string? SeriesImdbFor(SubtitleSearchRequest request)
        {
            if (_services == null
                || request.ContentType != VideoContentType.Episode
                || string.IsNullOrWhiteSpace(request.MediaPath))
            {
                return null;
            }

            try
            {
                return SeriesImdbOf(_services, request.MediaPath);
            }
            catch (Exception err) when (!(err is OperationCanceledException))
            {
                // A library call shaped differently in another Jellyfin version costs
                // this one rung, not the search.
                _logger.LogDebug(err, "SubtitleDB: no series id for {Path}", request.MediaPath);
                return null;
            }
        }

        // Kept out of line so that a library type or method missing from this Jellyfin
        // fails here, inside the caller's catch, and not while compiling the caller.
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static string? SeriesImdbOf(IServiceProvider services, string path)
        {
            var library = services.GetService(typeof(ILibraryManager)) as ILibraryManager;
            var episode = library?.FindByPath(path, false) as MediaBrowser.Controller.Entities.TV.Episode;
            var series = episode?.Series;
            if (series == null)
            {
                return null;
            }

            var imdb = MediaBrowser.Model.Entities.ProviderIdsExtensions
                .GetProviderId(series, MediaBrowser.Model.Entities.MetadataProvider.Imdb)?.Trim();
            return imdb != null && ImdbId.IsMatch(imdb) ? imdb : null;
        }

        internal static Hint HintFrom(SubtitleSearchRequest request, string? seriesImdbId = null)
        {
            var hint = new Hint
            {
                Year = request.ProductionYear,
                Release = ReleaseName(request.MediaPath),
            };

            if (request.ProviderIds != null)
            {
                if (request.ProviderIds.TryGetValue("Imdb", out var imdb)
                    && imdb != null
                    && ImdbId.IsMatch(imdb.Trim()))
                {
                    // The corpus files each episode under its own episode-level id, so
                    // this is the whole answer when the host has it, for TV as for film.
                    hint.ImdbId = imdb.Trim();
                }

                // Only for a film: an episode's TMDB id is the episode's, and the map
                // the API reads is keyed by the film's.
                if (request.ContentType == VideoContentType.Movie
                    && request.ProviderIds.TryGetValue("Tmdb", out var tmdb)
                    && long.TryParse(tmdb, NumberStyles.Integer, CultureInfo.InvariantCulture, out var tmdbId))
                {
                    hint.TmdbId = tmdbId;
                }
            }

            var isEpisode = request.ContentType == VideoContentType.Episode;
            if (isEpisode && !string.IsNullOrWhiteSpace(request.SeriesName))
            {
                hint.Title = request.SeriesName;
                hint.EpisodeTitle = request.Name;
                hint.Season = request.ParentIndexNumber;
                hint.Episode = request.IndexNumber;
                hint.SeriesImdbId = seriesImdbId;
            }
            else
            {
                hint.Title = request.Name;
            }

            return hint;
        }

        /// <summary>The file's own name, which is what a release name is compared against.</summary>
        internal static string? ReleaseName(string? mediaPath)
        {
            if (string.IsNullOrWhiteSpace(mediaPath))
            {
                return null;
            }

            var name = Path.GetFileNameWithoutExtension(mediaPath);
            return string.IsNullOrWhiteSpace(name) ? null : name;
        }

        internal static bool IsSameRelease(Candidate candidate)
        {
            return candidate.Reason.IndexOf("same release", StringComparison.Ordinal) >= 0;
        }

        internal static RemoteSubtitleInfo Describe(Candidate candidate, string providerName)
        {
            var row = candidate.Subtitle;
            return new RemoteSubtitleInfo
            {
                Id = row.Id.ToString(CultureInfo.InvariantCulture),
                ProviderName = providerName,
                Name = Matcher.Label(candidate),
                Format = row.Format,
                ThreeLetterISOLanguageName = Languages.ToAlpha3(row.Language),
                DownloadCount = row.Downloads,
                HearingImpaired = row.HearingImpaired,
                // Jellyfin draws this as the "matches your file" mark. It is a hash
                // match there and a release-name match here, which is the same claim:
                // this subtitle was recorded against the file you are playing.
                IsHashMatch = IsSameRelease(candidate),
                Comment = candidate.Reason,
            };
        }

        private SubtitleDbClient Client()
        {
            var apiBase = Plugin.Instance?.Configuration?.ApiBase;
            return new SubtitleDbClient(
                _http.CreateClient(NamedClient.Default),
                string.IsNullOrWhiteSpace(apiBase) ? SubtitleDbClient.DefaultApiBase : apiBase,
                "subtitledb-jellyfin");
        }
    }
}
