/**
 * Stands in for the debugger chunk. See engine.mjs: a real module, really imported,
 * recording what the loader asked of it.
 */
import { order } from './engine.mjs';

// Counts evaluations, so a test can tell whether the loader fetched this chunk at all.
globalThis.__sdbDebugLoads = (globalThis.__sdbDebugLoads ?? 0) + 1;

export const calls = [];

export function watchAttached(media, key, loadId, player) {
  const w = { media, key, loadId, player, resolved: [], selected: [], stopped: 0 };
  calls.push(w);
  return {
    resolved: (r) => w.resolved.push(r),
    selected: (s) => w.selected.push(s),
    stop: () => {
      w.stopped++;
      order.push('stop');
    },
  };
}

export const pages = [];

export function watchPage(options) {
  const p = { ...options, stopped: 0 };
  pages.push(p);
  return {
    stop: () => {
      p.stopped++;
    },
  };
}
