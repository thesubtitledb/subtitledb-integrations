using System;
using System.Collections.Generic;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using SubtitleDb.Core;

namespace SubtitleDb.Emby
{
    /// <summary>
    /// There is no account and no key. The settings are the API address, for anyone
    /// running their own mirror, how many subtitles to offer per language, and the
    /// lookup when a video starts. The plugin's page sets them and Emby keeps them in
    /// plugins/configurations/SubtitleDb.Emby.xml. The languages are Emby's, from its
    /// subtitle settings, and repeating them here would only let the two disagree.
    /// </summary>
    public class PluginConfiguration : BasePluginConfiguration
    {
        public string ApiBase { get; set; } = SubtitleDbClient.DefaultApiBase;

        public int PerLanguage { get; set; } = MatchOptions.PerLanguage;

        public bool LookUpOnPlay { get; set; } = true;
    }

    /// <summary>The plugin Emby lists, so it can be updated and removed like any other.</summary>
    public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
    {
        /// <summary>The name the settings page's data-controller loads the script by.</summary>
        internal const string ScriptPage = "subtitledb.js";
        public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
            : base(applicationPaths, xmlSerializer)
        {
            Instance = this;
        }

        /// <summary>
        /// Set once, by Emby, when it loads the plugin. The provider reads the
        /// configuration through this: Emby builds providers itself and does not hand
        /// them the plugin.
        /// </summary>
        public static Plugin? Instance { get; private set; }

        public override string Name => "SubtitleDB";

        public override Guid Id => Guid.Parse("8dd4c65a-eac6-4d61-88c5-779ed9c3539e");

        public override string Description =>
            "Subtitles from the SubtitleDB open index. No account, no key, no quota.";

        /// <summary>
        /// The settings page Emby opens from the plugin's entry, and its script. Emby
        /// counts every page as the plugin's settings page unless told otherwise.
        /// </summary>
        public IEnumerable<PluginPageInfo> GetPages()
        {
            var resource = GetType().Namespace + ".Configuration.configPage.";
            return new[]
            {
                new PluginPageInfo { Name = "subtitledb", EmbeddedResourcePath = resource + "html" },
                new PluginPageInfo
                {
                    Name = ScriptPage,
                    EmbeddedResourcePath = resource + "js",
                    IsMainConfigPage = false,
                },
            };
        }
    }
}
