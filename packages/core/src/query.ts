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
import type { MediaHint } from './identify.js';
import { type Candidate, candidateLabel, type MatchTier } from './match.js';
import { createSession } from './session.js';
import { type Cue, parseVtt, rescale, serialize, shift } from './transform.js';
import type { BundleSubtitle, LanguageCode, LookupTitle } from './types.js';

/**
 * How to convert a result on load. All optional; absent means the subtitle is returned
 * in its stored format, untouched.
 */
export interface QueryConvert {
  /** Convert to WebVTT. Any of the transforms below implies this. */
  convertTo?: 'vtt';
  /** Decode the source bytes with this charset. `'auto'` sniffs a BOM. Default UTF-8. */
  encoding?: string;
  /** Shift every cue by this many milliseconds. Negative pulls earlier. */
  offsetMs?: number;
  /** Rescale cue times from one frame rate to another. `from` defaults to the subtitle's own fps. */
  fps?: { from?: number; to: number };
  /** Include the parsed cues on the loaded result. */
  cues?: boolean;
}

export interface QueryOptions extends QueryConvert {
  /** What is playing. Same shape resolve() takes: imdbId, tmdbId, or title/year/season/episode. */
  hint?: MediaHint;
  /** Preferred languages, best first. Each is fetched and merged. */
  languages?: string[];
  hearingImpaired?: boolean;
  /** Candidates per language. */
  limit?: number;
  /** Correlation id sent on every request. The loader supplies its per-page-load value. */
  antispamId?: string;
  apiBase?: string;
  clientName?: string;
  fetch?: ClientOptions['fetch'];
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
 */
export async function query(opts: QueryOptions): Promise<QueryResult> {
  const session = createSession({
    formats: [...CONVERTIBLE],
    ...(opts.languages !== undefined ? { languages: opts.languages } : {}),
    ...(opts.hearingImpaired !== undefined ? { hearingImpaired: opts.hearingImpaired } : {}),
    ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
    ...(opts.antispamId !== undefined ? { antispamId: opts.antispamId } : {}),
    ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
    ...(opts.clientName !== undefined ? { clientName: opts.clientName } : {}),
    ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
  });

  const convert: QueryConvert = {
    ...(opts.convertTo !== undefined ? { convertTo: opts.convertTo } : {}),
    ...(opts.encoding !== undefined ? { encoding: opts.encoding } : {}),
    ...(opts.offsetMs !== undefined ? { offsetMs: opts.offsetMs } : {}),
    ...(opts.fps !== undefined ? { fps: opts.fps } : {}),
    ...(opts.cues !== undefined ? { cues: opts.cues } : {}),
  };

  const result = await session.resolve(opts.hint ?? {});
  const results = result.candidates.map((c) => wrap(session.client, c, convert));
  return { hint: result.hint, title: result.title, tier: result.tier, results };
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
