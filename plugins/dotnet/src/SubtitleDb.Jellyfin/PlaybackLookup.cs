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
    /// When a player asks for a film or an episode, asks SubtitleDB for it and saves the
    /// best match beside it, as Jellyfin saves a subtitle picked in its search dialog.
    /// </summary>
    /// <remarks>
    /// All of it is Jellyfin's own: the subtitle manager to search, fetch and save, and
    /// the refresh that adds the file to the video's tracks. The library's subtitle
    /// settings decide the languages, whether only a perfect match will do, and whether
    /// SubtitleDB is asked at all. <see cref="PlaybackInfoFilter"/> runs it before the
    /// player gets its list of tracks, so a subtitle found in time is in that list. One
    /// found later waits in <see cref="PlayGate"/> until the video stops, and is in the
    /// list from the next play.
    /// </remarks>
    public sealed class PlaybackLookup : IHostedService
    {
        private readonly ISessionManager _sessions;
        private readonly ISubtitleManager _subtitles;
        private readonly ILibraryManager _library;
        private readonly IProviderManager _providers;
        private readonly IFileSystem _fileSystem;
        private readonly IMediaSourceManager _mediaSources;
        private readonly PlayGate _gate;
        private readonly ILogger<PlaybackLookup> _logger;
        private readonly OnPlay _onPlay = new OnPlay();
        private readonly CancellationTokenSource _stopping = new CancellationTokenSource();

        public PlaybackLookup(
            ISessionManager sessions,
            ISubtitleManager subtitles,
            ILibraryManager library,
            IProviderManager providers,
            IFileSystem fileSystem,
            IMediaSourceManager mediaSources,
            PlayGate gate,
            ILogger<PlaybackLookup> logger)
        {
            _sessions = sessions;
            _subtitles = subtitles;
            _library = library;
            _providers = providers;
            _fileSystem = fileSystem;
            _mediaSources = mediaSources;
            _gate = gate;
            _logger = logger;
        }

        /// <summary>How long a player waits for the lookup before it gets its list without it.</summary>
        internal static TimeSpan Budget { get; set; } = TimeSpan.FromSeconds(4);

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
                _logger.LogError(err, "TSDb: the lookup on play is off, this Jellyfin's playback event is not the one it was built for");
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
                _logger.LogDebug(err, "TSDb: the lookup on play was never on");
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
            return string.Equals(provider, SubtitleDbSubtitleProvider.ProviderName, StringComparison.OrdinalIgnoreCase);
        }

        /// <summary>The language of the audio <paramref name="item"/> starts in, or null.</summary>
        /// <remarks>
        /// Called by name: what GetMediaStreams returns is not the same type in every
        /// Jellyfin this runs on, and a call compiled against one fails on the next.
        /// </remarks>
        [MethodImpl(MethodImplOptions.NoInlining)]
        internal static string? Spoken(IMediaSourceManager sources, Guid item)
        {
            var streams = typeof(IMediaSourceManager)
                .GetMethod("GetMediaStreams", new[] { typeof(Guid) })
                ?.Invoke(sources, new object[] { item }) as IEnumerable<MediaStream>;
            return OnPlay.Spoken(streams?
                .Where(s => s.Type == MediaStreamType.Audio)
                .Select(s => ((string?)s.Language, s.IsDefault)));
        }

        /// <summary>
        /// A player asked for the tracks of item <paramref name="id"/>. Looks it up for up
        /// to <see cref="Budget"/> first. Never throws: the player must get its answer.
        /// </summary>
        internal async Task BeforePlayAsync(Guid id, CancellationToken cancellationToken)
        {
            _gate.Open(id);
            try
            {
                var lookup = Begin(_library.GetItemById(id));
                if (lookup != null)
                {
                    await Task.WhenAny(lookup, Task.Delay(Budget, cancellationToken)).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException)
            {
                // The player went away.
            }
            catch (Exception err)
            {
                _logger.LogError(err, "TSDb: the lookup on play did not start");
            }

            await _gate.HandedAsync(id).ConfigureAwait(false);
        }

        /// <summary>The lookup for <paramref name="item"/>, started, or null when it is not wanted now.</summary>
        private Task? Begin(BaseItem? item)
        {
            if (Plugin.Instance?.Configuration?.LookUpOnPlay == false
                || !Wanted(item)
                || !_onPlay.Begin(item!.Id.ToString("N"), DateTime.UtcNow))
            {
                return null;
            }

            var video = (Video)item;
            return Task.Run(() => LookUpAsync(video));
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private void Subscribe()
        {
            _sessions.PlaybackStart += OnPlaybackStart;
            _sessions.PlaybackStopped += OnPlaybackStopped;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private void Unsubscribe()
        {
            _sessions.PlaybackStart -= OnPlaybackStart;
            _sessions.PlaybackStopped -= OnPlaybackStopped;
        }

        /// <summary>For a player that did not ask PlaybackInfo first; its find waits for the stop.</summary>
        private void OnPlaybackStart(object? sender, PlaybackProgressEventArgs e)
        {
            try
            {
                Begin(e.Item);
            }
            catch (Exception err)
            {
                _logger.LogError(err, "TSDb: the lookup on play did not start");
            }
        }

        private void OnPlaybackStopped(object? sender, PlaybackStopEventArgs e)
        {
            if (e.Item != null)
            {
                _gate.Stopped(e.Item.Id);
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
                        _logger.LogInformation("TSDb: {Path} was played, {Said}", video.Path, said);
                    }
                    else
                    {
                        _logger.LogDebug("TSDb: {Path} was played, {Said}", video.Path, said);
                    }
                }
            }
            catch (OperationCanceledException) when (_stopping.IsCancellationRequested)
            {
                // Jellyfin is stopping.
            }
            catch (SubtitleDbException err)
            {
                _logger.LogWarning("TSDb: the lookup on play failed for {Path}: {Message}", video.Path, err.Message);
            }
            catch (OperationCanceledException)
            {
                _logger.LogWarning("TSDb: the lookup on play gave up on {Path} after 2 minutes", video.Path);
            }
            catch (Exception err)
            {
                // A Jellyfin whose library or subtitle calls differ from the ones this was
                // built against lands here, with the playback itself untouched.
                _logger.LogError(err, "TSDb: the lookup on play failed for {Path}", video.Path);
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
            string? spoken = null;
            if (options.SkipSubtitlesIfAudioTrackMatches)
            {
                try
                {
                    spoken = Spoken(_mediaSources, video.Id);
                }
                catch (Exception err)
                {
                    // Every language is asked, as when the setting is off.
                    _logger.LogDebug(err, "TSDb: cannot tell what language {Path} is in", video.Path);
                }
            }

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
                // Not the lookup's 2 minutes: a find held for a player can wait a film long.
                (id, bytes, token) => _gate.ChangeAsync(video.Id, async () =>
                {
                    fetched!.Stream = new MemoryStream(bytes);
                    // Jellyfin names the file with this, and has no name for nothing.
                    if (string.IsNullOrEmpty(fetched.Language))
                    {
                        fetched.Language = asked;
                    }

                    await _subtitles.UploadSubtitle(video, fetched).ConfigureAwait(false);
                    await RefreshAsync(video).ConfigureAwait(false);
                }, _stopping.Token),
                cancellationToken,
                spoken).ConfigureAwait(false);
        }

        /// <summary>Adds the new file to the video's tracks before the player's list is made.</summary>
        private async Task RefreshAsync(Video video)
        {
            var options = new MetadataRefreshOptions(new DirectoryService(_fileSystem));
            try
            {
                await RefreshNowAsync(video, options).ConfigureAwait(false);
            }
            catch (Exception err) when (!(err is OperationCanceledException))
            {
                // A Jellyfin without this call: the file is in the list from the next play.
                _logger.LogDebug(err, "TSDb: no refresh now for {Path}", video.Path);
                _providers.QueueRefresh(video.Id, options, RefreshPriority.High);
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private Task RefreshNowAsync(Video video, MetadataRefreshOptions options)
        {
            return _providers.RefreshSingleItem(video, options, _stopping.Token);
        }
    }
}
