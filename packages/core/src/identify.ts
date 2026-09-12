import { basename, parseFilename } from './filename.js';

/**
 * What we believe we are watching. Every field is optional because the whole point
 * is that different players know different things: Jellyfin hands over an IMDb id,
 * a bare video tag hands over a URL and nothing else.
 */
export interface MediaHint {
  imdbId?: string;
  tmdbId?: number;
  /** For TV, the id of the series rather than the episode, when that is what we hold. */
  seriesImdbId?: string;
  title?: string;
  /** For TV, the name of the one episode. Separates it from the rest of the series. */
  episodeTitle?: string;
  year?: number;
  season?: number;
  episode?: number;
  /**
   * The file's own release name, without the container: the thing a subtitle's
   * release_name has to agree with for the timings to line up.
   */
  release?: string;
  /** Where the strongest field came from. Diagnostics only. */
  source?: HintSource;
}

export type HintSource = 'config' | 'dataset' | 'metadata' | 'filename';

export interface IdentifyOptions {
  /** Explicit values from the integration config. Highest precedence. */
  config?: MediaHint;
  /** The media element, read for data-* attributes and currentSrc. */
  element?: Element | null;
  /** Source URL or path, when not derivable from the element. */
  src?: string;
  /** Document to scrape for og: and JSON-LD metadata. Defaults to globalThis.document. */
  doc?: Document | null;
}

const IMDB_RE = /\b(tt\d{6,9})\b/;

function num(v: string | null | undefined): number | undefined {
  if (v === null || v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function fromDataset(el: Element | null | undefined): MediaHint {
  if (!el || !('dataset' in el)) return {};
  const d = (el as HTMLElement).dataset;
  const hint: MediaHint = {};
  const imdb = d.imdbId ?? d.imdb;
  if (imdb && IMDB_RE.test(imdb)) hint.imdbId = IMDB_RE.exec(imdb)?.[1];
  const tmdb = num(d.tmdbId ?? d.tmdb);
  if (tmdb !== undefined) hint.tmdbId = tmdb;
  if (d.title) hint.title = d.title;
  const year = num(d.year);
  if (year !== undefined) hint.year = year;
  const season = num(d.season);
  if (season !== undefined) hint.season = season;
  const episode = num(d.episode);
  if (episode !== undefined) hint.episode = episode;
  return hint;
}

function metaContent(doc: Document, selector: string): string | undefined {
  const el = doc.querySelector(selector);
  const v = el?.getAttribute('content') ?? undefined;
  return v && v.trim() !== '' ? v.trim() : undefined;
}

/**
 * Walk JSON-LD looking for a Movie / TVEpisode / VideoObject node. `sameAs` and `url`
 * commonly carry an IMDb link, which is the single most valuable thing a page can
 * tell us, so it is worth digging for.
 */
const LD_TYPES = new Set(['Movie', 'TVEpisode', 'TVSeries', 'VideoObject', 'Episode']);

function fromJsonLd(doc: Document): MediaHint {
  const hint: MediaHint = {};
  const nodes = doc.querySelectorAll('script[type="application/ld+json"]');

  for (const node of Array.from(nodes)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(node.textContent ?? '');
    } catch {
      continue;
    }

    // JSON-LD nests freely (@graph, arrays, itemListElement), so walk the whole tree
    // rather than assuming a shape. Depth is bounded by the document, and a visited
    // set keeps a self-referential graph from looping.
    const seen = new Set<object>();
    const stack: unknown[] = [parsed];

    while (stack.length) {
      const cur = stack.pop();
      if (Array.isArray(cur)) {
        stack.push(...cur);
        continue;
      }
      if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
      seen.add(cur);

      const o = cur as Record<string, unknown>;
      for (const v of Object.values(o)) {
        if (v && typeof v === 'object') stack.push(v);
      }

      const type = String(o['@type'] ?? '');
      if (!LD_TYPES.has(type)) continue;

      // sameAs and url routinely carry the IMDb permalink, which is the single most
      // valuable thing a page can tell us.
      for (const raw of [o.sameAs, o.url].flat()) {
        if (typeof raw !== 'string') continue;
        const m = IMDB_RE.exec(raw);
        if (m?.[1] && hint.imdbId === undefined) hint.imdbId = m[1];
      }

      if (hint.title === undefined && typeof o.name === 'string') hint.title = o.name;
      if (hint.year === undefined && typeof o.datePublished === 'string') {
        const y = Number(o.datePublished.slice(0, 4));
        if (Number.isFinite(y) && y > 1900) hint.year = y;
      }
      if (hint.episode === undefined) {
        const ep = num(typeof o.episodeNumber === 'number' ? String(o.episodeNumber) : undefined);
        if (ep !== undefined) hint.episode = ep;
      }
      const season = o.partOfSeason;
      if (hint.season === undefined && season && typeof season === 'object') {
        const sn = (season as Record<string, unknown>).seasonNumber;
        const s = num(typeof sn === 'number' || typeof sn === 'string' ? String(sn) : undefined);
        if (s !== undefined) hint.season = s;
      }
      const series = o.partOfSeries;
      if (series && typeof series === 'object') {
        for (const raw of [(series as Record<string, unknown>).sameAs].flat()) {
          if (typeof raw !== 'string') continue;
          const m = IMDB_RE.exec(raw);
          if (m?.[1] && hint.seriesImdbId === undefined) hint.seriesImdbId = m[1];
        }
      }
    }
  }
  return hint;
}

/** Read og: and itemprop metadata, plus any IMDb link anywhere in the head. */
function fromDocument(doc: Document | null | undefined): MediaHint {
  if (!doc) return {};
  const hint: MediaHint = {};

  const title =
    metaContent(doc, 'meta[property="og:title"]') ??
    metaContent(doc, 'meta[name="twitter:title"]') ??
    metaContent(doc, 'meta[itemprop="name"]');
  if (title) hint.title = title;

  const date =
    metaContent(doc, 'meta[property="video:release_date"]') ??
    metaContent(doc, 'meta[itemprop="datePublished"]');
  if (date) {
    const y = Number(date.slice(0, 4));
    if (Number.isFinite(y) && y > 1900) hint.year = y;
  }

  const season = num(metaContent(doc, 'meta[property="video:series_season"]'));
  if (season !== undefined) hint.season = season;
  const episode = num(metaContent(doc, 'meta[property="video:episode"]'));
  if (episode !== undefined) hint.episode = episode;

  // Any IMDb link in the document is a strong signal and costs one query to find.
  const link = doc.querySelector('a[href*="imdb.com/title/tt"], link[href*="imdb.com/title/tt"]');
  const href = link?.getAttribute('href');
  const m = href ? IMDB_RE.exec(href) : null;
  if (m?.[1]) hint.imdbId = m[1];

  return hint;
}

function fromSrc(src: string | undefined): MediaHint {
  if (!src) return {};
  const parsed = parseFilename(src);
  const hint: MediaHint = {};
  // Kept whether or not a title survived: a subtitle recorded against this exact
  // encode is the one that will be in sync, and that comparison needs the raw name.
  if (parsed.release) hint.release = parsed.release;
  if (parsed.title) hint.title = parsed.title;
  if (parsed.year !== null) hint.year = parsed.year;
  if (parsed.season !== null) hint.season = parsed.season;
  if (parsed.episode !== null) hint.episode = parsed.episode;
  // An IMDb id embedded in a path or filename is rare but unambiguous when present.
  const m = IMDB_RE.exec(basename(src));
  if (m?.[1]) hint.imdbId = m[1];
  return hint;
}

/** Later sources fill only the gaps left by earlier ones. */
function merge(into: MediaHint, from: MediaHint, source: HintSource): MediaHint {
  const out: MediaHint = { ...into };
  let used = false;
  for (const [k, v] of Object.entries(from) as [keyof MediaHint, never][]) {
    if (v === undefined || k === 'source') continue;
    if (out[k] === undefined) {
      out[k] = v;
      used = true;
    }
  }
  if (used && out.source === undefined) out.source = source;
  return out;
}

/**
 * Build the best hint available, preferring explicit configuration over anything
 * scraped. Never throws: a hint with no usable fields is a legitimate outcome and
 * the match ladder handles it by falling through to the manual picker.
 */
export function identify(opts: IdentifyOptions = {}): MediaHint {
  const el = opts.element ?? null;
  const src =
    opts.src ??
    (el && 'currentSrc' in el ? (el as HTMLMediaElement).currentSrc || undefined : undefined) ??
    (el && 'src' in el ? (el as HTMLMediaElement).src || undefined : undefined);

  const doc = opts.doc === undefined ? (globalThis.document ?? null) : opts.doc;

  let hint: MediaHint = {};
  if (opts.config) hint = merge(hint, opts.config, 'config');
  hint = merge(hint, fromDataset(el), 'dataset');
  // JSON-LD before og:, because a structured Movie node carries an IMDb permalink
  // while og:title carries a string somebody wrote for social previews.
  if (doc) hint = merge(hint, fromJsonLd(doc), 'metadata');
  hint = merge(hint, fromDocument(doc), 'metadata');
  hint = merge(hint, fromSrc(src), 'filename');
  return hint;
}

/**
 * What a media element knows about itself, in the form resolve() takes.
 *
 * Every adapter defaults to this when the host page passes no explicit hint, and
 * they all have to default to the same thing: an integration that identifies the
 * film on one player and nothing on another is not one integration. Kept here
 * rather than in each adapter so the two cannot drift apart.
 */
export function elementIdentity(el: unknown): IdentifyOptions {
  if (!el || typeof el !== 'object') return {};
  const media = el as { currentSrc?: string; src?: string };
  const src = media.currentSrc || media.src;
  return { element: el as Element, ...(src ? { src } : {}) };
}

/** True when the hint carries enough to attempt any lookup at all. */
export function isResolvable(hint: MediaHint): boolean {
  return Boolean(hint.imdbId || hint.tmdbId || (hint.title && hint.title.length > 1));
}
