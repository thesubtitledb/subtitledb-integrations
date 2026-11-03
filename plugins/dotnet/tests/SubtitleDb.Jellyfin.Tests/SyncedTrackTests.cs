using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using MediaBrowser.Model.Providers;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using SubtitleDb.Jellyfin;
using Xunit;

namespace SubtitleDb.Jellyfin.Tests
{
    /// <summary>
    /// How the SYNCED track is wired into Jellyfin. The sync itself is Core's
    /// (SyncTests); writing, syncing and the refresh run in plugins/hosts.
    /// </summary>
    public class SyncedTrackTests
    {
        [Fact]
        public void BothSyncSettingsAreOffUntilTurnedOn()
        {
            var config = new Configuration.PluginConfiguration();

            Assert.False(config.SyncWithSubtitles);
            Assert.False(config.SyncWithAudio);
        }

        [Fact]
        public void TheSettingsPageCarriesBothLabelsAsWritten()
        {
            var assembly = typeof(Plugin).Assembly;
            var name = assembly.GetManifestResourceNames().Single(n => n.EndsWith(".configPage.html", StringComparison.Ordinal));
            using var stream = assembly.GetManifestResourceStream(name)!;
            var html = new StreamReader(stream).ReadToEnd();

            Assert.Contains("<span>Sync subtitles with other subtitle tracks</span>", html, StringComparison.Ordinal);
            Assert.Contains("<span>Sync subtitles with audio (uses CPU/GPU)</span>", html, StringComparison.Ordinal);
            Assert.Contains("config.SyncWithSubtitles = ", html, StringComparison.Ordinal);
            Assert.Contains("config.SyncWithAudio = ", html, StringComparison.Ordinal);
        }

        [Fact]
        public void OneInstanceTakesDownloadsAndRunsAsAHostedService()
        {
            var services = new ServiceList();

            new PluginServiceRegistrator().RegisterServices(services, null!);

            Assert.Contains(services, d => d.ServiceType == typeof(SyncedTrack) && d.Lifetime == ServiceLifetime.Singleton);
            Assert.Contains(services, d => d.ServiceType == typeof(IHostedService) && d.ImplementationFactory != null);
        }

        [Fact]
        public void ADownloadKnowsTheVideoItWasOfferedFor()
        {
            SubtitleDbSubtitleProvider.Remember(
                new[] { new RemoteSubtitleInfo { Id = "1407986432" } },
                "/media/movies/The Thing (2011)/The Thing (2011).mp4");

            Assert.Equal("/media/movies/The Thing (2011)/The Thing (2011).mp4", SubtitleDbSubtitleProvider.Searched["1407986432"]);
        }

        private sealed class ServiceList : List<ServiceDescriptor>, IServiceCollection
        {
        }
    }
}
