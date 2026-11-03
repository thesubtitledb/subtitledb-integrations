using System;
using System.IO;

namespace SubtitleDb.Tests
{
    /// <summary>The Sintel clips under packages/subbot/test/media, shared with SubBot's tests.</summary>
    internal static class Media
    {
        public static string Path(string name)
        {
            for (var dir = new DirectoryInfo(AppContext.BaseDirectory); dir != null; dir = dir.Parent)
            {
                var candidate = System.IO.Path.Combine(dir.FullName, "packages", "subbot", "test", "media", name);
                if (File.Exists(candidate))
                {
                    return candidate;
                }
            }

            throw new FileNotFoundException("Not found above the test assembly.", name);
        }

        /// <summary>16-bit little-endian mono, as floats in [-1, 1).</summary>
        public static float[] Pcm(string name)
        {
            var bytes = File.ReadAllBytes(Path(name));
            var pcm = new float[bytes.Length / 2];
            for (var i = 0; i < pcm.Length; i++)
            {
                pcm[i] = (short)(bytes[2 * i] | (bytes[(2 * i) + 1] << 8)) / 32768f;
            }

            return pcm;
        }
    }
}
