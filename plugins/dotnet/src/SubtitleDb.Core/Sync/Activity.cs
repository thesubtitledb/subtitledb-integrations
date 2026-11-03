using System;
using System.Collections.Generic;

namespace SubtitleDb.Core.Sync
{
    /// <summary>A stretch of on/off activity: speech from the audio, or another track's cues.</summary>
    public sealed class Window
    {
        public Window(float[] activity, double start)
        {
            Activity = activity;
            Start = start;
        }

        /// <summary>Activity at <see cref="Signals.Rate"/> Hz, 0 to 1.</summary>
        public float[] Activity { get; }

        /// <summary>Media time in seconds of <c>Activity[0]</c>.</summary>
        public double Start { get; }
    }

    /// <summary>Activity signals, as in subtitledb-sync's signal.ts.</summary>
    public static class Signals
    {
        /// <summary>Frames per second of every activity signal: a 10 ms hop.</summary>
        public const int Rate = 100;

        /// <summary>
        /// Cues as an on/off signal at <paramref name="rate"/> Hz, times stretched by
        /// <paramref name="scale"/> first. Overlapping cues merge.
        /// </summary>
        public static float[] FromCues(IReadOnlyList<Cue> cues, double rate, int? length = null, double scale = 1)
        {
            var end = 0d;
            foreach (var c in cues)
            {
                end = Math.Max(end, c.End);
            }

            var len = Math.Max(0, length ?? ((int)Math.Ceiling(end * scale * rate) + 1));
            var o = new float[len];
            foreach (var c in cues)
            {
                var a = Math.Max(0, Round(c.Start * scale * rate));
                var b = Math.Min(len, Round(c.End * scale * rate));
                for (var i = a; i < b; i++)
                {
                    o[i] = 1;
                }
            }

            return o;
        }

        /// <summary>
        /// Silero's answers, one per 32 ms chunk, held over the 10 ms frames they cover.
        /// <paramref name="samples"/> is the audio's length in samples.
        /// </summary>
        public static float[] FromSpeech(float[] probs, int samples)
        {
            var frames = samples / (Silero.SampleRate / Rate);
            var act = new float[probs.Length == 0 ? 0 : frames];
            for (var i = 0; i < act.Length; i++)
            {
                act[i] = probs[Math.Min(probs.Length - 1, i * (Silero.SampleRate / Rate) / Silero.Chunk)];
            }

            return act;
        }

        /// <summary>Cue starts in [from, to) seconds once mapped through scale and shift.</summary>
        public static int OnsetsBetween(IReadOnlyList<Cue> cues, double scale, double shift, double from, double to)
        {
            var n = 0;
            foreach (var c in cues)
            {
                var t = (c.Start * scale) + shift;
                if (t >= from && t < to)
                {
                    n++;
                }
            }

            return n;
        }

        /// <summary>Box-average downsample by <paramref name="k"/>.</summary>
        public static float[] Decimate(float[] x, int k)
        {
            var o = new float[x.Length / k];
            for (var i = 0; i < o.Length; i++)
            {
                var s = 0f;
                for (var j = 0; j < k; j++)
                {
                    s += x[(i * k) + j];
                }

                o[i] = s / k;
            }

            return o;
        }

        /// <summary>JavaScript's Math.round, half up, so the port lands on the same frames.</summary>
        internal static int Round(double x) => (int)Math.Floor(x + 0.5);

        internal static long RoundLong(double x) => (long)Math.Floor(x + 0.5);
    }
}
