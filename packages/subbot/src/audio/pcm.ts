/**
 * The quietest 100 ms in `[from, to)` seconds of a 16 kHz window: where to cut it so
 * a window edge does not fall mid-word. Energy, not VAD; the model is what decides
 * what speech is.
 */
import { RATE } from './resample.js';

export function quietestAt(pcm: Int16Array, from: number, to: number): number {
  const frame = Math.round(0.02 * RATE);
  const a = Math.max(0, Math.round(from * RATE));
  const b = Math.min(pcm.length, Math.round(to * RATE));
  if (b - a < frame * 5) return to;
  const energies: number[] = [];
  for (let p = a; p + frame <= b; p += frame) {
    let e = 0;
    for (let i = p; i < p + frame; i++) {
      const v = (pcm[i] as number) / 32768;
      e += v * v;
    }
    energies.push(e);
  }
  let best = 0;
  let bestE = Number.POSITIVE_INFINITY;
  for (let i = 0; i + 5 <= energies.length; i++) {
    let e = 0;
    for (let k = 0; k < 5; k++) e += energies[i + k] as number;
    if (e <= bestE) {
      bestE = e;
      best = i;
    }
  }
  return (a + (best + 2) * frame) / RATE;
}
