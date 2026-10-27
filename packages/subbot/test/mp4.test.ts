import { describe, expect, it } from 'vitest';
import { fromBytes, Reader } from '../src/audio/bytes.js';
import {
  boxes,
  chunksOf,
  extents,
  parseMoof,
  parseMoov,
  parseSidx,
  pickAudio,
  samplesBetween,
  sampleTable,
} from '../src/audio/mp4.js';
import { media } from './fixtures.js';

function moovOf(u8: Uint8Array) {
  const moov = boxes(u8).find((b) => b.type === 'moov');
  if (!moov) throw new Error('no moov');
  return parseMoov(u8, moov);
}

describe('flat mp4', () => {
  const u8 = media('sintel.mp4');
  const movie = moovOf(u8);

  it('finds the AAC track with its config', () => {
    const track = pickAudio(movie);
    expect(track?.codec).toMatchObject({
      kind: 'aac',
      codec: 'mp4a.40.2',
      sampleRate: 44100,
      channels: 2,
    });
    // ffmpeg writes the two-byte config plus an explicit no-SBR extension.
    expect(track?.codec?.description?.length).toBeGreaterThanOrEqual(2);
    expect(track?.timescale).toBe(44100);
    // 20 s of 1024-sample frames, give or take the encoder's padding.
    expect(track?.samples.length).toBeGreaterThan(850);
    expect(track?.samples.length).toBeLessThan(880);
  });

  it('reads one second of samples by time, in one byte extent', () => {
    const track = pickAudio(movie);
    if (!track) throw new Error('no audio');
    const s = samplesBetween(track, 5, 6);
    expect(s.length).toBeGreaterThanOrEqual(42);
    expect(s.length).toBeLessThanOrEqual(45);
    const ex = extents(s);
    expect(ex).toHaveLength(1);
    const chunks = chunksOf(s, track, u8);
    expect(chunks).toHaveLength(s.length);
    expect(chunks[0]?.ts).toBeGreaterThanOrEqual(4.95);
    expect(chunks[0]?.ts).toBeLessThan(5.03);
    expect(chunks[1]?.ts ?? 0).toBeGreaterThan(chunks[0]?.ts ?? 0);
  });

  it('answers nothing past the end', () => {
    const track = pickAudio(movie);
    if (!track) throw new Error('no audio');
    expect(samplesBetween(track, 100, 101)).toHaveLength(0);
  });

  it('is reachable through a Reader', async () => {
    const r = new Reader(fromBytes(u8), 4096);
    const head = await r.read(0, 16);
    expect(boxes(head)[0]?.type).toBe('ftyp');
  });
});

describe('fragmented mp4', () => {
  const u8 = media('sintel-frag.mp4');
  const movie = moovOf(u8);

  it('has an empty sample table and trex defaults', () => {
    const track = pickAudio(movie);
    expect(track?.samples).toHaveLength(0);
    expect(track?.codec?.kind).toBe('aac');
  });

  it('reads every moof into timed samples that cover the file', () => {
    const track = pickAudio(movie);
    if (!track) throw new Error('no audio');
    const tracks = new Map(movie.tracks.map((t) => [t.id, t]));
    let n = 0;
    let lastDts = -1;
    for (const moof of boxes(u8).filter((b) => b.type === 'moof')) {
      for (const run of parseMoof(u8, moof, tracks)) {
        if (run.trackId !== track.id) continue;
        for (const s of run.samples) {
          expect(s.dts).toBeGreaterThan(lastDts);
          expect(s.offset + s.size).toBeLessThanOrEqual(u8.length);
          lastDts = s.dts;
          n++;
        }
      }
    }
    expect(n).toBeGreaterThan(850);
    expect(lastDts / track.timescale).toBeGreaterThan(19.5);
  });
});

describe('dash segments', () => {
  it('pairs an init segment with a media segment', () => {
    const init = media('dash/init-1.m4s');
    const seg = media('dash/chunk-1-00002.m4s');
    const movie = moovOf(init);
    const track = pickAudio(movie);
    if (!track) throw new Error('no audio');
    const tracks = new Map(movie.tracks.map((t) => [t.id, t]));
    const moof = boxes(seg).find((b) => b.type === 'moof');
    if (!moof) throw new Error('no moof');
    const runs = parseMoof(seg, moof, tracks);
    expect(runs).toHaveLength(1);
    const chunks = chunksOf(runs[0]?.samples ?? [], track, seg);
    expect(chunks.length).toBeGreaterThan(150);
    // The second 4 s segment starts at four seconds.
    expect(chunks[0]?.ts).toBeGreaterThan(3.9);
    expect(chunks[0]?.ts).toBeLessThan(4.1);
  });
});

describe('sidx', () => {
  it('reads a hand-made index', () => {
    const b = new Uint8Array([
      0, 0, 0, 44, 0x73, 0x69, 0x64, 0x78, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0x27, 0x10, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 1, 0, 0, 0x10, 0, 0, 0, 0x4e, 0x20, 0x90, 0, 0, 0,
    ]);
    const box = boxes(b)[0];
    if (!box) throw new Error('no box');
    const sidx = parseSidx(b, box);
    expect(sidx).toEqual({
      timescale: 10000,
      earliest: 0,
      firstOffset: 0,
      refs: [{ size: 4096, dur: 20000 }],
    });
  });
});

describe('sample table', () => {
  const u32 = (n: number[]) => {
    const b = new Uint8Array(n.length * 4);
    const v = new DataView(b.buffer);
    for (const [i, x] of n.entries()) v.setUint32(i * 4, x);
    return b;
  };
  const box = (type: string, ...parts: Uint8Array[]) => {
    const body = parts.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(8 + body);
    out.set(u32([8 + body]));
    out.set(new TextEncoder().encode(type), 4);
    let p = 8;
    for (const part of parts) {
      out.set(part, p);
      p += part.length;
    }
    return out;
  };

  // A phone or screen recording interleaves audio per video frame, so its stsc has a
  // run for nearly every chunk. Read once per chunk, that was 150k x 150k steps.
  it('maps 150k chunks with a run each in one pass', () => {
    const chunks = 150_000;
    const per = (c: number) => (c % 2 ? 2 : 1);
    const runs: number[] = [];
    let samples = 0;
    for (let c = 0; c < chunks; c++) {
      runs.push(c + 1, per(c), 1);
      samples += per(c);
    }
    const stbl = box(
      'stbl',
      box('stts', u32([0, 1, samples, 1024])),
      box('stsc', u32([0, chunks].concat(runs))),
      box('stsz', u32([0, 0, samples].concat(new Array<number>(samples).fill(10)))),
      box('stco', u32([0, chunks].concat(Array.from({ length: chunks }, (_, c) => c * 1000)))),
    );
    const root = boxes(stbl)[0];
    if (!root) throw new Error('no stbl');
    const t0 = performance.now();
    const s = sampleTable(stbl, root);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(s).toHaveLength(225_000);
    expect(s.slice(0, 4).map((x) => x.offset)).toEqual([0, 1000, 1010, 2000]);
    expect(s[3]?.dts).toBe(3 * 1024);
    expect(s.at(-1)?.offset).toBe((chunks - 1) * 1000 + 10);
  });
});
