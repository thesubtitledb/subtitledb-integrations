/**
 * The seconds a play reached, kept as a bitmap. collector.test.ts reaches it through
 * plays of a few minutes; these are the parts a short play never does: growing past
 * the first 2048 seconds, and the cap beyond which a position is a live clock.
 */
import { describe, expect, it } from 'vitest';
import { Seconds } from '../src/play.js';

describe('seconds played', () => {
  it('grow past the first 2048 and keep every second from before', () => {
    const s = new Seconds();
    s.add(0);
    s.add(5000);
    s.add(5000);
    expect(s.count).toBe(2);
    // 100 seconds a part: parts 0 and 50.
    expect(s.parts(6400)).toBe('0004000000000001');
    // Past the end of a shorter length is its last part.
    expect(s.parts(600)).toBe('8000000000000001');
  });

  it('stop at 2^21, about 24 days, where a position is a live clock and not a place', () => {
    const s = new Seconds();
    s.add(2 ** 21 - 1);
    s.add(2 ** 21);
    expect(s.count).toBe(1);
  });
});
