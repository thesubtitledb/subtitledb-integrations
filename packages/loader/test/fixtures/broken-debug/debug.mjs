/**
 * Stands in for a debugger chunk with a bug in it: it starts, and then every call the
 * loader makes into it throws. See ../debug.mjs.
 */
import { order } from '../engine.mjs';

export const calls = [];

const bug = () => {
  throw new Error('a bug in the debugger');
};

export function watchAttached(media) {
  calls.push(media);
  return {
    resolved: bug,
    selected: bug,
    stop: () => {
      order.push('stop');
      bug();
    },
  };
}
