using System;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using SubtitleDb.Core;
using Xunit;

namespace SubtitleDb.Tests
{
    public class ClientTests
    {
        private static SubtitleDbClient Client(StubHandler handler)
        {
            var client = new SubtitleDbClient(
                new HttpClient(handler), "https://api.example.test", downloads: new HttpClient(handler));
            // No sleeping in tests: the backoff is asserted by its shape, not its wait.
            client.Delay = (_, __) => Task.CompletedTask;
            return client;
        }

        [Theory]
        [InlineData("tt0133093", "0133093")]
        [InlineData("0133093", "0133093")]
        [InlineData("TT0133093", "0133093")]
        public void ImdbIdIsSentAsDigits(string given, string wanted)
        {
            Assert.Equal(wanted, SubtitleDbClient.ImdbDigits(given));
        }

        [Fact]
        public async Task EveryRequestNamesTheClientAndCarriesFreeTextInAQuery()
        {
            // Not a header: it is what tells one plugin from another in our logs, and
            // a query parameter survives every proxy between here and the API. The
            // by-title free text rides in the query too, because it carries dots and
            // slashes a path segment cannot.
            var handler = new StubHandler().On("/v1/by-title", "{\"title\":{},\"subtitles\":{\"items\":[]}}");
            await Client(handler).ByTitleAsync("matrix", null, null, null, 20, 0, CancellationToken.None);

            Assert.Contains("client=subtitledb-plugin", handler.Calls[0], StringComparison.Ordinal);
            Assert.Contains("q=matrix", handler.Calls[0], StringComparison.Ordinal);
        }

        [Fact]
        public async Task SeasonAndEpisodeDrillIntoThePathNotTheQuery()
        {
            var handler = new StubHandler().On("by-imdb", "{\"title\":{},\"subtitles\":{\"items\":[]}}");
            await Client(handler).ByImdbAsync("tt0133093", 5, 14, null, 100, 0, CancellationToken.None);

            Assert.Contains("/v1/by-imdb/0133093/season/5/episode/14", handler.Calls[0], StringComparison.Ordinal);
        }

        [Fact]
        public async Task AskingForOneLanguageAsksForExactlyOne()
        {
            var handler = new StubHandler().On("by-imdb", "{\"title\":{},\"subtitles\":{\"items\":[]}}");
            await Client(handler).ByImdbAsync("tt0133093", null, null, "en", 100, 0, CancellationToken.None);

            Assert.Contains("lang=en", handler.Calls[0], StringComparison.Ordinal);
            Assert.DoesNotContain(",", handler.Calls[0].Split('?')[1], StringComparison.Ordinal);
        }

        [Fact]
        public async Task AnOffsetIsSentOnlyPastTheFirstPage()
        {
            // The first page keeps the address it always had, so what the edge cached
            // for it still answers.
            var handler = new StubHandler().On("by-imdb", "{\"title\":{},\"subtitles\":{\"items\":[]}}");
            await Client(handler).ByImdbAsync("tt1", null, null, "en", 100, 0, CancellationToken.None);
            await Client(handler).ByImdbAsync("tt1", null, null, "en", 100, 200, CancellationToken.None);

            Assert.DoesNotContain("offset", handler.Calls[0], StringComparison.Ordinal);
            Assert.Contains("limit=100&offset=200", handler.Calls[1], StringComparison.Ordinal);
        }

        [Fact]
        public async Task A404IsARungThatDoesNotApply()
        {
            var handler = new StubHandler().On(
                "by-tmdb", "{\"error\":\"not_found\",\"message\":\"no mapping\"}", HttpStatusCode.NotFound);

            var err = await Assert.ThrowsAsync<SubtitleDbException>(
                () => Client(handler).ByTmdbAsync(603, null, null, null, 100, 0, CancellationToken.None));

            Assert.True(err.Fallthrough);
            Assert.Equal("no mapping", err.Message);
            Assert.Single(handler.Calls);
        }

        [Fact]
        public async Task A500IsRetried()
        {
            var handler = new RetryHandler(2);
            var client = new SubtitleDbClient(new HttpClient(handler), "https://api.example.test")
            {
                Delay = (_, __) => Task.CompletedTask,
            };

            var bundle = await client.ByImdbAsync("tt1", null, null, null, 100, 0, CancellationToken.None);

            Assert.Equal(3, handler.Attempts);
            Assert.Single(bundle.ScopedItems());
        }

        [Fact]
        public async Task A500ThatNeverStopsGivesUpWithTheServerMessage()
        {
            var handler = new StubHandler().On(
                "by-imdb", "{\"message\":\"upstream is down\"}", HttpStatusCode.InternalServerError);

            var err = await Assert.ThrowsAsync<SubtitleDbException>(
                () => Client(handler).ByImdbAsync("tt1", null, null, null, 100, 0, CancellationToken.None));

            Assert.Equal("upstream is down", err.Message);
            Assert.False(err.Fallthrough);
            Assert.Equal(3, handler.Calls.Count);
        }

        [Theory]
        [InlineData("https://api.example.test/get/1", true)]
        [InlineData("https://files.example.test/x/1.srt", true)]
        [InlineData("https://example.test/1.srt", true)]
        [InlineData("https://api.example.test.evil.com/1.srt", false)]
        [InlineData("https://evil.com/1.srt", false)]
        [InlineData("file:///etc/passwd", false)]
        [InlineData("not a url", false)]
        public void OnlyOurOwnHostsAreDownloadedFrom(string url, bool allowed)
        {
            var client = new SubtitleDbClient(new HttpClient(new StubHandler()), "https://api.example.test");
            Assert.Equal(allowed, client.IsOurs(url));
        }

        [Fact]
        public async Task ADownloadElsewhereIsRefusedBeforeItIsMade()
        {
            var handler = new StubHandler();
            await Assert.ThrowsAsync<SubtitleDbException>(
                () => Client(handler).DownloadAsync("https://evil.com/1.srt", CancellationToken.None));

            Assert.Empty(handler.Calls);
        }

        [Fact]
        public async Task ADownloadFollowsARedirectToOurFilesHost()
        {
            var handler = new StubHandler()
                .OnRedirect("/get/1", "https://files.example.test/x/1.srt")
                .On("/x/1.srt", "1\n00:00:01,000 --> 00:00:02,000\nhi\n");

            var bytes = await Client(handler).DownloadAsync("https://api.example.test/get/1", CancellationToken.None);

            Assert.StartsWith("1\n", System.Text.Encoding.UTF8.GetString(bytes), StringComparison.Ordinal);
            Assert.Equal(new[] { "https://api.example.test/get/1", "https://files.example.test/x/1.srt" }, handler.Calls);
        }

        [Fact]
        public async Task ARelativeRedirectStaysOnTheHostItCameFrom()
        {
            var handler = new StubHandler()
                .OnRedirect("/get/1", "/files/1.srt")
                .On("/files/1.srt", "1\n00:00:01,000 --> 00:00:02,000\nhi\n");

            await Client(handler).DownloadAsync("https://api.example.test/get/1", CancellationToken.None);

            Assert.Equal("https://api.example.test/files/1.srt", handler.Calls[1]);
        }

        [Fact]
        public async Task ARedirectOffOurHostsIsRefusedBeforeItIsRequested()
        {
            // The hosts' own clients follow a redirect and say where they landed, which
            // is after the request to somewhere else has gone out.
            var handler = new StubHandler()
                .OnRedirect("/get/1", "https://evil.com/1.srt")
                .On("evil.com", "not ours");

            var err = await Assert.ThrowsAsync<SubtitleDbException>(
                () => Client(handler).DownloadAsync("https://api.example.test/get/1", CancellationToken.None));

            Assert.Contains("off our hosts", err.Message, StringComparison.Ordinal);
            Assert.Equal(new[] { "https://api.example.test/get/1" }, handler.Calls);
        }

        [Fact]
        public async Task ADownloadTheHostRefusesSaysWhy()
        {
            var handler = new StubHandler().On("/get/1", string.Empty, HttpStatusCode.Gone);

            var err = await Assert.ThrowsAsync<SubtitleDbException>(
                () => Client(handler).DownloadAsync("https://api.example.test/get/1", CancellationToken.None));

            Assert.Equal(HttpStatusCode.Gone, err.Status);
        }

        [Fact]
        public async Task ARedirectLoopEnds()
        {
            var handler = new StubHandler().OnRedirect("/get/1", "https://api.example.test/get/1");

            await Assert.ThrowsAsync<SubtitleDbException>(
                () => Client(handler).DownloadAsync("https://api.example.test/get/1", CancellationToken.None));

            Assert.Equal(6, handler.Calls.Count);
        }

        [Fact]
        public async Task AnApiThatNeverAnswersIsAskedAgainAndThenSaysSo()
        {
            var handler = new SilentHandler();
            var client = new SubtitleDbClient(new HttpClient(handler), "https://api.example.test")
            {
                Delay = (_, __) => Task.CompletedTask,
                Timeout = TimeSpan.FromMilliseconds(50),
            };

            var err = await Assert.ThrowsAsync<SubtitleDbException>(
                () => client.ByImdbAsync("tt1", null, null, null, 100, 0, CancellationToken.None));

            Assert.Equal("cannot reach https://api.example.test: timed out", err.Message);
            Assert.Equal(3, handler.Calls);
        }

        [Fact]
        public async Task TheHostClientsOwnTimeoutIsTheSameAnswer()
        {
            // HttpClient.Timeout ends a request with TaskCanceledException, which is not
            // an HttpRequestException, and reached Jellyfin's log as a stack trace.
            var handler = new SilentHandler();
            var client = new SubtitleDbClient(
                new HttpClient(handler) { Timeout = TimeSpan.FromMilliseconds(50) }, "https://api.example.test")
            {
                Delay = (_, __) => Task.CompletedTask,
            };

            var err = await Assert.ThrowsAsync<SubtitleDbException>(
                () => client.ByImdbAsync("tt1", null, null, null, 100, 0, CancellationToken.None));

            Assert.Contains("timed out", err.Message, StringComparison.Ordinal);
            Assert.Equal(3, handler.Calls);
        }

        [Fact]
        public async Task ACallerThatCancelsGetsACancellationNotAnError()
        {
            var handler = new SilentHandler();
            var client = new SubtitleDbClient(new HttpClient(handler), "https://api.example.test");
            using (var cancel = new CancellationTokenSource())
            {
                var call = client.ByImdbAsync("tt1", null, null, null, 100, 0, cancel.Token);

                // Cancelled once the request is out. A fixed delay can run out before
                // it is sent on a loaded machine, and then nothing was ever asked.
                Assert.Same(handler.Entered.Task, await Task.WhenAny(
                    handler.Entered.Task, Task.Delay(TimeSpan.FromSeconds(10))));
                cancel.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => call);
            }

            Assert.Equal(1, handler.Calls);
        }

        [Theory]
        [InlineData("<!DOCTYPE html><html><body>Blocked</body></html>", "a web page")]
        [InlineData(" \n<HTML><body>Maintenance</body></HTML>", "a web page")]
        [InlineData("", "nothing")]
        [InlineData(" \r\n\t", "nothing")]
        [InlineData("\uFEFF<!doctype html><title>Sign in</title>", "a web page")]
        public async Task ADownloadThatIsNotASubtitleIsRefused(string body, string sent)
        {
            // A captive portal or an error page answering 200 was saved as the subtitle.
            var handler = new StubHandler().On("/get/1", body);

            var err = await Assert.ThrowsAsync<SubtitleDbException>(
                () => Client(handler).DownloadAsync("https://api.example.test/get/1", CancellationToken.None));

            Assert.Equal("https://api.example.test/get/1 sent " + sent + ", not a subtitle", err.Message);
        }

        [Fact]
        public async Task ASubtitleWithTagsInItIsStillASubtitle()
        {
            var handler = new StubHandler().On("/get/1", "1\n00:00:01,000 --> 00:00:02,000\n<i>hi</i>\n");

            var bytes = await Client(handler).DownloadAsync("https://api.example.test/get/1", CancellationToken.None);

            Assert.NotEmpty(bytes);
        }

        [Fact]
        public async Task ADownloadThatNeverAnswersSaysSo()
        {
            var handler = new SilentHandler();
            var client = new SubtitleDbClient(
                new HttpClient(handler), "https://api.example.test", downloads: new HttpClient(handler))
            {
                Timeout = TimeSpan.FromMilliseconds(50),
            };

            var err = await Assert.ThrowsAsync<SubtitleDbException>(
                () => client.DownloadAsync("https://api.example.test/get/1", CancellationToken.None));

            Assert.Equal("cannot download https://api.example.test/get/1: timed out", err.Message);
        }

        [Fact]
        public async Task ADownloadThatCannotConnectIsTheOneExceptionCallersCatch()
        {
            var refused = new HttpClient(new RefusingHandler());
            var client = new SubtitleDbClient(refused, "https://api.example.test", downloads: refused);

            var err = await Assert.ThrowsAsync<SubtitleDbException>(
                () => client.DownloadAsync("https://api.example.test/get/1", CancellationToken.None));

            Assert.StartsWith("cannot download https://api.example.test/get/1: ", err.Message, StringComparison.Ordinal);
        }

        /// <summary>Never answers: waits until the request is cancelled.</summary>
        private sealed class SilentHandler : HttpMessageHandler
        {
            private int _calls;

            public int Calls => _calls;

            /// <summary>Done when the first request arrives.</summary>
            public TaskCompletionSource<bool> Entered { get; } =
                new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);

            protected override async Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request,
                CancellationToken cancellationToken)
            {
                Interlocked.Increment(ref _calls);
                Entered.TrySetResult(true);
                await Task.Delay(System.Threading.Timeout.InfiniteTimeSpan, cancellationToken).ConfigureAwait(false);
                throw new InvalidOperationException("unreachable");
            }
        }

        /// <summary>A connection that is refused.</summary>
        private sealed class RefusingHandler : HttpMessageHandler
        {
            protected override Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request,
                CancellationToken cancellationToken)
            {
                throw new HttpRequestException("Connection refused");
            }
        }

        /// <summary>Fails the first <c>n</c> attempts with a 500, then answers.</summary>
        private sealed class RetryHandler : HttpMessageHandler
        {
            private readonly int _failures;

            public RetryHandler(int failures)
            {
                _failures = failures;
            }

            public int Attempts { get; private set; }

            protected override Task<HttpResponseMessage> SendAsync(
                HttpRequestMessage request,
                CancellationToken cancellationToken)
            {
                Attempts++;
                if (Attempts <= _failures)
                {
                    return Task.FromResult(new HttpResponseMessage(HttpStatusCode.InternalServerError)
                    {
                        Content = new StringContent("{\"message\":\"busy\"}"),
                        RequestMessage = request,
                    });
                }

                return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
                {
                    Content = new StringContent(
                        "{\"title\":{},\"subtitles\":{\"items\":[{\"id\":1,\"language\":\"en\",\"format\":\"srt\",\"cues\":900}]}}"),
                    RequestMessage = request,
                });
            }
        }
    }
}
