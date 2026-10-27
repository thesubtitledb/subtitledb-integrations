import { describe, expect, it } from 'vitest';
import { quietestAt } from '../src/audio/pcm.js';
import { downmix, RATE, resample, toFloat32, toInt16 } from '../src/audio/resample.js';

const fill = (n: number, v: number) => new Int16Array(n).fill(v);

describe('quietestAt', () => {
  it('finds the silence inside a loud stretch', () => {
    const pcm = fill(3 * RATE, 8000);
    pcm.fill(0, Math.round(1.4 * RATE), Math.round(1.6 * RATE));
    const t = quietestAt(pcm, 0.5, 2.5);
    expect(t).toBeGreaterThan(1.4);
    expect(t).toBeLessThan(1.6);
  });

  it('answers the end of a span too short to judge', () => {
    expect(quietestAt(fill(RATE, 1), 0.5, 0.55)).toBe(0.55);
  });
});

describe('resample', () => {
  const tone = (rate: number, hz: number, secs: number) => {
    const out = new Float32Array(rate * secs);
    for (let i = 0; i < out.length; i++) out[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate);
    return out;
  };
  const rms = (a: Float32Array) => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

  it('keeps a 1 kHz tone and removes a 10 kHz one going 48k to 16k', () => {
    const low = resample(tone(48000, 1000, 1), 48000, RATE);
    expect(low.length).toBe(RATE);
    expect(rms(low)).toBeGreaterThan(0.3);
    const high = resample(tone(48000, 10000, 1), 48000, RATE);
    expect(rms(high)).toBeLessThan(0.05);
  });

  it('handles 44.1k and leaves 16k alone', () => {
    const a = resample(tone(44100, 440, 1), 44100, RATE);
    expect(a.length).toBe(RATE);
    expect(rms(a)).toBeGreaterThan(0.3);
    const same = tone(RATE, 440, 1);
    expect(resample(same, RATE, RATE)).toBe(same);
  });

  it('downmixes by averaging and rounds trips int16', () => {
    const m = downmix([new Float32Array([1, 0]), new Float32Array([0, 1])]);
    expect(Array.from(m)).toEqual([0.5, 0.5]);
    const i = toInt16(new Float32Array([0.5, -0.5, 2]));
    expect(Array.from(i)).toEqual([16384, -16384, 32767]);
    expect(toFloat32(i)[0]).toBeCloseTo(0.5, 3);
  });
});
