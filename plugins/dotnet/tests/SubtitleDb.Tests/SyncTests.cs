using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using SubtitleDb.Core.Sync;
using Xunit;

namespace SubtitleDb.Tests
{
    /// <summary>The SYNCED track: parse and rewrite, line up, and the whole job through ffmpeg.</summary>
    public sealed class SyncTests
    {
        private const string Srt = "\uFEFF1\r\n00:00:01,000 --> 00:00:02,500\r\n<i>Hello</i>\r\nthere\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nBye\r\n";

        [Fact]
        public void A_retimed_srt_differs_only_in_its_times()
        {
            var doc = SubtitleDoc.Parse(Srt, "srt");
            var moved = doc.Retime(t => t + 1.25).Stringify();

            Assert.Equal(Srt.Replace("00:00:01,000 --> 00:00:02,500", "00:00:02,250 --> 00:00:03,750").Replace("00:00:03,000 --> 00:00:04,000", "00:00:04,250 --> 00:00:05,250"), moved);
        }

        [Fact]
        public void The_mark_opens_every_cue_and_nothing_else()
        {
            var marked = SubtitleDoc.Parse(Srt, "srt").Prefix(Syncer.Marker).Stringify();

            Assert.Contains("\r\n(syncing) <i>Hello</i>\r\nthere\r\n", marked, StringComparison.Ordinal);
            Assert.Contains("\r\n(syncing) Bye\r\n", marked, StringComparison.Ordinal);
            Assert.Equal(2, CountOf(marked, "(syncing)"));
        }

        [Fact]
        public void Ass_is_retimed_and_marked_in_its_own_fields()
        {
            var ass = "[Script Info]\nTitle: x\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
                + "Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an8}One, two\n";
            var doc = SubtitleDoc.Parse(ass, "ass");
            var output = doc.Prefix(Syncer.Marker).Retime(t => t * 2).Stringify();

            Assert.Equal("{\\an8}One, two", doc.Cues[0].Text);
            Assert.Contains("Dialogue: 0,0:00:02.00,0:00:04.00,Default,,0,0,0,,(syncing) {\\an8}One, two", output, StringComparison.Ordinal);
        }

        [Fact]
        public void Vtt_keeps_its_cue_settings()
        {
            var vtt = "WEBVTT\n\n00:01.000 --> 00:02.000 align:start\nHi\n";
            var output = SubtitleDoc.Parse(vtt).Retime(t => t + 1).Stringify();

            Assert.Contains("00:00:02.000 --> 00:00:03.000 align:start", output, StringComparison.Ordinal);
        }

        [Fact]
        public void A_latin1_file_comes_back_byte_for_byte()
        {
            var latin1 = Encoding.GetEncoding(28591);
            var bytes = latin1.GetBytes("1\n00:00:01,000 --> 00:00:02,000\nCaf\u00e9 cr\u00e8me\n");
            var (text, encoding) = Syncer.Decode(bytes);

            Assert.Contains("Caf\u00e9", text, StringComparison.Ordinal);
            Assert.Equal(bytes, encoding.GetBytes(SubtitleDoc.Parse(text, "srt").Stringify()));
        }

        [Fact]
        public void The_synced_file_is_named_so_the_host_shows_its_title()
        {
            Assert.Equal(
                Path.Combine("/m", "The Thing (2011).SYNCED - TSDb.eng.srt"),
                Syncer.PathFor("/m", "/media/The Thing (2011).mp4", "eng", "SRT"));
        }

        [Fact]
        public void Samples_are_taken_at_the_ends_first()
        {
            // subtitledb-sync's samplePoints(6180, 4, 120).
            Assert.Equal(new[] { 309d, 5751, 2123, 3937 }, Syncer.SampleStarts(6180, 4, 120).Select(x => Math.Round(x)));
        }

        [Theory]
        [InlineData(1, 2.5)]
        [InlineData(25 / 23.976, -4)]
        public void The_aligner_recovers_a_shift_and_a_speed(double scale, double shift)
        {
            var cues = RandomCues(900, 7);

            // The reference is the same cues as the media has them: media = scale * sub + shift.
            var media = cues.Select(c => new Cue((c.Start * scale) + shift, (c.End * scale) + shift, c.Text)).ToList();
            var windows = new[] { new Window(Signals.FromCues(media, Signals.Rate), 0) };

            var result = Aligner.Align(windows, cues, new AlignOptions { Lead = 0 });

            Assert.NotNull(result);
            Assert.InRange(result!.Scale, scale - 0.0005, scale + 0.0005);
            Assert.InRange(result.Map(450) - ((450 * scale) + shift), -0.05, 0.05);
            Assert.True(result.Confidence >= Syncer.MinConfidence, $"confidence {result.Confidence}");
        }

        [Fact]
        public void Another_films_subtitle_is_never_confident()
        {
            var windows = new[] { new Window(Signals.FromCues(RandomCues(900, 1), Signals.Rate), 0) };

            var result = Aligner.Align(windows, RandomCues(900, 2), new AlignOptions { Lead = 0 });

            Assert.True(result == null || result.Confidence < Syncer.MinConfidence, $"confidence {result?.Confidence}");
        }

        [Fact]
        public async Task A_subtitle_is_lined_up_against_a_text_track_inside_the_video()
        {
            var dir = Scratch();
            var cues = RandomCues(300, 3);
            var reference = Path.Combine(dir, "ref.srt");
            File.WriteAllText(reference, Srts(cues, 0));
            // First a forced track nobody flagged: a few cues, read and passed over.
            var forced = Path.Combine(dir, "forced.srt");
            File.WriteAllText(forced, Srts(cues.Take(3), 0));
            var video = Path.Combine(dir, "film.mkv");
            Run("ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-i", forced, "-i", reference,
                "-map", "0", "-map", "1", "-map", "2", "-t", "300", "-c:a", "flac", "-c:s", "srt",
                "-metadata:s:s:0", "language=eng", "-metadata:s:s:1", "language=eng", video);

            var late = Encoding.UTF8.GetBytes(Srts(cues, 3.2));
            var outcome = await Syncer.RunAsync(new Ffmpeg("ffmpeg", "ffprobe"), video, late, "srt", "eng", true, false, CancellationToken.None);

            Assert.True(outcome.Bytes != null, outcome.Said);
            Assert.StartsWith("lined up against subtitle stream 2 (eng)", outcome.Said, StringComparison.Ordinal);
            Assert.InRange(outcome.Result!.Shift, -3.25, -3.15);
            var synced = SubtitleDoc.Parse(Encoding.UTF8.GetString(outcome.Bytes!), "srt");
            Assert.InRange(synced.Cues[10].Start - cues[10].Start, -0.05, 0.05);
            Assert.DoesNotContain("(syncing)", Encoding.UTF8.GetString(outcome.Bytes!), StringComparison.Ordinal);
        }

        [Fact]
        public async Task A_subtitle_is_lined_up_against_the_speech()
        {
            // Sintel's excerpt and its subtitle, the subtitle two seconds late. Twelve cues
            // in a minute come out just under the bar a film clears with hundreds (0.48
            // here, 0.64 on a 103-minute film), so this run lowers it.
            var srt = File.ReadAllText(Media.Path("sintel-excerpt.en.srt"));
            var late = SubtitleDoc.Parse(srt, "srt").Retime(t => t + 2).Stringify();

            var ffmpeg = new Ffmpeg("ffmpeg", "ffprobe");
            var video = Media.Path("sintel-excerpt.mkv");
            var asIs = await Syncer.RunAsync(ffmpeg, video, Encoding.UTF8.GetBytes(srt), "srt", "eng", false, true, CancellationToken.None, 0.4);
            var outcome = await Syncer.RunAsync(ffmpeg, video, Encoding.UTF8.GetBytes(late), "srt", "eng", false, true, CancellationToken.None, 0.4);

            Assert.True(outcome.Bytes != null, outcome.Said);
            Assert.True(asIs.Bytes != null, asIs.Said);

            // The two seconds put in come back out, whatever the file's own small lead.
            Assert.InRange(outcome.Result!.Shift - asIs.Result!.Shift, -2.1, -1.9);
            Assert.InRange(asIs.Result.Shift, -0.5, 0.5);
        }

        [Fact]
        public async Task A_video_with_nothing_to_line_up_against_gives_no_file()
        {
            var dir = Scratch();
            var video = Path.Combine(dir, "silent.mkv");
            Run("ffmpeg", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "anullsrc=r=16000:cl=mono", "-t", "60", "-c:a", "flac", video);

            var outcome = await Syncer.RunAsync(new Ffmpeg("ffmpeg", "ffprobe"), video, Encoding.UTF8.GetBytes(Srts(RandomCues(60, 4), 0)), "srt", "eng", true, true, CancellationToken.None);

            Assert.Null(outcome.Bytes);
            Assert.Contains("no text subtitle in the video", outcome.Said, StringComparison.Ordinal);
        }

        [Fact]
        public async Task A_failing_ffmpeg_is_an_error_not_a_quiet_nothing()
        {
            await Assert.ThrowsAsync<IOException>(() => Syncer.RunAsync(
                new Ffmpeg("ffmpeg", "ffprobe"), "/no/such/video.mkv", Encoding.UTF8.GetBytes(Srt), "srt", "eng", true, true, CancellationToken.None));
        }

        [Fact]
        public void A_track_titled_forced_is_never_the_reference_and_the_language_comes_first()
        {
            var info = Ffmpeg.ParseProbe(Encoding.UTF8.GetBytes(
                "{\"format\":{\"duration\":\"100.5\"},\"streams\":["
                + "{\"index\":0,\"codec_type\":\"audio\",\"codec_name\":\"eac3\",\"channels\":6,\"disposition\":{\"default\":1}},"
                + "{\"index\":1,\"codec_type\":\"subtitle\",\"codec_name\":\"subrip\",\"tags\":{\"language\":\"eng\",\"title\":\"English (Forced)\"}},"
                + "{\"index\":2,\"codec_type\":\"subtitle\",\"codec_name\":\"hdmv_pgs_subtitle\",\"tags\":{\"language\":\"eng\"}},"
                + "{\"index\":3,\"codec_type\":\"subtitle\",\"codec_name\":\"subrip\",\"tags\":{\"language\":\"spa\"},\"disposition\":{\"default\":1}},"
                + "{\"index\":4,\"codec_type\":\"subtitle\",\"codec_name\":\"subrip\",\"tags\":{\"language\":\"eng\"}}]}"));

            Assert.Equal(100.5, info.Duration);
            Assert.Equal(6, Syncer.AudioTrack(info)!.Channels);
            Assert.Equal(new[] { 4, 3 }, Syncer.ReferenceTracks(info, "en").Select(s => s.Index));
        }

        [Fact]
        public void Arguments_survive_quoting()
        {
            Assert.Equal("plain", Ffmpeg.Quote("plain"));
            Assert.Equal("\"a b\"", Ffmpeg.Quote("a b"));
            Assert.Equal("\"say \\\"hi\\\"\"", Ffmpeg.Quote("say \"hi\""));
            Assert.Equal("\"c:\\dir with space\\\\\"", Ffmpeg.Quote("c:\\dir with space\\"));
            Assert.Equal("\"\"", Ffmpeg.Quote(string.Empty));
        }

        /// <summary>Cues of 1 to 4 s with gaps of 0.3 to 6 s, the same for the same seed.</summary>
        private static List<Cue> RandomCues(double seconds, int seed)
        {
            var random = new Random(seed);
            var cues = new List<Cue>();
            for (var t = 5 + random.NextDouble(); t < seconds - 5;)
            {
                var length = 1 + (random.NextDouble() * 3);
                cues.Add(new Cue(Math.Round(t, 3), Math.Round(t + length, 3), "Line " + cues.Count));
                t += length + 0.3 + (random.NextDouble() * 5.7);
            }

            return cues;
        }

        private static string Srts(IEnumerable<Cue> cues, double shift) =>
            string.Concat(cues.Select((c, i) => $"{i + 1}\n{SubtitleDoc.FormatSrtTime(c.Start + shift)} --> {SubtitleDoc.FormatSrtTime(c.End + shift)}\n{c.Text}\n\n"));

        private static int CountOf(string text, string part) => (text.Length - text.Replace(part, string.Empty).Length) / part.Length;

        private static string Scratch()
        {
            var dir = Path.Combine(Path.GetTempPath(), "tsdb-sync-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(dir);
            return dir;
        }

        private static void Run(string program, params string[] args)
        {
            var info = new ProcessStartInfo(program) { UseShellExecute = false, RedirectStandardError = true };
            foreach (var a in args)
            {
                info.ArgumentList.Add(a);
            }

            using var p = Process.Start(info)!;
            var err = p.StandardError.ReadToEnd();
            p.WaitForExit();
            Assert.True(p.ExitCode == 0, program + ": " + err);
        }
    }
}
