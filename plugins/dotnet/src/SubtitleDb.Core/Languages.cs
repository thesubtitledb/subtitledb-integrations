using System;
using System.Collections.Generic;
using System.Linq;

namespace SubtitleDb.Core
{
    /// <summary>
    /// Language codes, in every spelling the hosts hand us.
    /// </summary>
    /// <remarks>
    /// The API speaks two-letter codes with four OpenSubtitles additions (pb, ze, zt,
    /// pm) that are not ISO at all. The hosts do not: Jellyfin sends ISO639-2 and
    /// sometimes a region, Emby sends the same and occasionally the bibliographic
    /// form (ger, not deu). Brazilian Portuguese is the one that matters most: the
    /// corpus files it under pb, and a plugin that asks for pt hands a Brazilian
    /// viewer European Portuguese and looks broken.
    ///
    /// An unrecognised two-letter code passes through untouched. The corpus carries
    /// 185 distinct codes and this table names 74: resolving the rest to nothing
    /// would hide subtitles that exist, and resolving them to English would be a lie.
    /// </remarks>
    public static class Languages
    {
        private static readonly Dictionary<string, string> ByName = BuildByName();

        private static Dictionary<string, string> BuildByName()
        {
            var map = new Dictionary<string, string>();
            foreach (var pair in LanguageTables.Names)
            {
                var name = pair.Value.ToLowerInvariant();
                map[name] = pair.Key;
                // "Portuguese (Brazil)" also answers to "portuguese brazil".
                var plain = Squash(name.Replace("(", " ").Replace(")", " "));
                map[plain] = pair.Key;
            }

            return map;
        }

        private static string Squash(string value)
        {
            return string.Join(" ", value.Split(new[] { ' ', '\t', '\n', '\r' }, StringSplitOptions.RemoveEmptyEntries));
        }

        private static string Normalise(string value)
        {
            return Squash(value.Trim().ToLowerInvariant().Replace('_', '-'));
        }

        /// <summary>Resolve any spelling of a language to the code the API uses.</summary>
        /// <returns>null for an empty or unresolvable value.</returns>
        public static string? ToCode(string? value)
        {
            if (string.IsNullOrWhiteSpace(value))
            {
                return null;
            }

            var v = Normalise(value!);
            if (v.Length == 0)
            {
                return null;
            }

            if (LanguageTables.Names.ContainsKey(v))
            {
                return v;
            }

            if (LanguageTables.Aliases.TryGetValue(v, out var alias))
            {
                return alias;
            }

            if (LanguageTables.Alpha3.TryGetValue(v, out var alpha3))
            {
                return alpha3;
            }

            if (ByName.TryGetValue(v, out var named))
            {
                return named;
            }

            // A region we have no rule for: keep the base language.
            var dash = v.IndexOf('-');
            if (dash > 0)
            {
                return ToCode(v.Substring(0, dash));
            }

            // "Chinese (traditional)" arriving as "chinese traditional".
            var plain = Squash(v.Replace("(", " ").Replace(")", " "));
            if (!string.Equals(plain, v, StringComparison.Ordinal))
            {
                return ToCode(plain);
            }

            return v.Length == 2 && v.All(char.IsLetter) ? v : null;
        }

        /// <summary>Display name for a code, falling back to the code in capitals.</summary>
        public static string? Name(string? code)
        {
            if (string.IsNullOrWhiteSpace(code))
            {
                return null;
            }

            var key = code!.Trim().ToLowerInvariant();
            return LanguageTables.Names.TryGetValue(key, out var name) ? name : key.ToUpperInvariant();
        }

        /// <summary>
        /// The three-letter form a host expects back. Jellyfin and Emby both label a
        /// result by its ISO639-2 code, and the one they show is the one they asked
        /// with, so an unmapped code is returned as it arrived rather than dropped.
        /// </summary>
        public static string ToAlpha3(string? code)
        {
            var resolved = ToCode(code);
            if (resolved == null)
            {
                return string.Empty;
            }

            foreach (var pair in LanguageTables.Alpha3)
            {
                if (string.Equals(pair.Value, resolved, StringComparison.Ordinal))
                {
                    return pair.Key;
                }
            }

            return resolved;
        }

        /// <summary>
        /// Resolve a preference list, dropping what cannot be resolved and keeping the
        /// caller's order: it is the order the ranking scores by.
        /// </summary>
        public static List<string> ToCodes(IEnumerable<string?>? values)
        {
            var outp = new List<string>();
            if (values == null)
            {
                return outp;
            }

            foreach (var value in values)
            {
                var code = ToCode(value);
                if (code != null && !outp.Contains(code))
                {
                    outp.Add(code);
                }
            }

            return outp;
        }
    }
}
