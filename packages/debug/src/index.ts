/**
 * The playback debugger.
 *
 * Watches video elements and reports how playback went to the owner of a debugger
 * key: time to first frame, stalls, errors, what was watched, and for the plays the
 * key asks about, a trace of what happened in order. The owner reads it in the
 * SubtitleDB developer portal.
 *
 * Nothing here runs until a page passes a key. With no key there is no request, no
 * storage and no listener. With one, the only storage written is a random visitor id
 * and the outbox of unanswered snapshots (VISITOR and OUTBOX).
 */
import { type Chosen, Collector, type Context, MARK } from './collector.js';
import { everyVideo, type Stoppable } from './page.js';
import { Sender } from './send.js';
import type { EventKind } from './snapshot.js';
import { randomHex, visitorId } from './visitor.js';

export type { Chosen, Context } from './collector.js';
export type { Stoppable } from './page.js';
export { OUTBOX, VISITOR } from './send.js';
export type { EventKind, Snapshot, TraceEvent } from './snapshot.js';
export { FLAGS } from './snapshot.js';

/** `sdbg_` and 24 letters or digits. Never an API key, which is `sdb_` and 36. */
export const KEY_PATTERN = /^sdbg_[0-9A-Za-z]{24}$/;

export function looksLikeKey(key: unknown): key is string {
  return typeof key === 'string' && KEY_PATTERN.test(key);
}

export interface DebugOptions {
  key: string;
  /**
   * One id per page load. Anything that is at least 16 hex characters once dashes
   * are removed, which a UUID is; the first 16 are used.
   */
  loadId: string;
  /** Where snapshots go. Only a test or a self-hosted receiver sets this. */
  endpoint?: string;
  /** What is playing, when the page says: every video this watches is filed under it. */
  context?: Context;
}

/** One watched element, as the loader drives it. */
export interface Watch extends Stoppable {
  context(ctx: Context): void;
  record(kind: EventKind, detail: string): void;
  select(chosen: Chosen | null): void;
}

const senders = new Map<string, Sender>();
let visitor: string | undefined | null = null;

/** The 16 hex characters that go on the wire. */
export function toLoadId(id: string): string {
  const hex = id.replace(/-/g, '').slice(0, 16).toUpperCase();
  return /^[0-9A-F]{16}$/.test(hex) ? hex : randomHex(8);
}

/** One sender per key: each key has its own trace rule. */
function senderFor(o: DebugOptions, loadId: string): Sender {
  const id = `${o.endpoint ?? ''} ${o.key}`;
  let s = senders.get(id);
  if (!s) {
    s = new Sender(o.endpoint ? { endpoint: o.endpoint } : {});
    senders.set(id, s);
  }
  s.flush(loadId);
  return s;
}

const idle: Watch = { context() {}, record() {}, select() {}, stop() {} };

/** Watch one element. Watching it twice returns the first watch. */
export function watch(video: HTMLVideoElement, o: DebugOptions): Watch {
  if (!looksLikeKey(o.key))
    throw new TypeError('not a debugger key: sdbg_ and 24 letters or digits');
  const held = (video as unknown as { [MARK]?: Partial<Watch> })[MARK];
  if (held) {
    // Another copy of this code got there first. Use it if it speaks this interface;
    // otherwise leave it be rather than count every play twice.
    return typeof held.context === 'function' && typeof held.select === 'function'
      ? (held as Watch)
      : idle;
  }
  const loadId = toLoadId(o.loadId);
  if (visitor === null) visitor = visitorId();
  const c = new Collector(video, { key: o.key, loadId, visitor, sender: senderFor(o, loadId) });
  if (o.context) c.context(o.context);
  return c;
}

/** Watch every video on the page, now and as they are added. */
export function watchPage(o: DebugOptions, doc: Document = document): Stoppable {
  if (!looksLikeKey(o.key))
    throw new TypeError('not a debugger key: sdbg_ and 24 letters or digits');
  return everyVideo((video) => watch(video, o), doc);
}

/** Test seam: forget the senders and the visitor id. */
export function resetDebug(): void {
  senders.clear();
  visitor = null;
}
