using System.Collections.Generic;
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
