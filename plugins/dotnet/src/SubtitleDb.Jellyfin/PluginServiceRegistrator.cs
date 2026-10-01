using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Controller.Subtitles;
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
            serviceCollection.AddHostedService<PlaybackLookup>();
        }
    }
}
