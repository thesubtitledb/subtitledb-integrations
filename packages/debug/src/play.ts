/**
 * One play: from the first press of play (or the first error) to the end, a new
 * source, or the element going away. A replay after the end is a new play with
 * fresh counters, and so is a reload, because each page load has its own id.
 */
import type { EventKind, TraceEvent } from './snapshot.js';

/** Most events one play keeps. Past it, the oldest after the first HEAD are dropped. */
export const MAX_EVENTS = 150;
const HEAD = 30;

/** Beyond this a position is a live clock, not a place in the media. About 24 days. */
const MAX_SECOND = 1 << 21;

/**
 * Which whole seconds of the media were played, as a bitmap that grows as needed.
 *
 * Counted from positions actually reached during playback, so a forward seek skips
 * the seconds it jumps over and watching a scene twice counts it once. That is the
 * difference between this and credit per quartile crossed, which pays for a seek to
 * the end as if the whole film had been watched.
 */
export class Seconds {
  private bits = new Uint8Array(256);
  count = 0;

  add(second: number): void {
    if (!(second >= 0 && second < MAX_SECOND)) return;
    const at = second >> 3;
    if (at >= this.bits.length) {
      const grown = new Uint8Array(Math.max(at + 1, this.bits.length * 2));
      grown.set(this.bits);
      this.bits = grown;
    }
    const mask = 1 << (second & 7);
    const byte = this.bits[at] ?? 0;
    if (!(byte & mask)) {
      this.bits[at] = byte | mask;
      this.count++;
    }
  }
}

export class Play {
  /** The next snapshot's number. */
  seq = 0;
  startupMs = 0;
  watchMs = 0;
  readonly seconds = new Seconds();
  maxPos = 0;
  seeks = 0;
  pauses = 0;
  stalls = 0;
  stallMs = 0;
  error = 0;
  maxHeight = 0;
  dropped = 0;
  frames = 0;
  flags = 0;
  subMs = 0;
  subSwitches = 0;
  readonly events: TraceEvent[] = [];

  constructor(
    /** Unique within the page load, across every element on the page. */
    readonly no: number,
    /** Epoch seconds. */
    readonly startedAt: number,
  ) {}

  /** A problem play is one the default rule keeps a trace for. */
  get problem(): boolean {
    return this.error > 0 || this.stalls > 0;
  }

  note(kind: EventKind, t: number, detail = ''): void {
    this.events.push({ k: kind, t: Math.max(0, Math.round(t)), d: detail.slice(0, 120) });
    // Keep how the play began and what happened most recently. A session that seeks
    // back and forth for an hour must not grow without bound.
    if (this.events.length > MAX_EVENTS) this.events.splice(HEAD, 1);
  }
}
