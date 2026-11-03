using System;
using System.Collections.Concurrent;

namespace SubtitleDb.Core.Sync
{
    /// <summary>
    /// Radix-2 complex FFT and the cross-correlation built on it, as in
    /// subtitledb-sync's fft.ts. Tables are kept per size, since the aligner runs the
    /// same size once for each speed it tries.
    /// </summary>
    internal static class Fft
    {
        private static readonly ConcurrentDictionary<int, (double[] Cos, double[] Sin, int[] Rev)> Tables =
            new ConcurrentDictionary<int, (double[] Cos, double[] Sin, int[] Rev)>();

        public static int NextPow2(int n)
        {
            var p = 1;
            while (p < n)
            {
                p <<= 1;
            }

            return Math.Max(2, p);
        }

        public static void Transform(double[] re, double[] im, bool inverse)
        {
            var n = re.Length;
            if (n != im.Length || (n & (n - 1)) != 0)
            {
                throw new ArgumentException($"FFT length {n} is not a power of two.");
            }

            var (cos, sin, rev) = Tables.GetOrAdd(n, Build);
            for (var i = 0; i < n; i++)
            {
                var j = rev[i];
                if (j > i)
                {
                    (re[i], re[j]) = (re[j], re[i]);
                    (im[i], im[j]) = (im[j], im[i]);
                }
            }

            for (var size = 2; size <= n; size <<= 1)
            {
                var half = size >> 1;
                var step = n / size;
                for (var start = 0; start < n; start += size)
                {
                    for (int k = 0, tw = 0; k < half; k++, tw += step)
                    {
                        var wr = cos[tw];
                        var wi = inverse ? -sin[tw] : sin[tw];
                        var a = start + k;
                        var b = a + half;
                        var xr = (re[b] * wr) - (im[b] * wi);
                        var xi = (re[b] * wi) + (im[b] * wr);
                        re[b] = re[a] - xr;
                        im[b] = im[a] - xi;
                        re[a] += xr;
                        im[a] += xi;
                    }
                }
            }

            if (inverse)
            {
                for (var i = 0; i < n; i++)
                {
                    re[i] /= n;
                    im[i] /= n;
                }
            }
        }

        /// <summary>
        /// c[k] = sum over t of a[t] * b[k + t]. Both are real, so they share one
        /// forward transform. Entries past b.Length - a.Length wrap and mean nothing.
        /// </summary>
        public static double[] Xcorr(double[] a, double[] b)
        {
            var n = NextPow2(a.Length + b.Length);
            var re = new double[n];
            var im = new double[n];
            Array.Copy(a, re, a.Length);
            Array.Copy(b, im, b.Length);
            Transform(re, im, false);
            var pr = new double[n];
            var pi = new double[n];
            var mask = n - 1;
            for (var k = 0; k < n; k++)
            {
                var j = (n - k) & mask;
                var ar = (re[k] + re[j]) / 2;
                var ai = (im[k] - im[j]) / 2;
                var br = (im[k] + im[j]) / 2;
                var bi = (re[j] - re[k]) / 2;

                // conj(A) * B
                pr[k] = (ar * br) + (ai * bi);
                pi[k] = (ar * bi) - (ai * br);
            }

            Transform(pr, pi, true);
            return pr;
        }

        private static (double[] Cos, double[] Sin, int[] Rev) Build(int n)
        {
            var half = n >> 1;
            var cos = new double[half];
            var sin = new double[half];
            for (var i = 0; i < half; i++)
            {
                var a = -2 * Math.PI * i / n;
                cos[i] = Math.Cos(a);
                sin[i] = Math.Sin(a);
            }

            var rev = new int[n];
            var bits = 0;
            while ((1 << bits) < n)
            {
                bits++;
            }

            for (var i = 0; i < n; i++)
            {
                var r = 0;
                var x = i;
                for (var b = 0; b < bits; b++)
                {
                    r = (r << 1) | (x & 1);
                    x >>= 1;
                }

                rev[i] = r;
            }

            return (cos, sin, rev);
        }
    }
}
