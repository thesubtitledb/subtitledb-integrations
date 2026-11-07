using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Channels;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.MediaEncoding;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Model.IO;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using SubtitleDb.Core;
using SubtitleDb.Core.Sync;

namespace SubtitleDb.Jellyfin
{
    /// <summary>
    /// With either sync setting on, every TSDb download also gets a SYNCED copy beside
    /// the video, every cue marked "(syncing) ", which one job at a time then lines up
    /// and rewrites without the mark, or deletes when it cannot be sure.
    /// </summary>
    public sealed class SyncedTrack : IHostedService
    {
        private readonly ILibraryManager _library;
        private readonly IProviderManager _providers;
        private readonly IFileSystem _fileSystem;
        private readonly IMediaEncoder _encoder;
        private readonly PlayGate _gate;
        private readonly ILogger<SyncedTrack> _logger;
        private readonly Channel<Job> _jobs = Channel.CreateUnbounded<Job>(new UnboundedChannelOptions { SingleReader = true });
        private readonly ConcurrentDictionary<string, Job> _pending = new ConcurrentDictionary<string, Job>(StringComparer.Ordinal);
        private readonly ConcurrentDictionary<string, string> _tried = new ConcurrentDictionary<string, string>(StringComparer.Ordinal);
        private readonly CancellationTokenSource _stopping = new CancellationTokenSource();
        private Task? _worker;

        public SyncedTrack(
            ILibraryManager library,
            IProviderManager providers,
            IFileSystem fileSystem,
            IMediaEncoder encoder,
            PlayGate gate,
            ILogger<SyncedTrack> logger)
        {
            _library = library;
            _providers = providers;
            _fileSystem = fileSystem;
            _encoder = encoder;
            _gate = gate;
            _logger = logger;
        }

        /// <summary>The longest one sync may take before it is given up.</summary>
        internal static TimeSpan Limit { get; set; } = TimeSpan.FromMinutes(15);

        public Task StartAsync(CancellationToken cancellationToken)
        {
            _worker = Task.Run(WorkAsync);
            return Task.CompletedTask;
        }

        public async Task StopAsync(CancellationToken cancellationToken)
        {
            _jobs.Writer.TryComplete();
            _stopping.Cancel();
            if (_worker != null)
            {
                await Task.WhenAny(_worker, Task.Delay(TimeSpan.FromSeconds(5), cancellationToken)).ConfigureAwait(false);
            }

            // A marked file nobody will finish would stay marked for good.
            foreach (var job in _pending.Values)
            {
                Delete(job.Path);
            }
        }

        /// <summary>
        /// A TSDb subtitle was downloaded for the video at <paramref name="videoPath"/>.
        /// Never throws: the download itself must not fail over this.
        /// </summary>
        public void Downloaded(string? videoPath, byte[] subtitle, string? format, string? language)
        {
            try
            {
                var config = Plugin.Instance?.Configuration;
                if (config == null
                    || !(config.SyncWithSubtitles || config.SyncWithAudio)
                    || string.IsNullOrEmpty(videoPath)
                    || _stopping.IsCancellationRequested)
                {
                    return;
                }

                var video = Find(videoPath!);
                if (video == null)
                {
                    return;
                }

                // A player holding the video's list would lose its tracks to a new file.
                Job? job = null;
                if (_gate.TryChangeNow(video.Id, () => job = Prepare(video, videoPath!, subtitle, format, language, config.SyncWithSubtitles, config.SyncWithAudio)))
                {
                    Queue(job);
                }
                else
                {
                    _ = PrepareLaterAsync(video, videoPath!, subtitle, format, language, config.SyncWithSubtitles, config.SyncWithAudio);
                }
            }
            catch (Exception err)
            {
                _logger.LogError(err, "TSDb: no SYNCED subtitle for {Path}", videoPath);
            }
        }

        private async Task PrepareLaterAsync(Video video, string videoPath, byte[] subtitle, string? format, string? language, bool withTracks, bool withAudio)
        {
            try
            {
                Job? job = null;
                await _gate.ChangeAsync(
                    video.Id,
                    () =>
                    {
                        job = Prepare(video, videoPath, subtitle, format, language, withTracks, withAudio);
                        return Task.CompletedTask;
                    },
                    _stopping.Token).ConfigureAwait(false);
                Queue(job);
            }
            catch (OperationCanceledException) when (_stopping.IsCancellationRequested)
            {
                // Jellyfin is stopping.
            }
            catch (Exception err)
            {
                _logger.LogError(err, "TSDb: no SYNCED subtitle for {Path}", videoPath);
            }
        }

        private void Queue(Job? job)
        {
            if (job != null)
            {
                _pending[job.Path] = job;
                _jobs.Writer.TryWrite(job);
            }
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private Video? Find(string videoPath)
        {
            return _library.FindByPath(videoPath, false) as Video;
        }

        [MethodImpl(MethodImplOptions.NoInlining)]
        private Job? Prepare(Video video, string videoPath, byte[] subtitle, string? format, string? language, bool withTracks, bool withAudio)
        {
            var extension = string.IsNullOrWhiteSpace(format) ? "srt" : format!.Trim().ToLowerInvariant();
            var lang = Languages.ToAlpha3(language);
            if (string.IsNullOrEmpty(lang))
            {
                lang = "und";
            }

            var hash = Convert.ToBase64String(SHA256.HashData(subtitle));
            var folders = Folders(video);
            var existing = folders.Select(f => Syncer.PathFor(f, videoPath, lang, extension)).FirstOrDefault(File.Exists);

            // Played again: the subtitle is already saved and its SYNCED copy made, or
            // it was tried since Jellyfin started.
            if ((existing != null && OnPlay.AlreadyHeld(OnPlay.NamedFor(videoPath, folders.ToArray()), subtitle))
                || folders.Any(f => _tried.TryGetValue(Syncer.PathFor(f, videoPath, lang, extension), out var h) && h == hash))
            {
                return null;
            }

            var marked = Syncer.Marked(subtitle, extension);
            foreach (var folder in folders)
            {
                var path = Syncer.PathFor(folder, videoPath, lang, extension);
                try
                {
                    Directory.CreateDirectory(folder);
                    File.WriteAllBytes(path, marked);
                }
                catch (Exception err) when (err is IOException || err is UnauthorizedAccessException)
                {
                    _logger.LogDebug(err, "TSDb: cannot write {Path}", path);
                    continue;
                }

                _tried[path] = hash;
                Refresh(video);
                return new Job(video, videoPath, path, subtitle, extension, lang, hash, withTracks, withAudio);
            }

            _logger.LogWarning("TSDb: nowhere to write a SYNCED subtitle for {Path}", videoPath);
            return null;
        }

        /// <summary>Where Jellyfin saves a subtitle: beside the video when the library says so, else its metadata folder.</summary>
        private IReadOnlyList<string> Folders(Video video)
        {
            var folders = new List<string>();
            if (_library.GetLibraryOptions(video).SaveSubtitlesWithMedia && !string.IsNullOrEmpty(video.ContainingFolderPath))
            {
                folders.Add(video.ContainingFolderPath);
            }

            folders.Add(video.GetInternalMetadataPath());
            return folders;
        }

        private async Task WorkAsync()
        {
            try
            {
                await foreach (var job in _jobs.Reader.ReadAllAsync(_stopping.Token).ConfigureAwait(false))
                {
                    await SyncAsync(job).ConfigureAwait(false);
                }
            }
            catch (OperationCanceledException) when (_stopping.IsCancellationRequested)
            {
                // Jellyfin is stopping.
            }
        }

        private async Task SyncAsync(Job job)
        {
            var started = DateTime.UtcNow;
            var synced = false;
            try
            {
                using var limit = CancellationTokenSource.CreateLinkedTokenSource(_stopping.Token);
                limit.CancelAfter(Limit);
                var ffmpeg = new Ffmpeg(_encoder.EncoderPath, ProbePath());
                var outcome = await Syncer.RunAsync(ffmpeg, job.VideoPath, job.Subtitle, job.Extension, job.Language, job.WithTracks, job.WithAudio, limit.Token).ConfigureAwait(false);

                // A newer download for the same file may have replaced this one meanwhile.
                if (!_pending.TryGetValue(job.Path, out var current) || !ReferenceEquals(current, job))
                {
                    return;
                }

                // Rewritten in place, it keeps its number in a player's list.
                if (outcome.Bytes != null)
                {
                    File.WriteAllBytes(job.Path, outcome.Bytes);
                    _logger.LogInformation("TSDb: {Path} {Said}, in {Seconds:0.0} s", job.Path, outcome.Said, (DateTime.UtcNow - started).TotalSeconds);
                    synced = true;
                }
                else
                {
                    _logger.LogInformation("TSDb: {Path} not synced and removed: {Said}", job.Path, outcome.Said);
                }
            }
            catch (OperationCanceledException) when (_stopping.IsCancellationRequested)
            {
                Delete(job.Path);
                return;
            }
            catch (Exception err)
            {
                if (err is OperationCanceledException)
                {
                    _logger.LogWarning("TSDb: {Path} not synced and removed: gave up after {Minutes} minutes", job.Path, Limit.TotalMinutes);
                }
                else
                {
                    _logger.LogWarning(err, "TSDb: {Path} not synced and removed", job.Path);
                }
            }
            finally
            {
                _pending.TryRemove(new KeyValuePair<string, Job>(job.Path, job));
            }

            if (synced)
            {
                Refresh(job.Video);
            }
            else
            {
                _ = RemoveAsync(job);
            }
        }

        /// <summary>Removes a SYNCED copy that could not be synced, once no player holds the video's list.</summary>
        private async Task RemoveAsync(Job job)
        {
            try
            {
                await _gate.ChangeAsync(
                    job.Video.Id,
                    () =>
                    {
                        // A newer download for the same file may have written it again meanwhile.
                        if (!_pending.ContainsKey(job.Path))
                        {
                            Delete(job.Path);
                            Refresh(job.Video);
                        }

                        return Task.CompletedTask;
                    },
                    _stopping.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                // Jellyfin is stopping: a marked file nobody will finish would stay marked for good.
                Delete(job.Path);
            }
        }

        /// <summary>ffprobe sits beside ffmpeg in every Jellyfin package.</summary>
        private string ProbePath()
        {
            var ffmpeg = _encoder.EncoderPath;
            var dir = Path.GetDirectoryName(ffmpeg) ?? string.Empty;
            var name = Path.GetFileName(ffmpeg).Replace("ffmpeg", "ffprobe", StringComparison.Ordinal);
            var probe = Path.Combine(dir, name);
            return File.Exists(probe) ? probe : "ffprobe";
        }

        private void Refresh(Video video)
        {
            try
            {
                _providers.QueueRefresh(video.Id, new MetadataRefreshOptions(new DirectoryService(_fileSystem)), RefreshPriority.High);
            }
            catch (Exception err)
            {
                _logger.LogDebug(err, "TSDb: no refresh for {Path}", video.Path);
            }
        }

        private void Delete(string path)
        {
            try
            {
                File.Delete(path);
            }
            catch (Exception err) when (err is IOException || err is UnauthorizedAccessException)
            {
                _logger.LogWarning("TSDb: cannot remove {Path}: {Message}", path, err.Message);
            }
        }

        private sealed class Job
        {
            public Job(Video video, string videoPath, string path, byte[] subtitle, string extension, string language, string hash, bool withTracks, bool withAudio)
            {
                Video = video;
                VideoPath = videoPath;
                Path = path;
                Subtitle = subtitle;
                Extension = extension;
                Language = language;
                Hash = hash;
                WithTracks = withTracks;
                WithAudio = withAudio;
            }

            public Video Video { get; }

            public string VideoPath { get; }

            public string Path { get; }

            public byte[] Subtitle { get; }

            public string Extension { get; }

            public string Language { get; }

            public string Hash { get; }

            public bool WithTracks { get; }

            public bool WithAudio { get; }
        }
    }
}
