using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace SubtitleDb.Core
{
    /// <summary>
    /// The lookup when a video starts playing, apart from the host: which videos to ask
    /// about, in which languages, and whether what came back is already beside the
    /// video. Each host wires its own search, fetch and save into <see cref="RunAsync"/>.
    /// </summary>
    public sealed class OnPlay
    {
        /// <summary>
        /// A video is looked up once in this long, however often it starts. Players
        /// report a new start when they switch audio or restart a transcode.
        /// </summary>
        public static readonly TimeSpan Quiet = TimeSpan.FromMinutes(10);

        private readonly Dictionary<string, DateTime> _asked = new Dictionary<string, DateTime>();

        /// <summary>True, and noted, unless <paramref name="video"/> was looked up within <see cref="Quiet"/>.</summary>
        public bool Begin(string video, DateTime now)
        {
            lock (_asked)
            {
                if (_asked.TryGetValue(video, out var at) && now - at < Quiet)
                {
                    return false;
                }

                // What has gone quiet is forgotten, so a server that runs for months
                // does not keep every video it ever played.
                foreach (var old in _asked.Where(p => now - p.Value >= Quiet).Select(p => p.Key).ToList())
                {
                    _asked.Remove(old);
                }

                _asked[video] = now;
                return true;
            }
        }

        /// <summary>The library's subtitle download languages, in its order, each once.</summary>
        public static IReadOnlyList<string> Languages(IEnumerable<string?>? configured)
        {
            return (configured ?? Enumerable.Empty<string?>())
                .Select(code => (code ?? string.Empty).Trim())
                .Where(code => code.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        /// <summary>
        /// Asks in each language in turn and saves the first match, unless the video
        /// already has a file with exactly those bytes. Other subtitles do not stop it:
        /// a video that has some still gets SubtitleDB's. Returns what it did, for the log.
        /// </summary>
        /// <param name="languages">From <see cref="Languages"/>.</param>
        /// <param name="best">The host's id for SubtitleDB's best match in a language, or null.</param>
        /// <param name="fetch">That subtitle's bytes.</param>
        /// <param name="held">The files of the subtitles the video has now.</param>
        /// <param name="save">Saves the subtitle the way the host saves one a user picked.</param>
        /// <param name="cancellationToken">Ends the lookup.</param>
        public static async Task<string> RunAsync(
            IReadOnlyList<string> languages,
            Func<string, CancellationToken, Task<string?>> best,
            Func<string, CancellationToken, Task<byte[]>> fetch,
            Func<IEnumerable<string>> held,
            Func<string, byte[], CancellationToken, Task> save,
            CancellationToken cancellationToken)
        {
            if (languages.Count == 0)
            {
                return "no subtitle download languages are set for its library";
            }

            foreach (var language in languages)
            {
                var id = await best(language, cancellationToken).ConfigureAwait(false);
                if (id == null)
                {
                    continue;
                }

                var bytes = await fetch(id, cancellationToken).ConfigureAwait(false);
                if (AlreadyHeld(held(), bytes))
                {
                    return "it already has SubtitleDB's " + language + " subtitle " + id;
                }

                await save(id, bytes, cancellationToken).ConfigureAwait(false);
                return "saved SubtitleDB's " + language + " subtitle " + id;
            }

            return "SubtitleDB has nothing for it in " + string.Join(", ", languages);
        }

        /// <summary>
        /// The files in <paramref name="folders"/> named for <paramref name="video"/>, the
        /// way a host names a subtitle it saves for it: its file name, a dot, then the
        /// language and the format. Read from the disk because the hosts' own lists of a
        /// video's streams change shape between their versions.
        /// </summary>
        public static IEnumerable<string> NamedFor(string video, params string?[] folders)
        {
            var stem = Path.GetFileNameWithoutExtension(video) + ".";
            var found = new List<string>();
            foreach (var folder in folders.Where(f => !string.IsNullOrEmpty(f)).Distinct())
            {
                try
                {
                    found.AddRange(Directory.EnumerateFiles(folder!).Where(path =>
                        Path.GetFileName(path).StartsWith(stem, StringComparison.OrdinalIgnoreCase)
                        && !string.Equals(path, video, StringComparison.Ordinal)));
                }
                catch (IOException)
                {
                    // No such folder yet, as a metadata folder is until something is saved.
                }
                catch (UnauthorizedAccessException)
                {
                }
            }

            return found;
        }

        /// <summary>True when one of <paramref name="paths"/> holds exactly <paramref name="bytes"/>.</summary>
        public static bool AlreadyHeld(IEnumerable<string> paths, byte[] bytes)
        {
            foreach (var path in paths)
            {
                try
                {
                    var file = new FileInfo(path);
                    if (file.Exists && file.Length == bytes.LongLength && Same(File.ReadAllBytes(path), bytes))
                    {
                        return true;
                    }
                }
                catch (IOException)
                {
                    // A file that cannot be read now is not this one.
                }
                catch (UnauthorizedAccessException)
                {
                }
            }

            return false;
        }

        private static bool Same(byte[] a, byte[] b)
        {
            if (a.Length != b.Length)
            {
                return false;
            }

            for (var i = 0; i < a.Length; i++)
            {
                if (a[i] != b[i])
                {
                    return false;
                }
            }

            return true;
        }
    }
}
