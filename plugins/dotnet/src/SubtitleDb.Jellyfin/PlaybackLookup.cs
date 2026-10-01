using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Session;
using MediaBrowser.Controller.Subtitles;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Providers;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using SubtitleDb.Core;

namespace SubtitleDb.Jellyfin
{
    /// <summary>
    /// When a film or an episode starts playing, asks SubtitleDB for it and saves the
    /// best match beside it, as Jellyfin saves a subtitle picked in its search dialog.
    /// </summary>
    /// <remarks>
    /// All of it is Jellyfin's own: the playback event, the subtitle manager to search,
    /// fetch and save, and the refresh its subtitle routes queue after a save. The
    /// library's subtitle settings decide the languages, whether only a perfect match
    /// will do, and whether SubtitleDB is asked at all. A player reads the subtitle list
    /// when it starts, so the new one is in that list from the next play.
    /// </remarks>
    public sealed class PlaybackLookup : IHostedService
    {
        private readonly ISessionManager _sessions;
        private readonly ISubtitleManager _subtitles;
        private readonly ILibraryManager _library;
        private readonly IProviderManager _providers;
        private readonly IFileSystem _fileSystem;
        private readonly ILogger<PlaybackLookup> _logger;
        private readonly OnPlay _onPlay = new OnPlay();
        private readonly CancellationTokenSource _stopping = new CancellationTokenSource();

        public PlaybackLookup(
            ISessionManager sessions,
            ISubtitleManager subtitles,
            ILibraryManager library,
            IProviderManager providers,
            IFileSystem fileSystem,
            ILogger<PlaybackLookup> logger)
        {
            _sessions = sessions;
            _subtitles = subtitles;
            _library = library;
            _providers = providers;
            _fileSystem = fileSystem;
            _logger = logger;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            // A hosted service that throws here stops Jellyfin from starting at all. A
            // Jellyfin whose playback event differs from the one this was built
            // against fails in Subscribe, which is compiled when it is first called.
            try
            {
                Subscribe();
            }
            catch (Exception err)
            {
                _logger.LogError(err, "SubtitleDB: the lookup on play is off, this Jellyfin's playback event is not the one it was built for");
            }

            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            try
            {
                Unsubscribe();
            }
            catch (Exception err)
            {
                _logger.LogDebug(err, "SubtitleDB: the lookup on play was never on");
            }

            _stopping.Cancel();
            return Task.CompletedTask;
        }

        /// <summary>A film or an episode in a file, not a trailer or another extra.</summary>
        internal static bool Wanted(BaseItem? item)
        {
            return (item is Movie || item is Episode)
                && item.ExtraType == null
                && ((Video)item).VideoType == VideoType.VideoFile
                && !string.IsNullOrEmpty(item.Path)
                && item.IsFileProtocol;
        }

        /// <summary>
        /// The request Jellyfin builds for its own search of a video, asking SubtitleDB
        /// alone: the other providers may count downloads against an account, and
        /// nobody asked them.
        /// </summary>
        internal static SubtitleSearchRequest Request(
            Video video,
            string language,
            LibraryOptions options,
            IEnumerable<string> providers)
        {
            var episode = video as Episode;
            return new SubtitleSearchRequest
            {
                ContentType = episode == null ? VideoContentType.Movie : VideoContentType.Episode,
                Language = language,
                MediaPath = video.Path,
                Name = video.Name,
                IndexNumber = video.IndexNumber,
                IndexNumberEnd = episode?.IndexNumberEnd,
                ParentIndexNumber = video.ParentIndexNumber,
                ProductionYear = video.ProductionYear,
                ProviderIds = video.ProviderIds,
                RuntimeTicks = video.RunTimeTicks,
                SeriesName = episode?.SeriesName,
                IsPerfectMatch = options.RequirePerfectSubtitleMatch,
                IsAutomated = true,
                SearchAllProviders = true,
                DisabledSubtitleFetchers = providers
                    .Where(name => !IsOurs(name))
                    .ToArray(),
            };
        }

        private static bool IsOurs(string? provider)
        {
            return string.Equals(provider, "SubtitleDB", StringComparison.OrdinalIgnoreCase);
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private void Subscribe()
        {
            _sessions.PlaybackStart += OnPlaybackStart;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private void Unsubscribe()
        {
            _sessions.PlaybackStart -= OnPlaybackStart;
        }

        private void OnPlaybackStart(object? sender, PlaybackProgressEventArgs e)
        {
            try
            {
                if (Plugin.Instance?.Configuration?.LookUpOnPlay == false
                    || !Wanted(e.Item)
                    || !_onPlay.Begin(e.Item.Id.ToString("N"), DateTime.UtcNow))
                {
                    return;
                }

                var video = (Video)e.Item;
                _ = Task.Run(() => LookUpAsync(video));
            }
            catch (Exception err)
            {
                _logger.LogError(err, "SubtitleDB: the lookup on play did not start");
            }
        }

        private async Task LookUpAsync(Video video)
        {
            try
            {
                using (var timeout = CancellationTokenSource.CreateLinkedTokenSource(_stopping.Token))
                {
                    timeout.CancelAfter(TimeSpan.FromMinutes(2));
                    var said = await LookUpCoreAsync(video, timeout.Token).ConfigureAwait(false);
                    if (said.StartsWith("saved", StringComparison.Ordinal))
                    {
                        _logger.LogInformation("SubtitleDB: {Path} started playing, {Said}", video.Path, said);
                    }
                    else
                    {
                        _logger.LogDebug("SubtitleDB: {Path} started playing, {Said}", video.Path, said);
                    }
                }
            }
            catch (OperationCanceledException) when (_stopping.IsCancellationRequested)
            {
                // Jellyfin is stopping.
            }
            catch (SubtitleDbException err)
            {
                _logger.LogWarning("SubtitleDB: the lookup on play failed for {Path}: {Message}", video.Path, err.Message);
            }
            catch (OperationCanceledException)
            {
                _logger.LogWarning("SubtitleDB: the lookup on play gave up on {Path} after 2 minutes", video.Path);
            }
            catch (Exception err)
            {
                // A Jellyfin whose library or subtitle calls differ from the ones this was
                // built against lands here, with the playback itself untouched.
                _logger.LogError(err, "SubtitleDB: the lookup on play failed for {Path}", video.Path);
            }
        }

        private async Task<string> LookUpCoreAsync(Video video, CancellationToken cancellationToken)
        {
            var options = _library.GetLibraryOptions(video);
            if ((options.DisabledSubtitleFetchers ?? Array.Empty<string>()).Any(IsOurs))
            {
                return "SubtitleDB is not ticked for its library";
            }

            var providers = _subtitles.GetSupportedProviders(video).Select(p => p.Name).ToList();
            var asked = string.Empty;
            SubtitleResponse? fetched = null;
            return await OnPlay.RunAsync(
                OnPlay.Languages(options.SubtitleDownloadLanguages),
                async (language, token) =>
                {
                    asked = language;
                    var found = await _subtitles
                        .SearchSubtitles(Request(video, language, options, providers), token)
                        .ConfigureAwait(false);
                    return found.FirstOrDefault(r => IsOurs(r.ProviderName))?.Id;
                },
                async (id, token) =>
                {
                    fetched = await _subtitles.GetRemoteSubtitles(id, token).ConfigureAwait(false);
                    using (var copy = new MemoryStream())
                    {
                        await fetched.Stream.CopyToAsync(copy, 81920, token).ConfigureAwait(false);
                        fetched.Stream.Dispose();
                        return copy.ToArray();
                    }
                },
                // Where Jellyfin saves a subtitle: beside the video, or in its metadata
                // folder when the library keeps subtitles apart. Not GetMediaStreams: its
                // 10.10 form is gone from 10.11 and 12, where the lookup failed there on
                // every play.
                () => OnPlay.NamedFor(video.Path, video.ContainingFolderPath, video.GetInternalMetadataPath()),
                async (id, bytes, token) =>
                {
                    fetched!.Stream = new MemoryStream(bytes);
                    // Jellyfin names the file with this, and has no name for nothing.
                    if (string.IsNullOrEmpty(fetched.Language))
                    {
                        fetched.Language = asked;
                    }

                    await _subtitles.UploadSubtitle(video, fetched).ConfigureAwait(false);
                    _providers.QueueRefresh(
                        video.Id,
                        new MetadataRefreshOptions(new DirectoryService(_fileSystem)),
                        RefreshPriority.High);
                },
                cancellationToken).ConfigureAwait(false);
        }
    }
}
