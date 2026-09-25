using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace SubtitleDb.Core
{
    /// <summary>What the host knows about the file being played.</summary>
    public sealed class Hint
    {
        public string? ImdbId { get; set; }
        public long? TmdbId { get; set; }

        /// <summary>
        /// For TV, the series' IMDb id: what a server holds for the show when the
        /// episode has no id of its own. The ladder drills it to the season and episode.
        /// </summary>
        public string? SeriesImdbId { get; set; }

        public string? Title { get; set; }

        /// <summary>The name of the one episode, which is what tells it from the rest.</summary>
        public string? EpisodeTitle { get; set; }

        public int? Year { get; set; }
        public int? Season { get; set; }
        public int? Episode { get; set; }

        /// <summary>
        /// The video's own release name, without the container. A subtitle recorded
        /// against this exact encode is the one whose timings line up.
        /// </summary>
        public string? Release { get; set; }
    }

    /// <summary>What the caller can show, and in what order it wants it.</summary>
    public sealed class MatchOptions
    {
        /// <summary>Preference order. Earlier is better. Empty means no preference.</summary>
        public List<string> Languages { get; set; } = new List<string>();

        /// <summary>
        /// Formats the host can render. A hard filter, not a preference: handed a
        /// format it cannot parse, a player shows an empty track, which is the most
        /// confusing failure a subtitle plugin has.
        /// </summary>
        public List<string> Formats { get; set; } = new List<string> { "srt", "ass", "ssa", "sub", "vtt" };

        public bool? HearingImpaired { get; set; }

        /// <summary>
        /// The most subtitles per language. <see cref="Matcher.Rank"/> keeps this many in
        /// all; <see cref="Finder"/> reads and keeps this many for each language, 100 to
        /// a request.
        /// </summary>
        public int Limit { get; set; } = 100;

        /// <summary>What a plugin reads per language when its user has not said.</summary>
        public const int PerLanguage = 500;

        /// <summary>The most a plugin setting may ask for, in rows per language.</summary>
        public const int MostPerLanguage = 2000;

        /// <summary>A plugin setting read as rows per language: 100 to 2000, else 500.</summary>
        public static int PerLanguageFrom(int? setting)
        {
            return setting.HasValue
                ? Math.Min(Math.Max(setting.Value, Finder.Page), MostPerLanguage)
                : PerLanguage;
        }
    }

    /// <summary>One row, with why it is where it is.</summary>
    public sealed class Candidate
    {
        public Candidate(SubtitleRow subtitle, double score, string reason)
        {
            Subtitle = subtitle;
            Score = score;
            Reason = reason;
        }

        public SubtitleRow Subtitle { get; }

        /// <summary>Higher is better. Only comparable inside one result set.</summary>
        public double Score { get; }

        /// <summary>Readable, and safe to put in front of a viewer.</summary>
        public string Reason { get; }
    }

    public sealed class Ranked
    {
        public List<Candidate> Candidates { get; set; } = new List<Candidate>();

        /// <summary>Dropped because the host cannot render the format.</summary>
        public int Unrenderable { get; set; }

        /// <summary>Dropped because sub_meta files them under another episode.</summary>
        public int WrongEpisode { get; set; }
    }

    /// <summary>
    /// Which subtitle is the right one.
    /// </summary>
    /// <remarks>
    /// The same rules as packages/core/src/match.ts, plugins/python/subtitledb/match.py
    /// and plugins/vlc/subtitledb.lua. Resolving which title a file belongs to is the
    /// server's job now (the by-* lookup verbs), so only the client-side ranking of an
    /// already-resolved title's subtitles lives here. plugins/shared/match-cases.json
    /// holds the cases all four are checked against, so a rule changed here and nowhere
    /// else turns three other CI jobs red rather than quietly giving Emby users a
    /// different pick.
    /// </remarks>
    public static class Matcher
    {
        /// <summary>How close two release names must be before we call it one encode.</summary>
        public const double ExactRelease = 0.95;

        /// <summary>Fold case, accents and punctuation, so two spellings compare equal.</summary>
        public static string Normalise(string? value)
        {
            if (string.IsNullOrEmpty(value))
            {
                return string.Empty;
            }

            var decomposed = value!.ToLowerInvariant().Normalize(NormalizationForm.FormKD);
            var builder = new StringBuilder(decomposed.Length);
            var space = false;
            foreach (var ch in decomposed)
            {
                if (CharUnicodeInfo.GetUnicodeCategory(ch) == UnicodeCategory.NonSpacingMark)
                {
                    continue;
                }

                if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9'))
                {
                    builder.Append(ch);
                    space = false;
                }
                else if (!space && builder.Length > 0)
                {
                    builder.Append(' ');
                    space = true;
                }
            }

            return builder.ToString().Trim();
        }

        /// <summary>Dice coefficient over bigrams: forgiving of word order and punctuation.</summary>
        public static double Similarity(string? a, string? b)
        {
            var x = Normalise(a);
            var y = Normalise(b);
            if (x.Length == 0 || y.Length == 0)
            {
                return 0;
            }

            if (string.Equals(x, y, StringComparison.Ordinal))
            {
                return 1;
            }

            var left = Bigrams(x);
            var overlap = 0;
            var total = left.Values.Sum();
            foreach (var pair in Bigrams(y))
            {
                total += pair.Value;
                if (left.TryGetValue(pair.Key, out var have))
                {
                    overlap += Math.Min(have, pair.Value);
                }
            }

            return total == 0 ? 0 : 2.0 * overlap / total;
        }

        private static Dictionary<string, int> Bigrams(string value)
        {
            var grams = new Dictionary<string, int>();
            for (var i = 0; i + 1 < value.Length; i++)
            {
                var gram = value.Substring(i, 2);
                grams[gram] = grams.TryGetValue(gram, out var n) ? n + 1 : 1;
            }

            return grams;
        }

        /// <summary>
        /// Whether sub_meta files this row under a different episode. A row with no
        /// season at all is kept: sub_meta has no entry for every id, and unknown is
        /// not wrong.
        /// </summary>
        public static bool IsWrongEpisode(SubtitleRow row, Hint hint)
        {
            if (!hint.Season.HasValue || !hint.Episode.HasValue)
            {
                return false;
            }

            if (!row.Season.HasValue || !row.Episode.HasValue)
            {
                return false;
            }

            return row.Season.Value != hint.Season.Value || row.Episode.Value != hint.Episode.Value;
        }

        public static double ScoreSubtitle(SubtitleRow row, Hint hint, MatchOptions options, out string reason)
        {
            var reasons = new List<string>();
            double score = 0;

            var language = row.Language ?? string.Empty;
            if (options.Languages.Count > 0)
            {
                var index = options.Languages.IndexOf(language);
                if (index >= 0)
                {
                    score += 100 - (index * 20);
                    reasons.Add("preferred language " + language);
                }
                else
                {
                    score -= 50;
                }
            }

            if (options.HearingImpaired.HasValue)
            {
                if (row.HearingImpaired == options.HearingImpaired.Value)
                {
                    score += 15;
                    reasons.Add(options.HearingImpaired.Value ? "hearing impaired" : "not hearing impaired");
                }
                else
                {
                    score -= 15;
                }
            }

            // Release-name agreement is the strongest signal a subtitle matches this
            // exact encode, and it is a comparison between two release names.
            var release = (row.ReleaseName ?? string.Empty).Trim();
            if (release.Length > 0 && !string.IsNullOrWhiteSpace(hint.Release))
            {
                var similarity = Similarity(release, hint.Release);
                if (similarity >= ExactRelease)
                {
                    score += 60;
                    reasons.Add("same release");
                }
                else if (similarity > 0.5)
                {
                    score += similarity * 30;
                    reasons.Add("release name is close");
                }
            }

            // An episode we could confirm, rather than one we merely could not rule out.
            if (hint.Season.HasValue && row.Season.HasValue && !IsWrongEpisode(row, hint))
            {
                score += 20;
                reasons.Add(string.Format(
                    CultureInfo.InvariantCulture, "season {0} episode {1}", hint.Season, hint.Episode));
            }

            // A file with no cues renders as an empty track. Known corpus defect.
            if (row.Cues == 0)
            {
                score -= 500;
                reasons.Add("no cues");
            }

            reason = reasons.Count > 0
                ? string.Join(", ", reasons)
                : string.Format(CultureInfo.InvariantCulture, "{0} {1}", row.Language, row.Format);
            return score;
        }

        /// <summary>Filter, score and order, keeping <paramref name="keep"/> or else the options' limit.</summary>
        public static Ranked Rank(IEnumerable<SubtitleRow>? rows, Hint hint, MatchOptions options, int? keep = null)
        {
            var result = new Ranked();
            if (rows == null)
            {
                return result;
            }

            var renderable = new HashSet<string>(
                options.Formats.Select(f => (f ?? string.Empty).ToLowerInvariant()), StringComparer.Ordinal);

            var kept = new List<Candidate>();
            foreach (var row in rows)
            {
                var format = (row.Format ?? string.Empty).ToLowerInvariant();
                if (!renderable.Contains(format))
                {
                    result.Unrenderable++;
                    continue;
                }

                if (IsWrongEpisode(row, hint))
                {
                    result.WrongEpisode++;
                    continue;
                }

                var score = ScoreSubtitle(row, hint, options, out var reason);
                kept.Add(new Candidate(row, score, reason));
            }

            // The id breaks ties, so two runs of one search list the same order.
            result.Candidates = kept
                .OrderByDescending(c => c.Score)
                .ThenBy(c => c.Subtitle.Id)
                .Take(Math.Max(keep ?? options.Limit, 1))
                .ToList();

            return result;
        }

        /// <summary>
        /// What a viewer reads in the list. Most of the corpus carries no release
        /// name, so thirty English candidates for one film would otherwise read
        /// "English" thirty times and picking one would be a lottery. The cue count is
        /// the only other field that differs between them.
        /// </summary>
        public static string Label(Candidate candidate)
        {
            var row = candidate.Subtitle;
            var bits = new List<string> { Languages.Name(row.Language) ?? "Unknown" };
            if (row.HearingImpaired)
            {
                bits.Add("HI");
            }

            var release = (row.ReleaseName ?? string.Empty).Trim();
            if (release.Length > 0)
            {
                bits.Add(release.Length > 40 ? release.Substring(0, 40) : release);
            }
            else if (row.Cues > 0)
            {
                bits.Add(row.Cues.ToString(CultureInfo.InvariantCulture) + " lines");
            }

            return string.Join(" - ", bits);
        }
    }
}
