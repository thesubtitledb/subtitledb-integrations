import { describe, expect, it } from 'vitest';
import { cuesToVtt, formatTimestamp } from '../src/vtt.js';

describe('formatTimestamp', () => {
  it('writes the WebVTT HH:MM:SS.mmm form', () => {
    expect(formatTimestamp(0)).toBe('00:00:00.000');
    expect(formatTimestamp(3661.5)).toBe('01:01:01.500');
    expect(formatTimestamp(72.25)).toBe('00:01:12.250');
  });

  it('clamps a negative or non-finite time to zero', () => {
    expect(formatTimestamp(-5)).toBe('00:00:00.000');
    expect(formatTimestamp(Number.NaN)).toBe('00:00:00.000');
  });
});

describe('cuesToVtt', () => {
  it('builds a file with a header and one block per cue', () => {
    const vtt = cuesToVtt([
      { start: 0, end: 2, text: 'hello' },
      { start: 2.5, end: 4, text: 'world' },
    ]);
    expect(vtt.startsWith('WEBVTT\n')).toBe(true);
    expect(vtt).toContain('00:00:00.000 --> 00:00:02.000\nhello');
    expect(vtt).toContain('00:00:02.500 --> 00:00:04.000\nworld');
    expect((vtt.match(/-->/g) ?? []).length).toBe(2);
  });

  it('drops empty cues and gives a reversed one a short default duration', () => {
    // A model occasionally emits a blank line or a zero/reversed span at a chunk
    // boundary; neither should reach the player as a flicker.
    const vtt = cuesToVtt([
      { start: 5, end: 3, text: 'reversed' },
      { start: 10, end: 12, text: '   ' },
    ]);
    expect((vtt.match(/-->/g) ?? []).length).toBe(1);
    expect(vtt).toContain('00:00:05.000 --> 00:00:07.000\nreversed');
  });
});
