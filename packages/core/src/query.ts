/**
 * The query API: ask what subtitles exist for a title and get them back as data, so a
 * caller can wire them into their own player instead of handing us the element.
 *
 * A thin layer over the session. resolve() already does the whole match ladder and
 * returns ranked candidates carrying an absolute, auth-free download_url; query() maps
 * those to results and attaches a lazy `load()` that fetches the bytes and applies the
 * convert options only when it is called. Nothing is downloaded by query() itself, the
 * same eager/lazy split the adapters rely on.
 *
 * DOM lives one layer up in the loader (blob URLs, <track>). This module stays pure so
 * it runs and tests under Node with no browser globals.
 */
import type { ClientOptions, SubtitleDbClient } from './client.js';
import { CONVERTIBLE, toVtt } from './convert.js';
import { SubtitleDbError } from './errors.js';
import { isResolvable, type MediaHint } from './identify.js';
import { type Candidate, candidateLabel, type MatchTier, PAGE } from './match.js';
import { createSession } from './session.js';
import { type Cue, parseVtt, rescale, serialize, shift } from './transform.js';
import type { BundleSubtitle, LanguageCode, LookupTitle } from './types.js';

/**
 * How to convert a result on load. All optional; absent means the subtitle is returned
 * in its stored format, untouched.
 */
export interface QueryConvert {
  /** Convert to WebVTT. Any of the transforms below implies this. */
  convertTo?: 'vtt' | undefined;
  /** Decode the source bytes with this charset. `'auto'` sniffs a BOM. Default UTF-8. */
  encoding?: string | undefined;
  /** Shift every cue by this many milliseconds. Negative pulls earlier. Applied before `fps`. */
  offsetMs?: number | undefined;
  /**
   * Rescale cue times from one frame rate to another, after `offsetMs` has been
   * applied. `from` defaults to the subtitle's own fps.
   */
  fps?: { from?: number | undefined; to: number } | undefined;
  /** Include the parsed cues on the loaded result. */
  cues?: boolean | undefined;
}

export interface QueryOptions extends QueryConvert {
  /**
   * What is playing. Same shape resolve() takes: imdbId, tmdbId (with tmdbType), a
   * seriesImdbId with season and episode, or title/year/season/episode.
   */
  hint?: MediaHint | undefined;
  /** Preferred languages, best first, as tags (`en-US`, `pt-BR`). Each is fetched and merged. */
  languages?: string[] | undefined;
  /** One language, as a tag. Added to `languages`. */
  lang?: string | undefined;
  hearingImpaired?: boolean | undefined;
  /** Candidates per language. */
  limit?: number | undefined;
  /** Correlation id sent on every request. The loader supplies its per-page-load value. */
  antispamId?: string | undefined;
  apiBase?: string | undefined;
  clientName?: string | undefined;
  /** The name a download is recorded under; see ClientOptions.downloadClient. */
  downloadClient?: string | undefined;
  fetch?: ClientOptions['fetch'];
  /** See ClientOptions.removeWatermark. */
  removeWatermark?: ClientOptions['removeWatermark'];
  /** An API key; see ClientOptions.key. */
  key?: string | undefined;
}

/** A loaded subtitle: bytes plus what a player needs to label and tag the track. */
export interface LoadedQuery {
  text: string;
  /** `'vtt'` after any conversion, otherwise the stored format. */
  format: string;
  language: LanguageCode;
  label: string;
  /** Present only when `cues: true` was asked for. */
  cues?: Cue[];
}

/** One subtitle in a query result: metadata, a URL, and a lazy convert-aware loader. */
export interface QuerySubtitle {
  /** The full wire record, for any field not surfaced below. */
  subtitle: BundleSubtitle;
  id: number;
  language: LanguageCode;
  /** Stored format. What `load()` returns unless a conversion was requested. */
  format: string;
  /** Human-readable, safe to show in a picker. */
  label: string;
  /** Release name when the corpus has one, else empty. */
  release: string;
  hearingImpaired: boolean;
  /**
   * Absolute, auth-free, CORS-clean, and carrying the antispam id when one is set, so a
   * download made from it still ties to this query. Fetch it yourself, or call load().
   */
  url: string;
  /** Fetch the bytes and apply the query's convert options. Memoised: called twice, fetched once. */
  load(): Promise<LoadedQuery>;
}

export interface QueryResult {
  hint: MediaHint;
  title: LookupTitle | null;
  tier: MatchTier;
  results: QuerySubtitle[];
}

async function loadOne(
  fetchText: () => Promise<{ text: string; format: string }>,
  sub: BundleSubtitle,
  label: string,
  convert: QueryConvert,
): Promise<LoadedQuery> {
  const got = await fetchText();
  const language = sub.language;
  const wantsTransform =
    convert.offsetMs !== undefined || convert.fps !== undefined || convert.cues === true;

  if (convert.convertTo !== 'vtt' && !wantsTransform) {
    return { text: got.text, format: got.format, language, label };
  }
  const vtt = toVtt(got.text, got.format);
  if (!wantsTransform) return { text: vtt, format: 'vtt', language, label };

  // The offset first, then the rescale, so the offset is in the subtitle's own
  // milliseconds and is itself rescaled with them.
  let cues = parseVtt(vtt);
  if (convert.offsetMs) cues = shift(cues, convert.offsetMs);
  if (convert.fps) {
    const from = convert.fps.from ?? sub.fps ?? undefined;
    if (from) cues = rescale(cues, from, convert.fps.to);
  }
  return {
    text: serialize(cues),
    format: 'vtt',
    language,
    label,
    ...(convert.cues ? { cues } : {}),
  };
}

/**
 * Resolve a title to ranked subtitles, each with a lazy loader.
 *
 * `formats` is set to every convertible format rather than one player's list, because a
 * query result is for a caller's own player and must not be pre-filtered to what ours
 * would render.
 *
 * Unlike a session's resolve(), this throws: a caller asking for data wants to know
 * why there is none. A hint with nothing to look up by is refused before any request
 * (`bad_request`); an API refusal carries the API's own code and message; a hint that
 * matches no title is `not_found`. A title with no subtitles in the languages asked
 * for is not an error: it returns no results.
 */
export async function query(opts: QueryOptions): Promise<QueryResult> {
  const hint = opts.hint ?? {};
  if (!isResolvable(hint)) {
    throw new SubtitleDbError({
      message: 'query needs an imdbId, a tmdbId, a seriesImdbId or a title in hint',
      code: 'bad_request',
    });
  }
  const languages = [...(opts.lang ? [opts.lang] : []), ...(opts.languages ?? [])];
  // One call, so its budget is exactly what it asks for: a lookup per language per
  // page of `limit`, plus one.
  const pages = Math.max(1, Math.ceil((opts.limit ?? PAGE) / PAGE));
  const maxRequests = 1 + Math.max(1, languages.length) * pages;

  // resolve() reports and returns empty rather than throwing. The report is kept here
  // and thrown once resolve() has returned, so the caller gets the failure, not [].
  let failure: unknown;
  const session = createSession({
    formats: [...CONVERTIBLE],
    maxRequests,
    ...(languages.length ? { languages } : {}),
    ...(opts.hearingImpaired !== undefined ? { hearingImpaired: opts.hearingImpaired } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.antispamId !== undefined ? { antispamId: opts.antispamId } : {}),
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.clientName !== undefined ? { clientName: opts.clientName } : {}),
    ...(opts.downloadClient !== undefined ? { downloadClient: opts.downloadClient } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
    ...(opts.removeWatermark !== undefined ? { removeWatermark: opts.removeWatermark } : {}),
    ...(opts.key !== undefined ? { key: opts.key } : {}),
    onError: (err) => {
      failure ??= err;
    },
  });

  const convert: QueryConvert = {
    ...(opts.convertTo !== undefined ? { convertTo: opts.convertTo } : {}),
    ...(opts.encoding !== undefined ? { encoding: opts.encoding } : {}),
    ...(opts.offsetMs !== undefined ? { offsetMs: opts.offsetMs } : {}),
    ...(opts.fps !== undefined ? { fps: opts.fps } : {}),
    ...(opts.cues !== undefined ? { cues: opts.cues } : {}),
  };

  const result = await session.resolve(hint);
  if (failure !== undefined) throw failure;
  // Every rung answered 404.
  if (result.tier === 'manual') {
    throw new SubtitleDbError({
      message: `no title found for ${describe(hint)}`,
      status: 404,
      code: 'not_found',
    });
  }
  const results = result.candidates.map((c) => wrap(session.client, c, convert));
  return { hint: result.hint, title: result.title, tier: result.tier, results };
}

/** The strongest thing a hint looks up by, for a message. */
function describe(h: MediaHint): string {
  if (h.imdbId) return `imdbId ${h.imdbId}`;
  if (h.tmdbId) return `tmdbId ${h.tmdbId}`;
  if (h.seriesImdbId) return `seriesImdbId ${h.seriesImdbId}`;
  return `title "${h.title ?? ''}"`;
}

function wrap(client: SubtitleDbClient, c: Candidate, convert: QueryConvert): QuerySubtitle {
  const sub = c.subtitle;
  const label = candidateLabel(c);
  let cached: Promise<LoadedQuery> | undefined;
  const load = () =>
    (cached ??= loadOne(
      () => client.fetchSubtitleText(sub, convert.encoding ? { encoding: convert.encoding } : {}),
      sub,
      label,
      convert,
    ));
  return {
    subtitle: sub,
    id: sub.id,
    language: sub.language,
    format: sub.format,
    label,
    release: sub.release_name,
    hearingImpaired: sub.hearing_impaired,
    url: client.downloadUrl(sub),
    load,
  };
}
