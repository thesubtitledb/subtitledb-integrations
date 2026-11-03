using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace SubtitleDb.Core.Sync
{
    /// <summary>What a sync did.</summary>
    public sealed class SyncOutcome
    {
        /// <summary>The re-timed subtitle, or null when it could not be synced.</summary>
        public byte[]? Bytes { get; set; }

        /// <summary>What it was lined up against, or why it was not.</summary>
        public string Said { get; set; } = string.Empty;

        public AlignResult? Result { get; set; }
    }

    /// <summary>
    /// The SYNCED track: a copy of a downloaded subtitle, marked while it waits, then
    /// lined up against a text subtitle inside the video or against its speech.
    /// </summary>
    public static class Syncer
    {
        /// <summary>At the start of every cue until the sync is done.</summary>
        public const string Marker = "(syncing) ";

        /// <summary>The track's title in the host's subtitle list, from its file name.</summary>
        public const string Title = "SYNCED - TSDb";

        /// <summary>0.5 and over was never more than 300 ms off on subtitledb-sync's bench.</summary>
        public const double MinConfidence = 0.5;

        /// <summary>Seconds of audio per sample, and how many.</summary>
        public const double SampleSeconds = 120;

        public const int Samples = 4;

        /// <summary>A reference track with fewer cues says too little to line up against.</summary>
        public const int MinReferenceCues = 20;

        /// <summary>
        /// A reference track is read from the start up to this many cues, and never past
        /// <see cref="ReferenceSeconds"/> of the video: enough to find the shift, a few
        /// seconds of reading on any file.
        /// </summary>
        public const int ReferenceCues = 50;

        public const double ReferenceSeconds = 900;

        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);

        /// <summary><c>video.SYNCED - TSDb.eng.srt</c> in <paramref name="folder"/>.</summary>
        public static string PathFor(string folder, string video, string language, string extension) =>
            Path.Combine(folder, Path.GetFileNameWithoutExtension(video) + "." + Title + "." + language + "." + extension.TrimStart('.').ToLowerInvariant());

        /// <summary>The subtitle with <see cref="Marker"/> at the start of every cue, in its own encoding.</summary>
        public static byte[] Marked(byte[] subtitle, string extension)
        {
            var (text, encoding) = Decode(subtitle);
            return encoding.GetBytes(SubtitleDoc.Parse(text, extension).Prefix(Marker).Stringify());
        }

        /// <summary>
        /// UTF-16 by its BOM, UTF-8 when it decodes as UTF-8, else Latin-1, which takes
        /// any byte and gives it back unchanged on the way out.
        /// </summary>
        public static (string Text, Encoding Encoding) Decode(byte[] bytes)
        {
            if (bytes.Length >= 2 && ((bytes[0] == 0xFF && bytes[1] == 0xFE) || (bytes[0] == 0xFE && bytes[1] == 0xFF)))
            {
                var utf16 = bytes[0] == 0xFF ? Encoding.Unicode : Encoding.BigEndianUnicode;
                return (utf16.GetString(bytes), utf16);
            }

            try
            {
                return (StrictUtf8.GetString(bytes), StrictUtf8);
            }
            catch (DecoderFallbackException)
            {
                var latin1 = Encoding.GetEncoding(28591);
                return (latin1.GetString(bytes), latin1);
            }
        }

        /// <summary>
        /// Where the audio samples start: the ends of the middle 90% first, then the
        /// points between, as subtitledb-sync's samplePoints.
        /// </summary>
        public static double[] SampleStarts(double duration, int samples, double seconds)
        {
            var n = Math.Max(1, samples);
            var first = duration * 0.05;
            var span = Math.Max(0, (duration * 0.9) - seconds);
            double At(int i) => first + (n == 1 ? 0 : span * i / (n - 1));
            if (n <= 2)
            {
                return Enumerable.Range(0, n).Select(At).ToArray();
            }

            var order = new List<int> { 0, n - 1 };
            var queue = new Queue<(int Lo, int Hi)>();
            queue.Enqueue((0, n - 1));
            while (queue.Count > 0)
            {
                var (lo, hi) = queue.Dequeue();
                var mid = (lo + hi) >> 1;
                if (mid == lo || mid == hi)
                {
                    continue;
                }

                order.Add(mid);
                queue.Enqueue((lo, mid));
                queue.Enqueue((mid, hi));
            }

            return order.Select(At).ToArray();
        }

        /// <summary>
        /// Text subtitle streams to line up against, best first: not forced, in
        /// <paramref name="language"/> first, then the default.
        /// </summary>
        public static IReadOnlyList<ProbeStream> ReferenceTracks(MediaInfo info, string? language) =>
            info.Streams
                .Where(s => s.Type == "subtitle" && !s.IsForced && Ffmpeg.TextCodecs.Contains(s.Codec))
                .OrderByDescending(s => language != null && string.Equals(Languages.ToAlpha3(s.Language), Languages.ToAlpha3(language), StringComparison.OrdinalIgnoreCase))
                .ThenByDescending(s => s.IsDefault)
                .ToList();

        /// <summary>
        /// Reference tracks read at most: each read goes through the whole file, and a
        /// second one only matters when the first is a forced track nobody flagged.
        /// </summary>
        public const int MaxReferenceTracks = 2;

        /// <summary>The default audio stream, else the first.</summary>
        public static ProbeStream? AudioTrack(MediaInfo info) =>
            info.Streams.Where(s => s.Type == "audio").OrderByDescending(s => s.IsDefault).FirstOrDefault();

        /// <summary>
        /// Lines <paramref name="subtitle"/> up with <paramref name="video"/>: against a
        /// text subtitle inside it when <paramref name="withTracks"/>, then against its
        /// speech when <paramref name="withAudio"/>. Bytes is null when neither was sure.
        /// </summary>
        public static async Task<SyncOutcome> RunAsync(
            Ffmpeg ffmpeg,
            string video,
            byte[] subtitle,
            string extension,
            string? language,
            bool withTracks,
            bool withAudio,
            CancellationToken cancellationToken,
            double minConfidence = MinConfidence)
        {
            var (text, encoding) = Decode(subtitle);
            var doc = SubtitleDoc.Parse(text, extension);
            if (doc.Cues.Count == 0)
            {
                return new SyncOutcome { Said = "the subtitle has no cues" };
            }

            var info = await ffmpeg.ProbeAsync(video, cancellationToken).ConfigureAwait(false);
            var said = new List<string>();

            if (withTracks)
            {
                var tracks = ReferenceTracks(info, language);
                if (tracks.Count == 0)
                {
                    said.Add("no text subtitle in the video");
                }

                foreach (var track in tracks.Take(MaxReferenceTracks))
                {
                    var srt = await ffmpeg.SubtitleAsync(video, track, ReferenceCues, ReferenceSeconds, cancellationToken).ConfigureAwait(false);
                    var cues = SubtitleDoc.Parse(srt, "srt").Cues.Take(ReferenceCues).ToList();
                    var against = "subtitle stream " + track.Index + (track.Language != null ? " (" + track.Language + ")" : string.Empty);
                    if (cues.Count < MinReferenceCues)
                    {
                        said.Add(against + " has " + cues.Count + " cues");
                        continue;
                    }

                    var windows = new[] { new Window(Signals.FromCues(cues, Signals.Rate), 0) };
                    var result = Aligner.Align(windows, doc.Cues, new AlignOptions { Lead = 0 });
                    if (Sure(result, minConfidence))
                    {
                        return Done(doc, encoding, result!, against);
                    }

                    said.Add(against + Unsure(result));
                }
            }

            if (withAudio)
            {
                var audio = AudioTrack(info);
                if (audio == null || info.Duration <= 0)
                {
                    said.Add("no audio");
                }
                else
                {
                    var seconds = Math.Min(SampleSeconds, info.Duration);
                    var starts = info.Duration < SampleSeconds * 2 ? new[] { 0d } : SampleStarts(info.Duration, Samples, seconds);
                    var windows = new List<Window>();
                    foreach (var start in starts)
                    {
                        var pcm = await ffmpeg.AudioAsync(video, audio, start, seconds, cancellationToken).ConfigureAwait(false);
                        cancellationToken.ThrowIfCancellationRequested();
                        windows.Add(new Window(Signals.FromSpeech(Silero.Probabilities(pcm), pcm.Length), start));
                    }

                    var result = Aligner.Align(windows, doc.Cues);
                    if (Sure(result, minConfidence))
                    {
                        return Done(doc, encoding, result!, "the audio");
                    }

                    said.Add("the audio" + Unsure(result));
                }
            }

            return new SyncOutcome { Said = string.Join(", ", said) };
        }

        private static bool Sure(AlignResult? result, double min) => result != null && result.Confidence >= min;

        private static string Unsure(AlignResult? result) =>
            result == null ? " matched nowhere" : " matched with confidence " + result.Confidence.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture);

        private static SyncOutcome Done(SubtitleDoc doc, Encoding encoding, AlignResult result, string against) =>
            new SyncOutcome
            {
                Bytes = encoding.GetBytes(doc.Retime(result.Map).Stringify()),
                Result = result,
                Said = string.Format(
                    System.Globalization.CultureInfo.InvariantCulture,
                    "lined up against {0}: shift {1:0.000} s, speed {2:0.00000}, confidence {3:0.00}",
                    against,
                    result.Shift,
                    result.Scale,
                    result.Confidence),
            };
    }
}
