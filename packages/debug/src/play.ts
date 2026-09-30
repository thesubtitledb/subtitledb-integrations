/**
 * One play: from the first press of play (or the first error) to the end, a new
 * source, or the element going away. A replay after the end is a new play with
 * fresh counters, and so is a reload, because each page load has its own id.
 */
import { type EventKind, FLAGS, type TraceEvent } from './snapshot.js';

/** Most events one play keeps. Past it, the oldest after the first HEAD are dropped. */
export const MAX_EVENTS = 150;
const HEAD = 30;

/** Beyond this a position is a live clock, not a place in the media. About 24 days. */
const MAX_SECOND = 1 << 21;

/** The parts a duration is cut into for coverage: one bit each, 64 to a UInt64. */
const PARTS = 64;

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

  /**
   * Which of 64 equal parts of `length` seconds had any second played, as 16 hex
   * characters with bit 0 the first part, or '' when none did. Worked out from the
   * seconds at each report rather than kept, so it always follows the latest length.
   */
  parts(length: number): string {
    if (!(length > 0)) return '';
    const half = [0, 0];
    for (let at = 0; at < this.bits.length; at++) {
      const byte = this.bits[at] ?? 0;
      for (let b = 0; byte && b < 8; b++) {
        if (!(byte & (1 << b))) continue;
        const part = Math.min(PARTS - 1, Math.floor(((at * 8 + b) * PARTS) / length));
        half[part >> 5] = (half[part >> 5] ?? 0) | (1 << (part & 31));
      }
    }
    const hex = (n = 0) => (n >>> 0).toString(16).padStart(8, '0');
    return half[0] || half[1] ? hex(half[1]) + hex(half[0]) : '';
  }
}

/** Milliseconds a condition held, started and stopped as it changes. */
export class Clock {
  ms = 0;
  since: number | null = null;

  set(on: boolean, t: number): void {
    if (on && this.since === null) this.since = t;
    if (!on && this.since !== null) {
      this.ms += t - this.since;
      this.since = null;
    }
  }

  /** The total so far, counting a stretch still running, without stopping it. */
  read(t: number): number {
    return this.ms + (this.since === null ? 0 : t - this.since);
  }
}

export class Play {
  /** The next snapshot's number. */
  seq = 0;
  startupMs = 0;
  /** Playing: not paused, stalled or seeking. */
  readonly watch = new Clock();
  /** Playing with a subtitle on screen. */
  readonly sub = new Clock();
  /** Playing below the tallest picture this play has reached. */
  readonly low = new Clock();
  readonly seconds = new Seconds();
  maxPos = 0;
  seeks = 0;
  pauses = 0;
  stalls = 0;
  stallMs = 0;
  error = 0;
  maxHeight = 0;
  /** Times the picture got smaller after the first frame. */
  picDowns = 0;
  dropped = 0;
  frames = 0;
  flags = 0;
  subSwitches = 0;
  /** The last subtitle on screen while this play was playing: source, language, SubtitleDB id. */
  subSource = '';
  subLang = '';
  subId = 0;
  /** Times the duration grew after the first frame; see the collector's #onDuration. */
  grew = 0;
  /** Seen to be a live window. It stays live: a stream does not turn into a film. */
  live = false;
  readonly events: TraceEvent[] = [];

  constructor(
    /** Unique within the page load, across every element on the page. */
    readonly no: number,
    /** Epoch seconds. */
    readonly startedAt: number,
  ) {}

  /**
   * A problem play is one the default rule keeps a trace for: it failed, it stalled,
   * or it has not shown a frame. The receiving side applies the same rule.
   */
  get problem(): boolean {
    return this.error > 0 || this.stalls > 0 || !(this.flags & FLAGS.started);
  }

  note(kind: EventKind, t: number, detail = ''): void {
    this.events.push({ k: kind, t: Math.max(0, Math.round(t)), d: detail.slice(0, 120) });
    // Keep how the play began and what happened most recently. A session that seeks
    // back and forth for an hour must not grow without bound.
    if (this.events.length > MAX_EVENTS) this.events.splice(HEAD, 1);
  }
}
