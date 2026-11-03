using System;
using System.IO;
using System.Numerics;

namespace SubtitleDb.Core.Sync
{
    /// <summary>
    /// Silero VAD v5, the 16 kHz network, in plain C#: the chance of speech in each
    /// 32 ms of audio. Written out rather than run through ONNX Runtime, whose native
    /// library is 47 MB for each platform a server might run on. The weights are the
    /// model's own, taken out by tools/silero-weights.py, and the tests hold the
    /// output to ONNX Runtime's.
    /// Silero VAD is MIT, (c) Silero Team, https://github.com/snakers4/silero-vad.
    /// </summary>
    public sealed class Silero
    {
        /// <summary>The rate the audio must be at.</summary>
        public const int SampleRate = 16000;

        /// <summary>Samples per answer, 32 ms.</summary>
        public const int Chunk = 512;

        private const int Context = 64;
        private const int Hidden = 128;

        private static readonly Lazy<Weights> Model = new Lazy<Weights>(Weights.Load);

        private readonly Weights _w = Model.Value;
        private readonly float[] _x = new float[Context + Chunk + Context];
        private readonly float[] _spec = new float[258];
        private readonly float[] _mag = new float[4 * 129];
        private readonly float[] _e0 = new float[4 * 128];
        private readonly float[] _e1 = new float[2 * 64];
        private readonly float[] _e2 = new float[64];
        private readonly float[] _e3 = new float[128];
        private readonly float[] _gates = new float[4 * Hidden];
        private readonly float[] _h = new float[Hidden];
        private readonly float[] _c = new float[Hidden];

        /// <summary>
        /// The chance of speech in each <see cref="Chunk"/> of <paramref name="pcm"/>,
        /// mono at <see cref="SampleRate"/>, from a fresh state. A partial last chunk
        /// is left out.
        /// </summary>
        public static float[] Probabilities(float[] pcm)
        {
            var net = new Silero();
            var probs = new float[pcm.Length / Chunk];
            for (var k = 0; k < probs.Length; k++)
            {
                probs[k] = net.Step(pcm, k * Chunk);
            }

            return probs;
        }

        /// <summary>The chance of speech in the <see cref="Chunk"/> samples at <paramref name="offset"/>.</summary>
        public float Step(float[] pcm, int offset)
        {
            var x = _x;
            Array.Copy(pcm, offset, x, Context, Chunk);

            // Reflected on the right by 64, as the model's STFT pads.
            for (var j = 0; j < Context; j++)
            {
                x[Context + Chunk + j] = x[Context + Chunk - 2 - j];
            }

            // Four frames of 256, hop 128: rows 0-128 real, 129-257 imaginary.
            for (var f = 0; f < 4; f++)
            {
                for (var r = 0; r < 258; r++)
                {
                    _spec[r] = Dot(_w.Basis, r * 256, x, f * 128, 256);
                }

                for (var k = 0; k < 129; k++)
                {
                    _mag[(f * 129) + k] = (float)Math.Sqrt((_spec[k] * _spec[k]) + (_spec[129 + k] * _spec[129 + k]));
                }
            }

            Conv(_mag, 4, 129, _w.Enc0, _w.Enc0Bias, 1, _e0);
            Conv(_e0, 4, 128, _w.Enc1, _w.Enc1Bias, 2, _e1);
            Conv(_e1, 2, 64, _w.Enc2, _w.Enc2Bias, 2, _e2);
            Conv(_e2, 1, 64, _w.Enc3, _w.Enc3Bias, 1, _e3);

            // LSTM cell, gates in PyTorch's order: input, forget, cell, output.
            for (var r = 0; r < 4 * Hidden; r++)
            {
                _gates[r] = Dot(_w.Ih, r * Hidden, _e3, 0, Hidden) + Dot(_w.Hh, r * Hidden, _h, 0, Hidden) + _w.GateBias[r];
            }

            var p = _w.OutBias;
            for (var i = 0; i < Hidden; i++)
            {
                var c = (Sigmoid(_gates[Hidden + i]) * _c[i]) + (Sigmoid(_gates[i]) * (float)Math.Tanh(_gates[(2 * Hidden) + i]));
                var h = Sigmoid(_gates[(3 * Hidden) + i]) * (float)Math.Tanh(c);
                _c[i] = c;
                _h[i] = h;
                p += Math.Max(h, 0) * _w.Out[i];
            }

            // The last 64 samples lead the next chunk.
            Array.Copy(x, Chunk, x, 0, Context);
            return Sigmoid(p);
        }

        /// <summary>Kernel 3, padding 1, then ReLU. Time-major: <c>x[t * cin + i]</c>.</summary>
        private static void Conv(float[] x, int t, int cin, float[] w, float[] b, int stride, float[] y)
        {
            var cout = b.Length;
            var tout = ((t - 1) / stride) + 1;
            for (var o = 0; o < tout; o++)
            {
                for (var co = 0; co < cout; co++)
                {
                    var s = b[co];
                    for (var k = 0; k < 3; k++)
                    {
                        var src = (o * stride) + k - 1;
                        if (src >= 0 && src < t)
                        {
                            s += Dot(w, ((co * 3) + k) * cin, x, src * cin, cin);
                        }
                    }

                    y[(o * cout) + co] = Math.Max(s, 0);
                }
            }
        }

        private static float Dot(float[] a, int ao, float[] b, int bo, int n)
        {
            var i = 0;
            var s = 0f;
            var width = Vector<float>.Count;
            if (Vector.IsHardwareAccelerated && n >= width)
            {
                var acc = Vector<float>.Zero;
                for (; i <= n - width; i += width)
                {
                    acc += new Vector<float>(a, ao + i) * new Vector<float>(b, bo + i);
                }

                s = Vector.Dot(acc, Vector<float>.One);
            }

            for (; i < n; i++)
            {
                s += a[ao + i] * b[bo + i];
            }

            return s;
        }

        private static float Sigmoid(float z) => 1f / (1f + (float)Math.Exp(-z));

        private sealed class Weights
        {
            public float[] Basis = Array.Empty<float>();
            public float[] Enc0 = Array.Empty<float>();
            public float[] Enc0Bias = Array.Empty<float>();
            public float[] Enc1 = Array.Empty<float>();
            public float[] Enc1Bias = Array.Empty<float>();
            public float[] Enc2 = Array.Empty<float>();
            public float[] Enc2Bias = Array.Empty<float>();
            public float[] Enc3 = Array.Empty<float>();
            public float[] Enc3Bias = Array.Empty<float>();
            public float[] Ih = Array.Empty<float>();
            public float[] Hh = Array.Empty<float>();
            public float[] GateBias = Array.Empty<float>();
            public float[] Out = Array.Empty<float>();
            public float OutBias;

            public static Weights Load()
            {
                using var stream = typeof(Silero).Assembly.GetManifestResourceStream("SubtitleDb.Core.Sync.silero_v5_16k.bin")
                    ?? throw new InvalidOperationException("The Silero weights are missing from the assembly.");
                using var reader = new BinaryReader(stream);
                if (new string(reader.ReadChars(4)) != "SLR5")
                {
                    throw new InvalidDataException("The Silero weights are not v5.");
                }

                float[] Read(int n)
                {
                    var bytes = reader.ReadBytes(n * 4);
                    if (bytes.Length != n * 4)
                    {
                        throw new InvalidDataException("The Silero weights are cut short.");
                    }

                    var a = new float[n];
                    Buffer.BlockCopy(bytes, 0, a, 0, bytes.Length);
                    return a;
                }

                // Conv weights come as [out][in][3]; each output's taps are stored
                // [3][in] so a tap is one run over the input channels.
                float[] Taps(int cout, int cin)
                {
                    var src = Read(cout * cin * 3);
                    var dst = new float[src.Length];
                    for (var o = 0; o < cout; o++)
                    {
                        for (var i = 0; i < cin; i++)
                        {
                            for (var k = 0; k < 3; k++)
                            {
                                dst[(((o * 3) + k) * cin) + i] = src[(((o * cin) + i) * 3) + k];
                            }
                        }
                    }

                    return dst;
                }

                var w = new Weights { Basis = Read(258 * 256) };
                w.Enc0 = Taps(128, 129);
                w.Enc0Bias = Read(128);
                w.Enc1 = Taps(64, 128);
                w.Enc1Bias = Read(64);
                w.Enc2 = Taps(64, 64);
                w.Enc2Bias = Read(64);
                w.Enc3 = Taps(128, 64);
                w.Enc3Bias = Read(128);
                w.Ih = Read(4 * Hidden * Hidden);
                w.Hh = Read(4 * Hidden * Hidden);
                var bih = Read(4 * Hidden);
                var bhh = Read(4 * Hidden);
                w.GateBias = new float[4 * Hidden];
                for (var r = 0; r < bih.Length; r++)
                {
                    w.GateBias[r] = bih[r] + bhh[r];
                }

                w.Out = Read(Hidden);
                w.OutBias = Read(1)[0];
                if (stream.Position != stream.Length)
                {
                    throw new InvalidDataException("The Silero weights run long.");
                }

                return w;
            }
        }
    }
}
