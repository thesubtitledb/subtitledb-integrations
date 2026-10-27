import { describe, expect, it } from 'vitest';
import { fillTemplate, isoDuration, parseMpd } from '../src/audio/dash.js';
import { parseM3u8, pickHlsAudio } from '../src/audio/hls.js';
import { find, parseXml } from '../src/audio/xml.js';
import { mediaText } from './fixtures.js';

const BASE = 'https://cdn.example.test/v/';

describe('m3u8', () => {
  it('reads a TS media playlist into timed segments', () => {
    const p = parseM3u8(mediaText('hls-ts/index.m3u8'), `${BASE}hls-ts/index.m3u8`);
    if (p.kind !== 'media') throw new Error('expected media');
    expect(p.endlist).toBe(true);
    expect(p.segments).toHaveLength(5);
    expect(p.segments[0]).toMatchObject({ uri: `${BASE}hls-ts/seg000.ts`, start: 0, map: null });
    expect(p.segments[1]?.start).toBeCloseTo(p.segments[0]?.duration ?? 0, 5);
    const total = p.segments.reduce((n, s) => n + s.duration, 0);
    expect(total).toBeGreaterThan(19.5);
  });

  it('carries the init segment of an fmp4 playlist on every segment', () => {
    const p = parseM3u8(mediaText('hls-fmp4/index.m3u8'), `${BASE}hls-fmp4/index.m3u8`);
    if (p.kind !== 'media') throw new Error('expected media');
    expect(p.segments.every((s) => s.map?.uri === `${BASE}hls-fmp4/init.mp4`)).toBe(true);
    expect(p.segments[0]?.uri).toBe(`${BASE}hls-fmp4/seg000.m4s`);
  });

  it('reads a master playlist and picks the audio rendition', () => {
    const p = parseM3u8(mediaText('hls-alt/master.m3u8'), `${BASE}hls-alt/master.m3u8`);
    if (p.kind !== 'master') throw new Error('expected master');
    expect(p.variants).toHaveLength(1);
    expect(p.audio[0]).toMatchObject({ groupId: 'aud', language: 'en', isDefault: true });
    expect(pickHlsAudio(p)).toBe(`${BASE}hls-alt/audio/index.m3u8`);
  });

  it('falls back to the variant when its audio is muxed in', () => {
    const p = parseM3u8(
      ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=800000,CODECS="avc1,mp4a"', 'v/index.m3u8'].join(
        '\n',
      ),
      `${BASE}master.m3u8`,
    );
    if (p.kind !== 'master') throw new Error('expected master');
    expect(pickHlsAudio(p)).toBe(`${BASE}v/index.m3u8`);
  });

  it('reads byte ranges, with an omitted offset continuing the last one', () => {
    const p = parseM3u8(
      [
        '#EXTM3U',
        '#EXT-X-MAP:URI="one.mp4",BYTERANGE="600@0"',
        '#EXTINF:4.0,',
        '#EXT-X-BYTERANGE:1000@600',
        'one.mp4',
        '#EXTINF:4.0,',
        '#EXT-X-BYTERANGE:500',
        'one.mp4',
      ].join('\n'),
      `${BASE}p.m3u8`,
    );
    if (p.kind !== 'media') throw new Error('expected media');
    expect(p.segments[0]?.byteRange).toEqual([600, 1600]);
    expect(p.segments[1]?.byteRange).toEqual([1600, 2100]);
    expect(p.segments[0]?.map?.byteRange).toEqual([0, 600]);
  });
});

describe('mpd', () => {
  it('reads a SegmentTemplate with a timeline', () => {
    const a = parseMpd(mediaText('dash/manifest.mpd'), `${BASE}dash/manifest.mpd`);
    expect(a?.codecs).toBe('mp4a.40.2');
    expect(a?.init?.uri).toBe(`${BASE}dash/init-1.m4s`);
    expect(a?.segments).toHaveLength(5);
    expect(a?.segments?.[0]).toMatchObject({ uri: `${BASE}dash/chunk-1-00001.m4s`, start: 0 });
    expect(a?.segments?.[4]?.uri).toBe(`${BASE}dash/chunk-1-00005.m4s`);
    const end = (a?.segments?.[4]?.start ?? 0) + (a?.segments?.[4]?.duration ?? 0);
    expect(end).toBeGreaterThan(19.5);
    expect(a?.duration).toBe(20);
  });

  it('reads a SegmentTemplate with a fixed duration', () => {
    const a = parseMpd(mediaText('dash-number/manifest.mpd'), `${BASE}dash-number/manifest.mpd`);
    expect(a?.segments?.length).toBeGreaterThanOrEqual(5);
    expect(a?.segments?.[1]?.uri).toBe(`${BASE}dash-number/chunk-1-00002.m4s`);
  });

  it('reads SegmentBase as an indexed file', () => {
    const mpd = `<MPD mediaPresentationDuration="PT10S"><Period><AdaptationSet contentType="audio" lang="fr">
      <Representation id="a" bandwidth="1" mimeType="audio/mp4" codecs="mp4a.40.2"><BaseURL>audio.mp4</BaseURL>
      <SegmentBase indexRange="800-1200"><Initialization range="0-799"/></SegmentBase></Representation>
      </AdaptationSet></Period></MPD>`;
    const a = parseMpd(mpd, `${BASE}m.mpd`);
    expect(a?.language).toBe('fr');
    expect(a?.init).toEqual({ uri: `${BASE}audio.mp4`, byteRange: [0, 800] });
    expect(a?.indexed).toEqual({ uri: `${BASE}audio.mp4`, indexRange: [800, 1201] });
    expect(a?.segments).toBeNull();
  });

  it('prefers the asked language and the cheapest representation', () => {
    const mpd = `<MPD mediaPresentationDuration="PT8S"><Period>
      <AdaptationSet contentType="audio" lang="en"><SegmentTemplate media="$RepresentationID$-$Number$.m4s" duration="4" startNumber="1"/>
        <Representation id="hi" bandwidth="200"/><Representation id="lo" bandwidth="100"/></AdaptationSet>
      <AdaptationSet contentType="audio" lang="de"><SegmentTemplate media="$RepresentationID$-$Number$.m4s" duration="4" startNumber="1"/>
        <Representation id="de" bandwidth="100"/></AdaptationSet>
      </Period></MPD>`;
    expect(parseMpd(mpd, `${BASE}m.mpd`)?.segments?.[0]?.uri).toBe(`${BASE}lo-1.m4s`);
    expect(parseMpd(mpd, `${BASE}m.mpd`, 'de')?.segments?.map((s) => s.uri)).toEqual([
      `${BASE}de-1.m4s`,
      `${BASE}de-2.m4s`,
    ]);
  });

  it('fills templates', () => {
    expect(
      fillTemplate('$RepresentationID$-$Number%05d$-$Time$$$', { id: 'a', number: 7, time: 90 }),
    ).toBe('a-00007-90$');
    expect(isoDuration('PT1H2M3.5S')).toBe(3723.5);
    expect(isoDuration('PT20.0S')).toBe(20);
  });
});

describe('xml', () => {
  it('reads nested elements, attributes, self-closing tags and entities', () => {
    const doc = parseXml(
      '<?xml version="1.0"?><a x="1 &amp; 2"><b/><c y=\'q\'>t&lt;</c><!-- no --></a>',
    );
    const a = find(doc, 'a');
    expect(a?.attrs.x).toBe('1 & 2');
    expect(a?.children.map((c) => c.name)).toEqual(['b', 'c']);
    expect(find(a as never, 'c')?.text).toBe('t<');
  });
});
