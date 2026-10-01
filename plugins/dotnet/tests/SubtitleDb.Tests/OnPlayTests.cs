using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using SubtitleDb.Core;
using Xunit;

namespace SubtitleDb.Tests
{
    /// <summary>
    /// The lookup on play, with the host's search, fetch and save as plain functions.
    /// The Jellyfin and Emby halves are run against the real servers in plugins/hosts.
    /// </summary>
    public sealed class OnPlayTests : IDisposable
    {
        private static readonly DateTime T0 = new DateTime(2026, 10, 1, 12, 0, 0, DateTimeKind.Utc);
        private static readonly byte[] Ours = Encoding.UTF8.GetBytes("1\n00:00:01,000 --> 00:00:02,000\nours\n");

        private readonly string _dir = Path.Combine(Path.GetTempPath(), "sdb-onplay-" + Guid.NewGuid().ToString("N"));

        public OnPlayTests()
        {
            Directory.CreateDirectory(_dir);
        }

        public void Dispose()
        {
            Directory.Delete(_dir, true);
        }

        [Fact]
        public void AVideoIsLookedUpOnceInTheQuietSpanHoweverOftenItStarts()
        {
            var onPlay = new OnPlay();

            Assert.True(onPlay.Begin("film", T0));
            Assert.False(onPlay.Begin("film", T0.AddSeconds(5)));
            Assert.True(onPlay.Begin("episode", T0.AddSeconds(5)));
            Assert.False(onPlay.Begin("film", T0 + OnPlay.Quiet - TimeSpan.FromSeconds(1)));
            Assert.True(onPlay.Begin("film", T0 + OnPlay.Quiet));
        }

        [Fact]
        public void TheLibrarysLanguagesAreAskedInItsOrderEachOnce()
        {
            Assert.Equal(new[] { "spa", "eng" }, OnPlay.Languages(new[] { " spa", "eng", string.Empty, null, "SPA" }));
            Assert.Empty(OnPlay.Languages(null));
        }

        [Fact]
        public async Task WithNoLanguagesNothingIsAsked()
        {
            var host = new Host();

            var said = await host.Run();

            Assert.Empty(host.Asked);
            Assert.Contains("no subtitle download languages", said, StringComparison.Ordinal);
        }

        [Fact]
        public async Task TheFirstLanguageWithAMatchIsSavedAndTheRestAreNotAsked()
        {
            var host = new Host();
            host.Best["eng"] = "h_1";
            host.Best["fre"] = "h_2";

            var said = await host.Run("spa", "eng", "fre");

            Assert.Equal(new[] { "spa", "eng" }, host.Asked);
            Assert.Equal(new[] { "h_1" }, host.Saved);
            Assert.Equal("saved SubtitleDB's eng subtitle h_1", said);
        }

        [Fact]
        public async Task AVideoThatHasSubtitlesStillGetsOurs()
        {
            var host = new Host();
            host.Best["eng"] = "h_1";
            host.Held.Add(Write("film.eng.srt", "1\n00:00:01,000 --> 00:00:02,000\ntheirs\n"));
            host.Held.Add(Write("film.srt", "1\n00:00:01,000 --> 00:00:02,000\nmore of theirs\n"));

            await host.Run("eng");

            Assert.Equal(new[] { "h_1" }, host.Saved);
        }

        [Fact]
        public async Task TheSameFileIsNotSavedTwice()
        {
            var host = new Host();
            host.Best["eng"] = "h_1";
            host.Held.Add(Write("film.eng.srt", Encoding.UTF8.GetString(Ours)));

            var said = await host.Run("eng");

            Assert.Empty(host.Saved);
            Assert.Equal("it already has SubtitleDB's eng subtitle h_1", said);
        }

        [Fact]
        public async Task NothingInAnyLanguageSavesNothing()
        {
            var host = new Host();

            var said = await host.Run("spa", "eng");

            Assert.Equal(new[] { "spa", "eng" }, host.Asked);
            Assert.Empty(host.Saved);
            Assert.Equal("SubtitleDB has nothing for it in spa, eng", said);
        }

        [Fact]
        public async Task TheLanguageTheAudioIsInIsNotAskedWhenTheLibrarySkipsIt()
        {
            // Any spelling of the language: the audio says fra, the library says fre.
            var host = new Host { Spoken = "fra" };
            host.Best["fre"] = "h_2";
            host.Best["eng"] = "h_1";

            await host.Run("fre", "eng");

            Assert.Equal(new[] { "eng" }, host.Asked);
            Assert.Equal(new[] { "h_1" }, host.Saved);
        }

        [Fact]
        public async Task AudioInTheOnlyLanguageAsksNothingAndSaysWhy()
        {
            var host = new Host { Spoken = "eng" };
            host.Best["eng"] = "h_1";

            var said = await host.Run("eng");

            Assert.Empty(host.Asked);
            Assert.Equal("its audio is in eng, and its library skips a subtitle in that language", said);
        }

        [Fact]
        public void TheAudioThatCountsIsTheDefaultStreamElseTheFirst()
        {
            Assert.Equal("eng", OnPlay.Spoken(new (string?, bool)[] { ("ger", false), ("eng", true) }));
            Assert.Equal("ger", OnPlay.Spoken(new (string?, bool)[] { ("ger", false), ("eng", false) }));
            // A default stream that names no language says nothing, as the hosts read it.
            Assert.Null(OnPlay.Spoken(new (string?, bool)[] { (null, true), ("eng", false) }));
            Assert.Null(OnPlay.Spoken(Array.Empty<(string?, bool)>()));
            Assert.Null(OnPlay.Spoken(null));
        }

        [Fact]
        public async Task AFetchThatFailsSavesNothingAndSaysWhy()
        {
            var host = new Host { Fails = true };
            host.Best["eng"] = "h_1";

            var err = await Assert.ThrowsAsync<SubtitleDbException>(() => host.Run("eng"));

            Assert.Contains("sent a web page", err.Message, StringComparison.Ordinal);
            Assert.Empty(host.Saved);
        }

        [Fact]
        public void OnlyTheSameBytesCountAsHeld()
        {
            var same = Write("a.srt", Encoding.UTF8.GetString(Ours));
            var longer = Write("b.srt", Encoding.UTF8.GetString(Ours) + "\n");
            var sameLength = Write("c.srt", Encoding.UTF8.GetString(Ours).Replace("ours", "OURS"));
            var missing = Path.Combine(_dir, "gone.srt");

            Assert.True(OnPlay.AlreadyHeld(new[] { missing, longer, same }, Ours));
            Assert.False(OnPlay.AlreadyHeld(new[] { missing, longer, sameLength }, Ours));
            Assert.False(OnPlay.AlreadyHeld(Array.Empty<string>(), Ours));
        }

        [Fact]
        public void TheFilesNamedForTheVideoAreTheOnesItHolds()
        {
            // Beside the video, and in a second folder (Jellyfin's metadata folder) that
            // need not exist yet. Another film's subtitle and the video itself are not it.
            var video = Write("Heat.1995.1080p.mkv", "video");
            var beside = Write("Heat.1995.1080p.en.srt", "beside");
            var cased = Write("heat.1995.1080p.eng.0.srt", "a second one");
            Write("Heat.1995.720p.en.srt", "another release");
            Write("Heat.1995.1080p-en.srt", "not after a dot");
            var metadata = Path.Combine(_dir, "metadata");
            Directory.CreateDirectory(metadata);
            var kept = Path.Combine(metadata, "Heat.1995.1080p.eng.srt");
            File.WriteAllText(kept, "kept apart");

            Assert.Equal(
                new[] { beside, cased, kept }.OrderBy(p => p, StringComparer.Ordinal),
                OnPlay.NamedFor(video, _dir, metadata, Path.Combine(_dir, "none"), null)
                    .OrderBy(p => p, StringComparer.Ordinal));
        }

        private string Write(string name, string text)
        {
            var path = Path.Combine(_dir, name);
            File.WriteAllText(path, text, new UTF8Encoding(false));
            return path;
        }

        /// <summary>A host whose search answers from <see cref="Best"/> and whose fetch returns <see cref="Ours"/>.</summary>
        private sealed class Host
        {
            public Dictionary<string, string> Best { get; } = new Dictionary<string, string>();

            public List<string> Held { get; } = new List<string>();

            public List<string> Asked { get; } = new List<string>();

            public List<string> Saved { get; } = new List<string>();

            public bool Fails { get; set; }

            public string? Spoken { get; set; }

            public Task<string> Run(params string[] languages)
            {
                return OnPlay.RunAsync(
                    languages,
                    (language, _) =>
                    {
                        Asked.Add(language);
                        return Task.FromResult(Best.TryGetValue(language, out var id) ? id : null);
                    },
                    (_, __) => Fails
                        ? throw new SubtitleDbException("https://api.example.test/get/1 sent a web page, not a subtitle")
                        : Task.FromResult(Ours),
                    () => Held,
                    (id, _, __) =>
                    {
                        Saved.Add(id);
                        return Task.CompletedTask;
                    },
                    CancellationToken.None,
                    Spoken);
            }
        }
    }
}
