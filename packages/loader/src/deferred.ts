/**
 * A handle for something that has not been loaded yet.
 *
 * `attachSubtitleDb` returns a handle synchronously. Behind a lazy loader it cannot:
 * the module that builds one is still in flight when the caller wants an object back.
 * Returning a bare promise would put `.then()` around a call that is synchronous in
 * every other distribution of this code, and would make the CDN docs a second set of
 * docs describing a second API.
 *
 * So the same shape comes back immediately, and the two synchronous readers answer
 * what a real handle answers before its first resolve completes: `tracks()` empty,
 * `current()` null. Both are documented states of a live handle, not stand-ins
 * invented here. `player`, `degraded` and `session` are null until the real handle
 * exists, because there is no honest value for them and an invented one would be read
 * as fact.
 *
 * A `destroy()` that arrives first is remembered and applied on arrival. That is the
 * case that matters rather than an edge case: a component unmounting inside the
 * window where its chunk is still downloading would otherwise leave a live session
 * and its timers behind it.
 */
import type {
  Candidate,
  DegradedInfo,
  PlayerInfo,
  ResolveResult,
  SubtitleSession,
} from '@subtitledb/core';
import type { AttachHandle } from '@subtitledb/players';

export interface DeferredHandle {
  /** The real handle, once its module has loaded and the attach has run. */
  ready: Promise<AttachHandle>;
  /** Null until `ready` settles. */
  readonly player: PlayerInfo | null;
  /** Null until `ready` settles, and null after it unless the attach degraded. */
  readonly degraded: DegradedInfo | null;
  /** Null until `ready` settles. */
  readonly session: SubtitleSession | null;
  media(): HTMLVideoElement | null;
  refresh(): Promise<ResolveResult>;
  select(candidate: Candidate): Promise<void>;
  /** Empty until the first resolve completes, exactly as a live handle is. */
  tracks(): Candidate[];
  /** Null until the first resolve completes, exactly as a live handle is. */
  current(): ResolveResult | null;
  destroy(): void;
}

export function deferHandle(load: () => Promise<AttachHandle>): DeferredHandle {
  let real: AttachHandle | null = null;
  let dead = false;

  const ready = load().then((handle) => {
    real = handle;
    // Ordering, not tidiness. destroy() may have been called while this was in
    // flight, when the handle it was meant for did not exist yet.
    if (dead) handle.destroy();
    return handle;
  });

  // The failure is the caller's, through `ready` and through onError. Without this
  // line an unknown player on a page that never reads `ready` is an unhandled
  // rejection in the host page's console, reported against the host page.
  ready.catch(() => {});

  return {
    ready,
    get player() {
      return real?.player ?? null;
    },
    get degraded() {
      return real?.degraded ?? null;
    },
    get session() {
      return real?.session ?? null;
    },
    media: () => real?.media() ?? null,
    refresh: () => (real ? real.refresh() : ready.then((h) => h.refresh())),
    select: (candidate) => (real ? real.select(candidate) : ready.then((h) => h.select(candidate))),
    tracks: () => real?.tracks() ?? [],
    current: () => real?.current() ?? null,
    destroy() {
      dead = true;
      real?.destroy();
    },
  };
}
