import { SubtitleDbAbort, SubtitleDbError } from './errors.js';
import { corpusLanguage } from './languages.js';
import { decodeBytes } from './transform.js';
import type {
  ApiErrorBody,
  BundleSubtitle,
  HealthResponse,
  LanguageCode,
  LookupBundle,
  ResponseClass,
  SearchResponse,
  SearchSort,
  SubtitleSort,
  TitleKind,
  TmdbType,
} from './types.js';

/**
 * Where the API lives. Every path is appended to it and starts `/v1`, so the same API
 * is also reached through the site with `apiBase: 'https://thesubtitledb.org/api'`.
 */
export const DEFAULT_API_BASE = 'https://api.thesubtitledb.org';

// Every optional option is also `| undefined`, so a caller compiling with
// exactOptionalPropertyTypes can pass `{ key: process.env.KEY }` as it is.
export interface ClientOptions {
  /** Must be https when `key` is set: the key is never sent over plain http. */
  apiBase?: string | undefined;
  /** Injected for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch | undefined;
  /** Per-attempt timeout. The total budget is roughly this times (retries + 1). */
  timeoutMs?: number | undefined;
  /** Retries after the first attempt. Only 429, 5xx and transport failures retry. */
  retries?: number | undefined;
  /**
   * Your integration's name, sent as a `client` query parameter on every request. A
   * query parameter rather than a header, so a browser sends no CORS preflight for it.
   */
  client?: string | undefined;
  /**
   * Sent as `client` on the subtitle download in place of `client`: the name the API
   * records the download under. It keeps a closed list for our own integrations and
   * records any other name as `other`. Defaults to `client`.
   */
  downloadClient?: string | undefined;
  /**
   * A per-page-load id, sent as `antispam_id` on every request including the subtitle
   * download, so the API can tie a page's downloads to its lookups. Not a visitor id:
   * the loader makes a fresh one each page load and never stores it.
   */
  antispamId?: string | undefined;
  /**
   * An API key from thesubtitledb.org/account/keys. Optional: every lookup and download
   * works without one. A key raises the lookup and download limits and is required by
   * search().
   * Sent as a Bearer header, so keep it server-side: a key in page code is public. With
   * a key, an http `apiBase` or `download_url` is refused (`bad_request`).
   */
  key?: string | undefined;
}

export interface RequestOptions {
  signal?: AbortSignal | undefined;
}

/**
 * Paging and filtering for a single lookup bundle's `subtitles` buckets.
 *
 * `limit`, `offset`, `lang`, `format` and `sort` apply to the bundle's own `subtitles`
 * page at every scope: a movie, an episode drill, and the show-level or season-pack
 * page of a series root or a season drill. In the `seasons` tree under a series or a
 * season, only `limit` applies, capping every season and episode page; `offset`, `lang`,
 * `format` and `sort` do not apply there.
 *
 * `lang` takes a comma list, up to 16 codes: `lang=en,fr,de` comes back with all three.
 * A malformed code answers 400; a well-formed code with no files answers 200 with
 * total 0.
 */
export interface LookupParams extends RequestOptions {
  /**
   * Page size of the `subtitles` page and of every page in the `seasons` tree. The API
   * defaults to 20 and reads anything over 100 as 100.
   */
  limit?: number | undefined;
  /** Offset into the `subtitles` page. At most 10000. */
  offset?: number | undefined;
  /**
   * One language, or up to 16 comma separated. Each is mapped to the code the corpus
   * files it under, so `en-US` asks for `en`, `pt-BR` for `pb`, `zh-TW` for `zt` and
   * `es-419` or `es-MX` for `ea`.
   * Filters the `subtitles` page, not the `seasons` tree.
   */
  lang?: LanguageCode | undefined;
  /** The same as `lang`, as a list. Both given, the list is appended to `lang`. */
  languages?: readonly string[] | undefined;
  /** srt, ass, ssa, sub or vtt. Filters the `subtitles` page, not the `seasons` tree. */
  format?: string | undefined;
  sort?: SubtitleSort | undefined;
  /** How much TMDB enrichment the bundle's `title` carries. The API defaults to `minimal`. */
  response_class?: ResponseClass | undefined;
}

/** Filters and paging for search(). */
export interface SearchParams extends RequestOptions {
  /** One language, or up to 16 comma separated: titles with subtitles in it. Mapped like LookupParams.lang. */
  lang?: LanguageCode | undefined;
  /** The same as `lang`, as a list. */
  languages?: readonly string[] | undefined;
  type?: TitleKind | undefined;
  year?: number | undefined;
  year_from?: number | undefined;
  year_to?: number | undefined;
  sort?: SearchSort | undefined;
  dir?: 'asc' | 'desc' | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * A lookup that can resolve to a series, plus the optional season and episode that
 * narrow it. A movie has no seasons: by-imdb and the other drillable verbs answer 400
 * for a movie asked for a season, and `/v1/by-tmdb/movie/:id/season/...` has no route
 * and answers 404, so byTmdb drops the season and episode when `type` is `movie`.
 */
export interface DrillParams extends LookupParams {
  season?: number | undefined;
  episode?: number | undefined;
}

export interface TmdbParams extends DrillParams {
  /**
   * Which TMDB numbering the id is in: a film and a show can share an id. Sent as
   * `/v1/by-tmdb/movie/:id` or `/v1/by-tmdb/tv/:id`. A `season` or `episode` implies
   * `tv`. With none of them, the untyped `/v1/by-tmdb/:id` is called, which answers
   * with the film when both exist.
   */
  type?: TmdbType | undefined;
}

/**
 * The `lang` query value: every tag from `lang` (comma separated) and `languages`, as
 * corpus codes, deduplicated, in the caller's order. Undefined when nothing was asked.
 */
export function langParam(
  lang: string | undefined,
  languages: readonly string[] | undefined,
): string | undefined {
  const tags = [...(lang ?? '').split(','), ...(languages ?? [])];
  const codes = [...new Set(tags.map(corpusLanguage).filter(Boolean))];
  return codes.length ? codes.join(',') : undefined;
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
  private readonly downloadClient: string | undefined;
  private readonly antispamId: string | undefined;
  private readonly key: string | undefined;

  constructor(opts: ClientOptions = {}) {
    this.apiBase = (opts.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '');
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new SubtitleDbError({ message: 'no fetch implementation available' });
    }
    // Stored as given and always called detached, never as `this.doFetch(...)`. A
    // native fetch invoked as a method of this object is an "Illegal invocation" in
    // every browser. Calling detached also leaves an already-bound wrapper alone,
    // which binding to globalThis would not, and covers a fetch from another realm
    // that is the platform's but not identical to this global.
    this.doFetch = f;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.retries = opts.retries ?? 2;
    this.client = opts.client;
    this.downloadClient = opts.downloadClient ?? opts.client;
    this.antispamId = opts.antispamId;
    this.key = opts.key?.trim() || undefined;
    if (this.key && plainHttp(this.apiBase)) {
      throw new SubtitleDbError({
        message: 'apiBase is http; a key is only sent over https',
        code: 'bad_request',
        url: this.apiBase,
      });
    }
  }

  /** The key header, when there is a key. None otherwise, so a keyless call needs no preflight. */
  private auth(): Record<string, string> {
    return this.key ? { authorization: `Bearer ${this.key}` } : {};
  }

  private url(path: string, params: Record<string, string | number | undefined> = {}): string {
    const u = new URL(this.apiBase + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') u.searchParams.set(k, String(v));
    }
    if (this.client) u.searchParams.set('client', this.client);
    if (this.antispamId) u.searchParams.set('antispam_id', this.antispamId);
    return u.toString();
  }

  /** A fetch that threw: our own timeout, or the network. */
  private failed(url: string, cause: unknown, message: string): SubtitleDbError {
    const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
    return new SubtitleDbError({
      message: timedOut ? `no answer within ${this.timeoutMs} ms` : message,
      status: 0,
      code: timedOut ? 'timeout' : 'transport_error',
      url,
      cause,
    });
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
          headers: { accept: 'application/json', ...this.auth() },
          signal: joinSignals(AbortSignal.timeout(this.timeoutMs), signal),
        });
      } catch (cause) {
        if (signal?.aborted) throw new SubtitleDbAbort();
        // Covers the browser opaque failure for a cross-origin rejection that never
        // received CORS headers. There is no body to read in that case, by
        // construction, so nothing below may depend on one.
        last = this.failed(url, cause, 'network request failed');
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
   * bundle. Every verb returns `{title, subtitles}` plus the verb's own extras:
   * `subtitles` is the page for the scope asked for, and `seasons`, the tree, is there
   * only for a series root or a season drill. There is nothing to narrow; see
   * LookupBundle.
   *
   * tmdb is the headline key and by-imdb sits right beside it, first-class and the same
   * bundle shape, because media servers identify content by IMDb id. `lang`/`format`/
   * `sort` narrow and order the subtitle bucket the same way on every verb.
   *
   * search() is the one verb that needs a key. Without one, resolve free text with
   * byTitle(), which returns the single closest title.
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
      lang: langParam(p.lang, p.languages),
      format: p.format,
      sort: p.sort,
      response_class: p.response_class,
    };
  }

  /**
   * Look up a title by TMDB id. TMDB numbers films and shows separately, so pass
   * `type: 'movie'` or `type: 'tv'`; the wrong one answers 404. `season`/`episode`
   * narrow a show and, with no `type`, imply `tv`. With `type: 'movie'` they are not
   * sent, since the movie path has no seasons and would answer 404.
   */
  async byTmdb(tmdb: string | number, params: TmdbParams = {}): Promise<LookupBundle> {
    const id = Number(tmdb);
    const type =
      params.type ??
      (params.season !== undefined || params.episode !== undefined ? 'tv' : undefined);
    const drill = type === 'movie' ? '' : this.drill(params.season, params.episode);
    const query = this.pageQuery(params);
    if (!type)
      return this.request<LookupBundle>(
        this.url(`/v1/by-tmdb/${id}${drill}`, query),
        params.signal,
      );
    try {
      return await this.request<LookupBundle>(
        this.url(`/v1/by-tmdb/${type}/${id}${drill}`, query),
        params.signal,
      );
    } catch (err) {
      // The public API has the typed paths. An older deployment at a custom apiBase
      // answers "no route" for them: ask its untyped path with ?type= instead.
      if (!noRoute(err)) throw err;
      return this.request<LookupBundle>(
        this.url(`/v1/by-tmdb/${id}${drill}`, { type, ...query }),
        params.signal,
      );
    }
  }

  /**
   * Look up a title by IMDb id. Accepts 133093, "133093" or "tt0133093". Pass
   * `season`/`episode` to narrow a series. First-class beside byTmdb and the same bundle
   * shape: media servers hand over an IMDb id, so this is the rung that resolves them.
   */
  async byImdb(imdb: string | number, params: DrillParams = {}): Promise<LookupBundle> {
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
   * Search titles by free text: a ranked, paged list, each title with the id of its
   * newest subtitle. Needs a key (`createClient({ key })`); without one it throws
   * before any request, since the API would only answer 401.
   */
  search(q: string, params: SearchParams = {}): Promise<SearchResponse> {
    if (!this.key) {
      // Nothing was sent, so no status, the same as every other refusal made here.
      return Promise.reject(
        new SubtitleDbError({
          message: 'search needs an API key: createClient({ key })',
          code: 'key_required',
        }),
      );
    }
    const { signal, lang, languages, ...query } = params;
    return this.request<SearchResponse>(
      this.url('/v1/by-search', { q, ...query, lang: langParam(lang, languages) }),
      signal,
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
   * Append the download's client name and the antispam id to a URL this client did not
   * build.
   *
   * `url()` handles the /v1 requests; the subtitle download goes to download_url, which
   * points at the /get/ redirect on the API host but is handed to us whole, so it gets
   * the parameters here instead. A download_url that will not parse as a URL is left
   * alone rather than dropped: the download still matters more than the attribution.
   */
  private forDownload(raw: string): string {
    if (!this.downloadClient && !this.antispamId) return raw;
    try {
      const u = new URL(raw);
      if (this.downloadClient) u.searchParams.set('client', this.downloadClient);
      if (this.antispamId) u.searchParams.set('antispam_id', this.antispamId);
      return u.toString();
    } catch {
      return raw;
    }
  }

  /**
   * The address fetchSubtitleText fetches: download_url with the client name and the
   * antispam id on it. For a caller that downloads the file itself, so that download
   * is still put down to the integration and tied to its search.
   */
  downloadUrl(sub: Pick<BundleSubtitle, 'download_url'>): string {
    return this.forDownload(sub.download_url);
  }

  /**
   * Fetch the subtitle bytes as text.
   *
   * Follows download_url as the API returned it, adding only the client name and the
   * antispam id. download_url redirects to wherever the file is served from, so no
   * file URL is ever built here.
   *
   * Returns the stored format untouched. Bytes are decoded as UTF-8, which is what the
   * API sends; a row's `encoding` is the charset the file was uploaded in. Pass
   * `encoding` for a deployment that sends something else.
   *
   * Only the API's own hosts are read from: a download_url pointing anywhere else is
   * refused before it is fetched, since the key would go with the request, and so is
   * an http download_url when a key is set. A web page or an empty body is refused
   * too: a captive portal also answers 200.
   *
   * A refused download carries the API's own code and message: `bad_request`,
   * `bad_key` for a key that is wrong or revoked, `key_required` where one is needed,
   * `rate_limited` past the download allowance. Anything else that is not a subtitle is
   * `download_failed`.
   */
  async fetchSubtitleText(
    sub: Pick<BundleSubtitle, 'download_url' | 'format'>,
    opts: RequestOptions & { encoding?: string | undefined } = {},
  ): Promise<{ text: string; format: string }> {
    const url = this.downloadUrl(sub);
    if (!ours(url, this.apiBase)) {
      const host = hostOf(url);
      throw new SubtitleDbError({
        message: url
          ? `download_url is ${host ? `on ${host}, not the API's hosts` : 'not a URL'}`
          : 'download_url is empty',
        code: 'bad_request',
        url,
      });
    }
    if (this.key && plainHttp(url)) {
      throw new SubtitleDbError({
        message: 'download_url is http; a key is only sent over https',
        code: 'bad_request',
        url,
      });
    }
    const signal = joinSignals(AbortSignal.timeout(this.timeoutMs), opts.signal);
    let res: Response;
    try {
      const doFetch = this.doFetch;
      res = await doFetch(url, { method: 'GET', headers: this.auth(), signal });
    } catch (cause) {
      if (opts.signal?.aborted) throw new SubtitleDbAbort();
      throw this.failed(url, cause, 'subtitle download failed');
    }
    if (!res.ok) {
      // The API says why it refused a download in the same body shape as a lookup:
      // bad_request on 400, bad_key on 401, key_required on 403, rate_limited on 429.
      let body: Partial<ApiErrorBody> | undefined;
      if ([400, 401, 403, 429].includes(res.status)) {
        try {
          body = (await res.json()) as Partial<ApiErrorBody>;
        } catch {
          body = undefined;
        }
      }
      throw new SubtitleDbError({
        message: body?.message ?? `subtitle download failed with ${res.status}`,
        status: res.status,
        code: body?.error ?? 'download_failed',
        hint: body?.hint,
        url,
      });
    }
    // A browser follows the redirect before this code sees it, so where it ended is
    // checked after. An empty res.url is a fetch that does not report one.
    if (res.url && !ours(res.url, this.apiBase)) {
      throw new SubtitleDbError({
        message: `subtitle download ended off the API's hosts, on ${hostOf(res.url)}`,
        code: 'download_failed',
        url,
      });
    }
    const text = opts.encoding
      ? decodeBytes(new Uint8Array(await res.arrayBuffer()), opts.encoding)
      : await res.text();
    const head = text.trimStart().slice(0, 14).toLowerCase();
    if (!head || head.startsWith('<!doctype html') || head.startsWith('<html')) {
      throw new SubtitleDbError({
        message: `the download was ${head ? 'a web page' : 'empty'}, not a subtitle`,
        code: 'download_failed',
        url,
      });
    }
    return { text, format: sub.format };
  }

  /** Absolute URL for a TMDB artwork path, proxied through our own host. */
  posterUrl(path: string | null | undefined, size = 'w342'): string | null {
    if (!path) return null;
    return `${this.apiBase}/p/${size}${path.startsWith('/') ? path : `/${path}`}`;
  }
}

/** The public API host and the files host its /get/ redirect goes to. */
const API_HOSTS = new Set(['api.thesubtitledb.org', 'files.thesubtitledb.org']);

/**
 * True for the API's hosts, the configured apiBase host and its siblings (a
 * deployment's own files host), nothing else.
 */
function ours(raw: string, apiBase: string): boolean {
  const host = hostOf(raw);
  if (API_HOSTS.has(host)) return true;
  const base = hostOf(apiBase);
  if (!host || !base) return false;
  if (host === base) return true;
  const root = base.split('.').slice(-2).join('.');
  return host === root || host.endsWith(`.${root}`);
}

/** A 404 for a path the API has no route for, as opposed to an id it has no title for. */
function noRoute(err: unknown): boolean {
  return err instanceof SubtitleDbError && err.status === 404 && err.message.startsWith('no route');
}

/** True for an http: URL. */
function plainHttp(raw: string): boolean {
  try {
    return new URL(raw).protocol === 'http:';
  } catch {
    return false;
  }
}

/** The hostname of a URL, or '' for anything that does not parse as one. */
function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
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
