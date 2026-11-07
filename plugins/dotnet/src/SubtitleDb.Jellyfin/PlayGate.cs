using System;
using System.Collections.Concurrent;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Session;
using Microsoft.Extensions.Logging;

namespace SubtitleDb.Jellyfin
{
    /// <summary>
    /// When the plugin may add or remove a video's subtitle files. A player numbers the
    /// tracks from the list it gets before it starts, and Jellyfin numbers the files
    /// beside a video ahead of the tracks inside it, so a file added or removed while
    /// it plays moves every number: the track picked then never loads. A file rewritten
    /// in place moves nothing and needs no gate.
    /// </summary>
    public sealed class PlayGate
    {
        private readonly Func<Guid, bool> _playing;
        private readonly TimeSpan _grace;
        private readonly TimeSpan _poll;
        private readonly ConcurrentDictionary<Guid, DateTime> _handed = new ConcurrentDictionary<Guid, DateTime>();
        private readonly SemaphoreSlim _lock = new SemaphoreSlim(1, 1);
        private TaskCompletionSource<bool> _wake = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

        public PlayGate(ISessionManager sessions, ILogger<PlayGate> logger)
            : this(id => Playing(sessions, logger, id), TimeSpan.FromMinutes(2), TimeSpan.FromSeconds(15))
        {
        }

        /// <param name="playing">Whether a player is playing the video now.</param>
        /// <param name="grace">How long a list handed out counts as playing before the start is reported.</param>
        /// <param name="poll">How often a held change looks again, besides when a video stops.</param>
        internal PlayGate(Func<Guid, bool> playing, TimeSpan grace, TimeSpan poll)
        {
            _playing = playing;
            _grace = grace;
            _poll = poll;
        }

        /// <summary>A player is asking for the video's tracks: changes may run until <see cref="HandedAsync"/>.</summary>
        public void Open(Guid id)
        {
            _handed.TryRemove(id, out _);
            Wake();
        }

        /// <summary>The player gets the list now. Waits for a change under way, so the list has it.</summary>
        public async Task HandedAsync(Guid id)
        {
            await _lock.WaitAsync().ConfigureAwait(false);
            try
            {
                var now = DateTime.UtcNow;
                foreach (var old in _handed.Where(p => now - p.Value >= _grace).Select(p => p.Key).ToList())
                {
                    _handed.TryRemove(old, out _);
                }

                _handed[id] = now;
            }
            finally
            {
                _lock.Release();
            }
        }

        /// <summary>A player stopped the video: held changes may run.</summary>
        public void Stopped(Guid id)
        {
            _handed.TryRemove(id, out _);
            Wake();
        }

        /// <summary>Runs <paramref name="change"/> once no player holds the video's list.</summary>
        public async Task ChangeAsync(Guid id, Func<Task> change, CancellationToken cancellationToken)
        {
            while (true)
            {
                Task wake;
                await _lock.WaitAsync(cancellationToken).ConfigureAwait(false);
                try
                {
                    if (Free(id))
                    {
                        await change().ConfigureAwait(false);
                        return;
                    }

                    wake = _wake.Task;
                }
                finally
                {
                    _lock.Release();
                }

                await Task.WhenAny(wake, Task.Delay(_poll, cancellationToken)).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
            }
        }

        /// <summary>Runs <paramref name="change"/> now and returns true, unless a player holds the list or another change is under way.</summary>
        public bool TryChangeNow(Guid id, Action change)
        {
            if (!_lock.Wait(0))
            {
                return false;
            }

            try
            {
                if (!Free(id))
                {
                    return false;
                }

                change();
                return true;
            }
            finally
            {
                _lock.Release();
            }
        }

        private bool Free(Guid id)
        {
            return !(_handed.TryGetValue(id, out var at) && DateTime.UtcNow - at < _grace) && !_playing(id);
        }

        private void Wake()
        {
            Interlocked.Exchange(ref _wake, new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously)).TrySetResult(true);
        }

        private static bool Playing(ISessionManager sessions, ILogger logger, Guid id)
        {
            try
            {
                return NowPlaying(sessions, id);
            }
            catch (Exception err)
            {
                // The list handed out still holds changes back for the grace period.
                logger.LogDebug(err, "TSDb: cannot tell who is playing what");
                return false;
            }
        }

        /// <summary>Compiled when first called: the session list's shape may differ in another Jellyfin.</summary>
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static bool NowPlaying(ISessionManager sessions, Guid id)
        {
            return sessions.Sessions.Any(s => s.NowPlayingItem != null && s.NowPlayingItem.Id.Equals(id));
        }
    }
}
