/**
 * Line one subtitle file up against another of the same video by cue times alone.
 *
 * Two files of one film in two languages start their lines at nearly the same moments,
 * whatever words they hold. Every pair of cue starts within {@link RANGE_MS} of each
 * other votes for the difference between them; the true offset collects one vote per
 * line, every other difference collects noise spread evenly over the range. The
 * densest one-second window wins if it stands clear of that noise.
 */
import type { Cue } from './transform.js';
import type { SpeechCue } from './types.js';

/** How far apart two files may be and still be lined up. */
export const RANGE_MS = 120_000;
const BIN_MS = 200;
/** Votes within this of the peak are the peak's. */
const WINDOW_MS = 500;
/** The peak's lines above the noise, as a share of the shorter file. */
const MIN_SHARE = 0.25;
const MIN_LINES = 8;
/** Enough of each file to decide; the rest only adds pairs. */
const MAX_CUES = 600;

export interface LineUp {
  /** Milliseconds to add to `other` so it lines up with `ref`. */
  ms: number;
  /** Lines of `other` that agreed. */
  lines: number;
}

/** The offset that lines `other` up with `ref`, or null when nothing stands out. */
export function lineUp(ref: Cue[], other: Cue[]): LineUp | null {
  const a = ref
    .slice(0, MAX_CUES * 2)
    .map((c) => c.start)
    .sort((x, y) => x - y);
  const b = other.slice(0, MAX_CUES).map((c) => c.start);
  const n = Math.min(a.length, b.length);
  if (n < MIN_LINES) return null;

  const bins = new Map<number, number>();
  let pairs = 0;
  let lo = 0;
  for (const t of b) {
    while (lo < a.length && (a[lo] as number) < t - RANGE_MS) lo++;
    for (let i = lo; i < a.length && (a[i] as number) <= t + RANGE_MS; i++) {
      const bin = Math.round(((a[i] as number) - t) / BIN_MS);
      bins.set(bin, (bins.get(bin) ?? 0) + 1);
      pairs++;
    }
  }

  const reach = Math.round(WINDOW_MS / BIN_MS);
  let best = 0;
  let peak = 0;
  for (const bin of bins.keys()) {
    let sum = 0;
    for (let k = -reach; k <= reach; k++) sum += bins.get(bin + k) ?? 0;
    if (sum > peak || (sum === peak && Math.abs(bin) < Math.abs(best))) {
      peak = sum;
      best = bin;
    }
  }
  const noise = (pairs * (2 * reach + 1) * BIN_MS) / (2 * RANGE_MS);
  if (peak - noise < Math.max(MIN_LINES, MIN_SHARE * n)) return null;

  // The median of the votes in the window, and how many lines of `other` cast one.
  const centre = best * BIN_MS;
  const votes: number[] = [];
  let lines = 0;
  for (const t of b) {
    let hit = false;
    for (const s of a) {
      const d = s - t - centre;
      if (d < -WINDOW_MS) continue;
      if (d > WINDOW_MS) break;
      votes.push(d + centre);
      hit = true;
    }
    if (hit) lines++;
  }
  votes.sort((x, y) => x - y);
  return { ms: Math.round(votes[votes.length >> 1] ?? centre), lines };
}

/** How far a heard word trigram may sit from the file's and still agree. */
const AGREE_MS = 5000;
/** One word per character where a script has no spaces. */
const WORDS = /[฀-໿က-႟ក-៿぀-ヿ㐀-鿿]|[\p{L}\p{N}]+/gu;

function grams(cues: readonly SpeechCue[]): Array<[string, number]> {
  const ws: string[] = [];
  const at: number[] = [];
  for (const c of cues) {
    for (const w of c.text.toLowerCase().match(WORDS) ?? []) {
      ws.push(w);
      at.push(c.start_ms);
    }
  }
  const out: Array<[string, number]> = [];
  for (let i = 0; i + 2 < ws.length; i++)
    out.push([`${ws[i]} ${ws[i + 1]} ${ws[i + 2]}`, at[i] as number]);
  return out;
}

/**
 * How much of what was heard a subtitle file also says at that moment: the distinct
 * word trigrams of `heard`, and how many of them `file` holds within 5 s. `file` is
 * already shifted onto the video.
 */
export function agreement(
  file: readonly SpeechCue[],
  heard: readonly SpeechCue[],
): { hits: number; total: number } {
  const at = new Map<string, number[]>();
  for (const [g, ms] of grams(file)) {
    const l = at.get(g);
    if (l) l.push(ms);
    else at.set(g, [ms]);
  }
  const seen = new Set<string>();
  let hits = 0;
  for (const [g, ms] of grams(heard)) {
    if (seen.has(g)) continue;
    seen.add(g);
    if (at.get(g)?.some((t) => Math.abs(t - ms) <= AGREE_MS)) hits++;
  }
  return { hits, total: seen.size };
}
