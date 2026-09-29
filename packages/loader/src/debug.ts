/**
 * The debugger's two ways in: one attached video, or every video on the page.
 *
 * The public names are `SubtitleDB.debug()` and the `debug` option, never
 * `debugger`: that is a reserved word, and a page that destructures the options
 * object would have a syntax error the moment it named it.
 *
 * Everything here is small on purpose, because it sits in the entry every page
 * downloads. The debugger itself is a chunk of its own, fetched only with a key.
 */
import type { LoadedSubtitle, ResolveResult } from '@subtitledb/core';
import type { AttachHandle, AttachOptions } from '@subtitledb/players';
import type { Attached } from './chunks/debug.js';
import { chunk } from './chunks.js';
import type { DeferredHandle } from './deferred.js';
import { ANTISPAM_ID } from './ids.js';

const KEY = /^sdbg_[0-9A-Za-z]{24}$/;
const BAD_KEY =
  'SubtitleDB debug needs a debugger key: sdbg_ and 24 letters or digits, from the developer portal';

export interface DebugHandle {
  /** Settles once the debugger is running, or rejects if its code could not load. */
  ready: Promise<void>;
  stop(): void;
}

/** `SubtitleDB.debug(key)`: every video on the page, including ones added later. */
export function debug(key: string, moduleUrl?: string): DebugHandle {
  if (!KEY.test(String(key))) throw new TypeError(BAD_KEY);
  let stop: (() => void) | undefined;
  let stopped = false;
  const ready = chunk('debug', moduleUrl).then((m) => {
    if (!stopped) stop = m.watchPage({ key, loadId: ANTISPAM_ID }).stop;
  });
  // The failure is the caller's through `ready`; unread, it is not the page's problem.
  ready.catch(() => {});
  return {
    ready,
    stop() {
      stopped = true;
      stop?.();
    },
  };
}

/**
 * The `debug` option of one attach.
 *
 * Wraps the page's onResolved and onSelected so the debugger learns what is playing
 * and which subtitle is on, then starts once both the attach and the chunk are in.
 * Returns what to do with the handle, or null when there is no key. A key of the
 * wrong shape is reported through onError and the attach goes ahead without it.
 */
export function debugAttach(
  key: unknown,
  opts: AttachOptions,
  moduleUrl: string | undefined,
  report: (message: string) => void,
): ((handle: DeferredHandle) => void) | null {
  if (key === undefined || key === null || key === '') return null;
  if (!KEY.test(String(key))) {
    report(BAD_KEY);
    return null;
  }
  const loading = chunk('debug', moduleUrl);
  loading.catch((err: unknown) =>
    report(`SubtitleDB could not start the debugger: ${(err as Error)?.message ?? err}`),
  );

  let watch: Attached | null = null;
  let resolved: ResolveResult | undefined;
  let selected: LoadedSubtitle | undefined;
  const { onResolved, onSelected } = opts;
  opts.onResolved = (r) => {
    resolved = r;
    watch?.resolved(r);
    onResolved?.(r);
  };
  opts.onSelected = (s) => {
    selected = s;
    watch?.selected(s);
    onSelected?.(s);
  };

  return (handle) => {
    let stopped = false;
    const destroy = handle.destroy;
    handle.destroy = () => {
      // The final snapshot goes before the handle takes the element away.
      stopped = true;
      watch?.stop();
      destroy();
    };
    const start = (h: AttachHandle) =>
      loading.then((m) => {
        const media = h.media();
        if (stopped || !media) return;
        watch = m.watchAttached(media, String(key), ANTISPAM_ID, h.player?.name);
        if (resolved) watch.resolved(resolved);
        if (selected) watch.selected(selected);
      });
    // A failed attach has already said so through onError; a failed chunk, above.
    handle.ready.then(start).catch(() => {});
  };
}
