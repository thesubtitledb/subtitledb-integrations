using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Subtitles;
using MediaBrowser.Model.Logging;
using MediaBrowser.Model.Providers;
using SubtitleDb.Core;

namespace SubtitleDb.Emby
{
    /// <summary>
    /// Subtitles from the SubtitleDB open index, inside Emby.
    /// </summary>
    /// <remarks>
    /// The same rules as the Jellyfin plugin, against a request that carries slightly
    /// different fields: Emby names the language in a CultureDto and says whether it
    /// wants a hearing-impaired track, and both are used.
    /// </remarks>
    public class SubtitleDbSubtitleProvider : ISubtitleProvider, IHasOrder
    {
        private static readonly Regex ImdbId = new Regex(@"^tt\d{6,9}$", RegexOptions.Compiled);

        /// <summary>
        /// One for the process. Emby hands plugins its own IHttpClient, which has no
        /// HttpClient behind it to borrow, and a new one per search would leak a
        /// socket pool per file in a library scan.
        /// </summary>
        private static readonly HttpClient Shared = NewHttpClient();

        private readonly ILogger _logger;

        public SubtitleDbSubtitleProvider(ILogManager logManager)
        {
            _logger = logManager.GetLogger("SubtitleDB");
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
            var options = OptionsFrom(request);
            var hint = HintFrom(request);

            try
            {
                var found = await Finder
                    .FindAsync(Client(), hint, options, cancellationToken)
                    .ConfigureAwait(false);

                var candidates = found.Candidates.AsEnumerable();
                if (request.IsPerfectMatch)
                {
                    // Emby asks this when it is about to download with nobody looking.
                    // Only a subtitle recorded against this exact release is safe then.
                    candidates = candidates.Where(IsSameRelease);
                }

                _logger.Info(
                    "SubtitleDB: {0} candidates for {1}, {2} unrenderable, {3} for another episode",
                    found.Candidates.Count,
                    request.MediaPath ?? string.Empty,
                    found.Unrenderable,
                    found.WrongEpisode);

                return candidates.Select(c => Describe(c, Name)).ToList();
            }
            catch (SubtitleDbException err)
            {
                // A provider that throws here is one Emby stops asking. Nothing found
                // is the honest answer to "the index did not have it".
                _logger.ErrorException("SubtitleDB: search failed", err);
                return new RemoteSubtitleInfo[0];
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

        internal static MatchOptions OptionsFrom(SubtitleSearchRequest request)
        {
            var language = Languages.ToCode(request.Language)
                ?? Languages.ToCode(request.LanguageInfo?.TwoLetterISOLanguageName)
                ?? Languages.ToCode(request.LanguageInfo?.ThreeLetterISOLanguageName);

            return new MatchOptions
            {
                Languages = language == null ? new List<string>() : new List<string> { language },
                // Emby converts nothing: what it stores beside the video is what its
                // player has to parse, so this is what it can actually render.
                Formats = new List<string> { "srt", "ass", "ssa", "sub", "vtt" },
                HearingImpaired = request.IsHearingImpaired,
                Limit = MatchOptions.PerLanguageFrom(Plugin.Instance?.Configuration?.PerLanguage),
            };
        }

        internal static Hint HintFrom(SubtitleSearchRequest request)
        {
            var hint = new Hint
            {
                Year = request.ProductionYear,
                Release = ReleaseName(request.MediaPath),
            };

            hint.ImdbId = FirstImdb(request.ProviderIds);

            // Only for a film: an episode's TMDB id is the episode's, and the map the
            // API reads is keyed by the film's.
            if (request.ContentType == VideoContentType.Movie
                && request.ProviderIds != null
                && request.ProviderIds.TryGetValue("Tmdb", out var tmdb)
                && long.TryParse(tmdb, NumberStyles.Integer, CultureInfo.InvariantCulture, out var tmdbId))
            {
                hint.TmdbId = tmdbId;
            }

            var isEpisode = request.ContentType == VideoContentType.Episode;
            if (isEpisode && !string.IsNullOrWhiteSpace(request.SeriesName))
            {
                hint.Title = request.SeriesName;
                hint.EpisodeTitle = request.Name;
                hint.Season = request.ParentIndexNumber;
                hint.Episode = request.IndexNumber;

                // Emby keeps the series' ids beside the episode's. The series' IMDb id,
                // which the ladder drills to the season and episode, finds an episode
                // that has no id of its own. Emby also files the series' id as the
                // episode's when the episode has none, and that is not the episode's.
                hint.SeriesImdbId = FirstImdb(request.SeriesProviderIds);
                if (hint.ImdbId != null
                    && string.Equals(hint.SeriesImdbId, hint.ImdbId, StringComparison.OrdinalIgnoreCase))
                {
                    hint.ImdbId = null;
                }
            }
            else
            {
                hint.Title = request.Name;
            }

            return hint;
        }

        private static string? FirstImdb(IDictionary<string, string>? providerIds)
        {
            if (providerIds == null)
            {
                return null;
            }

            if (!providerIds.TryGetValue("Imdb", out var imdb) || imdb == null)
            {
                return null;
            }

            var trimmed = imdb.Trim();
            // Emby fills this from whichever metadata provider ran, and a TVDB id sent
            // as an IMDb id resolves to somebody else's film.
            return ImdbId.IsMatch(trimmed) ? trimmed : null;
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
                // Language, not ThreeLetterISOLanguageName: Emby deprecated that one,
                // and this is the code it names the saved file with.
                Language = Languages.ToAlpha3(row.Language),
                DownloadCount = row.Downloads,
                IsHearingImpaired = row.HearingImpaired,
                // Emby draws this as the "matches your file" mark. It is a hash match
                // there and a release-name match here, which is the same claim: this
                // subtitle was recorded against the file you are playing.
                IsHashMatch = IsSameRelease(candidate),
                Comment = candidate.Reason,
            };
        }

        private static HttpClient NewHttpClient()
        {
            var http = new HttpClient();
            http.Timeout = TimeSpan.FromSeconds(20);
            http.DefaultRequestHeaders.TryAddWithoutValidation(
                "User-Agent", "subtitledb-emby/0.1 (+https://thesubtitledb.org)");
            return http;
        }

        private static SubtitleDbClient Client()
        {
            var apiBase = Plugin.Instance?.Configuration?.ApiBase;
            return new SubtitleDbClient(
                Shared,
                string.IsNullOrWhiteSpace(apiBase) ? SubtitleDbClient.DefaultApiBase : apiBase,
                "subtitledb-emby");
        }
    }
}
