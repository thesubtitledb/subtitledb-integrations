/**
 * Wire types for the SubtitleDB public API.
 *
 * These mirror what api.thesubtitledb.org actually returns, captured from the live
 * service rather than transcribed from docs. Fields that the API currently sends as
 * null are typed as nullable even where they are conceptually required, because a
 * consumer has to handle today's data, not the data we wish existed. Two in
 * particular are null across the whole corpus right now:
 *
 *   tmdb_id / media_type   the imdb->tmdb map is empty, so every title reports null
 *   season / episode       never populated by the ingest, so TV cannot be addressed
 *                          by number yet. See MatchTier.SeriesEpisode.
 */

/** ISO639 code as the API emits it: lowercase, occasionally non-standard (pb, ze, zt). */
export type LanguageCode = string;

/** The API allowlists exactly these, though `episode` is unreachable until the backfill. */
export type TitleKind = 'movie' | 'episode';

export type SearchSort = 'relevance' | 'subtitles' | 'year' | 'name';
export type SubtitleSort = 'lang' | 'downloads' | 'cues' | 'bytes';

/**
 * How much of the TMDB enrichment a lookup bundle's `title` carries. Each tier keeps
 * everything below it: `minimal` is the id block alone, `standard` adds the artwork and
 * overview, `detailed` the credits and certification, `full` the money and the company
 * lists. Unknown values degrade to `minimal` rather than 400.
 */
export type ResponseClass = 'minimal' | 'standard' | 'detailed' | 'full';

export interface Title {
  imdb_id: number;
  /** Zero-padded display form, e.g. "tt0133093". */
  imdb: string;
  tmdb_id: number | null;
  media_type: string | null;
  name: string;
  year: number;
  kind: TitleKind;
  languages: LanguageCode[];
  subtitle_count: number;
  /** TMDB path such as "/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg", not a URL. */
  poster_path: string | null;
  backdrop_path: string | null;
  subtitles_url: string;
}

export interface Subtitle {
  id: number;
  imdb: string;
  language: LanguageCode;
  /** Stored format. The API never converts, so this is what you will receive. */
  format: string;
  title: string;
  year: number;
  season: number | null;
  episode: number | null;
  cues: number;
  duration_s: number;
  bytes: number;
  encoding: string;
  release_name: string;
  uploader: string;
  hearing_impaired: boolean;
  fps: number | null;
  downloads: number;
  source_shard: string;
  /** Stable URL on the API host. 302s to the files host, which may change. */
  download_url: string;
}

export interface SearchResponse {
  query: {
    q: string;
    lang: LanguageCode | null;
    type: TitleKind | null;
    year: number | null;
    sort: SearchSort;
  };
  total: number;
  limit: number;
  offset: number;
  results: Title[];
}

export interface TitleSubtitlesResponse {
  title: Title;
  query: { lang: LanguageCode | null; format: string | null; sort: SubtitleSort };
  total: number;
  limit: number;
  offset: number;
  subtitles: Subtitle[];
}

export interface HealthResponse {
  ok: boolean;
  clickhouse: string;
  titles: number;
  indexed_subtitles: number;
  tmdb_mappings: number;
}

/** Shape of every non-2xx body the API emits. */
export interface ApiErrorBody {
  error: string;
  message: string;
  hint?: string;
  stored_format?: string;
  /** Sent with a rejected hash: how the API expects that hash to have been computed. */
  hash_spec?: {
    algorithm: string;
    encoding: string;
    hashed: string;
    canonical_form: string[];
  };
}

/**
 * The lookup surface: one id in, the whole title back.
 *
 * `/v1/by-*` resolves an identifier to a single title and returns one bundle shaped
 * to that title's media type. These types are the second, leaner projection the API
 * emits, captured off the live service the same way the site types above were, and
 * they are deliberately NOT the site types:
 *
 *   - A bundle's subtitle item (`BundleSubtitle`) drops the parent-echoing and internal
 *     fields the leaf `Subtitle` still carries -- `imdb`/`title`/`year` live on the
 *     bundle's `title`, and `downloads`/`source_shard`/`added` are gone. It keeps the
 *     ISO `added_at`. The full `Subtitle` is now an /app read only: `/v1/subtitles/:id`
 *     404s since the content mirror moved off /v1, so a bundle item is what /v1 gives
 *     you. The two are different reads and different shapes on purpose.
 *   - A bundle's `title` (`LookupTitle`) is `shapeTitle` with the /v1 field cleanups:
 *     no `imdb_id`/`kind`/`languages`/`subtitles_url`, `language_counts` renamed
 *     `subtitle_languages`, and the TMDB enrichment carried inline. Every enrichment
 *     field is OMITTED when the map has no value for it, never sent as null, so all of
 *     them are optional here -- a consumer must handle the id-only title.
 */

/** One file in a bundle page. Leaner than `Subtitle`: no parent echo, no internals. */
export interface BundleSubtitle {
  id: number;
  language: LanguageCode;
  format: string;
  season: number | null;
  episode: number | null;
  cues: number;
  duration_s: number;
  bytes: number;
  encoding: string;
  release_name: string;
  uploader: string;
  hearing_impaired: boolean;
  fps: number | null;
  /** ISO 8601, e.g. "2021-06-04T12:11:09Z". */
  added_at: string;
  /** Stable counted redirect on the API host; 302s to the files host. */
  download_url: string;
}

/** A page of files inside a bundle, newest first. Default `limit` is 20. */
export interface SubtitlePage {
  total: number;
  limit: number;
  offset: number;
  items: BundleSubtitle[];
}

/**
 * A bundle's title. The identity block is always present; the TMDB enrichment is
 * present only for a mapped title and is omitted field by field otherwise.
 */
export interface LookupTitle {
  /** Zero-padded display form, e.g. "tt0133093". */
  imdb: string;
  tmdb_id: number | null;
  media_type: string | null;
  name: string;
  /** Null where the corpus has no year, which includes every `partial` title. */
  year: number | null;
  /** Omitted on a `partial` title: there is no title row to count against. */
  subtitle_count?: number;
  /**
   * A title assembled from its own subtitle rows, with no title row behind it: `name` is
   * empty, `year` and `tmdb_id` are null. The API answers 200 for these, so a caller that
   * reads any 200 as "resolved" shows a blank title. Check this before trusting `name`.
   */
  partial?: true;
  /** Per-language file counts across the whole title, e.g. {"en":142,"es":88}. */
  subtitle_languages: Record<string, number>;

  // TMDB enrichment. Omitted (never null) unless the title is mapped AND response_class
  // asked for the tier it sits in. The default class, `minimal`, carries NONE of this,
  // which is why poster_path is absent from a plain lookup.
  poster_path?: string | null;
  backdrop_path?: string | null;
  overview?: string;
  original_title?: string;
  original_language?: string;
  release_date?: string;
  genres?: string[];
  /** 0-100 (TMDB vote_average * 10), not 0-10. */
  vote?: number;
  popularity?: number;
  runtime_min?: number;
  tagline?: string;
  certification?: string;
  cert_country?: string;
  directors?: string[];
  keywords?: string[];
  spoken_languages?: string[];
  translated_titles?: string[];
  origin_country?: string[];

  // response_class 'full' only.
  budget?: number;
  revenue?: number;
  homepage?: string;
  collection_name?: string;
  production_companies?: string[];
  production_countries?: string[];

  // Series only.
  number_of_seasons?: number;
  number_of_episodes?: number;
  in_production?: boolean;
  networks?: string[];
  last_air_date?: string;
  next_episode_air_date?: string;
}

/** One episode of a series, holding only the files pinned to exactly this episode. */
export interface LookupEpisode {
  season: number;
  episode: number;
  imdb: string;
  name: string;
  /** Cumulative for the episode. */
  subtitle_count: number;
  subtitles: SubtitlePage;
  /** From TMDB when the season is mapped; omitted otherwise. */
  air_date?: string;
}

/**
 * One season of a series. `subtitle_count` is cumulative (every file in the season,
 * its episodes included); the season's own `subtitles` bucket, when present, holds
 * only the season-pack files that carry a season but no episode.
 */
export interface LookupSeason {
  season: number;
  /** Cumulative for the season. */
  subtitle_count: number;
  episodes: LookupEpisode[];
  /** Present when the season has season-pack files of its own. */
  subtitles?: SubtitlePage;
  // From TMDB when the season is mapped; omitted otherwise.
  name?: string;
  poster_path?: string | null;
  air_date?: string;
  episode_count?: number;
}

/** by-infohash: the torrent that resolved to the title. */
export interface TorrentRef {
  infohash: string;
  name: string;
}

/** by-releasename: which stored release name won, and how strongly. */
export interface ReleaseMatch {
  sub_id: number;
  release_name: string;
  score: number;
  shared_tokens: number;
}

/** by-title: the single closest title, and its score. */
export interface TitleMatch {
  name: string;
  imdb: string;
  score: number;
}

/**
 * The per-verb extras. Each is present only for the verb that produces it:
 * `torrent` for by-infohash, `match` for by-releasename/by-title, `subtitle` for
 * by-subid (the exact file that was looked up).
 */
export interface LookupExtras {
  torrent?: TorrentRef;
  match?: ReleaseMatch | TitleMatch;
  subtitle?: BundleSubtitle;
}

/**
 * Every `by-*` verb returns this one object. There is no union and nothing to narrow:
 * `title`, `subtitles` and `seasons` are always all three present, plus whichever
 * LookupExtras block the verb adds.
 *
 * This was modelled as a four-way union (`MovieBundle | SeriesBundle | SeasonBundle |
 * EpisodeBundle`) narrowed on `'episode' in b` / `'season' in b`. The API never sent
 * those keys. Every consumer fell through to `subtitles` and was right by accident,
 * while `'seasons' in b` -- documented as the test for a series -- is true for a movie
 * too, because the key is present and null. Verified against production 2026-09-06 on
 * by-imdb, by-tmdb, by-subid, by-title and by-releasename.
 *
 * `subtitles` is always the page for exactly the scope asked for: a movie's files, a
 * drilled episode's own files, or a series' unbucketed files. `seasons` is the tree
 * and is null for a movie AND for an episode drill; a season drill still returns every
 * season in it, so read `subtitles` and not `seasons[0]` when a slug was used.
 */
export interface LookupBundle extends LookupExtras {
  title: LookupTitle;
  subtitles: SubtitlePage;
  seasons: LookupSeason[] | null;
}
