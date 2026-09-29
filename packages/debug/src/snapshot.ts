/**
 * One snapshot on the wire: what a play has done so far, as running totals.
 *
 * Every counter is cumulative for the play and only ever grows. That is the one
 * property everything on the receiving side rests on: the final state of a play is
 * the largest value of each field across its snapshots, so a lost, repeated or
 * reordered snapshot changes nothing, and neither does sending the last one twice.
 * A field added here has to keep that property or it does not belong here.
 *
 * Field names are one or two letters. The body leaves a viewer's browser several
 * times per play, every byte is theirs, and a name that reads like tracking is a
 * name a content blocker matches on. A blocked debugger reports a site as healthy
 * when it is not, which is worse than having none.
 */

export type EventKind =
  | 'attach'
  | 'source'
  | 'manifest'
  | 'offered'
  | 'first_frame'
  | 'playing'
  | 'pause'
  | 'seek'
  | 'stall_start'
  | 'stall_end'
  | 'track'
  | 'level'
  | 'error'
  | 'ended';

/** One line of a trace: what happened, when (ms since the element was watched), and a detail a person reads. */
export interface TraceEvent {
  k: EventKind;
  t: number;
  d: string;
}

export interface Snapshot {
  /** Wire version. */
  v: 1;
  /** The debugger key. Public, and only accepted from the key's own domains. */
  k: string;
  /** Page-load id, 16 hex characters, and the play within that page load, from 1. */
  l: string;
  p: number;
  /** Snapshot number within the play, from 0. */
  s: number;
  /** When the play started, epoch seconds. */
  ps: number;
  /** Visitor id, 16 hex characters. Absent when the browser keeps no storage. */
  u?: string;

  /** Path and query of the page, and what is playing when SubtitleDB knows. */
  pa?: string;
  im?: number;
  tm?: number;
  se?: number;
  ep?: number;

  /** Length in seconds, 0 for live, and the live flag. */
  du?: number;
  li?: number;

  /** Time to first frame, time spent playing, unique seconds played, furthest position. */
  st?: number;
  wa?: number;
  un?: number;
  mp?: number;
  /** Seeks, pauses, stalls and time stalled. */
  sk?: number;
  pu?: number;
  sn?: number;
  sm?: number;
  /** The highest media error code seen, the tallest frame, dropped and total frames. */
  er?: number;
  mh?: number;
  dr?: number;
  fr?: number;
  /** FLAGS, each set the first time it happens and never cleared. */
  fl?: number;

  /** Player, subtitle source, language, time shown, switches, SubtitleDB id, audio language. */
  pl?: string;
  ss?: string;
  sl?: string;
  sb?: number;
  sw?: number;
  si?: number;
  al?: string;

  /** The trace, on a snapshot that could be the play's last, when the key keeps one. */
  ev?: TraceEvent[];
}

/** The bits of `fl`. Each means "ever", which is what keeps the field monotonic. */
export const FLAGS = {
  started: 1,
  ended: 2,
  fullscreen: 4,
  pip: 8,
  cast: 16,
  muted: 32,
  autoplay: 64,
} as const;

/** The receiving side refuses a body over 8 KB. Aim well under it. */
export const MAX_BODY = 7 * 1024;

/** Events kept from the start of a trace when one has to be cut to fit. */
const HEAD = 20;

const U8 = 255;
const U16 = 65535;
const U32 = 4294967295;

/** The range the receiving side accepts for each number. Out of range is a refused post. */
const MAX: Record<string, number> = {
  p: U8,
  s: 2000,
  im: U32,
  tm: U32,
  se: U16,
  ep: U16,
  du: U32,
  li: 1,
  st: U32,
  wa: U32,
  un: U32,
  mp: U32,
  sk: U16,
  pu: U16,
  sn: U16,
  sm: U32,
  er: U8,
  mh: U16,
  dr: U32,
  fr: U32,
  fl: U16,
  sb: U32,
  sw: U16,
  si: U32,
};

/** And the longest each string may be. */
const LEN: Record<string, number> = { k: 64, pa: 512, pl: 32, ss: 16, sl: 16, al: 16 };

/** Sent even when zero. Everything else defaults to zero or empty on arrival. */
const REQUIRED = new Set(['v', 'k', 'l', 'p', 's', 'ps']);

function compact(s: Snapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(s)) {
    let value: unknown = raw;
    if (typeof value === 'number') {
      value = Math.min(Math.max(Math.floor(value) || 0, 0), MAX[name] ?? Number.MAX_SAFE_INTEGER);
    } else if (typeof value === 'string') {
      value = value.slice(0, LEN[name] ?? 200);
    }
    const empty =
      value === 0 ||
      value === '' ||
      value === undefined ||
      (Array.isArray(value) && value.length === 0);
    if (!empty || REQUIRED.has(name)) out[name] = value;
  }
  return out;
}

const bytes = (text: string): number => new TextEncoder().encode(text).length;

/**
 * The body for one snapshot.
 *
 * A trace that would take the body past MAX_BODY loses events from its middle, a
 * few at a time, keeping how the play began and how it ended, which are the two
 * parts anyone reads. If even that does not fit, the trace goes and the running
 * totals are sent alone: the play's record matters more than its story.
 */
export function encode(s: Snapshot): string {
  let body = JSON.stringify(compact(s));
  const ev = s.ev?.slice() ?? [];
  while (ev.length > HEAD && bytes(body) > MAX_BODY) {
    ev.splice(HEAD, Math.max(1, Math.ceil((ev.length - HEAD) / 4)));
    body = JSON.stringify(compact({ ...s, ev }));
  }
  if (bytes(body) > MAX_BODY) body = JSON.stringify(compact({ ...s, ev: undefined }));
  return body;
}

/**
 * A stable 0-99 bucket for a string, FNV-1a.
 *
 * The receiving side decides which plays of a `fraction` key keep a trace with this
 * exact function over `<load id>:<play>`, so the two have to agree on every input.
 * test/snapshot.test.ts pins the same vectors the receiving side's tests pin.
 */
export function bucket(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}
