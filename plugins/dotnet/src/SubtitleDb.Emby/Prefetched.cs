using System;
using System.Collections.Concurrent;
using System.IO;
using MediaBrowser.Controller.Subtitles;

namespace SubtitleDb.Emby
{
    /// <summary>
    /// A subtitle the lookup on play has fetched, held while Emby saves it.
    /// </summary>
    /// <remarks>
    /// Emby saves a subtitle only by asking the provider for it again, and each ask
    /// is a lookup and a download. The lookup holds what it already has, the file and
    /// what the provider said about it, for that one save.
    /// </remarks>
    internal static class Prefetched
    {
        private static readonly ConcurrentDictionary<string, SubtitleResponse> Held =
            new ConcurrentDictionary<string, SubtitleResponse>();

        /// <summary>
        /// Holds <paramref name="bytes"/> and the format, language and hearing-impaired
        /// flag of <paramref name="fetched"/> for <paramref name="id"/> until disposed.
        /// </summary>
        public static IDisposable Hold(string id, SubtitleResponse fetched, byte[] bytes)
        {
            var key = Bare(id);
            Held[key] = new SubtitleResponse
            {
                Format = fetched.Format,
                Language = fetched.Language,
                IsHearingImpaired = fetched.IsHearingImpaired,
                Stream = new MemoryStream(bytes),
            };
            return new Release(key);
        }

        /// <summary>The subtitle held for <paramref name="id"/>, once, or null.</summary>
        public static SubtitleResponse? Take(string id)
        {
            return Held.TryRemove(Bare(id), out var held) ? held : null;
        }

        /// <summary>
        /// The provider's own id. Emby's subtitle manager puts its key for the provider
        /// and the language in front of it, each followed by an underscore
        /// (<c>4c29aabd01ed42af4e8ee437834ff0ba_en_860400</c>), and takes them off before
        /// asking. This provider's ids are numbers, so the id is what follows the last
        /// underscore.
        /// </summary>
        internal static string Bare(string id)
        {
            var cut = id.LastIndexOf('_');
            return cut < 0 ? id : id.Substring(cut + 1);
        }

        private sealed class Release : IDisposable
        {
            private readonly string _key;

            public Release(string key)
            {
                _key = key;
            }

            public void Dispose()
            {
                Held.TryRemove(_key, out _);
            }
        }
    }
}
