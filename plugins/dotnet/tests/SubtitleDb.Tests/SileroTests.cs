using System;
using System.Globalization;
using System.IO;
using System.Linq;
using SubtitleDb.Core.Sync;
using Xunit;

namespace SubtitleDb.Tests
{
    /// <summary>
    /// The C# network against ONNX Runtime's answers for the same audio, written by
    /// tools/silero-weights.py --golden from the 20 s of Sintel SubBot's tests use.
    /// </summary>
    public sealed class SileroTests
    {
        [Fact]
        public void Matches_onnx_runtime()
        {
            var pcm = Media.Pcm("sintel-20s.pcm");
            var golden = File.ReadAllLines(Path.Combine(AppContext.BaseDirectory, "silero-sintel-20s.txt"))
                .Select(line => float.Parse(line, CultureInfo.InvariantCulture))
                .ToArray();

            var probs = Silero.Probabilities(pcm);

            Assert.Equal(golden.Length, probs.Length);
            var worst = golden.Zip(probs, (a, b) => Math.Abs(a - b)).Max();
            Assert.True(worst < 1e-4, $"worst difference {worst}");

            // Speech and silence both, or the comparison proves little.
            Assert.Contains(golden, p => p > 0.9);
            Assert.Contains(golden, p => p < 0.1);
        }
    }
}
