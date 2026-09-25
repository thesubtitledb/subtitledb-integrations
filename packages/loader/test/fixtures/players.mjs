/** Stands in for the bindings chunk. See engine.mjs. */
import { handle } from './engine.mjs';

export const calls = [];

export function attachSubtitleDb(target, options) {
  calls.push({ target, options });
  return handle('videojs');
}
