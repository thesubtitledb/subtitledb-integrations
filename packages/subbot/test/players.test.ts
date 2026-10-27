import { describe, expect, it } from 'vitest';
import { planFor } from '../src/players.js';

const media = (src: string) => ({ currentSrc: src, src }) as unknown as HTMLMediaElement;

describe('planFor', () => {
  it('reads a plain element from its own source, by extension', () => {
    expect(planFor(media('https://x.test/a.mp4'), null).spec).toEqual({
      kind: 'url',
      url: 'https://x.test/a.mp4',
    });
    expect(planFor(media('https://x.test/a.m3u8?t=1'), null).spec).toEqual({
      kind: 'hls',
      url: 'https://x.test/a.m3u8?t=1',
    });
    expect(planFor(media('https://x.test/a.mpd'), null).spec).toEqual({
      kind: 'dash',
      url: 'https://x.test/a.mpd',
    });
    expect(planFor(media('blob:https://x.test/1'), null).spec).toEqual({
      kind: 'url',
      url: 'blob:https://x.test/1',
    });
  });

  it('throws no_source for an element with nothing to read', () => {
    expect(() => planFor(media(''), null)).toThrow(expect.objectContaining({ code: 'no_source' }));
  });

  it('prefers the override', () => {
    expect(planFor(media('blob:x'), null, 'https://x.test/cors/a.mp4').spec).toEqual({
      kind: 'url',
      url: 'https://x.test/cors/a.mp4',
    });
  });

  it('reads the manifest of hls.js, with its appended audio as the fallback', () => {
    const handlers = new Map<string, (e: string, d: unknown) => void>();
    const hls = {
      url: 'https://x.test/live.m3u8',
      levels: [],
      on: (e: string, fn: (e: string, d: unknown) => void) => handlers.set(e, fn),
      off: (e: string) => handlers.delete(e),
    };
    const plan = planFor(media('blob:x'), hls);
    expect(plan.spec).toEqual({ kind: 'hls', url: 'https://x.test/live.m3u8' });
    expect(plan.fallback?.spec).toEqual({ kind: 'feed', container: 'mp4' });
    const fed: Array<[number, boolean, number | null]> = [];
    const off = plan.fallback?.hook?.((b, init, start) => fed.push([b.length, init, start]));
    handlers.get('hlsBufferAppending')?.('hlsBufferAppending', {
      type: 'video',
      data: new Uint8Array(3),
    });
    handlers.get('hlsBufferAppending')?.('hlsBufferAppending', {
      type: 'audio',
      data: new Uint8Array(5),
      frag: { start: 12 },
    });
    expect(fed).toEqual([[5, false, 12]]);
    off?.();
    expect(handlers.size).toBe(0);
  });

  it('reads the MPD of dash.js and the asset of Shaka', () => {
    const dash = { getSource: () => 'https://x.test/a.mpd', on: () => {}, off: () => {} };
    expect(planFor(media('blob:x'), dash).spec).toEqual({
      kind: 'dash',
      url: 'https://x.test/a.mpd',
    });
    const shaka = { getAssetUri: () => 'https://x.test/a.m3u8', getNetworkingEngine: () => null };
    expect(planFor(media('blob:x'), shaka).spec).toEqual({
      kind: 'hls',
      url: 'https://x.test/a.m3u8',
    });
    const unloaded = { getAssetUri: () => null, getNetworkingEngine: () => null };
    expect(planFor(media('blob:x'), unloaded).spec).toEqual({ kind: 'feed', container: 'mp4' });
  });
});
