/**
 * Getting a snapshot there, and holding it until it arrives.
 *
 * A `text/plain` POST with no custom header is a CORS simple request, so each
 * snapshot is one round trip and never a preflight, and `credentials: 'omit'`
 * keeps the viewer's cookies out of it. `keepalive` lets a post outlive the page
 * that sent it, including the one sent from `pagehide`. A beacon is the fallback
 * only where fetch is missing or refuses: it would carry cookies.
 *
 * A snapshot that has not been answered stays in localStorage under OUTBOX and is
 * sent again the next time a page on the site starts the debugger. Resending is
 * safe because every counter is cumulative: the receiving side keeps the largest
 * value of each, so a snapshot that did arrive after all changes nothing.
 */
import { bucket } from './snapshot.js';

export const ENDPOINT = 'https://api.thesubtitledb.org/dbg';

/** The only two things this package ever writes to storage. */
export const OUTBOX = 'sdb_dbg_ob';
export const VISITOR = 'sdb_uid';

/** Plays whose last unanswered snapshot the outbox keeps. */
const OUTBOX_PLAYS = 5;

/** An outbox entry older than this is dropped unsent: it would be filed under the wrong day. */
const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Which plays keep a trace. `problems` (errored or stalled) is the default; a number
 * is a percentage of plays, chosen by bucket() so both sides pick the same ones.
 */
export type TraceRule = 'none' | 'problems' | 'all' | number;

export function parseRule(value: string | null): TraceRule | null {
  if (value === 'none' || value === 'problems' || value === 'all') return value;
  if (value && /^\d{1,3}$/.test(value)) return Math.min(100, Number(value));
  return null;
}

interface Entry {
  /** `<load id>:<play>`. */
  i: string;
  b: string;
  /** Epoch ms when it was written. */
  a: number;
}

export interface SenderOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  beacon?: (url: string, body: string) => boolean;
  storage?: Storage | null;
  epoch?: () => number;
}

export class Sender {
  /** Learned from the answer to the first post; the default until then. */
  rule: TraceRule = 'problems';
  readonly #endpoint: string;
  readonly #post: typeof fetch | undefined;
  readonly #beacon: ((url: string, body: string) => boolean) | undefined;
  readonly #storage: Storage | null;
  readonly #epoch: () => number;
  #flushed = false;

  constructor(o: SenderOptions = {}) {
    const g = globalThis as {
      fetch?: typeof fetch;
      navigator?: { sendBeacon?: (url: string, body: string) => boolean };
    };
    this.#endpoint = o.endpoint ?? ENDPOINT;
    this.#post = o.fetch ?? g.fetch?.bind(globalThis);
    const nav = g.navigator;
    this.#beacon =
      o.beacon ?? (nav?.sendBeacon ? (u, b) => nav.sendBeacon?.(u, b) === true : undefined);
    this.#storage = o.storage === undefined ? localStore() : o.storage;
    this.#epoch = o.epoch ?? Date.now;
  }

  /** Does the key keep a trace for this play? */
  wantsTrace(problem: boolean, loadId: string, playNo: number): boolean {
    const rule = this.rule;
    if (rule === 'none') return false;
    if (rule === 'all') return true;
    if (rule === 'problems') return problem;
    return bucket(`${loadId}:${playNo}`) < rule;
  }

  /**
   * Send one snapshot. `id` names its play, so a newer snapshot of the same play
   * replaces an older one in the outbox rather than queueing behind it.
   */
  send(body: string, id: string): void {
    this.#put(id, body);
    if (this.#fetchOnce(body, () => this.#take(id, body))) return;
    try {
      if (this.#beacon?.(this.#endpoint, body)) this.#take(id, body);
    } catch {
      // Over the browser's beacon quota. It stays in the outbox.
    }
  }

  /**
   * Resend what earlier page loads left unanswered, once per page. Only other
   * loads' entries: this page's own are still in flight.
   */
  flush(ownLoad: string): void {
    if (this.#flushed) return;
    this.#flushed = true;
    const now = this.#epoch();
    for (const e of this.#read()) {
      if (e.i.startsWith(`${ownLoad}:`)) continue;
      if (now - e.a > OUTBOX_MAX_AGE_MS) this.#take(e.i, e.b);
      else this.#fetchOnce(e.b, () => this.#take(e.i, e.b));
    }
  }

  /** False when nothing was sent: no fetch at all, or one that threw before sending. */
  #fetchOnce(body: string, done: () => void): boolean {
    if (!this.#post) return false;
    let sent: Promise<Response>;
    try {
      sent = this.#post(this.#endpoint, {
        method: 'POST',
        body,
        keepalive: true,
        credentials: 'omit',
        mode: 'cors',
      });
    } catch {
      return false;
    }
    sent.then(
      (res) => {
        const rule = parseRule(res.headers?.get?.('x-sdb-trace') ?? null);
        if (rule !== null) this.rule = rule;
        if (res.ok) done();
      },
      // Offline, blocked or cut off: it stays in the outbox for the next page load.
      () => {},
    );
    return true;
  }

  #read(): Entry[] {
    try {
      const raw = this.#storage?.getItem(OUTBOX);
      const list: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(list)
        ? list.filter(
            (e): e is Entry =>
              typeof e?.i === 'string' && typeof e?.b === 'string' && typeof e?.a === 'number',
          )
        : [];
    } catch {
      return [];
    }
  }

  #write(list: Entry[]): void {
    try {
      if (list.length) this.#storage?.setItem(OUTBOX, JSON.stringify(list));
      else this.#storage?.removeItem(OUTBOX);
    } catch {
      // Storage full or blocked. The post still goes; only the retry is lost.
    }
  }

  #put(id: string, body: string): void {
    if (!this.#storage) return;
    const list = this.#read().filter((e) => e.i !== id);
    list.push({ i: id, b: body, a: this.#epoch() });
    this.#write(list.slice(-OUTBOX_PLAYS));
  }

  /** Remove a play's entry, but only if it is still this body and not a newer one. */
  #take(id: string, body: string): void {
    if (!this.#storage) return;
    const list = this.#read();
    const kept = list.filter((e) => !(e.i === id && e.b === body));
    if (kept.length !== list.length) this.#write(kept);
  }
}

/** localStorage, or null where reading it throws (sandboxed frames, some private modes). */
export function localStore(): Storage | null {
  try {
    const s = (globalThis as { localStorage?: Storage }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}
