import type { Cue } from '@subtitledb/core';
import { describe, expect, it } from 'vitest';
import { cueLines, cuesAt, formatOffset, sortCues } from '../src/cues.js';

const cue = (start: number, end: number, text = `${start}`): Cue => ({ start, end, text });

describe('cuesAt', () => {
  const cues = sortCues([cue(5000, 7000), cue(1000, 3000), cue(2500, 4000), cue(9000, 9500)]);

  it('finds what is on screen, overlaps included, in file order', () => {
    expect(cuesAt(cues, 500)).toEqual([]);
    expect(cuesAt(cues, 1000).map((c) => c.start)).toEqual([1000]);
    expect(cuesAt(cues, 2800).map((c) => c.start)).toEqual([1000, 2500]);
    expect(cuesAt(cues, 3000).map((c) => c.start)).toEqual([2500]);
    expect(cuesAt(cues, 4500)).toEqual([]);
    expect(cuesAt(cues, 9499).map((c) => c.start)).toEqual([9000]);
    expect(cuesAt(cues, 20_000)).toEqual([]);
  });

  it('a positive offset shows every line later, a negative one earlier', () => {
    expect(cuesAt(cues, 1500, 1000)).toEqual([]);
    expect(cuesAt(cues, 2000, 1000).map((c) => c.start)).toEqual([1000]);
    expect(cuesAt(cues, 4000, -1000).map((c) => c.start)).toEqual([5000]);
  });

  it('copes with an empty file', () => {
    expect(cuesAt([], 1000)).toEqual([]);
  });
});

describe('cueLines', () => {
  it('keeps b, i and u, drops every other tag and keeps its text', () => {
    expect(cueLines('<i>Hello</i> <c.yellow>there</c>\n<v Bob><b>Bob</b></v>')).toEqual([
      [
        { text: 'Hello', b: false, i: true, u: false },
        { text: ' ', b: false, i: false, u: false },
        { text: 'there', b: false, i: false, u: false },
      ],
      [{ text: 'Bob', b: true, i: false, u: false }],
    ]);
  });

  it('never lets markup through as markup: it comes back as text or not at all', () => {
    const lines = cueLines('<img src=x onerror=alert(1)>&lt;script&gt;x&lt;/script&gt;');
    expect(
      lines
        .flat()
        .map((s) => s.text)
        .join(''),
    ).toBe('<script>x</script>');
  });

  it('decodes entities and drops trailing empty lines', () => {
    expect(cueLines('Tom &amp; Jerry&#33;\n\n')).toEqual([
      [{ text: 'Tom & Jerry!', b: false, i: false, u: false }],
    ]);
  });
});

describe('formatOffset', () => {
  it('says which way and how far', () => {
    expect(formatOffset(0)).toBe('0 s');
    expect(formatOffset(1500)).toBe('+1.5 s');
    expect(formatOffset(-250)).toBe('-0.25 s');
    expect(formatOffset(-2000)).toBe('-2 s');
  });
});
