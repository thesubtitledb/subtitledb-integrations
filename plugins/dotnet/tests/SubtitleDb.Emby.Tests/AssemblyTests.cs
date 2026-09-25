using System;
using System.Linq;
using SubtitleDb.Emby;
using Xunit;

namespace SubtitleDb.Emby.Tests
{
    /// <summary>
    /// What the one DLL asks its host for. Emby resolves a plugin's references only
    /// against its own assemblies, so a version it does not ship is a load failure.
    /// </summary>
    public class AssemblyTests
    {
        [Fact]
        public void SystemTextJsonIsAskedForAtTheVersionEmby48Ships()
        {
            // Found by the live run: Emby 4.8 runs on .NET 6 and has System.Text.Json
            // 6.0.0.0. Built against the 8.0 package, the plugin asked for 8.0.0.0 and
            // every search failed with FileNotFoundException. 4.9 and later bind a
            // 6.0.0.0 request to their newer copy.
            var reference = typeof(SubtitleDbSubtitleProvider).Assembly
                .GetReferencedAssemblies()
                .Single(a => a.Name == "System.Text.Json");

            Assert.True(reference.Version <= new Version(6, 0, 0, 0), reference.FullName);
        }
    }
}
