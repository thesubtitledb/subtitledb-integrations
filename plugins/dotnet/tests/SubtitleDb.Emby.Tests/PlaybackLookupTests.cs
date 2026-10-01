using System.Collections.Generic;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Entities.Movies;
using MediaBrowser.Controller.Entities.TV;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Controller.Providers;
using MediaBrowser.Controller.Subtitles;
using MediaBrowser.Model.Configuration;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Logging;
using SubtitleDb.Emby;
using Xunit;

namespace SubtitleDb.Emby.Tests
{
    /// <summary>
    /// What the lookup on play hands Emby. The decisions after that are Core's
    /// (OnPlayTests); the event, the download and the refresh run in plugins/hosts.
    /// </summary>
    public class PlaybackLookupTests
    {
        private static readonly string[] Providers = { "Open Subtitles", "SubtitleDB", "Podnapisi" };

        [Fact]
        public void AnEpisodeIsAskedForWithItsSeriesIdsAndOfSubtitleDbAlone()
        {
            var episode = new Episode
            {
                Name = "Ozymandias",
                SeriesName = "Breaking Bad",
                ParentIndexNumber = 5,
                IndexNumber = 14,
                Path = "/media/tv/Breaking.Bad.S05E14.1080p.BluRay.x264-DEMAND.mkv",
            };
            var series = new ProviderIdDictionary(new Dictionary<string, string> { { "Imdb", "tt0903747" } });

            var request = PlaybackLookup.Request(
                episode, "eng", null, new LibraryOptions { RequirePerfectSubtitleMatch = true }, Providers, series);

            Assert.Equal(VideoContentType.Episode, request.ContentType);
            Assert.Equal("eng", request.Language);
            Assert.Equal("Breaking Bad", request.SeriesName);
            Assert.Equal(5, request.ParentIndexNumber);
            Assert.Equal(14, request.IndexNumber);
            Assert.Equal("tt0903747", request.SeriesProviderIds["Imdb"]);
            Assert.True(request.IsPerfectMatch);
            Assert.Null(request.IsForced);
            Assert.Null(request.IsHearingImpaired);
            // The other providers may count each download against an account.
            Assert.Equal(new[] { "Open Subtitles", "Podnapisi" }, request.DisabledSubtitleFetchers);
        }

        [Fact]
        public void TheLibrarysForcedAndHearingImpairedRulesAreAskedWith()
        {
            var film = new Movie { Name = "Anatomy of a Fall", Path = "/media/films/Anatomy.of.a.Fall.2023.mkv" };
            var options = new LibraryOptions
            {
                RequirePerfectSubtitleMatch = false,
                ForcedSubtitlesOnly = true,
                HearingImpairedSubtitlesOnly = true,
            };

            var request = PlaybackLookup.Request(film, "fre", null, options, new[] { "SubtitleDB" }, null);

            Assert.Equal(VideoContentType.Movie, request.ContentType);
            Assert.True(request.IsForced);
            Assert.True(request.IsHearingImpaired);
            Assert.False(request.IsPerfectMatch);
            Assert.Empty(request.DisabledSubtitleFetchers);
        }

        [Fact]
        public async Task AForcedOnlySearchFindsNothingBecauseTheIndexMarksNone()
        {
            var provider = new SubtitleDbSubtitleProvider(DispatchProxy.Create<ILogManager, Nothing>());
            var request = new SubtitleSearchRequest
            {
                ContentType = VideoContentType.Movie,
                Name = "Anatomy of a Fall",
                Language = "eng",
                IsForced = true,
            };

            var found = await provider.Search(request, CancellationToken.None);

            Assert.Empty(found);
        }

        [Fact]
        public void OnlyAFilmOrAnEpisodeIsLookedUpAndNeverATrailer()
        {
            Assert.False(PlaybackLookup.Wanted(new Movie { Path = "/media/films/x-trailer.mkv", ExtraType = ExtraType.Trailer }));
            Assert.False(PlaybackLookup.Wanted(new Video { Path = "/media/home/holiday.mkv" }));
            Assert.False(PlaybackLookup.Wanted(null));
        }

        [Fact]
        public void EmbyStartsTheLookupAsAnEntryPoint()
        {
            // Emby builds each public IServerEntryPoint in a plugin's assembly and calls Run.
            var type = typeof(PlaybackLookup);
            Assert.True(type.IsPublic && !type.IsAbstract);
            Assert.True(typeof(IServerEntryPoint).IsAssignableFrom(type));
            Assert.True(new PluginConfiguration().LookUpOnPlay);
        }

        [Theory]
        [InlineData("4c29aabd01ed42af4e8ee437834ff0ba_en_481207")]
        [InlineData("8d1e4b7c_481207")]
        public void TheSaveAfterALookupOnPlayIsHandedTheBytesItFetched(string searched)
        {
            // Emby's search hands out its key, the language and the provider's id, as in
            // the first case, which is what Emby 4.8 to 4.10 log. It takes the first two
            // off before it asks the provider, so the provider is asked for the bare id.
            var bytes = new byte[] { 1, 2, 3 };
            using (Prefetched.Hold(searched, bytes))
            {
                Assert.Same(bytes, Prefetched.Take("481207"));
                Assert.Null(Prefetched.Take("481207"));
            }
        }

        [Fact]
        public void NothingIsHeldOnceTheSaveIsOver()
        {
            using (Prefetched.Hold("481208", new byte[] { 1 }))
            {
            }

            Assert.Null(Prefetched.Take("481208"));
        }

        /// <summary>Any Emby interface, answering every call with null.</summary>
        public class Nothing : DispatchProxy
        {
            protected override object? Invoke(MethodInfo? targetMethod, object?[]? args) => null;
        }
    }
}
