import { describe, expect, it } from 'vitest';
import { fromBytes, Reader } from '../src/audio/bytes.js';
import {
  chunksOfCluster,
  clusterFor,
  element,
  parseCluster,
  pickAudio,
  readHeader,
  vint,
} from '../src/audio/ebml.js';
import { media } from './fixtures.js';

async function header(name: string) {
  const u8 = media(name);
  const h = await readHeader(new Reader(fromBytes(u8), 64 * 1024));
  if (!h) throw new Error(`${name}: not ebml`);
  return { u8, h };
}

describe('vint', () => {
  it('reads ids with the marker and sizes without', () => {
    expect(vint(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 0, true)).toEqual({
      value: 0x1a45dfa3,
      length: 4,
    });
    expect(vint(new Uint8Array([0x81]), 0, false)).toEqual({ value: 1, length: 1 });
    expect(vint(new Uint8Array([0x40, 0x02]), 0, false)).toEqual({ value: 2, length: 2 });
    expect(vint(new Uint8Array([0xff]), 0, false).value).toBe(-1);
  });
});

describe('matroska header', () => {
  it('reads an opus webm: track, codec private, cues and duration', async () => {
    const { h } = await header('sintel-opus.webm');
    const t = pickAudio(h);
    expect(t?.codecId).toBe('A_OPUS');
    expect(t?.codec).toMatchObject({ kind: 'opus', codec: 'opus', sampleRate: 48000, channels: 2 });
    expect(new TextDecoder().decode(t?.codec?.description?.subarray(0, 8))).toBe('OpusHead');
    expect(h.duration).toBeGreaterThan(19.9);
    expect(h.duration).toBeLessThan(20.2);
    expect(h.cues.length).toBeGreaterThan(0);
    expect(h.firstCluster).toBeGreaterThan(0);
  });

  it('reads aac, flac and ac3 in mkv', async () => {
    const aac = (await header('sintel-aac.mkv')).h;
    expect(pickAudio(aac)?.codec).toMatchObject({
      kind: 'aac',
      codec: 'mp4a.40.2',
      sampleRate: 44100,
    });
    expect(pickAudio(aac)?.codec?.description?.length).toBeGreaterThanOrEqual(2);
    const flac = (await header('sintel-flac.mkv')).h;
    expect(pickAudio(flac)?.codec).toMatchObject({ kind: 'flac', sampleRate: 16000, channels: 1 });
    expect(new TextDecoder().decode(pickAudio(flac)?.codec?.description?.subarray(0, 4))).toBe(
      'fLaC',
    );
    const ac3 = (await header('sintel-ac3.mkv')).h;
    expect(pickAudio(ac3)?.codec?.kind).toBe('ac3');
  });

  it('picks the audio track of a file that also has video', async () => {
    const { h } = await header('sintel-aac.mkv');
    expect(h.tracks.length).toBe(2);
    expect(pickAudio(h)?.type).toBe(2);
  });
});

describe('clusters', () => {
  it('reads the blocks of the first cluster as timed opus packets', async () => {
    const { u8, h } = await header('sintel-opus.webm');
    const t = pickAudio(h);
    if (!t) throw new Error('no audio');
    const e = element(u8, h.firstCluster);
    if (!e) throw new Error('no cluster');
    const cluster = parseCluster(u8, e);
    const chunks = chunksOfCluster(h, t, cluster);
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks[0]?.ts).toBeLessThan(0.05);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i]?.ts ?? 0).toBeGreaterThanOrEqual(chunks[i - 1]?.ts ?? 0);
    }
    expect((chunks[1]?.ts ?? 0) - (chunks[0]?.ts ?? 0)).toBeCloseTo(0.02, 2);
  });

  it('walks every cluster to the end of the file', async () => {
    const { u8, h } = await header('sintel-aac.mkv');
    const t = pickAudio(h);
    if (!t) throw new Error('no audio');
    let p = h.firstCluster;
    let n = 0;
    let last = -1;
    while (p < u8.length) {
      const e = element(u8, p);
      if (!e) break;
      if (e.id !== 0x1f43b675) {
        p = e.start + e.size;
        continue;
      }
      const c = parseCluster(u8, e);
      for (const ch of chunksOfCluster(h, t, c)) {
        expect(ch.ts).toBeGreaterThanOrEqual(last);
        last = ch.ts;
        n++;
      }
      p = c.end;
    }
    expect(n).toBeGreaterThan(850);
    expect(last).toBeGreaterThan(19.5);
  });

  it('finds the cluster for a time through the cues', async () => {
    const { h } = await header('sintel-opus.webm');
    expect(clusterFor(h, 0)).toBe(h.firstCluster);
    expect(clusterFor(h, 15)).toBeGreaterThan(h.firstCluster);
  });
});
