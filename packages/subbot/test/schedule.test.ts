import { describe, expect, it } from 'vitest';
import { Intervals, LIVE, nextLive, nextQuality, qualityWorkers } from '../src/schedule.js';

describe('Intervals', () => {
  it('merges, answers containment and lists gaps', () => {
    const s = new Intervals();
    s.add(0, 4);
    s.add(4, 8);
    s.add(10, 12);
    expect(s.spans).toEqual([
      [0, 8],
      [10, 12],
    ]);
    expect(s.has(1, 7)).toBe(true);
    expect(s.has(7, 11)).toBe(false);
    expect(s.gaps(0, 20)).toEqual([
      [8, 10],
      [12, 20],
    ]);
    expect(s.until(3)).toBe(8);
    expect(s.until(9)).toBe(9);
    expect(s.total()).toBe(10);
  });
});

describe('nextLive', () => {
  const audio = (t: number) => t + 100;

  it('starts with a short window at the playhead', () => {
    expect(nextLive(10, new Intervals(), audio, 600, LIVE, true)).toEqual({ t0: 10, t1: 13 });
  });

  it('then takes the step and stops at the lead', () => {
    const done = new Intervals();
    done.add(10, 14);
    expect(nextLive(10, done, audio, 600)).toEqual({ t0: 14, t1: 20 });
    done.add(14, 40);
    expect(nextLive(10, done, audio, 600)).toBeNull();
  });

  it('is bounded by the decoded audio and the duration', () => {
    expect(nextLive(10, new Intervals(), (t) => t + 2, 600)).toEqual({ t0: 10, t1: 12 });
    expect(nextLive(10, new Intervals(), (t) => t + 0.2, 600)).toBeNull();
    expect(nextLive(598, new Intervals(), audio, 600)).toEqual({ t0: 598, t1: 600 });
  });
});

describe('nextQuality', () => {
  const audio = (t: number) => t + 100;

  it('takes the gap ahead of the playhead before the one behind', () => {
    const done = new Intervals();
    done.add(100, 130);
    expect(nextQuality(100, done, audio, 600)).toEqual({ t0: 130, t1: 145 });
    done.add(130, 600);
    expect(nextQuality(100, done, audio, 600)).toEqual({ t0: 0, t1: 15 });
    done.add(0, 100);
    expect(nextQuality(100, done, audio, 600)).toBeNull();
  });
});

describe('qualityWorkers', () => {
  it('scales with cores and stays off on a small machine', () => {
    expect(qualityWorkers(2, undefined)).toBe(0);
    expect(qualityWorkers(4, 8)).toBe(0);
    expect(qualityWorkers(8, 8)).toBe(2);
    expect(qualityWorkers(16, 32)).toBe(3);
    expect(qualityWorkers(16, 2)).toBe(0);
  });
});
