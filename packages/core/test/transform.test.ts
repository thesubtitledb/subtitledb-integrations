import { describe, expect, it } from 'vitest';
import { decodeBytes, parseVtt, rescale, serialize, shift } from '../src/transform.js';

const VTT = `WEBVTT

00:00:01.000 --> 00:00:02.500
Hello

00:00:03.000 --> 00:00:04.000 line:80%
World
`;

describe('parseVtt / serialize', () => {
  it('round-trips cues, times and settings', () => {
    const cues = parseVtt(VTT);
    expect(cues).toEqual([
      { start: 1000, end: 2500, text: 'Hello' },
      { start: 3000, end: 4000, text: 'World', settings: 'line:80%' },
    ]);
    // Serialise and parse again: the times and settings survive the trip.
    expect(parseVtt(serialize(cues))).toEqual(cues);
  });

  it('ignores the header, notes and cue identifiers', () => {
    const cues = parseVtt('WEBVTT\n\nNOTE a comment\n\n7\n00:00:01.000 --> 00:00:02.000\nHi\n');
    expect(cues).toEqual([{ start: 1000, end: 2000, text: 'Hi' }]);
  });

  it('reads MM:SS.mmm without an hour field', () => {
    expect(parseVtt('WEBVTT\n\n01:02.000 --> 01:03.000\nx\n')[0]?.start).toBe(62000);
  });
});

describe('shift', () => {
  it('moves every cue and clamps at zero', () => {
    const cues = [
      { start: 1000, end: 2000, text: 'a' },
      { start: 200, end: 500, text: 'b' },
    ];
    expect(shift(cues, 500)).toEqual([
      { start: 1500, end: 2500, text: 'a' },
      { start: 700, end: 1000, text: 'b' },
    ]);
    expect(shift(cues, -800)).toEqual([
      { start: 200, end: 1200, text: 'a' },
      { start: 0, end: 0, text: 'b' },
    ]);
  });
});

describe('rescale', () => {
  it('scales by from/to', () => {
    const out = rescale([{ start: 1000, end: 2000, text: 'a' }], 23.976, 25);
    expect(out[0]?.start).toBeCloseTo((1000 * 23.976) / 25, 5);
    expect(out[0]?.end).toBeCloseTo((2000 * 23.976) / 25, 5);
  });

  it('rejects a non-positive rate rather than dividing by zero', () => {
    expect(() => rescale([], 0, 25)).toThrow();
  });
});

describe('decodeBytes', () => {
  it('reads UTF-8 by default and strips a BOM', () => {
    expect(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toBe('hi');
  });

  it('sniffs UTF-16LE from a byte-order mark', () => {
    expect(decodeBytes(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]))).toBe('hi');
  });

  it('detects BOM-less UTF-16LE from NUL density', () => {
    const s = 'hello';
    const bytes = new Uint8Array(s.length * 2);
    for (let i = 0; i < s.length; i++) bytes[i * 2] = s.charCodeAt(i);
    expect(decodeBytes(bytes, 'auto')).toBe('hello');
  });

  it('honours a named charset', () => {
    // 0xE9 is a valid é in Windows-1252 and a lone continuation byte in UTF-8.
    expect(decodeBytes(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), 'windows-1252')).toBe('café');
  });

  it('throws a ConvertError on an unknown charset', () => {
    expect(() => decodeBytes(new Uint8Array([1]), 'not-a-charset')).toThrow();
  });
});
