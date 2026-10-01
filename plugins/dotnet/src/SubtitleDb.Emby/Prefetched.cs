using System;
using System.Collections.Concurrent;

namespace SubtitleDb.Emby
{
    /// <summary>
    /// A subtitle the lookup on play has fetched, held while Emby saves it.
    /// </summary>
    /// <remarks>
    /// Emby saves a subtitle only by asking the provider for it again, and each ask
    /// is a download. The lookup holds the bytes it already has for that one save.
    /// </remarks>
    internal static class Prefetched
    {
        private static readonly ConcurrentDictionary<string, byte[]> Held = new ConcurrentDictionary<string, byte[]>();

        /// <summary>Holds <paramref name="bytes"/> for <paramref name="id"/> until disposed.</summary>
        public static IDisposable Hold(string id, byte[] bytes)
        {
            var key = Bare(id);
            Held[key] = bytes;
            return new Release(key);
        }

        /// <summary>The bytes held for <paramref name="id"/>, once, or null.</summary>
        public static byte[]? Take(string id)
        {
            return Held.TryRemove(Bare(id), out var bytes) ? bytes : null;
        }

        /// <summary>
        /// The provider's own id. Emby's subtitle manager puts a key for the provider
        /// and an underscore in front of it, and takes them off before asking.
        /// </summary>
        internal static string Bare(string id)
        {
            var cut = id.IndexOf('_');
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
