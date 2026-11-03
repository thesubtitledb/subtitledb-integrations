using System;
using System.Collections.Generic;
using System.Linq;

namespace SubtitleDb.Core.Sync
{
    /// <summary>Settings for <see cref="Aligner.Align"/>. The defaults are subtitledb-sync's, from its bench.</summary>
    public sealed class AlignOptions
    {
        /// <summary>Common framerate conversions: 1, 25/23.976, 24/25 and their kin.</summary>
        public static readonly double[] FpsScales =
        {
            1, 25 / 23.976, 23.976 / 25, 24 / 25.0, 25 / 24.0, 24 / 23.976, 23.976 / 24, 25 / 29.97, 29.97 / 25,
        };

        /// <summary>What a short window can tell apart.</summary>
        public static readonly double[] ShortScales = { 1, 25 / 23.976, 23.976 / 25 };

        /// <summary>Corpus median of how far cues lead the speech they caption, in seconds.</summary>
        public const double DefaultLead = 0.09;

        public double[] Scales { get; set; } = FpsScales;

        public double[] ShortWindowScales { get; set; } = ShortScales;

        /// <summary>Seconds below which a window counts as short.</summary>
        public double ShortWindow { get; set; } = 150;

        /// <summary>Decimation for the coarse search: 5 is 20 Hz.</summary>
        public int Coarse { get; set; } = 5;

        /// <summary>Fraction of the window that must overlap the subtitle span.</summary>
        public double MinCover { get; set; } = 0.5;

        /// <summary>Seconds around the peak left out when looking for the runner-up.</summary>
        public double Exclusion { get; set; } = 3;

        /// <summary>Bound on |shift| in seconds; none when null.</summary>
        public double? MaxShift { get; set; }

        /// <summary>Windows shorter than this, in seconds, are ignored.</summary>
        public double MinWindow { get; set; } = 8;

        /// <summary>Seconds per chunk of the drift fit.</summary>
        public double DriftChunk { get; set; } = 180;

        /// <summary>
        /// Taken off the shift so cues lead speech as people time them. Zero when the
        /// reference is another subtitle track, which is timed the same way.
        /// </summary>
        public double Lead { get; set; } = DefaultLead;
    }

    /// <summary>One window's answer.</summary>
    public sealed class WindowResult
    {
        public double Start { get; set; }

        public double Duration { get; set; }

        public double Scale { get; set; }

        public double Shift { get; set; }

        public double Score { get; set; }

        public double RunnerUp { get; set; }

        public double Z { get; set; }

        public int Onsets { get; set; }

        public double Confidence { get; set; }
    }

    /// <summary>media = Scale * subtitle + Shift, and how sure.</summary>
    public sealed class AlignResult
    {
        public double Scale { get; set; }

        public double Shift { get; set; }

        /// <summary>0 to 1; 0.5 and over is worth applying.</summary>
        public double Confidence { get; set; }

        public double Score { get; set; }

        public IReadOnlyList<WindowResult> Windows { get; set; } = Array.Empty<WindowResult>();

        /// <summary>True when the drift fit set <see cref="Scale"/>.</summary>
        public bool DriftFitted { get; set; }

        public double Map(double t) => (Scale * t) + Shift;
    }

    /// <summary>
    /// Lines cues up with an activity signal, ported from subtitledb-sync's align.ts
    /// with its constants. Each window is matched against the whole subtitle
    /// timeline by normalised cross-correlation over every lag, coarse by FFT then at
    /// the full rate; chunks of every window then go through a robust line fit that
    /// turns a slope into a speed correction. docs/algorithm.md there has the bench.
    /// </summary>
    public static class Aligner
    {
        private const int Rate = Signals.Rate;

        /// <summary>The best mapping, or null when no window could be matched at all.</summary>
        public static AlignResult? Align(IReadOnlyList<Window> windows, IReadOnlyList<Cue> cues, AlignOptions? options = null)
        {
            var o = options ?? new AlignOptions();
            if (cues.Count == 0)
            {
                return null;
            }

            var usable = windows.Where(w => (double)w.Activity.Length / Rate >= o.MinWindow).ToList();
            var results = new List<WindowResult>();
            foreach (var w in usable)
            {
                var scales = (double)w.Activity.Length / Rate < o.ShortWindow ? o.ShortWindowScales : o.Scales;
                var r = AlignWindow(w, cues, scales, o);
                if (r != null)
                {
                    results.Add(r);
                }
            }

            if (results.Count == 0)
            {
                return null;
            }

            results = results.OrderByDescending(r => r.Confidence).ThenByDescending(r => r.Score).ToList();
            var best = results[0];
            var scale = best.Scale;
            var shift = best.Shift;
            var drift = false;

            var pts = TrackChunks(usable, cues, best, o);
            if (pts.Count >= 4)
            {
                var xs = pts.Select(p => p.X).ToArray();
                var ys = pts.Select(p => p.Y).ToArray();
                var (slope, intercept) = TheilSen(xs, ys);
                var inliers = xs.Where((x, i) => Math.Abs(ys[i] - ((slope * x) + intercept)) < 0.35).Count();
                var span = xs.Max() - xs.Min();
                var agree = inliers >= 4 && (double)inliers / pts.Count >= 0.6;

                // shift(t) = intercept + slope * t in media time, and media = scale * sub + shift,
                // so media * (1 - slope) = scale * sub + intercept.
                if (agree && span > 600 && Math.Abs(slope) > 1e-4)
                {
                    scale /= 1 - slope;
                    shift = intercept / (1 - slope);
                    drift = true;
                }
                else if (agree)
                {
                    shift = ys.OrderBy(y => y).ElementAt(ys.Length >> 1);
                }
            }

            return new AlignResult
            {
                Scale = scale,
                Shift = shift - o.Lead,
                Confidence = best.Confidence,
                Score = best.Score,
                Windows = results,
                DriftFitted = drift,
            };
        }

        /// <summary>
        /// From peak height, its lead over the runner-up, its z-score and how many cues
        /// the window holds. Above 0.5 was never more than 300 ms off on the bench.
        /// </summary>
        public static double ConfidenceOf(double score, double runnerUp, double z, int onsets)
        {
            var dominance = score - Math.Max(0, runnerUp);
            var evidence = 1 - Math.Exp(-onsets / 40.0);
            var zBar = Math.Max(1.5, 3 - (2 * Math.Max(0, Math.Log(onsets / 40.0, 2))));
            var c = Sig((z - zBar) / 1.2) * Sig(dominance / 0.06) * Sig((score - 0.15) / 0.08);
            return Math.Max(0, Math.Min(1, c * (0.5 + (0.5 * evidence))));
        }

        internal static (double Slope, double Intercept) TheilSen(double[] xs, double[] ys)
        {
            var slopes = new List<double>();
            for (var i = 0; i < xs.Length; i++)
            {
                for (var j = i + 1; j < xs.Length; j++)
                {
                    if (xs[j] != xs[i])
                    {
                        slopes.Add((ys[j] - ys[i]) / (xs[j] - xs[i]));
                    }
                }
            }

            slopes.Sort();
            var slope = slopes.Count > 0 ? slopes[slopes.Count >> 1] : 0;
            var inter = xs.Select((x, i) => ys[i] - (slope * x)).OrderBy(v => v).ToList();
            return (slope, inter[inter.Count >> 1]);
        }

        private static double Sig(double x) => 1 / (1 + Math.Exp(-x));

        private static bool Beats(double a, double aScale, double b, double bScale)
        {
            // A rescaled timeline must beat the unscaled one clearly, not by noise.
            var bar = aScale != 1 && bScale == 1 ? 1.03 : aScale == 1 && bScale != 1 ? 1 / 1.03 : 1;
            return a > b * bar;
        }

        private static WindowResult? AlignWindow(Window win, IReadOnlyList<Cue> cues, double[] scales, AlignOptions o)
        {
            var cr = (double)Rate / o.Coarse;
            var aC = Signals.Decimate(win.Activity, o.Coarse);
            if (aC.Length < 4)
            {
                return null;
            }

            Candidate? best = null;
            var cands = new List<Candidate>();
            foreach (var s in scales.OrderBy(x => Math.Abs(x - 1)))
            {
                var bC = Signals.FromCues(cues, cr, null, s);
                var (ncc, wgt, pad) = NccAll(aC, bC, o.MinCover);
                var lo = 0;
                var hi = ncc.Length;
                if (o.MaxShift is double max)
                {
                    lo = (int)Math.Floor(pad + ((win.Start - max) * cr));
                    hi = (int)Math.Ceiling(pad + ((win.Start + max) * cr)) + 1;
                }

                var p = PeakInfo(ncc, wgt, Signals.Round(o.Exclusion * cr), lo, hi);
                if (p == null)
                {
                    continue;
                }

                p.Scale = s;
                p.Pad = pad;
                cands.Add(p);
                if (best == null || Beats(p.Peak, s, best.Peak, best.Scale))
                {
                    best = p;
                }
            }

            if (best == null)
            {
                return null;
            }

            // Neighbouring ratios (24/25 against 23.976/25) are 0.1% apart, closer than
            // the coarse rate separates on a short file, so any candidate within 2% of
            // the best is settled at the full rate.
            (int Lag, double Score) Fine(Candidate c)
            {
                var sub = Signals.FromCues(cues, Rate, null, c.Scale);
                var lagC = c.Idx + c.Frac - c.Pad;
                return Refine(win.Activity, sub, Signals.Round(lagC / cr * Rate), Rate);
            }

            var r = Fine(best);
            foreach (var c in cands)
            {
                if (c == best || c.Peak < best.Peak * 0.98)
                {
                    continue;
                }

                var rc = Fine(c);
                if (Beats(rc.Score, c.Scale, r.Score, best.Scale))
                {
                    best = c;
                    r = rc;
                }
            }

            var shift = win.Start - ((double)r.Lag / Rate);
            var duration = (double)win.Activity.Length / Rate;
            var onsets = Signals.OnsetsBetween(cues, best.Scale, shift, win.Start, win.Start + duration);
            return new WindowResult
            {
                Start = win.Start,
                Duration = duration,
                Scale = best.Scale,
                Shift = shift,
                Score = r.Score,
                RunnerUp = best.RunnerUp,
                Z = best.Z,
                Onsets = onsets,
                Confidence = ConfidenceOf(r.Score, best.RunnerUp, best.Z, onsets),
            };
        }

        /// <summary>
        /// Normalised cross-correlation of template <paramref name="a"/> against every
        /// window of <paramref name="b"/>, which is padded by a's length on both sides
        /// so the template may hang off either end. Lags whose overlap with the real
        /// span is under <paramref name="minCover"/> are -1.
        /// </summary>
        private static (double[] Ncc, double[] Wgt, int Pad) NccAll(float[] a, float[] b, double minCover)
        {
            var len = a.Length;
            var ma = 0d;
            foreach (var v in a)
            {
                ma += v;
            }

            ma /= len;
            var az = new double[len];
            var na = 0d;
            for (var i = 0; i < len; i++)
            {
                az[i] = a[i] - ma;
                na += az[i] * az[i];
            }

            na = Math.Sqrt(na) + 1e-9;
            var pad = len;
            var bp = new double[b.Length + (2 * pad)];
            for (var i = 0; i < b.Length; i++)
            {
                bp[pad + i] = b[i];
            }

            var c = Fft.Xcorr(az, bp);
            var ps = new double[bp.Length + 1];
            var ps2 = new double[bp.Length + 1];
            for (var i = 0; i < bp.Length; i++)
            {
                ps[i + 1] = ps[i] + bp[i];
                ps2[i + 1] = ps2[i] + (bp[i] * bp[i]);
            }

            var nl = bp.Length - len + 1;
            var ncc = new double[nl];
            var wgt = new double[nl];
            var minOv = Signals.Round(minCover * len);
            for (var k = 0; k < nl; k++)
            {
                var ov = Math.Min(k + len, pad + b.Length) - Math.Max(k, pad);
                if (ov < minOv)
                {
                    ncc[k] = -1;
                    continue;
                }

                var s = ps[k + len] - ps[k];
                var s2 = ps2[k + len] - ps2[k];
                var varb = s2 - (s * s / len);
                wgt[k] = (double)ov / len;
                ncc[k] = varb <= 1e-9 ? -1 : c[k] / (na * Math.Sqrt(varb));
            }

            return (ncc, wgt, pad);
        }

        private static Candidate? PeakInfo(double[] ncc, double[] wgt, int excl, int lo, int hi)
        {
            // The lag is picked on correlation times overlap, so a half-covered
            // coincidence cannot beat a full match; height, runner-up and z are the
            // plain correlation.
            var from = Math.Max(0, lo);
            var to = Math.Min(ncc.Length, hi);
            var bi = -1;
            for (var i = from; i < to; i++)
            {
                if (ncc[i] > -1 && (bi < 0 || ncc[i] * wgt[i] > ncc[bi] * wgt[bi]))
                {
                    bi = i;
                }
            }

            if (bi < 0)
            {
                return null;
            }

            var peak = ncc[bi];
            var frac = 0d;
            if (bi > 0 && bi < ncc.Length - 1 && ncc[bi - 1] > -1 && ncc[bi + 1] > -1)
            {
                var y0 = ncc[bi - 1];
                var y2 = ncc[bi + 1];
                var d = y0 - (2 * peak) + y2;
                if (d < 0)
                {
                    frac = 0.5 * (y0 - y2) / d;
                }
            }

            var runnerUp = -1d;
            var n = 0;
            var mean = 0d;
            var m2 = 0d;
            for (var i = from; i < to; i++)
            {
                if (ncc[i] <= -1)
                {
                    continue;
                }

                n++;
                mean += ncc[i];
                m2 += ncc[i] * ncc[i];
                if (Math.Abs(i - bi) > excl && ncc[i] > runnerUp)
                {
                    runnerUp = ncc[i];
                }
            }

            mean /= Math.Max(1, n);
            var std = Math.Sqrt(Math.Max(0, (m2 / Math.Max(1, n)) - (mean * mean))) + 1e-9;
            return new Candidate { Idx = bi, Frac = frac, Peak = peak, RunnerUp = runnerUp, Z = (peak - mean) / std };
        }

        /// <summary>Direct NCC at the full rate over lag0 plus or minus radius.</summary>
        private static (int Lag, double Score) Refine(float[] activity, float[] sub, int lag0, int radius)
        {
            var len = activity.Length;
            var ma = 0d;
            foreach (var v in activity)
            {
                ma += v;
            }

            ma /= len;
            var sa2 = 0d;
            foreach (var v in activity)
            {
                sa2 += (v - ma) * (v - ma);
            }

            var na = Math.Sqrt(sa2) + 1e-9;
            var best = -2d;
            var bestLag = lag0;
            for (var lag = lag0 - radius; lag <= lag0 + radius; lag++)
            {
                var s = 0d;
                var sb = 0d;
                var sb2 = 0d;
                var from = Math.Max(0, -lag);
                var to = Math.Min(len, sub.Length - lag);
                for (var i = from; i < to; i++)
                {
                    double b = sub[lag + i];
                    s += (activity[i] - ma) * b;
                    sb += b;
                    sb2 += b * b;
                }

                var v = s / (na * Math.Sqrt(Math.Max(1e-9, sb2 - (sb * sb / len))));
                if (v > best)
                {
                    best = v;
                    bestLag = lag;
                }
            }

            return (bestLag, best);
        }

        /// <summary>
        /// Local offsets over chunks of every window, tracked outward from the best
        /// window. Each chunk searches near its last accepted neighbour, within a
        /// radius that grows with the gap, so a real drift is followed across a file
        /// while a wrong window cannot pull the fit away.
        /// </summary>
        private static List<(double X, double Y)> TrackChunks(List<Window> windows, IReadOnlyList<Cue> cues, WindowResult best, AlignOptions o)
        {
            var cr = (double)Rate / o.Coarse;
            var sub = Signals.FromCues(cues, Rate, null, best.Scale);
            var subC = Signals.FromCues(cues, cr, null, best.Scale);
            var chunks = new List<(double Start, float[] Act)>();
            foreach (var w in windows)
            {
                var dur = (double)w.Activity.Length / Rate;
                var len = Math.Min(dur, o.DriftChunk);
                var n = Math.Max(1, (int)Math.Floor(dur / len));
                for (var i = 0; i < n; i++)
                {
                    var s = Signals.Round(i * len * Rate);
                    var e = i == n - 1 ? w.Activity.Length : Signals.Round((i + 1) * len * Rate);
                    var act = new float[e - s];
                    Array.Copy(w.Activity, s, act, 0, act.Length);
                    chunks.Add((w.Start + ((double)s / Rate), act));
                }
            }

            chunks = chunks.OrderBy(c => c.Start).ToList();
            double Centre((double Start, float[] Act) c) => c.Start + ((double)c.Act.Length / Rate / 2);
            var anchor = best.Start + (best.Duration / 2);
            var a0 = 0;
            for (var i = 1; i < chunks.Count; i++)
            {
                if (Math.Abs(Centre(chunks[i]) - anchor) < Math.Abs(Centre(chunks[a0]) - anchor))
                {
                    a0 = i;
                }
            }

            var pts = new List<(double X, double Y)>();
            (double X, double Y) Visit(int i, (double X, double Y) prev)
            {
                var c = chunks[i];
                var x = Centre(c);

                // 3 s covers a window's error, 0.5% of the gap any real drift.
                var radius = 3 + (0.005 * Math.Abs(x - prev.X));
                var coarse = Refine(Signals.Decimate(c.Act, o.Coarse), subC, Signals.Round((c.Start - prev.Y) * cr), (int)Math.Ceiling(radius * cr));
                var r = Refine(c.Act, sub, Signals.Round(coarse.Lag / cr * Rate), 2 * o.Coarse);
                var y = c.Start - ((double)r.Lag / Rate);
                var onsets = Signals.OnsetsBetween(cues, best.Scale, y, c.Start, c.Start + ((double)c.Act.Length / Rate));
                if (r.Score <= 0.2 || onsets < 4)
                {
                    return prev;
                }

                pts.Add((x, y));
                return (x, y);
            }

            var seed = Visit(a0, (anchor, best.Shift));
            var at = seed;
            for (var i = a0 + 1; i < chunks.Count; i++)
            {
                at = Visit(i, at);
            }

            at = seed;
            for (var i = a0 - 1; i >= 0; i--)
            {
                at = Visit(i, at);
            }

            return pts;
        }

        private sealed class Candidate
        {
            public int Idx;
            public double Frac;
            public double Peak;
            public double RunnerUp;
            public double Z;
            public double Scale;
            public int Pad;
        }
    }
}
