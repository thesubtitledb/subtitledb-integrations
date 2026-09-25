using MediaBrowser.Model.Plugins;
using SubtitleDb.Core;

namespace SubtitleDb.Jellyfin.Configuration
{
    /// <summary>
    /// There is no account and no key, so there is nothing here to fill in. The
    /// language a search asks for is the one Jellyfin already asks with, from the
    /// user's own subtitle settings, and repeating it here would only let the two
    /// disagree.
    /// </summary>
    public class PluginConfiguration : BasePluginConfiguration
    {
        /// <summary>For anyone running their own mirror of the API.</summary>
        public string ApiBase { get; set; } = SubtitleDbClient.DefaultApiBase;

        /// <summary>The most subtitles to read and offer for each language.</summary>
        public int PerLanguage { get; set; } = MatchOptions.PerLanguage;
    }
}
