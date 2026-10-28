import { describe, expect, it } from 'vitest';
import { type ByteSource, fromBytes, fromUrl, READS, readRanges } from '../src/audio/bytes.js';

describe('readRanges', () => {
  it('reads the first range alone, then the rest a few at a time, in order', async () => {
    const data = fromBytes(Uint8Array.from({ length: 1000 }, (_, i) => i % 256));
    let open = 0;
    let most = 0;
    const order: number[] = [];
    const src: ByteSource = {
      size: 1000,
      async read(a, b) {
        order.push(a);
        open++;
        most = Math.max(most, open);
        await new Promise((r) => setTimeout(r, 5));
        open--;
        return data.read(a, b);
      },
    };
    const ranges = Array.from({ length: 50 }, (_, i) => [i * 20, i * 20 + 10] as const);
    const parts = await readRanges(src, ranges);
    expect(order[0]).toBe(0);
    expect(most).toBe(READS);
    expect(parts.map((p) => p[0])).toEqual(ranges.map(([a]) => a % 256));
  });
});

describe('fromUrl', () => {
  it('asks again when the server answers 5xx', async () => {
    let asked = 0;
    const fetchFn = (async () => {
      asked++;
      return asked === 1
        ? new Response('busy', { status: 500 })
        : new Response(new Uint8Array([1, 2, 3, 4]), {
            status: 206,
            headers: { 'content-range': 'bytes 0-3/4000' },
          });
    }) as typeof fetch;
    const src = fromUrl('https://example.test/film.mp4', fetchFn);
    expect([...(await src.read(0, 4))]).toEqual([1, 2, 3, 4]);
    expect(asked).toBe(2);
    expect(src.size).toBe(4000);
  });
});
