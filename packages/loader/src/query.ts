/**
 * The query API at the loader surface.
 *
 * The work is in core and rides the engine chunk; this file is the thin lazy edge of
 * it. `query`/`get` load the engine once and hand back results whose bytes are still
 * not fetched. `toBlobUrl`/`toTrack` are the DOM half, and they are deliberately sync
 * and self-contained: pulling them from core would bundle core into this always-loaded
 * entry and defeat the whole point of splitting.
 */
import type { LoadedQuery, QueryOptions, QueryResult, QuerySubtitle } from '@subtitledb/core';
import { chunk } from './chunks.js';
import { ANTISPAM_ID, CLIENT } from './ids.js';

/** A query result at this layer: what core returns, plus lazy DOM handles. */
export interface WiredSubtitle extends QuerySubtitle {
  /** load(), then a blob URL. The caller revokes it with URL.revokeObjectURL. */
  blobUrl(): Promise<string>;
  /** load(), then a <track> element ready to append to a media element. */
  track(): Promise<HTMLTrackElement>;
}

export interface WiredResult extends Omit<QueryResult, 'results'> {
  results: WiredSubtitle[];
}

/** A loaded top result from get(): the bytes, plus a blob URL and a <track> already made. */
export interface GotSubtitle extends LoadedQuery {
  subtitle: QuerySubtitle['subtitle'];
  url: string;
  blobUrl: string;
  track: HTMLTrackElement;
}

// Mirrors core's subtitleMime. A <track> only ever wants text/vtt, but a passthrough
// result (convertTo unset) keeps its stored format and needs the right type on the blob.
const MIME: Record<string, string> = { vtt: 'text/vtt', ass: 'text/x-ssa', ssa: 'text/x-ssa' };

/** A blob URL for a loaded subtitle. Same-origin by construction, so a <track> can read it. */
export function toBlobUrl(loaded: LoadedQuery): string {
  const type = MIME[loaded.format.toLowerCase()] ?? 'text/plain';
  return URL.createObjectURL(new Blob([loaded.text], { type: `${type};charset=utf-8` }));
}

/** A <track> element for a loaded subtitle, labelled and language-tagged. */
export function toTrack(loaded: LoadedQuery): HTMLTrackElement {
  const el = document.createElement('track');
  el.kind = 'subtitles';
  el.label = loaded.label;
  el.srclang = loaded.language;
  el.src = toBlobUrl(loaded);
  return el;
}

function wire(r: QuerySubtitle): WiredSubtitle {
  return {
    ...r,
    blobUrl: async () => toBlobUrl(await r.load()),
    track: async () => toTrack(await r.load()),
  };
}

/** Stamp in the loader's client name and per-page-load antispam id, unless the caller set them. */
function withIds(opts: QueryOptions): QueryOptions {
  return { clientName: CLIENT, antispamId: ANTISPAM_ID, ...opts };
}

/**
 * Ask what subtitles exist for a title. Loads the engine chunk once, then returns ranked
 * results, each with its URL and a lazy convert-aware load()/blobUrl()/track(). Nothing
 * is downloaded until one of those is called.
 */
export async function query(opts: QueryOptions, moduleUrl?: string): Promise<WiredResult> {
  const engine = await chunk('engine', moduleUrl);
  const result = await engine.query(withIds(opts));
  return { ...result, results: result.results.map(wire) };
}

/**
 * query(), then load the top result. Returns it as a loaded subtitle with a blob URL and
 * a <track> already made, or null when nothing matched. The one-liner for "give me the
 * best subtitle for this, ready to drop in".
 */
export async function get(opts: QueryOptions, moduleUrl?: string): Promise<GotSubtitle | null> {
  const engine = await chunk('engine', moduleUrl);
  const result = await engine.query(withIds(opts));
  const top = result.results[0];
  if (!top) return null;
  const loaded = await top.load();
  return {
    ...loaded,
    subtitle: top.subtitle,
    url: top.url,
    blobUrl: toBlobUrl(loaded),
    track: toTrack(loaded),
  };
}
