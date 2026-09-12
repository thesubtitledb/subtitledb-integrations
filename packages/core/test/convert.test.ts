import { describe, expect, it } from 'vitest';
import { assToVtt, ConvertError, srtToVtt, toVtt } from '../src/convert.js';

// The srt sample is shaped from a real download off the API: CRLF endings, a BOM,
// sequence numbers, comma decimal separators, and an <i> tag. All four are things a
// naive converter gets wrong.
const SRT = [
  '﻿1',
  '00:00:01,000 --> 00:00:04,500',
  'Wake up, <i>Neo</i>.',
  '',
  '2',
  '00:00:05,000 --> 00:00:07,250',
  'The Matrix has you.',
  'Follow the white rabbit.',
  '',
].join('\r\n');

describe('srt to vtt', () => {
  it('emits a WEBVTT header and dot separated timestamps', () => {
    const vtt = srtToVtt(SRT);
    expect(vtt.startsWith('WEBVTT\n')).toBe(true);
    expect(vtt).toContain('00:00:01.000 --> 00:00:04.500');
    expect(vtt).toContain('00:00:05.000 --> 00:00:07.250');
  });

  it('drops sequence numbers and keeps multi-line cue text', () => {
    const vtt = srtToVtt(SRT);
    expect(vtt).not.toMatch(/^\s*2\s*$/m);
    expect(vtt).toContain('The Matrix has you.\nFollow the white rabbit.');
  });

  it('keeps WebVTT tags and escapes everything else', () => {
    const vtt = srtToVtt(SRT);
    expect(vtt).toContain('<i>Neo</i>');

    const hostile = srtToVtt('1\n00:00:01,000 --> 00:00:02,000\n<script>alert(1)</script> A & B\n');
    expect(hostile).toContain('&lt;script&gt;');
    expect(hostile).not.toContain('<script>');
    expect(hostile).toContain('A &amp; B');
  });

  it('drops font colouring instead of putting the markup on screen', () => {
    // Colour tags are everywhere in the SubRip corpus and WebVTT has no equivalent.
    // Escaping them is safe and unreadable: the viewer gets a line of markup.
    const vtt = srtToVtt(
      '1\n00:00:01,000 --> 00:00:02,000\n<font color="#ffff00">Wake up, Neo.</font>\n',
    );
    expect(vtt).toContain('Wake up, Neo.');
    expect(vtt).not.toContain('font');
    expect(vtt).not.toContain('&lt;');
  });

  it('pads short hour and millisecond fields', () => {
    const vtt = srtToVtt('1\n1:2:3,4 --> 1:2:4,50\nhi\n');
    expect(vtt).toContain('01:02:03.400 --> 01:02:04.500');
  });

  it('tolerates the dot separator some files use instead of a comma', () => {
    expect(srtToVtt('1\n00:00:01.000 --> 00:00:02.000\nhi\n')).toContain(
      '00:00:01.000 --> 00:00:02.000',
    );
  });

  it('drops SubRip coordinate lines rather than rendering them as text', () => {
    const vtt = srtToVtt('1\n00:00:01,000 --> 00:00:02,000\nX1:100 X2:200 Y1:10 Y2:20\nhi\n');
    expect(vtt).not.toContain('X1:100');
    expect(vtt).toContain('hi');
  });

  it('throws rather than returning an empty track', () => {
    // An empty WEBVTT file loads without error and shows nothing, so a caller that
    // gets one has no way to tell a broken subtitle from a silent one.
    expect(() => srtToVtt('not a subtitle at all')).toThrow(ConvertError);
  });
});

const ASS = [
  '[Script Info]',
  'ScriptType: v4.00+',
  '',
  '[V4+ Styles]',
  'Format: Name, Fontname',
  'Style: Default,Arial',
  '',
  '[Events]',
  'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  'Dialogue: 0,0:00:05.00,0:00:07.25,Default,,0,0,0,,{\\an8}Second, with a comma',
  'Dialogue: 0,0:00:01.00,0:00:04.50,Default,,0,0,0,,First line\\NSecond line',
  'Comment: 0,0:00:09.00,0:00:10.00,Default,,0,0,0,,not dialogue',
].join('\n');

describe('ass to vtt', () => {
  it('reads field positions from the Format line, not by assumption', () => {
    const vtt = assToVtt(ASS);
    expect(vtt).toContain('00:00:01.000 --> 00:00:04.500');
    expect(vtt).toContain('00:00:05.000 --> 00:00:07.250');
  });

  it('keeps commas inside the text field', () => {
    expect(assToVtt(ASS)).toContain('Second, with a comma');
  });

  it('strips override blocks and expands the line break escape', () => {
    const vtt = assToVtt(ASS);
    expect(vtt).not.toContain('\\an8');
    expect(vtt).toContain('First line\nSecond line');
  });

  it('sorts cues, because ASS does not require chronological order', () => {
    const vtt = assToVtt(ASS);
    expect(vtt.indexOf('00:00:01.000')).toBeLessThan(vtt.indexOf('00:00:05.000'));
  });

  it('skips Comment events', () => {
    expect(assToVtt(ASS)).not.toContain('not dialogue');
  });

  it('throws on a file with no dialogue', () => {
    expect(() => assToVtt('[Script Info]\nTitle: empty\n')).toThrow(ConvertError);
  });
});

describe('toVtt', () => {
  it('passes WebVTT through, normalising only line endings and the BOM', () => {
    const out = toVtt('﻿WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nhi\r\n', 'vtt');
    expect(out.startsWith('WEBVTT')).toBe(true);
    expect(out).not.toContain('\r');
  });

  it('adds the header to headerless vtt, which some of the corpus is missing', () => {
    expect(toVtt('00:00:01.000 --> 00:00:02.000\nhi\n', 'vtt').startsWith('WEBVTT\n')).toBe(true);
  });

  it('treats ssa the same as ass', () => {
    expect(toVtt(ASS, 'ssa')).toContain('00:00:01.000 --> 00:00:04.500');
  });

  it('refuses formats it cannot parse instead of guessing', () => {
    expect(() => toVtt('anything', 'sub')).toThrow(ConvertError);
  });
});

describe('cue text a player has to be able to parse', () => {
  it('leaves an entity the file already escaped alone', () => {
    // Escaping every ampersand turns &amp; into &amp;amp; and the viewer reads the
    // entity instead of the character. Most of the corpus is already escaped.
    const vtt = srtToVtt('1\n00:00:01,000 --> 00:00:02,000\nTom &amp; Jerry, it&#39;s late\n');
    expect(vtt).toContain('Tom &amp; Jerry');
    expect(vtt).toContain('it&#39;s late');
    expect(vtt).not.toContain('&amp;amp;');
    expect(vtt).not.toContain('&amp;#39;');
  });

  it('escapes an arrow in the text so it cannot be read as a timestamp', () => {
    // A cue whose text contains --> ends the cue early in a strict parser, and the
    // rest of the line is dropped or the file is rejected outright.
    const vtt = srtToVtt('1\n00:00:01,000 --> 00:00:02,000\ngo 1 --> 2\n');
    expect(vtt).toContain('go 1 --&gt; 2');
    expect(vtt.match(/-->/g)).toHaveLength(1);
  });

  it('keeps a WebVTT tag that carries attributes', () => {
    // <lang en> and <c.classname> are WebVTT's own, and matching the bare tag name
    // only meant anything with an attribute was escaped and shown as markup.
    const vtt = srtToVtt('1\n00:00:01,000 --> 00:00:02,000\n<lang en>hi</lang>\n');
    expect(vtt).toContain('<lang en>hi</lang>');
    expect(vtt).not.toContain('&lt;lang');
  });

  it('strips ass overrides before escaping, not after', () => {
    // {\an8} is positioning, not text. Escaping first leaves the braces on screen.
    const vtt = assToVtt(
      [
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:01.00,0:00:02.00,Default,,0,0,0,,{\\an8}Wake up & listen',
      ].join('\n'),
    );
    expect(vtt).toContain('Wake up &amp; listen');
    expect(vtt).not.toContain('an8');
  });
});
