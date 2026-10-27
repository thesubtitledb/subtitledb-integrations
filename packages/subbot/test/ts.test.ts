import { describe, expect, it } from 'vitest';
import { TsDemuxer } from '../src/audio/ts.js';
import { media } from './fixtures.js';

describe('mpeg-ts', () => {
  it('finds the ADTS audio stream and splits it into timed frames', () => {
    const d = new TsDemuxer();
    const chunks = d.push(media('sintel.ts')).concat(d.end());
    expect(d.codec).toMatchObject({
      kind: 'aac',
      codec: 'mp4a.40.2',
      sampleRate: 44100,
      channels: 2,
    });
    expect(d.codec?.description).toEqual(new Uint8Array([0x12, 0x10]));
    expect(chunks.length).toBeGreaterThan(850);
    for (let i = 1; i < chunks.length; i++) {
      expect((chunks[i]?.ts ?? 0) - (chunks[i - 1]?.ts ?? 0)).toBeGreaterThan(0);
    }
    const span = (chunks[chunks.length - 1]?.ts ?? 0) - (chunks[0]?.ts ?? 0);
    expect(span).toBeGreaterThan(19.5);
    expect(span).toBeLessThan(20.5);
  });

  it('produces the same frames fed one HLS segment at a time', () => {
    const whole = new TsDemuxer();
    const all = whole.push(media('sintel.ts')).concat(whole.end());
    const d = new TsDemuxer();
    let n = 0;
    for (const name of ['seg000', 'seg001', 'seg002', 'seg003', 'seg004']) {
      n += d.push(media(`hls-ts/${name}.ts`)).length;
    }
    n += d.end().length;
    expect(n).toBe(all.length);
  });

  it('finishes a PES packet cut across two pushes', () => {
    const u8 = media('sintel.ts');
    const cut = 188 * 400 + 50;
    const d = new TsDemuxer();
    const a = d.push(u8.subarray(0, cut));
    const b = d.push(u8.subarray(cut)).concat(d.end());
    const whole = new TsDemuxer();
    expect(a.length + b.length).toBe(whole.push(u8).concat(whole.end()).length);
  });
});
