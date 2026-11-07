using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;
using SubtitleDb.Jellyfin;
using Xunit;

namespace SubtitleDb.Jellyfin.Tests
{
    /// <summary>
    /// No subtitle file is added or removed while a player holds the video's list of
    /// tracks: the numbers in that list would move and the track picked never load.
    /// </summary>
    public class PlayGateTests
    {
        private static readonly Guid Video = Guid.NewGuid();

        [Fact]
        public async Task AFileFoundBeforeThePlayerGetsItsListIsSavedAtOnce()
        {
            var gate = new PlayGate(_ => false, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(1));
            var saved = false;

            gate.Open(Video);
            await gate.ChangeAsync(Video, () => { saved = true; return Task.CompletedTask; }, CancellationToken.None);

            Assert.True(saved);
        }

        [Fact]
        public async Task AFileFoundAfterThePlayerGotItsListWaitsForTheStop()
        {
            var playing = false;
            var gate = new PlayGate(_ => playing, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(1));
            gate.Open(Video);
            await gate.HandedAsync(Video);

            // Handed out but not yet reported as playing, then playing.
            Assert.False(gate.TryChangeNow(Video, () => { }));
            playing = true;
            var saved = false;
            var change = gate.ChangeAsync(Video, () => { saved = true; return Task.CompletedTask; }, CancellationToken.None);
            await Task.Delay(100);
            Assert.False(saved);

            playing = false;
            gate.Stopped(Video);
            await change.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(saved);
        }

        [Fact]
        public async Task AListHandedOutHoldsOnlyItsOwnVideo()
        {
            var gate = new PlayGate(_ => false, TimeSpan.FromMinutes(2), TimeSpan.FromMinutes(1));
            await gate.HandedAsync(Video);

            Assert.True(gate.TryChangeNow(Guid.NewGuid(), () => { }));
            Assert.False(gate.TryChangeNow(Video, () => { }));
        }

        [Fact]
        public void TheFilterRunsBeforeJellyfinsPlaybackInfoAndNothingElse()
        {
            var services = new ServiceCollection();
            services.AddOptions();
            new PluginServiceRegistrator().RegisterServices(services, null!);

            var filters = services.BuildServiceProvider().GetRequiredService<IOptions<MvcOptions>>().Value.Filters;

            Assert.Contains(filters, f => f is ServiceFilterAttribute s && s.ServiceType == typeof(PlaybackInfoFilter));
            Assert.Contains(services, d => d.ServiceType == typeof(PlaybackInfoFilter) && d.Lifetime == ServiceLifetime.Singleton);
            Assert.True(PlaybackInfoFilter.IsPlaybackInfo("MediaInfo", "GetPostedPlaybackInfo"));
            Assert.True(PlaybackInfoFilter.IsPlaybackInfo("MediaInfo", "GetPlaybackInfo"));
            Assert.False(PlaybackInfoFilter.IsPlaybackInfo("MediaInfo", "GetBitrateTestBytes"));
            Assert.False(PlaybackInfoFilter.IsPlaybackInfo("Items", "GetPlaybackInfo"));
        }
    }
}
