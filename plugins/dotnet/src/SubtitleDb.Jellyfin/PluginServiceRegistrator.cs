using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Controller.Subtitles;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.DependencyInjection;

namespace SubtitleDb.Jellyfin
{
    /// <summary>Puts the provider and the lookup on play in Jellyfin's service container.</summary>
    /// <remarks>
    /// Jellyfin's subtitle manager takes its providers from the service container and
    /// does not scan plugin assemblies for them. Without this the plugin loads, shows
    /// in the dashboard as active, and is never asked for a subtitle. A hosted service
    /// is how a plugin runs from startup since Jellyfin 10.9.
    /// </remarks>
    public class PluginServiceRegistrator : IPluginServiceRegistrator
    {
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            serviceCollection.AddSingleton<ISubtitleProvider, SubtitleDbSubtitleProvider>();
            serviceCollection.AddSingleton<PlayGate>();

            // One instance: the PlaybackInfo filter calls it, and as a hosted service it
            // hears playback start and stop.
            serviceCollection.AddSingleton<PlaybackLookup>();
            serviceCollection.AddHostedService(services => services.GetRequiredService<PlaybackLookup>());
            serviceCollection.AddSingleton<PlaybackInfoFilter>();
            serviceCollection.Configure<MvcOptions>(options => options.Filters.AddService<PlaybackInfoFilter>());

            // One instance: the provider hands it downloads, and as a hosted service it syncs them.
            serviceCollection.AddSingleton<SyncedTrack>();
            serviceCollection.AddHostedService(services => services.GetRequiredService<SyncedTrack>());
        }
    }
}
