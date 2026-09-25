using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using SubtitleDb.Core;
using Xunit;

namespace SubtitleDb.Tests
{
    public class FinderTests
    {
        private const string SrtRow =
            "{\"id\":1,\"language\":\"en\",\"format\":\"srt\",\"cues\":900}";

        /// <summary>A movie bundle: a top-level subtitles page carrying the given rows.</summary>
        private static string Movie(string rows) =>
            "{\"title\":{},\"subtitles\":{\"items\":[" + rows + "]}}";

        private static SubtitleDbClient Client(StubHandler handler)
        {
            return new SubtitleDbClient(new HttpClient(handler), "https://api.example.test")
            {
                Delay = (_, __) => Task.CompletedTask,
            };
        }

        private static MatchOptions Options(params string[] languages)
        {
            return new MatchOptions
            {
                Languages = languages.ToList(),
                Formats = new List<string> { "srt" },
            };
        }

        [Fact]
        public async Task AnImdbIdIsOneRequest()
        {
            var handler = new StubHandler().On("by-imdb/0133093", Movie(SrtRow));

            var result = await Finder.FindAsync(
                Client(handler), new Hint { ImdbId = "tt0133093" }, Options(), CancellationToken.None);

            Assert.Equal(MatchTier.ExplicitImdb, result.Tier);
            Assert.Single(result.Candidates);
            Assert.Single(handler.Calls);
        }

        [Fact]
        public async Task TmdbLeadsTheLadderWhenItIsPresent()
        {
            // tmdb is the headline key: an explicit tmdb id is tried before an imdb id.
            var handler = new StubHandler()
                .On("by-tmdb", Movie(SrtRow))
                .On("by-imdb", Movie("{\"id\":9,\"language\":\"en\",\"format\":\"srt\",\"cues\":900}"));

            var result = await Finder.FindAsync(
                Client(handler),
                new Hint { TmdbId = 603, ImdbId = "tt0133093" },
                Options(),
                CancellationToken.None);

            Assert.Equal(MatchTier.ExplicitTmdb, result.Tier);
            Assert.Single(handler.Calls);
        }

        [Fact]
        public async Task ATmdb404FallsThroughToImdb()
        {
            // subs.tmdb_map is only partial in production, so by-tmdb 404s for many ids.
            // A plugin must read that as "next rung", never as an error.
            var handler = new StubHandler()
                .On("by-tmdb", "{\"error\":\"not_found\"}", HttpStatusCode.NotFound)
                .On("by-imdb", Movie(SrtRow));

            var result = await Finder.FindAsync(
                Client(handler),
                new Hint { TmdbId = 603, ImdbId = "tt0133093" },
                Options(),
                CancellationToken.None);

            Assert.Equal(MatchTier.ExplicitImdb, result.Tier);
            Assert.Single(result.Candidates);
        }

        [Fact]
        public async Task AnImdb404FallsThroughToTheTitleRung()
        {
            var handler = new StubHandler()
                .On("by-imdb", "{\"error\":\"not_found\"}", HttpStatusCode.NotFound)
                .On("by-title", Movie(SrtRow));

            var result = await Finder.FindAsync(
                Client(handler),
                new Hint { ImdbId = "tt1", Title = "The Matrix" },
                Options(),
                CancellationToken.None);

            Assert.Equal(MatchTier.Title, result.Tier);
            Assert.Single(result.Candidates);
        }

        [Fact]
        public async Task AnEpisodeDrillsByTitleOnTheSeasonAndEpisodeNumbers()
        {
            // No imdb id, so the title rung resolves the series server-side and drills
            // straight to the episode. The drill narrows the top-level page; it does not
            // move it under an episode block, which the API never sent.
            var handler = new StubHandler().On(
                "by-title/season/5/episode/14",
                "{\"title\":{},\"subtitles\":{\"items\":[{\"id\":7,\"language\":\"en\",\"format\":\"srt\",\"cues\":900,\"season\":5,\"episode\":14}]}}");

            var result = await Finder.FindAsync(
                Client(handler),
                new Hint { Title = "Breaking Bad", Season = 5, Episode = 14, EpisodeTitle = "Ozymandias" },
                Options("en"),
                CancellationToken.None);

            Assert.Equal(MatchTier.Title, result.Tier);
            Assert.Equal(7, result.Candidates[0].Subtitle.Id);
            Assert.Contains("/season/5/episode/14", handler.Calls[0], System.StringComparison.Ordinal);
        }

        [Fact]
        public async Task AnEpisodeWithNoIdOfItsOwnGoesByTheSeriesIdBeforeTheName()
        {
            // By name, the API answers "Friends" with Matlock (2024). The series' id,
            // drilled to the season and episode, is the episode's own page.
            var handler = new StubHandler()
                .On("by-imdb/0108778/season/1/episode/1", Movie(SrtRow))
                .On("by-title", Movie("{\"id\":9,\"language\":\"en\",\"format\":\"srt\",\"cues\":900}"));

            var result = await Finder.FindAsync(
                Client(handler),
                new Hint { SeriesImdbId = "tt0108778", Title = "Friends", Season = 1, Episode = 1 },
                Options(),
                CancellationToken.None);

            Assert.Equal(MatchTier.SeriesImdb, result.Tier);
            Assert.Equal(1, result.Candidates[0].Subtitle.Id);
            Assert.Single(handler.Calls);
        }

        [Fact]
        public async Task TheEpisodesOwnIdComesBeforeTheSeriesId()
        {
            var handler = new StubHandler().On("by-imdb/0583459", Movie(SrtRow));

            var result = await Finder.FindAsync(
                Client(handler),
                new Hint { ImdbId = "tt0583459", SeriesImdbId = "tt0108778", Season = 1, Episode = 1 },
                Options(),
                CancellationToken.None);

            Assert.Equal(MatchTier.ExplicitImdb, result.Tier);
            Assert.Single(handler.Calls);
        }

        [Fact]
        public async Task AnEpisodeTheSeriesIdCannotDrillToFallsThroughToTheName()
        {
            // A season or episode the index has no row for is a 404 like any other miss.
            var handler = new StubHandler()
                .On("by-imdb", "{\"error\":\"not_found\"}", HttpStatusCode.NotFound)
                .On("by-title", Movie(SrtRow));

            var result = await Finder.FindAsync(
                Client(handler),
                new Hint { SeriesImdbId = "tt0108778", Title = "Friends", Season = 1, Episode = 99 },
                Options(),
                CancellationToken.None);

            Assert.Equal(MatchTier.Title, result.Tier);
            Assert.Equal(2, handler.Calls.Count);
        }

        [Fact]
        public async Task EachLanguageIsOneRequestAndTheOrderIsKept()
        {
            // One request per language. lang does take up to 16 comma separated codes
            // now; the fan-out is what this port chooses, so it is what is pinned.
            var handler = new StubHandler()
                .On("lang=en", Movie("{\"id\":1,\"language\":\"en\",\"format\":\"srt\",\"cues\":900}"))
                .On("lang=fr", Movie("{\"id\":2,\"language\":\"fr\",\"format\":\"srt\",\"cues\":900}"));

            var result = await Finder.FindAsync(
                Client(handler), new Hint { ImdbId = "tt1" }, Options("en", "fr"), CancellationToken.None);

            Assert.Equal(2, handler.Calls.Count);
            Assert.Equal(new long[] { 1, 2 }, result.Candidates.Select(c => c.Subtitle.Id).ToArray());
        }

        [Fact]
        public async Task TheSameRowUnderTwoLanguagesIsListedOnce()
        {
            var row = "{\"id\":9,\"language\":\"en\",\"format\":\"srt\",\"cues\":900}";
            var handler = new StubHandler()
                .On("lang=en", Movie(row))
                .On("lang=de", Movie(row));

            var result = await Finder.FindAsync(
                Client(handler), new Hint { ImdbId = "tt1" }, Options("en", "de"), CancellationToken.None);

            Assert.Single(result.Candidates);
        }

        [Fact]
        public async Task AResolvedTitleWithNoUsableRowsStillStopsTheLadder()
        {
            // The title resolved; it simply has nothing in the asked-for format. That is
            // not a fallthrough, so the title rung is never reached.
            var handler = new StubHandler()
                .On("by-imdb", Movie("{\"id\":1,\"language\":\"en\",\"format\":\"rar\",\"cues\":900}"))
                .On("by-title", Movie(SrtRow));

            var result = await Finder.FindAsync(
                Client(handler),
                new Hint { ImdbId = "tt1", Title = "The Matrix" },
                Options(),
                CancellationToken.None);

            Assert.Equal(MatchTier.ExplicitImdb, result.Tier);
            Assert.Empty(result.Candidates);
            Assert.Single(handler.Calls);
        }

        [Fact]
        public async Task NothingToGoOnSpendsNoRequests()
        {
            var handler = new StubHandler();
            var result = await Finder.FindAsync(
                Client(handler), new Hint(), Options(), CancellationToken.None);

            Assert.Equal(MatchTier.None, result.Tier);
            Assert.Empty(result.Candidates);
            Assert.Empty(handler.Calls);
        }

        /// <summary>Rows <paramref name="from"/> to <paramref name="to"/> of a title holding <paramref name="total"/>.</summary>
        private static string Page(int from, int to, int total, string language = "en") =>
            "{\"title\":{},\"subtitles\":{\"total\":" + total + ",\"items\":["
            + string.Join(",", Enumerable.Range(from, to - from + 1).Select(i =>
                "{\"id\":" + i + ",\"language\":\"" + language + "\",\"format\":\"srt\",\"cues\":900}"))
            + "]}}";

        private static MatchOptions Limited(int limit, params string[] languages)
        {
            var options = Options(languages);
            options.Limit = limit;
            return options;
        }

        [Fact]
        public async Task ALongListIsReadPastTheFirstHundred()
        {
            // The API sends rows in the order they were added, so the one in sync with
            // the file can sit on page three. The Matrix has 147 English rows.
            var handler = new StubHandler()
                .On("offset=200", Page(201, 250, 250))
                .On("offset=100", Page(101, 200, 250))
                .On("by-imdb", Page(1, 100, 250));

            var result = await Finder.FindAsync(
                Client(handler), new Hint { ImdbId = "tt1" }, Limited(500, "en"), CancellationToken.None);

            Assert.Equal(250, result.Candidates.Count);
            Assert.Equal(3, handler.Calls.Count);
            Assert.DoesNotContain("offset", handler.Calls[0], System.StringComparison.Ordinal);
            Assert.Contains("limit=100&offset=100", handler.Calls[1], System.StringComparison.Ordinal);
            Assert.Contains("limit=100&offset=200", handler.Calls[2], System.StringComparison.Ordinal);
        }

        [Fact]
        public async Task TheLimitEndsTheRead()
        {
            var handler = new StubHandler()
                .On("offset=100", Page(101, 150, 1000))
                .On("by-imdb", Page(1, 100, 1000));

            var result = await Finder.FindAsync(
                Client(handler), new Hint { ImdbId = "tt1" }, Limited(150, "en"), CancellationToken.None);

            Assert.Equal(150, result.Candidates.Count);
            Assert.Equal(2, handler.Calls.Count);
            Assert.Contains("limit=50&offset=100", handler.Calls[1], System.StringComparison.Ordinal);
        }

        [Fact]
        public async Task ASmallLimitStillRanksAWholePage()
        {
            var handler = new StubHandler().On("by-imdb", Page(1, 100, 1000));

            var result = await Finder.FindAsync(
                Client(handler), new Hint { ImdbId = "tt1" }, Limited(5, "en"), CancellationToken.None);

            Assert.Equal(5, result.Candidates.Count);
            Assert.Single(handler.Calls);
            Assert.Contains("limit=100", handler.Calls[0], System.StringComparison.Ordinal);
        }

        [Fact]
        public async Task APageThatBringsNothingNewEndsTheRead()
        {
            // What a server that ignored offset would send, and what one past its offset
            // cap does send. Reading on would ask the same page again until the limit.
            var handler = new StubHandler().On("by-imdb", Page(1, 100, 1000));

            var result = await Finder.FindAsync(
                Client(handler), new Hint { ImdbId = "tt1" }, Limited(500, "en"), CancellationToken.None);

            Assert.Equal(100, result.Candidates.Count);
            Assert.Equal(2, handler.Calls.Count);
        }

        [Fact]
        public async Task TheLimitHoldsPerLanguage()
        {
            // One cap over the merged list let a hundred English rows push every French
            // one out, since a first language outscores a second.
            var handler = new StubHandler()
                .On("lang=en", Page(1, 100, 100))
                .On("lang=fr", Page(1001, 1003, 3, "fr"));

            var result = await Finder.FindAsync(
                Client(handler), new Hint { ImdbId = "tt1" }, Options("en", "fr"), CancellationToken.None);

            Assert.Equal(3, result.Candidates.Count(c => c.Subtitle.Language == "fr"));
        }

        [Theory]
        [InlineData(null, 500)]
        [InlineData(0, 100)]
        [InlineData(50, 100)]
        [InlineData(300, 300)]
        [InlineData(99999, 2000)]
        public void ASettingIsReadAsRowsPerLanguage(int? setting, int want)
        {
            Assert.Equal(want, MatchOptions.PerLanguageFrom(setting));
        }

        [Fact]
        public async Task ATitleTheServerCannotResolveIsNoAnswer()
        {
            // by-title 404s when the matcher finds nothing close enough. The ladder ends
            // with no automatic answer rather than throwing.
            var handler = new StubHandler().On("by-title", "{\"error\":\"not_found\"}", HttpStatusCode.NotFound);

            var result = await Finder.FindAsync(
                Client(handler),
                new Hint { Title = "Zzzz Nonexistent Qqqq" },
                Options(),
                CancellationToken.None);

            Assert.Equal(MatchTier.None, result.Tier);
            Assert.Empty(result.Candidates);
        }
    }
}
