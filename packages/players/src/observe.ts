import { attachedTo, attachSubtitleDb } from './attach.js';
import { isVideoElement } from './probe.js';
import { playerFor } from './resolve.js';
import type { AttachHandle, AttachOptions } from './types.js';

/**
 * Attaching to players that do not exist yet.
 *
 * `attachSubtitleDb` needs the player. A host page that controls its own setup can
 * call it there, but plenty cannot: a tag manager script runs before the player, a
 * single page app builds one on a route change and throws it away on the next, a
 * feed mounts a player per card as the reader scrolls, and a CMS embed has no
 * integration point at all. For all of those the integration has to watch instead
 * of being told, which is what this does: find every video in the page, work out
 * what owns it, attach once, and keep watching for the next one.
 *
 * Attaching is idempotent per player, so a video that is moved in the DOM, or seen
 * twice by two observers, is still one session and one set of tracks.
 */
export interface ObserveOptions extends AttachOptions {
  /** Where to look. Defaults to the whole document. */
  root?: ParentNode;
  /** Called once per player, after it has been attached. */
  onAttach?: (handle: AttachHandle, target: unknown) => void;
}

export interface ObserveHandle {
  /** Everything attached so far, in the order it appeared. */
  handles(): AttachHandle[];
  /** Stop watching. Existing handles keep working. */
  stop(): void;
  /** Stop watching and destroy every handle this observer created. */
  destroy(): void;
}

function videosIn(node: unknown): unknown[] {
  const out: unknown[] = [];
  if (isVideoElement(node)) out.push(node);
  const el = node as { querySelectorAll?: (s: string) => Iterable<unknown> };
  if (typeof el?.querySelectorAll === 'function') {
    // Gated the same way as the node itself: a query result is not automatically an
    // element, and a plain object with a tagName reaches attach() and fails there.
    for (const found of el.querySelectorAll('video')) if (isVideoElement(found)) out.push(found);
  }
  return out;
}

export function observeSubtitleDb(options: ObserveOptions = {}): ObserveHandle {
  const { root, onAttach, ...attachOptions } = options;
  const where = root ?? (globalThis.document as ParentNode | undefined);
  const handles: AttachHandle[] = [];
  const seen = new WeakSet<object>();
  let stopped = false;

  function attach(video: unknown): void {
    if (stopped) return;
    // Keyed on the element as well as on the player. A lazy player wraps and
    // re-inserts its video after the first scan, so the second record resolves to a
    // different object and the video was attached twice: two track sets, two menus,
    // two downloads on select.
    const el = video as object | null;
    const mine = el && typeof el === 'object';
    if (mine && (seen.has(el) || attachedTo(el))) return;
    const target = playerFor(video);
    if (!target || typeof target !== 'object' || seen.has(target)) return;
    // Somebody else owns this one: a second observer, or a host page that attached
    // explicitly before starting one. Adopting it would put another destroy() on a
    // session this observer did not open.
    if (attachedTo(target)) return;
    try {
      const handle = attachSubtitleDb(target, attachOptions);
      seen.add(target);
      if (el && typeof el === 'object') seen.add(el);
      handles.push(handle);
      onAttach?.(handle, target);
    } catch (err) {
      // A video nobody can bind is not worth throwing over: the observer is watching
      // a whole page and has to survive the parts of it that are not players.
      attachOptions.onError?.(err);
    }
  }

  for (const video of videosIn(where)) attach(video);

  const Observer = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  const observer =
    Observer && where
      ? new Observer((records) => {
          for (const record of records) {
            for (const node of record.addedNodes) for (const video of videosIn(node)) attach(video);
          }
        })
      : undefined;
  observer?.observe(where as Node, { childList: true, subtree: true });

  return {
    handles: () => [...handles],
    stop() {
      stopped = true;
      observer?.disconnect();
    },
    destroy() {
      stopped = true;
      observer?.disconnect();
      for (const h of handles) h.destroy();
      handles.length = 0;
    },
  };
}
