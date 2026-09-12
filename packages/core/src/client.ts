import { SubtitleDbAbort, SubtitleDbError } from './errors.js';
import type {
  BundleSubtitle,
  HealthResponse,
  LanguageCode,
  LookupBundle,
  ResponseClass,
  SubtitleSort,
} from './types.js';

/**
 * Where the API lives, and the reason every path below starts `/v1` rather than
 * `/api/v1`.
 *
 * There are two ways to reach the same API and they differ by exactly this prefix:
 *
 *   https://api.thesubtitledb.org/v1/...       the API's own host, what this defaults to
 *   https://thesubtitledb.org/api/v1/...       the site origin, which proxies /api
 *
 * The paths used to carry `/api` while the base pointed at the API host, which
 * produced `https://api.thesubtitledb.org/api/v1/by-tmdb/603` and a 404 on every single
 * request. It failed silently, because resolve() reports and returns an empty result
 * rather than throwing, so every player showed "no subtitles found" for every title
 * and nothing anywhere said why.
 *
 * With the prefix on the base instead of the path, both deployments work: pass
 * `apiBase: 'https://thesubtitledb.org/api'` and the same `/v1` paths land correctly.
 */
export const DEFAULT_API_BASE = 'https://api.thesubtitledb.org';

export interface ClientOptions {
  apiBase?: string;
  /** Injected for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Per-attempt timeout. The total budget is roughly this times (retries + 1). */
  timeoutMs?: number;
  /** Retries after the first attempt. Only 429, 5xx and transport failures retry. */
  retries?: number;
  /**
   * Sent as a `client` query parameter on every request so traffic is attributable
   * in our logs. Deliberately a query parameter and not a header: a custom header
   * makes the browser issue a CORS preflight before every new path, and the point
   * of this field is diagnostics, not something worth a round trip. The API ignores
   * unknown query parameters, verified against the live service.
   */
  client?: string;
}

export interface RequestOptions {
  signal?: AbortSignal;
}

/**
 * Paging and filtering for a single lookup bundle's `subtitles` buckets.
 *
 * Two things about `lang` and `format` that the response cannot tell you apart from a
 * filter that matched nothing:
 *
 *   - `lang` NOW TAKES A COMMA LIST, up to 16 codes: `lang=en,fr,de` comes back with all
 *     three. It used to take one code and silently drop a list, which is why the callers
 *     in this repo still fan out one request per language. That fan-out is now a cost we
 *     choose, not one the API forces; collapsing it is a behaviour change across four
 *     language ports and is deliberately not part of this change.
 *   - Both filters bite on a MOVIE bundle and on an episode drill, and are IGNORED on a
 *     series or season bundle: the tree is served unfiltered by design, so
 *     `by-imdb/tt0944947?lang=en` returns exactly the bytes of the unfiltered call.
 *     Drill to `/season/:s/episode/:e` when the filter has to hold.
 */
export interface LookupParams extends RequestOptions {
  /** Page size of every `subtitles` bucket in the bundle. The API defaults to 20, caps at 100. */
  limit?: number;
  offset?: number;
  /** One ISO code, or up to 16 comma separated. Ignored on a series or season bundle. */
  lang?: LanguageCode;
  /** Ignored on a series or season bundle, like `lang`. */
  format?: string;
  sort?: SubtitleSort;
  /** How much TMDB enrichment the bundle's `title` carries. The API defaults to `minimal`. */
  response_class?: ResponseClass;
}

/**
 * A lookup that can resolve to a series, plus the optional slug that narrows it.
 * `season`/`episode` are ignored when the resolved title is a movie -- except that
 * the API answers 400 for a movie asked for a season, matching the site's slugs.
 */
export interface DrillParams extends LookupParams {
  season?: number;
  episode?: number;
}

const RETRY_BASE_MS = 300;
const MAX_BACKOFF_MS = 8000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SubtitleDbAbort());
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(new SubtitleDbAbort());
    };
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Honour Retry-After when the server sends one, otherwise exponential backoff with
 * full jitter. Jitter matters more than it looks here: eager loading means many
 * independent players can hit a cold cache within the same second, and un-jittered
 * backoff marches all of them into the next wall together.
 */
export function backoffMs(attempt: number, retryAfter: string | null, rand = Math.random): number {
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_BACKOFF_MS);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.min(Math.max(at - Date.now(), 0), MAX_BACKOFF_MS);
  }
  const ceiling = Math.min(RETRY_BASE_MS * 2 ** attempt, MAX_BACKOFF_MS);
  return rand() * ceiling;
}

function joinSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  return b ? AbortSignal.any([a, b]) : a;
}

export class SubtitleDbClient {
  readonly apiBase: string;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly client: string | undefined;

  constructor(opts: ClientOptions = {}) {
    this.apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new SubtitleDbError({ message: 'no fetch implementation available' });
    }
    // Stored as given and always called detached, never as `this.doFetch(...)`. A
    // native fetch invoked as a method of this object is an "Illegal invocation" in
    // every browser, which is what a page bringing no fetch of its own used to hit on
    // every request. Calling detached also leaves an already-bound wrapper alone,
    // which binding to globalThis would not, and covers a fetch from another realm
    // that is the platform's but not identical to this global.
    this.doFetch = f;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
    this.client = opts.client;
  }

  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    }
    if (this.client) u.searchParams.set('client', this.client);
    return u.toString();
  }

  /** One request, with timeout, retry and typed errors. */
  private async request<T>(url: string, signal?: AbortSignal): Promise<T> {
    let last: SubtitleDbError | undefined;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (signal?.aborted) throw new SubtitleDbAbort();
      let res: Response;
      try {
        const doFetch = this.doFetch;
        res = await doFetch(url, {
          method: 'GET',
          headers: { accept: 'application/json' },
          signal: joinSignals(AbortSignal.timeout(this.timeoutMs), signal),
        });
      } catch (cause) {
        if (signal?.aborted) throw new SubtitleDbAbort();
        // Covers the browser opaque failure for a cross-origin rejection that never
        // received CORS headers. There is no body to read in that case, by
        // construction, so nothing below may depend on one.
        last = new SubtitleDbError({
          message: 'network request failed',
          status: 0,
          code: 'transport_error',
          url,
          cause,
        });
        if (attempt < this.retries) {
          await sleep(backoffMs(attempt, null), signal);
          continue;
        }
        throw last;
      }

      if (res.ok) return (await res.json()) as T;

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        body = undefined;
      }
      last = SubtitleDbError.fromBody(res.status, url, body);
      if (!last.retryable || attempt === this.retries) throw last;
      await sleep(backoffMs(attempt, res.headers.get('retry-after')), signal);
    }

    throw last ?? new SubtitleDbError({ message: 'request failed', url });
  }

  health(opts: RequestOptions = {}): Promise<HealthResponse> {
    return this.request<HealthResponse>(this.url('/healthz'), opts.signal);
  }

  /**
   * The lookup surface: hand over one identifier, get back the whole title as a single
   * bundle. Every verb returns the same shape, `{title, subtitles, seasons}` plus the
   * verb's own extras: `subtitles` is the page for the scope asked for and `seasons` is
   * the tree, null for a movie and for an episode drill. There is nothing to narrow;
   * see LookupBundle.
   *
   * tmdb is the headline key and by-imdb sits right beside it, first-class and the same
   * bundle shape, because media servers identify content by IMDb id. `lang`/`format`/
   * `sort` narrow and order the subtitle bucket the same way on every verb.
   *
   * `by-search` is intentionally absent: it needs a key, and this client carries no
   * credential. Resolve free text with byTitle(), which needs none.
   */

  /** The `/season/:s[/episode/:e]` suffix, or '' when no season was asked for. */
  private drill(season?: number, episode?: number): string {
    if (season === undefined) return '';
    const s = `/season/${season}`;
    return episode === undefined ? s : `${s}/episode/${episode}`;
  }

  /** The subtitle-bucket query shared by every verb: paging plus the lang/format/sort filter. */
  private pageQuery(p: LookupParams): Record<string, string | number | undefined> {
    return {
      limit: p.limit,
      offset: p.offset,
      lang: p.lang,
      format: p.format,
      sort: p.sort,
      response_class: p.response_class,
    };
  }

  /** Look up a title by TMDB id. Pass `season`/`episode` to narrow a series. */
  byTmdb(tmdb: string | number, params: DrillParams = {}): Promise<LookupBundle> {
    return this.request<LookupBundle>(
      this.url(
        `/v1/by-tmdb/${Number(tmdb)}${this.drill(params.season, params.episode)}`,
        this.pageQuery(params),
      ),
      params.signal,
    );
  }

  /**
   * Look up a title by IMDb id. Accepts 133093, "133093" or "tt0133093". Pass
   * `season`/`episode` to narrow a series. First-class beside byTmdb and the same bundle
   * shape: media servers hand over an IMDb id, so this is the rung that resolves them.
   */
  byImdb(imdb: string | number, params: DrillParams = {}): Promise<LookupBundle> {
    const id = normaliseImdb(imdb);
    return this.request<LookupBundle>(
      this.url(
        `/v1/by-imdb/${id}${this.drill(params.season, params.episode)}`,
        this.pageQuery(params),
      ),
      params.signal,
    );
  }

  /**
   * Look up the title a torrent belongs to, by its infohash. The hash is lowercased
   * the way the API stores it. The bundle carries a `torrent` block. A series target
   * accepts the same `season`/`episode` narrowing.
   */
  byInfohash(infohash: string, params: DrillParams = {}): Promise<LookupBundle> {
    const hash = infohash.trim().toLowerCase();
    return this.request<LookupBundle>(
      this.url(
        `/v1/by-infohash/${hash}${this.drill(params.season, params.episode)}`,
        this.pageQuery(params),
      ),
      params.signal,
    );
  }

  /**
   * Resolve a scene release name to its title. Free text goes in a query parameter,
   * not the path, because release names carry dots and slashes. The bundle carries a
   * `match` block (which stored release won, and its score).
   */
  byReleasename(release: string, params: DrillParams = {}): Promise<LookupBundle> {
    return this.request<LookupBundle>(
      this.url(`/v1/by-releasename${this.drill(params.season, params.episode)}`, {
        release,
        ...this.pageQuery(params),
      }),
      params.signal,
    );
  }

  /**
   * Resolve free text to the single closest title (the top-1 of the search matcher),
   * and drill straight to a season/episode when the caller knows the numbers. The
   * bundle carries a `match` block. This is the SDK's title rung: the server does the
   * matching, so no ranked list of titles crosses the wire.
   */
  byTitle(q: string, params: DrillParams = {}): Promise<LookupBundle> {
    return this.request<LookupBundle>(
      this.url(`/v1/by-title${this.drill(params.season, params.episode)}`, {
        q,
        ...this.pageQuery(params),
      }),
      params.signal,
    );
  }

  /**
   * Look up the title a single subtitle belongs to, by the subtitle id. The bundle is
   * scoped to where that file sits -- a movie file returns the movie, a TV file its
   * episode (or season pack) -- and carries a `subtitle` block with the file itself.
   */
  bySubid(id: string | number, params: LookupParams = {}): Promise<LookupBundle> {
    return this.request<LookupBundle>(
      this.url(`/v1/by-subid/${Number(id)}`, this.pageQuery(params)),
      params.signal,
    );
  }

  /**
   * Fetch the subtitle bytes as text.
   *
   * Always follows download_url exactly as the API returned it. The files host is
   * documented as changeable and the /get/ redirect exists precisely so that stays
   * true, so building a files-host URL here would be a bug with a long fuse. It has
   * already moved once: /d/ and /dl/ were removed and /get/:id is the only byte path.
   *
   * Returns the stored format untouched. This library never converts.
   */
  async fetchSubtitleText(
    sub: Pick<BundleSubtitle, 'download_url' | 'format'>,
    opts: RequestOptions = {},
  ): Promise<{ text: string; format: string }> {
    const signal = joinSignals(AbortSignal.timeout(this.timeoutMs), opts.signal);
    let res: Response;
    try {
      const doFetch = this.doFetch;
      res = await doFetch(sub.download_url, { method: 'GET', signal });
    } catch (cause) {
      if (opts.signal?.aborted) throw new SubtitleDbAbort();
      throw new SubtitleDbError({
        message: 'subtitle download failed',
        url: sub.download_url,
        cause,
      });
    }
    if (!res.ok) {
      throw new SubtitleDbError({
        message: `subtitle download failed with ${res.status}`,
        status: res.status,
        code: 'download_failed',
        url: sub.download_url,
      });
    }
    return { text: await res.text(), format: sub.format };
  }

  /** Absolute URL for a TMDB artwork path, proxied through our own host. */
  posterUrl(path: string | null | undefined, size = 'w342'): string | null {
    if (!path) return null;
    return `${this.apiBase}/p/${size}${path.startsWith('/') ? path : `/${path}`}`;
  }
}

export function normaliseImdb(imdb: string | number): string {
  const s = String(imdb).trim().toLowerCase();
  const digits = s.startsWith('tt') ? s.slice(2) : s;
  if (!/^\d+$/.test(digits)) {
    throw new SubtitleDbError({ message: `not an imdb id: ${imdb}`, code: 'bad_request' });
  }
  return `tt${digits.padStart(7, '0')}`;
}

export function createClient(opts: ClientOptions = {}): SubtitleDbClient {
  return new SubtitleDbClient(opts);
}
