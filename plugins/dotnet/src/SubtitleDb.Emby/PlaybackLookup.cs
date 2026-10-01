using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Session;
using MediaBrowser.Controller.Subtitles;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Globalization;
using MediaBrowser.Model.IO;
using MediaBrowser.Model.Logging;
using SubtitleDb.Core;

namespace SubtitleDb.Emby
{
    /// <summary>
    /// When a film or an episode starts playing, asks SubtitleDB for it and saves the
    /// best match beside it, as Emby saves a subtitle picked in its search dialog.
    /// </summary>
    /// <remarks>
    /// All of it is Emby's own: the playback event, the subtitle manager to search,
    /// fetch and download, and a refresh after the download. The library's subtitle
    /// settings decide the languages, whether only a perfect match will do, and
    /// whether SubtitleDB is asked at all. A player reads the subtitle list when it
    /// starts, so the new one is in that list from the next play.
    /// </remarks>
    public sealed class PlaybackLookup : IServerEntryPoint
    {
        private readonly ISessionManager _sessions;
        private readonly ISubtitleManager _subtitles;
        private readonly ILibraryManager _library;
        private readonly IProviderManager _providers;
        private readonly IFileSystem _fileSystem;
        private readonly ILocalizationManager _localization;
        private readonly ILogger _logger;
        private readonly OnPlay _onPlay = new OnPlay();
        private readonly CancellationTokenSource _stopping = new CancellationTokenSource();

        public PlaybackLookup(
            ISessionManager sessions,
            ISubtitleManager subtitles,
            ILibraryManager library,
            IProviderManager providers,
            IFileSystem fileSystem,
            ILocalizationManager localization,
            ILogManager logManager)
        {
            _sessions = sessions;
            _subtitles = subtitles;
            _library = library;
            _providers = providers;
            _fileSystem = fileSystem;
            _localization = localization;
            _logger = logManager.GetLogger("SubtitleDB");
        }

        public void Run()
        {
            _sessions.PlaybackStart += OnPlaybackStart;
        }

        public void Dispose()
        {
            _sessions.PlaybackStart -= OnPlaybackStart;
            _stopping.Cancel();
        }

        /// <summary>A film or an episode in a file, not a trailer or another extra.</summary>
        internal static bool Wanted(BaseItem? item)
        {
            return (item is Movie || item is Episode)
                && item.ExtraType == null
                && !item.IsPlaceHolder
                && !string.IsNullOrEmpty(item.Path)
                && item.IsFileProtocol;
        }

        /// <summary>
        /// The request Emby builds for its own search of a video, asking SubtitleDB
        /// alone: the other providers may count downloads against an account, and
        /// nobody asked them. <paramref name="seriesIds"/> are an episode's series' ids.
        /// </summary>
        internal static SubtitleSearchRequest Request(
            Video video,
            string language,
            CultureDto? culture,
            LibraryOptions options,
            IEnumerable<string> providers,
            ProviderIdDictionary? seriesIds)
        {
            var episode = video as Episode;
            return new SubtitleSearchRequest
            {
                ContentType = episode == null ? VideoContentType.Movie : VideoContentType.Episode,
                Language = language,
                LanguageInfo = culture,
                MediaPath = video.Path,
                Name = video.Name,
                IndexNumber = video.IndexNumber,
                IndexNumberEnd = episode?.IndexNumberEnd,
                ParentIndexNumber = video.ParentIndexNumber,
                ProductionYear = video.ProductionYear,
                ProviderIds = video.ProviderIds,
                SeriesName = episode?.SeriesName,
                SeriesProviderIds = seriesIds,
                IsPerfectMatch = options.RequirePerfectSubtitleMatch,
                IsForced = options.ForcedSubtitlesOnly ? true : (bool?)null,
                IsHearingImpaired = options.HearingImpairedSubtitlesOnly ? true : (bool?)null,
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

        private void OnPlaybackStart(object? sender, PlaybackProgressEventArgs e)
        {
            try
            {
                if (Plugin.Instance?.Configuration?.LookUpOnPlay == false
                    || !Wanted(e.Item)
                    || !_onPlay.Begin(e.Item.InternalId.ToString(System.Globalization.CultureInfo.InvariantCulture), DateTime.UtcNow))
                {
                    return;
                }

                var video = (Video)e.Item;
                _ = Task.Run(() => LookUpAsync(video));
            }
            catch (Exception err)
            {
                _logger.Error("SubtitleDB: the lookup on play did not start: {0}", err);
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
                        _logger.Info("SubtitleDB: {0} started playing, {1}", video.Path, said);
                    }
                    else
                    {
                        _logger.Debug("SubtitleDB: {0} started playing, {1}", video.Path, said);
                    }
                }
            }
            catch (OperationCanceledException) when (_stopping.IsCancellationRequested)
            {
                // Emby is stopping.
            }
            catch (SubtitleDbException err)
            {
                _logger.Warn("SubtitleDB: the lookup on play failed for {0}: {1}", video.Path, err.Message);
            }
            catch (OperationCanceledException)
            {
                _logger.Warn("SubtitleDB: the lookup on play gave up on {0} after 2 minutes", video.Path);
            }
            catch (Exception err)
            {
                // An Emby whose library or subtitle calls differ from the ones this was
                // built against lands here, with the playback itself untouched.
                _logger.Error("SubtitleDB: the lookup on play failed for {0}: {1}", video.Path, err);
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
            var seriesIds = (video as Episode)?.Series?.ProviderIds;
            return await OnPlay.RunAsync(
                OnPlay.Languages(options.SubtitleDownloadLanguages),
                async (language, token) =>
                {
                    var request = Request(
                        video, language, _localization.FindLanguageInfo(language), options, providers, seriesIds);
                    var found = await _subtitles.SearchSubtitles(request, token).ConfigureAwait(false);
                    return found.FirstOrDefault(r => IsOurs(r.ProviderName))?.Id;
                },
                async (id, token) =>
                {
                    var fetched = await _subtitles.GetRemoteSubtitles(id, token).ConfigureAwait(false);
                    using (fetched.Stream)
                    using (var copy = new MemoryStream())
                    {
                        await fetched.Stream.CopyToAsync(copy, 81920, token).ConfigureAwait(false);
                        return copy.ToArray();
                    }
                },
                () => video.GetMediaStreams()
                    .Where(s => s.Type == MediaStreamType.Subtitle && s.IsExternal && !string.IsNullOrEmpty(s.Path))
                    .Select(s => s.Path),
                async (id, bytes, token) =>
                {
                    // Emby has no call that saves bytes it is handed, so it fetches the
                    // subtitle again and saves it as its search dialog's download does.
                    await _subtitles.DownloadSubtitles(video, id, options, token).ConfigureAwait(false);
                    _providers.QueueRefresh(video.InternalId, new MetadataRefreshOptions(_fileSystem), RefreshPriority.High);
                },
                cancellationToken).ConfigureAwait(false);
        }
    }
}
