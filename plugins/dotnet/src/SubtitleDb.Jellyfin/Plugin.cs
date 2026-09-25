using System;
using System.Collections.Generic;
using System.Globalization;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using SubtitleDb.Jellyfin.Configuration;

namespace SubtitleDb.Jellyfin
{
    /// <summary>The plugin Jellyfin lists, so it can be updated and removed like any other.</summary>
    public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
        }

        /// <summary>
        /// Set in the constructor, which Jellyfin calls once. The provider reads the
        /// configuration through this: Jellyfin builds providers from the container
        /// and does not hand them the plugin.
        /// </summary>
        public static Plugin? Instance { get; private set; }

        public override string Name => "SubtitleDB";

        public override Guid Id => Guid.Parse("e8067282-ad64-415a-b9ed-9057e6679483");

        public override string Description =>
            "Subtitles from the SubtitleDB open index. No account, no key, no quota.";

        public IEnumerable<PluginPageInfo> GetPages()
        {
            return new[]
            {
                new PluginPageInfo
                {
                    Name = Name,
                    EmbeddedResourcePath = string.Format(
                        CultureInfo.InvariantCulture,
                        "{0}.Configuration.configPage.html",
                        GetType().Namespace),
                },
            };
        }
    }
}
