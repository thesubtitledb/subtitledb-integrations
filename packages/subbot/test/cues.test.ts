import { describe, expect, it } from 'vitest';
import {
  type Cue,
  CueStore,
  held,
  isJunk,
  type Segment,
  segmentsToCues,
  trimToSpeech,
} from '../src/cues.js';
import { cuesToVtt, formatTimestamp } from '../src/vtt.js';

const seg = (t0: number, t1: number, text: string, extra: Partial<Segment> = {}): Segment => ({
  t0,
  t1,
  text,
  nsp: 0.1,
  p: 0.9,
  ...extra,
});

describe('segmentsToCues', () => {
  it('drops silence, junk and repeats', () => {
    const cues = segmentsToCues(
      [
        seg(0, 2, ' Hello there. '),
        seg(2, 4, '(music)', { nsp: 0.9, p: 0.3 }),
        seg(4, 6, 'Thank you for watching.'),
        seg(6, 8, '♪'),
        seg(8, 10, 'hello there.'),
        seg(10, 12, 'Yes yes yes yes yes yes yes.'),
        seg(12, 14, 'You are lucky. You are lucky.'),
      ],
      'live',
      0,
      14,
    );
    expect(cues.map((c) => c.text)).toEqual(['Hello there.', 'Yes.', 'You are lucky.']);
    expect(isJunk('[BLANK_AUDIO]')).toBe(true);
    expect(isJunk('Subtitles by the Amara.org community')).toBe(true);
    expect(isJunk('We go now.')).toBe(false);
  });

  it('clamps to the window and keeps a minimum duration', () => {
    const cues = segmentsToCues([seg(-1, 0.1, 'Early.'), seg(5, 5, 'Blip.')], 'live', 0, 6);
    expect(cues[0]).toMatchObject({ start: 0, text: 'Early.' });
    expect(cues[0]?.end).toBeCloseTo(0.6, 5);
    expect(cues[1]).toMatchObject({ start: 5, end: 5.6 });
  });

  it('splits a long line into readable pieces timed by tokens', () => {
    const text =
      'This is a very long line of dialogue that no viewer could read in one go on screen at all really';
    const tokens = text.split(' ').map((w, i, all) => ({
      text: i === 0 ? w : ` ${w}`,
      t0: (i / all.length) * 6,
      t1: ((i + 1) / all.length) * 6,
      p: 0.9,
    }));
    const cues = segmentsToCues([seg(0, 6, text, { tokens })], 'quality', 0, 6);
    expect(cues.length).toBeGreaterThanOrEqual(2);
    expect(cues.every((c) => c.text.length <= 84)).toBe(true);
    expect(cues.map((c) => c.text).join(' ')).toBe(text);
    expect(cues[0]?.end).toBeGreaterThan(1);
    expect(cues[0]?.end).toBeLessThan(5);
    expect(cues[cues.length - 1]?.end).toBe(6);
  });

  it('never lets one cue overlap the next', () => {
    const cues = segmentsToCues([seg(0, 5, 'One.'), seg(2, 6, 'Two.')], 'live', 0, 10);
    expect(cues[0]?.end).toBe(2);
  });
});

describe('CueStore', () => {
  const cue = (start: number, end: number, tier: Cue['tier'], text = 'x'): Cue => ({
    start,
    end,
    text,
    tier,
  });

  it('quality replaces live on the same span, live never touches quality', () => {
    const s = new CueStore();
    const events: Array<[number, number]> = [];
    s.listen((a, r) => events.push([a.length, r.length]));
    s.replace(0, 6, [cue(0, 2, 'live'), cue(3, 5, 'live')], 'live');
    s.replace(0, 15, [cue(0, 2, 'quality'), cue(4, 6, 'quality')], 'quality');
    expect(s.cues.map((c) => c.tier)).toEqual(['quality', 'quality']);
    s.replace(6, 12, [cue(5, 7, 'live'), cue(8, 10, 'live')], 'live');
    expect(s.cues.map((c) => [c.start, c.tier])).toEqual([
      [0, 'quality'],
      [4, 'quality'],
      [8, 'live'],
    ]);
    expect(events).toEqual([
      [2, 0],
      [2, 2],
      [1, 0],
    ]);
  });

  it('a later live window replaces an earlier live one', () => {
    const s = new CueStore();
    s.replace(0, 6, [cue(1, 2, 'live', 'a')], 'live');
    s.replace(0, 6, [cue(1, 2, 'live', 'b')], 'live');
    expect(s.cues.map((c) => c.text)).toEqual(['b']);
    s.clear();
    expect(s.cues).toEqual([]);
  });
});

describe('vtt', () => {
  it('formats timestamps and escapes markup', () => {
    expect(formatTimestamp(3723.456)).toBe('01:02:03.456');
    const vtt = cuesToVtt([cue(0.5, 2, 'a <b> & c'), cue(3, 3, 'empty')]);
    expect(vtt).toBe('WEBVTT\n\n00:00:00.500 --> 00:00:02.000\na &lt;b&gt; &amp; c\n\n');
  });
  const cue = (start: number, end: number, text: string): Cue => ({
    start,
    end,
    text,
    tier: 'live',
  });
});

describe('trimToSpeech', () => {
  const cue = (start: number, end: number): Cue => ({ start, end, text: 'x', tier: 'live' });

  it('moves a start that sits in silence forward to the voice, and an end back to it', () => {
    const spans: Array<[number, number]> = [
      [14, 15.8],
      [18, 21.4],
    ];
    const [a] = trimToSpeech([cue(15.8, 21.4)], spans);
    expect(a?.start).toBe(18);
    expect(a?.end).toBe(21.4);
    const [b] = trimToSpeech([cue(18, 23)], spans);
    expect(b?.start).toBe(18);
    expect(b?.end).toBe(21.4);
  });

  it('leaves a cue alone when both edges are on speech, or when trimming would empty it', () => {
    const spans: Array<[number, number]> = [[10, 12]];
    expect(trimToSpeech([cue(10.1, 11.9)], spans)[0]).toMatchObject({ start: 10.1, end: 11.9 });
    expect(trimToSpeech([cue(13, 14)], spans)[0]).toMatchObject({ start: 13, end: 14 });
    expect(trimToSpeech([cue(13, 14)], [])[0]).toMatchObject({ start: 13, end: 14 });
  });
});

describe('held', () => {
  const cue = (start: number, end: number, text: string): Cue => ({
    start,
    end,
    text,
    tier: 'live',
  });

  it('keeps a short line up long enough to read', () => {
    const [a, b] = held([cue(10, 10.6, 'Ah!'), cue(20, 20.8, 'Who is hungry for some lunch now?')]);
    expect(a?.end).toBeCloseTo(11.2);
    // 33 characters at 17 a second.
    expect(b?.end).toBeCloseTo(20 + 33 / 17);
  });

  it('closes a short gap and never runs into the next line', () => {
    const [a, b, c] = held([
      cue(0, 2, 'One line here.'),
      cue(2.5, 3, 'Go!'),
      cue(3.4, 6, 'Then a third.'),
    ]);
    expect(a?.end).toBe(2.5);
    expect(b?.end).toBe(3.4);
    expect(c?.end).toBe(6);
  });

  it('leaves a gap the screen should show, and the heard times alone', () => {
    const heard = [cue(0, 2, 'First line.'), cue(10, 12, 'After a pause.')];
    const [a] = held(heard);
    expect(a?.end).toBe(2);
    expect(heard[0]?.end).toBe(2);
  });
});
