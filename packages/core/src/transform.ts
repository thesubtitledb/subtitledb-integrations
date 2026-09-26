/**
 * Cue-level transforms for the query API.
 *
 * convert.ts turns a whole subtitle into WebVTT text and stops there, which is all the
 * player adapters need. The query API lets a caller ask for a time shift, a frame-rate
 * rescale or the parsed cues themselves, and those need the cues as data rather than as
 * a string. This module is that missing piece: parse WebVTT into cues, transform them,
 * serialise back. Deliberately small and WebVTT-only, because query() converts to
 * WebVTT first (via toVtt) and every transform below is applied to the result.
 */
import { ConvertError } from './convert.js';

export interface Cue {
  /** Milliseconds from the start of the media. */
  start: number;
  end: number;
  /** Cue payload, already WebVTT-safe because it came through toVtt. */
  text: string;
  /** Trailing cue settings (position, align), kept verbatim when present. */
  settings?: string;
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function normaliseNewlines(s: string): string {
  return stripBom(s).replace(/\r\n?/g, '\n');
}

/**
 * Decode subtitle bytes to text.
 *
 * The API serves whatever a subtitle was stored as, and a large part of the corpus is
 * not UTF-8: Windows-1251 for Cyrillic, Windows-1252 for Western European, and a run
 * of UTF-16 files. `res.text()` always assumes UTF-8, so those arrive as mojibake. A
 * caller that knows, or wants us to guess, passes `encoding`.
 *
 * `'auto'` sniffs a byte-order mark, then falls back to a NUL-density check that
 * catches BOM-less UTF-16LE (the corpus holds some, stored with the high byte zeroed).
 * Everything else is treated as UTF-8, which is both the common case and a superset of
 * ASCII, so a mislabelled Latin-1 file at least keeps its ASCII.
 */
export function decodeBytes(bytes: Uint8Array, encoding = 'auto'): string {
  if (encoding && encoding !== 'auto') {
    try {
      return new TextDecoder(encoding).decode(bytes);
    } catch {
      throw new ConvertError(`unknown encoding ${encoding}`);
    }
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  // BOM-less UTF-16LE reads as text bytes at even offsets and NUL at odd ones. A quarter
  // of the sampled odd bytes being NUL is far past anything valid UTF-8 produces.
  const n = Math.min(bytes.length, 200);
  let nul = 0;
  for (let i = 1; i < n; i += 2) if (bytes[i] === 0) nul++;
  if (n >= 4 && nul > n / 4) return new TextDecoder('utf-16le').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

/** `HH:MM:SS.mmm` and `MM:SS.mmm`, comma or dot, with the hours optional. */
const CUE_LINE =
  /^\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})(.*)$/;

function toMs(h: string | undefined, m: string, s: string, frac: string): number {
  const ms = Number(`${frac}000`.slice(0, 3));
  return ((Number(h ?? '0') * 60 + Number(m)) * 60 + Number(s)) * 1000 + ms;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

function fromMs(total: number): string {
  const ms = Math.max(0, Math.round(total));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms % 1000, 3)}`;
}

/**
 * Parse WebVTT into cues.
 *
 * Blocks are split on blank lines; a block counts only when it holds a timing line.
 * Anything before that line in the block is a cue identifier and is dropped, and the
 * header, NOTE and STYLE blocks carry no timing line so they fall out on their own.
 */
export function parseVtt(input: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of normaliseNewlines(input).split(/\n{2,}/)) {
    const lines = block.split('\n');
    const idx = lines.findIndex((l) => CUE_LINE.test(l));
    if (idx === -1) continue;
    const m = CUE_LINE.exec(lines[idx] as string);
    if (!m) continue;
    const start = toMs(m[1], m[2] as string, m[3] as string, m[4] as string);
    const end = toMs(m[5], m[6] as string, m[7] as string, m[8] as string);
    const settings = (m[9] ?? '').trim();
    const text = lines
      .slice(idx + 1)
      .join('\n')
      .trim();
    cues.push({ start, end, text, ...(settings ? { settings } : {}) });
  }
  return cues;
}

/** Cues back to a WebVTT document. */
export function serialize(cues: Cue[]): string {
  const out: string[] = ['WEBVTT', ''];
  for (const c of cues) {
    out.push(`${fromMs(c.start)} --> ${fromMs(c.end)}${c.settings ? ` ${c.settings}` : ''}`);
    out.push(c.text);
    out.push('');
  }
  return out.join('\n');
}

/** Shift every cue by `ms` (negative pulls earlier), clamped so nothing goes before 0. */
export function shift(cues: Cue[], ms: number): Cue[] {
  return cues.map((c) => ({
    ...c,
    start: Math.max(0, c.start + ms),
    end: Math.max(0, c.end + ms),
  }));
}

/**
 * Rescale cue times for a frame-rate mismatch.
 *
 * `from` is the frame rate the subtitle timings were authored against, `to` the frame
 * rate of the video actually playing. The factor is `from / to`: a 23.976 fps subtitle
 * played over a 25 fps (PAL) transfer needs its times compressed, and 23.976 / 25 < 1
 * does exactly that.
 */
export function rescale(cues: Cue[], from: number, to: number): Cue[] {
  if (!(from > 0) || !(to > 0)) throw new ConvertError(`bad frame rates ${from} -> ${to}`);
  const f = from / to;
  return cues.map((c) => ({ ...c, start: c.start * f, end: c.end * f }));
}
