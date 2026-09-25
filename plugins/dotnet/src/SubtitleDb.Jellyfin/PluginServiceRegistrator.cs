using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Controller.Subtitles;
using Microsoft.Extensions.DependencyInjection;

namespace SubtitleDb.Jellyfin
{
    /// <summary>Puts the provider in the container Jellyfin reads its subtitle providers from.</summary>
    /// <remarks>
    /// Jellyfin's subtitle manager takes its providers from the service container and
    /// does not scan plugin assemblies for them. Without this the plugin loads, shows
    /// in the dashboard as active, and is never asked for a subtitle.
    /// </remarks>
    public class PluginServiceRegistrator : IPluginServiceRegistrator
    {
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            serviceCollection.AddSingleton<ISubtitleProvider, SubtitleDbSubtitleProvider>();
        }
    }
}
