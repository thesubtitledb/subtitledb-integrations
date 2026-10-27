import { describe, expect, it } from 'vitest';
import { lineUp } from '../src/align.js';
import type { Cue } from '../src/transform.js';

/** A film's lines: uneven gaps, as speech has. Seeded so a failure repeats. */
function film(n: number, seed = 7): Cue[] {
  let x = seed;
  const rand = () => {
    x = (x * 1103515245 + 12345) % 2147483648;
    return x / 2147483648;
  };
  const out: Cue[] = [];
  let t = 30_000;
  for (let i = 0; i < n; i++) {
    t += 1500 + rand() * 6000;
    out.push({ start: Math.round(t), end: Math.round(t + 1800), text: `line ${i}` });
  }
  return out;
}

describe('lineUp', () => {
  it('finds the offset between two languages of one film', () => {
    const ref = film(400);
    // The other file: its own words, 3.7 s early, timed by another hand (up to 150 ms
    // off), one line in five merged away and a few of its own.
    const other = ref
      .filter((_, i) => i % 5 !== 0)
      .map((c, i) => ({ ...c, start: c.start - 3700 + ((i * 37) % 300) - 150, text: 'otra' }))
      .concat(film(20, 99));
    const fit = lineUp(ref, other);
    expect(fit).not.toBeNull();
    expect(Math.abs((fit?.ms ?? 0) - 3700)).toBeLessThan(200);
    expect(fit?.lines).toBeGreaterThan(250);
  });

  it('answers null for files of two different films', () => {
    expect(lineUp(film(300, 1), film(300, 2))).toBeNull();
  });

  it('answers null with too few lines to decide', () => {
    const ref = film(5);
    expect(lineUp(ref, ref)).toBeNull();
  });
});
