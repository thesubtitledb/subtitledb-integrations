using System;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using SubtitleDb.Emby;
using Xunit;

namespace SubtitleDb.Emby.Tests
{
    /// <summary>
    /// The settings page against the plugin. That Emby's web app runs it is
    /// plugins/hosts/settings_page.py's to show.
    /// </summary>
    public class SettingsPageTests
    {
        // Without its constructor, which would hand every other test this as Plugin.Instance.
        private static readonly Plugin Ours = (Plugin)RuntimeHelpers.GetUninitializedObject(typeof(Plugin));

        private static string Page(bool main)
        {
            var page = Ours.GetPages().Single(p => p.IsMainConfigPage == main);
            using var stream = typeof(Plugin).Assembly.GetManifestResourceStream(page.EmbeddedResourcePath);
            Assert.NotNull(stream);
            return new StreamReader(stream!).ReadToEnd();
        }

        [Fact]
        public void EmbyOpensThePageAndLoadsTheScriptItNames()
        {
            // Emby takes every page for the plugin's settings page unless told otherwise,
            // and a data-controller it cannot load leaves the page an empty form.
            var script = Ours.GetPages().Single(p => !p.IsMainConfigPage);

            Assert.Equal(Plugin.ScriptPage, script.Name);
            Assert.Contains("data-controller=\"__plugin/" + Plugin.ScriptPage + "\"", Page(main: true),
                StringComparison.Ordinal);
            Assert.Contains("define([], () => {", Page(main: false), StringComparison.Ordinal);
        }

        [Fact]
        public void ThePageReadsAndWritesEverySettingOfThisPlugin()
        {
            // A setting the page never fills is saved back empty, one it never writes is
            // a setting nobody can change, and another plugin's id loads a form that
            // saves nothing.
            var html = Page(main: true);
            var script = Page(main: false);
            foreach (var property in typeof(PluginConfiguration).GetProperties())
            {
                if (property.DeclaringType != typeof(PluginConfiguration))
                {
                    continue;
                }

                Assert.Contains("id=\"" + property.Name + "\"", html, StringComparison.Ordinal);
                Assert.Contains("= config." + property.Name + ";", script, StringComparison.Ordinal);
                Assert.Contains("config." + property.Name + " = ", script, StringComparison.Ordinal);
            }

            Assert.Contains("var pluginId = '" + Ours.Id.ToString("D") + "';", script, StringComparison.Ordinal);
        }

        [Fact]
        public void TheLookupOnPlayIsCalledGetLatestSubtitlesOnPlay()
        {
            Assert.Matches(
                "id=\"LookUpOnPlay\"[^>]*/>\\s*<span>Get latest subtitles on play</span>",
                Page(main: true));
        }

        [Fact]
        public void TheScriptNamesItselfForTheBrowserCheck()
        {
            // settings_page.py tells this script's errors from Emby's own by that name.
            Assert.Matches("//# sourceURL=subtitledb\\S*\\.js", Page(main: false));
        }
    }
}
