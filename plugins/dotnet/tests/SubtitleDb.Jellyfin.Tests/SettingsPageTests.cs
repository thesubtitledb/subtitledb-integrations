using System;
using System.IO;
using System.Linq;
using SubtitleDb.Jellyfin;
using Xunit;

namespace SubtitleDb.Jellyfin.Tests
{
    /// <summary>
    /// The settings page's text. That Jellyfin's web app runs it is
    /// plugins/hosts/settings_page.py's to show.
    /// </summary>
    public class SettingsPageTests
    {
        private static string Page()
        {
            var assembly = typeof(Plugin).Assembly;
            var name = assembly.GetManifestResourceNames()
                .Single(n => n.EndsWith(".configPage.html", StringComparison.Ordinal));
            using var stream = assembly.GetManifestResourceStream(name);
            Assert.NotNull(stream);
            return new StreamReader(stream!).ReadToEnd();
        }

        [Fact]
        public void ThePageSendsTheReaderToEachLibrary()
        {
            // Jellyfin keeps the download languages and the ticked downloaders on each
            // library. Its playback settings have no subtitles page to turn this plugin on in.
            var html = Page();

            Assert.Contains("for each library under Dashboard, Libraries", html, StringComparison.Ordinal);
            Assert.DoesNotContain("Playback, Subtitles", html, StringComparison.Ordinal);
        }
    }
}
