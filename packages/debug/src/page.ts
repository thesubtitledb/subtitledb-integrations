/**
 * Every `<video>` on the page, including the ones added after this runs.
 *
 * For a page that has no SubtitleDB integration at all and wants only the
 * debugger. A video inside a shadow root is invisible to this, as it is to
 * `querySelectorAll`; pass such an element to the loader's attach instead.
 */
import { MARK } from './collector.js';

export interface Stoppable {
  stop(): void;
}

export function everyVideo(
  start: (video: HTMLVideoElement) => Stoppable,
  doc: Document,
): Stoppable {
  const watching = new Map<HTMLVideoElement, Stoppable>();
  const add = (video: HTMLVideoElement) => {
    // Already watched, by an attach or another copy of this code: that one has the
    // better context, and two collectors on one element would count every play twice.
    if (watching.has(video) || MARK in video) return;
    watching.set(video, start(video));
  };
  const scan = (node: Node) => {
    if (node.nodeName === 'VIDEO') add(node as HTMLVideoElement);
    (node as ParentNode).querySelectorAll?.('video').forEach(add);
  };
  // A removed element is paused by the browser; its play gets a final snapshot here.
  // One moved within the same task is connected again by the time this runs.
  const sweep = () => {
    for (const [video, w] of watching) {
      if (!video.isConnected) {
        w.stop();
        watching.delete(video);
      }
    }
  };

  scan(doc);
  const Observer = (globalThis as { MutationObserver?: typeof MutationObserver }).MutationObserver;
  const observer = Observer
    ? new Observer((records) => {
        let removed = false;
        for (const r of records) {
          r.addedNodes.forEach(scan);
          if (r.removedNodes.length) removed = true;
        }
        if (removed) sweep();
      })
    : null;
  observer?.observe(doc.documentElement ?? doc, { childList: true, subtree: true });

  return {
    stop() {
      observer?.disconnect();
      for (const w of watching.values()) w.stop();
      watching.clear();
    },
  };
}
