/**
 * Which stretch of audio to transcribe next.
 *
 * Two tiers share the work. The live tier keeps a lead ahead of the playhead with a
 * small model and short windows, so a viewer who just turned captions on sees a line
 * within seconds and keeps seeing them. The quality tier re-does everything with a
 * larger model in longer windows, nearest the playhead first, then from the start of
 * the file, and its cues replace the live ones as they land. A seek moves both.
 */
export type Span = [number, number];

/** A sorted set of disjoint spans. */
export class Intervals {
  spans: Span[] = [];

  add(a: number, b: number): void {
    if (b <= a) return;
    const out: Span[] = [];
    let s: Span = [a, b];
    for (const [x, y] of this.spans) {
      if (y < s[0] - 1e-6) out.push([x, y]);
      else if (x > s[1] + 1e-6) out.push([x, y]);
      else s = [Math.min(x, s[0]), Math.max(y, s[1])];
    }
    out.push(s);
    out.sort((p, q) => p[0] - q[0]);
    this.spans = out;
  }

  has(a: number, b: number): boolean {
    return this.spans.some(([x, y]) => x <= a + 1e-6 && y >= b - 1e-6);
  }

  /** The end of the span containing `t`, or `t` when none does. */
  until(t: number): number {
    for (const [x, y] of this.spans) if (x <= t + 1e-6 && y > t) return y;
    return t;
  }

  /** The gaps inside `[a, b)`. */
  gaps(a: number, b: number): Span[] {
    const out: Span[] = [];
    let p = a;
    for (const [x, y] of this.spans) {
      if (y <= p) continue;
      if (x >= b) break;
      if (x > p) out.push([p, Math.min(x, b)]);
      p = Math.max(p, y);
    }
    if (p < b) out.push([p, b]);
    return out;
  }

  total(): number {
    let n = 0;
    for (const [x, y] of this.spans) n += y - x;
    return n;
  }
}

export interface Window {
  t0: number;
  t1: number;
}

export interface LivePlan {
  /** Seconds of the first window: short, so the first cue lands fast. */
  first: number;
  /** Later windows. */
  step: number;
  /** How far ahead of the playhead to stay. Beyond it the live tier idles. */
  lead: number;
}

export const LIVE: LivePlan = { first: 2, step: 6, lead: 30 };
export const QUALITY_WINDOW = 15;

/**
 * The next live window: the first gap at or after the playhead that neither tier has
 * covered, within the lead. `audioUntil` bounds it to decoded audio.
 */
export function nextLive(
  playhead: number,
  done: Intervals,
  audioUntil: (t: number) => number,
  duration: number,
  plan: LivePlan = LIVE,
  fresh = false,
): Window | null {
  const horizon = Math.min(duration || Number.POSITIVE_INFINITY, playhead + plan.lead);
  // A gap earlier than one second of audio is a rounding seam, not work.
  const gap = done.gaps(playhead, horizon).find(([a, b]) => b - a >= 0.5);
  if (!gap) return null;
  const want = fresh ? plan.first : plan.step;
  const t0 = gap[0];
  const t1 = Math.min(gap[1], t0 + want, audioUntil(t0));
  if (t1 - t0 < 0.5) return null;
  return { t0, t1 };
}

/**
 * The next quality window: the nearest gap after the playhead first, so what the
 * viewer is about to watch is upgraded soonest, then the earliest gap in the file.
 */
export function nextQuality(
  playhead: number,
  done: Intervals,
  audioUntil: (t: number) => number,
  duration: number,
  size = QUALITY_WINDOW,
): Window | null {
  const end = duration || Number.POSITIVE_INFINITY;
  const ahead = done.gaps(playhead, end).find(([a, b]) => b - a >= 0.5);
  const behind = done.gaps(0, playhead).find(([a, b]) => b - a >= 0.5);
  const gap = ahead ?? behind;
  if (!gap) return null;
  const t0 = gap[0];
  const t1 = Math.min(gap[1], t0 + size, audioUntil(t0));
  if (t1 - t0 < 0.5) return null;
  return { t0, t1 };
}

/** Thread count for the quality pool: none on a small machine, three at most. */
export function qualityWorkers(cores: number, memoryGb: number | undefined): number {
  if (memoryGb !== undefined && memoryGb < 4) return 0;
  return Math.max(0, Math.min(3, Math.floor((cores - 2) / 3)));
}
