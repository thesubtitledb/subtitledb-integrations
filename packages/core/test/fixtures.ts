import type {
  BundleSubtitle,
  LookupBundle,
  LookupEpisode,
  LookupSeason,
  LookupTitle,
} from '../src/types.js';

/**
 * Fixtures shaped from real `/v1/by-*` bundles captured off api.thesubtitledb.org,
 * including the fields that are still null for most of the corpus (tmdb_id, media_type,
 * and season and episode for any id sub_meta has no entry for). Tests that quietly
 * assume those are populated would pass here and fail against production, which is the
 * failure mode these fixtures exist to prevent.
 *
 * These are the lean bundle shapes the SDK actually reads. The leaf `Subtitle`/`Title`
 * shapes are a different, wider read the SDK no longer issues, so no fixture builds them.
 *
 * Every bundle carries `title`, `subtitles` and `seasons`, at every scope. Leaving
 * `seasons` off is what let the four-way union survive: fixtures without the key made
 * `'seasons' in b` false, so the narrowing looked like it worked here and was wrong
 * against production, where the key is always present and null for a movie.
 */

export function lookupTitle(over: Partial<LookupTitle> = {}): LookupTitle {
  return {
    imdb: 'tt0133093',
    tmdb_id: null,
    media_type: null,
    name: 'The Matrix',
    year: 1999,
    subtitle_count: 715,
    poster_path: '/dXNAPwY7VrqMAo51EKhhCJfaGb5.jpg',
    backdrop_path: '/tlm8UkiQsitc8rSuIAscQDCnP8d.jpg',
    subtitle_languages: { en: 142, fr: 88 },
    ...over,
  };
}

export function bundleSubtitle(over: Partial<BundleSubtitle> = {}): BundleSubtitle {
  // download_url tracks id and format the way the real API builds it, so a test that
  // overrides the id gets a distinct URL rather than silently reusing one.
  const id = over.id ?? 114415;
  const format = over.format ?? 'srt';
  return {
    id,
    language: 'en',
    format,
    season: null,
    episode: null,
    cues: 1386,
    duration_s: 7827,
    bytes: 106244,
    encoding: 'utf-8',
    release_name: '',
    uploader: '',
    hearing_impaired: false,
    fps: null,
    added_at: '2021-06-04T12:11:09Z',
    download_url: `https://api.thesubtitledb.org/get/${id}`,
    ...over,
  };
}

/** A movie bundle: the film and a page of its files. What most verbs resolve to. */
export function movieBundle(
  subs: BundleSubtitle[] = [],
  t: LookupTitle = lookupTitle(),
): LookupBundle {
  return {
    title: t,
    subtitles: { total: subs.length, limit: 20, offset: 0, items: subs },
    seasons: null,
  };
}

/**
 * An episode drill: one episode's own files in the top-level page, and `seasons: null`.
 * Identical in shape to a movie bundle, which is exactly what the API sends.
 */
export function episodeBundle(
  subs: BundleSubtitle[],
  over: { season?: number; episode?: number; title?: LookupTitle } = {},
): LookupBundle {
  return {
    title: over.title ?? lookupTitle(),
    subtitles: { total: subs.length, limit: 20, offset: 0, items: subs },
    seasons: null,
  };
}

/**
 * A whole series: the tree in `seasons[]`, and the files belonging to no episode in the
 * top-level page. The only bundle shape where `seasons` is not null.
 */
export function seriesBundle(
  episodes: { season?: number; episode?: number; subs: BundleSubtitle[] }[],
  loose: BundleSubtitle[] = [],
  t: LookupTitle = lookupTitle(),
): LookupBundle {
  const nodes: LookupEpisode[] = episodes.map((e) => ({
    season: e.season ?? 1,
    episode: e.episode ?? 1,
    imdb: t.imdb,
    name: t.name,
    subtitle_count: e.subs.length,
    subtitles: { total: e.subs.length, limit: 20, offset: 0, items: e.subs },
  }));
  const season: LookupSeason = {
    season: nodes[0]?.season ?? 1,
    subtitle_count: nodes.reduce((n, e) => n + e.subtitle_count, 0),
    episodes: nodes,
  };
  return {
    title: t,
    subtitles: { total: loose.length, limit: 20, offset: 0, items: loose },
    seasons: [season],
  };
}

export interface StubCall {
  url: string;
  init: RequestInit | undefined;
}

export interface StubRoute {
  match: RegExp;
  status?: number;
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
  /** Throw a transport-style failure instead of responding. */
  throws?: boolean;
}

/**
 * Minimal fetch stub. Records every call so tests can assert request counts, which is
 * how the eager-loading traffic budget is verified.
 */
export function stubFetch(routes: StubRoute[]): {
  fetch: typeof fetch;
  calls: StubCall[];
} {
  const calls: StubCall[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const route = routes.find((r) => r.match.test(url));
    if (!route) {
      return new Response(JSON.stringify({ error: 'not_found', message: 'no stub' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (route.throws) throw new TypeError('Failed to fetch');
    if (route.text !== undefined) {
      return new Response(route.text, {
        status: route.status ?? 200,
        headers: { 'content-type': 'text/plain', ...(route.headers ?? {}) },
      });
    }
    return new Response(JSON.stringify(route.body ?? {}), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...(route.headers ?? {}) },
    });
  }) as unknown as typeof fetch;

  return { fetch: impl, calls };
}
