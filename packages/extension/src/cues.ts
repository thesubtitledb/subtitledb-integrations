/**
 * Which cue is on screen, and what its text is made of. Pure, so it runs under Node.
 */
import type { Cue } from '@subtitledb/core';

/**
 * The cues showing at `ms`, in file order. `offsetMs` moves the subtitle: positive
 * shows every line later. Cues are sorted by start, so a binary search finds the last
 * one that has started and the walk back stops at the first that ended long before.
 */
export function cuesAt(cues: readonly Cue[], ms: number, offsetMs = 0): Cue[] {
  const t = ms - offsetMs;
  let lo = 0;
  let hi = cues.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((cues[mid] as Cue).start <= t) lo = mid + 1;
    else hi = mid;
  }
  const out: Cue[] = [];
  // Overlapping cues are rare and short; a lookback of 16 covers every file seen.
  for (let i = lo - 1; i >= 0 && i >= lo - 16; i--) {
    const c = cues[i] as Cue;
    if (c.end > t) out.unshift(c);
  }
  return out;
}

/** Sorted by start, as cuesAt needs. A file is usually sorted already. */
export function sortCues(cues: readonly Cue[]): Cue[] {
  return [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
}

/** A run of cue text and the styles it sits inside. */
export interface Span {
  text: string;
  b: boolean;
  i: boolean;
  u: boolean;
}

/**
 * Cue text as styled runs, one array per line. Only b, i and u survive; every other
 * tag (voice, class, ruby, timestamps) is dropped and its text kept. Entities are
 * decoded here because the text is set with textContent, never innerHTML.
 */
export function cueLines(text: string): Span[][] {
  const lines: Span[][] = [];
  const open = { b: 0, i: 0, u: 0 };
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line: Span[] = [];
    for (const part of raw.split(/(<\/?[^>]*>)/)) {
      if (!part) continue;
      const tag = /^<(\/?)([biu])(?:[.\s][^>]*)?>$/i.exec(part);
      if (tag) {
        const k = (tag[2] as string).toLowerCase() as 'b' | 'i' | 'u';
        open[k] = Math.max(0, open[k] + (tag[1] ? -1 : 1));
        continue;
      }
      if (part.startsWith('<') && part.endsWith('>')) continue;
      const t = decode(part);
      if (t) line.push({ text: t, b: open.b > 0, i: open.i > 0, u: open.u > 0 });
    }
    lines.push(line);
  }
  while (lines.length && !lines[lines.length - 1]?.length) lines.pop();
  return lines;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  nbsp: ' ',
  lrm: '‎',
  rlm: '‏',
  quot: '"',
  apos: "'",
};

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** "+1.5 s", "-0.25 s", "0 s": the offset as the popup shows it. */
export function formatOffset(ms: number): string {
  if (!ms) return '0 s';
  const s = (Math.abs(ms) / 1000).toFixed(2).replace(/\.?0+$/, '');
  return `${ms > 0 ? '+' : '-'}${s} s`;
}
