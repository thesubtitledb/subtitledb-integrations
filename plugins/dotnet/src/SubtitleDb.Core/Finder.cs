using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;

namespace SubtitleDb.Core
{
    /// <summary>Which rung produced the answer. Logged so a report says why, not just what.</summary>
    public enum MatchTier
    {
        None,
        ExplicitTmdb,
        ExplicitImdb,
        SeriesImdb,
        Title,
    }

    public sealed class FindResult
    {
        public List<Candidate> Candidates { get; set; } = new List<Candidate>();

        public TitleRow? Title { get; set; }

        public MatchTier Tier { get; set; } = MatchTier.None;

        public int Unrenderable { get; set; }

        public int WrongEpisode { get; set; }
    }

    /// <summary>
    /// The ladder: from what the host knows about a file to a ranked list.
    /// </summary>
    /// <remarks>
    /// Each rung resolves one identifier to a title bundle and falls through to the
    /// next, strongest evidence first. tmdb is the headline key and leads; imdb sits
    /// right behind it, because media servers identify content by IMDb id and the
    /// imdb-to-tmdb map is only partial, so an explicit tmdb 404s for many ids and
    /// hands off to imdb. An episode with no id of its own goes by its series' id,
    /// drilled to the season and episode. Free text is the last automatic rung: the
    /// server matches the title and drills to the episode, so no ranked list of titles
    /// crosses the wire.
    /// Every rung issues lookup-shaped requests only; the bytes are fetched later, and
    /// only for the one the viewer picked.
    /// </remarks>
    public static class Finder
    {
        /// <summary>The most rows the API returns for one request. More takes an offset.</summary>
        public const int Page = 100;

        /// <summary>One page of one lookup: a language, or null for any, and where to start.</summary>
        private delegate Task<LookupBundle> Fetch(
            string? language, int limit, int offset, CancellationToken cancellationToken);

        public static async Task<FindResult> FindAsync(
            SubtitleDbClient client,
            Hint hint,
            MatchOptions options,
            CancellationToken cancellationToken)
        {
            if (client == null)
            {
                throw new ArgumentNullException(nameof(client));
            }

            options = options ?? new MatchOptions();

            // Rung 1: an explicit TMDB id, the headline key. The map is only partial in
            // production, so this 404s for many ids and falls through to imdb.
            if (hint.TmdbId.HasValue)
            {
                var result = await ViaAsync(
                    (lang, limit, offset, ct) => client.ByTmdbAsync(
                        hint.TmdbId!.Value, hint.Season, hint.Episode, lang, limit, offset, ct),
                    hint, options, MatchTier.ExplicitTmdb, cancellationToken).ConfigureAwait(false);
                if (result != null)
                {
                    return result;
                }
            }

            // Rung 2: an explicit IMDb id. Works for films and for TV episodes, which the
            // corpus files under their own episode-level id. This is the rung media
            // servers hit, since they hand over an IMDb id.
            if (!string.IsNullOrWhiteSpace(hint.ImdbId))
            {
                var result = await ViaAsync(
                    (lang, limit, offset, ct) => client.ByImdbAsync(
                        hint.ImdbId!, hint.Season, hint.Episode, lang, limit, offset, ct),
                    hint, options, MatchTier.ExplicitImdb, cancellationToken).ConfigureAwait(false);
                if (result != null)
                {
                    return result;
                }
            }

            // Rung 3: the series' IMDb id, drilled to the season and episode. Emby keeps a
            // series' ids beside an episode's, Jellyfin's library holds them, and an
            // episode scraped from TVDB or TMDB often has none of its own. A name can
            // resolve to another show (the API answers "Friends" with Matlock), and an
            // id cannot.
            if (!string.IsNullOrWhiteSpace(hint.SeriesImdbId)
                && !string.Equals(hint.SeriesImdbId, hint.ImdbId, StringComparison.OrdinalIgnoreCase))
            {
                var result = await ViaAsync(
                    (lang, limit, offset, ct) => client.ByImdbAsync(
                        hint.SeriesImdbId!, hint.Season, hint.Episode, lang, limit, offset, ct),
                    hint, options, MatchTier.SeriesImdb, cancellationToken).ConfigureAwait(false);
                if (result != null)
                {
                    return result;
                }
            }

            // Rung 4: free text, drilled to the episode when the numbers are known. The
            // server matches the title (top-1) and narrows by season/episode.
            if (!string.IsNullOrWhiteSpace(hint.Title) && hint.Title!.Trim().Length > 1)
            {
                var result = await ViaAsync(
                    (lang, limit, offset, ct) => client.ByTitleAsync(
                        hint.Title!, hint.Season, hint.Episode, lang, limit, offset, ct),
                    hint, options, MatchTier.Title, cancellationToken).ConfigureAwait(false);
                if (result != null)
                {
                    return result;
                }
            }

            return new FindResult();
        }

        /// <summary>
        /// Fetch a bundle through <paramref name="fetch"/> and rank its scoped page, or
        /// null on a fallthrough (404/400 = "this rung does not apply"). A 200 with no
        /// usable rows still stops the ladder: the title resolved, it simply has nothing
        /// in the asked-for language or format.
        /// </summary>
        private static async Task<FindResult?> ViaAsync(
            Fetch fetch,
            Hint hint,
            MatchOptions options,
            MatchTier tier,
            CancellationToken cancellationToken)
        {
            TitleRow? title;
            List<SubtitleRow> subtitles;
            try
            {
                // A full page even for a small limit, so the ranking keeps the best few
                // rows and not the first few.
                (title, subtitles) = await FetchBundlePageAsync(
                    fetch, options.Languages, Math.Max(options.Limit, Page), cancellationToken)
                    .ConfigureAwait(false);
            }
            catch (SubtitleDbException err) when (err.Fallthrough)
            {
                return null;
            }

            // The limit holds per language, so a second language is not crowded out by
            // the first one's long list.
            var ranked = Matcher.Rank(
                subtitles, hint, options, options.Limit * Math.Max(1, options.Languages.Count));
            return new FindResult
            {
                Candidates = ranked.Candidates,
                Title = title,
                Tier = tier,
                Unrenderable = ranked.Unrenderable,
                WrongEpisode = ranked.WrongEpisode,
            };
        }

        /// <summary>
        /// Up to <paramref name="cap"/> rows per preferred language, merged in the
        /// caller's priority order.
        /// </summary>
        /// <remarks>
        /// The API sends at most 100 rows a request, in the order they were added
        /// rather than how well they match, so the one in sync with a popular film's
        /// file can sit past the first page. A language is read on until the title
        /// runs out, the cap is reached, or a page brings nothing new.
        /// The API's lang takes up to 16 comma separated codes, so the per-language
        /// fan-out is a cost we choose rather than one the API forces; collapsing it
        /// changes behaviour in four language ports at once and is deliberately left
        /// alone here.
        /// </remarks>
        private static async Task<(TitleRow? Title, List<SubtitleRow> Subtitles)> FetchBundlePageAsync(
            Fetch fetch,
            List<string> languages,
            int cap,
            CancellationToken cancellationToken)
        {
            IEnumerable<string?> asks = languages.Count == 0 ? new string?[] { null } : languages;
            TitleRow? title = null;
            var seen = new HashSet<long>();
            var subtitles = new List<SubtitleRow>();
            foreach (var language in asks)
            {
                var read = 0;
                while (read < cap)
                {
                    var bundle = await fetch(language, Math.Min(Page, cap - read), read, cancellationToken)
                        .ConfigureAwait(false);
                    title ??= bundle.Title;
                    var items = bundle.ScopedItems();
                    var fresh = 0;
                    foreach (var row in items)
                    {
                        if (seen.Add(row.Id))
                        {
                            subtitles.Add(row);
                            fresh++;
                        }
                    }

                    read += items.Count;

                    // No new row means the offset was ignored or went past the end.
                    if (fresh == 0 || read >= (bundle.Subtitles?.Total ?? 0))
                    {
                        break;
                    }
                }
            }

            return (title, subtitles);
        }
    }
}
