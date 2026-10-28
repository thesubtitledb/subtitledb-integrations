/**
 * Random access to the bytes of a media file, from a URL, a Blob or memory.
 *
 * Every demuxer reads through this and never the whole file: a feature film is
 * gigabytes, and what a transcription needs at any moment is one header and a few
 * seconds of audio frames. `read(start, end)` is end-exclusive.
 */
import { SubbotError } from '../errors.js';

export interface ByteSource {
  /** Total length, or null when the server would not say. */
  size: number | null;
  read(start: number, end: number): Promise<Uint8Array>;
}

export function fromBytes(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(start, end) {
      return bytes.subarray(start, Math.min(end, bytes.length));
    },
  };
}

export function fromBlob(blob: Blob): ByteSource {
  return {
    size: blob.size,
    async read(start, end) {
      return new Uint8Array(await blob.slice(start, Math.min(end, blob.size)).arrayBuffer());
    },
  };
}

export const RETRIES = 2;
export const RETRY_MS = 300;
/** Range requests in flight at once for one window. */
export const READS = 6;

/**
 * Many ranges of one source, `READS` at a time, in order. A window of audio in a
 * high-bitrate MP4 is dozens of ranges (the audio sits between ~100 KB runs of video),
 * and one after another each is a full round trip to the host. The first is read
 * alone: it learns whether the server honours Range, and if not the rest come from the
 * whole body it kept.
 */
export async function readRanges(
  src: ByteSource,
  ranges: ReadonlyArray<readonly [number, number]>,
): Promise<Uint8Array[]> {
  const out: Uint8Array[] = new Array(ranges.length);
  const first = ranges[0];
  if (!first) return out;
  out[0] = await src.read(first[0], first[1]);
  let next = 1;
  const lane = async (): Promise<void> => {
    while (next < ranges.length) {
      const i = next++;
      const [a, b] = ranges[i] as readonly [number, number];
      out[i] = await src.read(a, b);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READS, ranges.length - 1) }, lane));
  return out;
}

/**
 * A URL read with Range requests. The first read learns the size from Content-Range.
 * A server that answers 200 to a Range request has no range support; the whole body
 * is then kept and every later read is served from it, which is right for a small
 * file and the only option for a large one.
 */
export function fromUrl(url: string, fetchFn: typeof fetch = fetch): ByteSource {
  let whole: Uint8Array | null = null;
  const src: ByteSource = {
    size: null,
    async read(start, end) {
      if (whole) return whole.subarray(start, Math.min(end, whole.length));
      const ask = () => fetchFn(url, { headers: { range: `bytes=${start}-${end - 1}` } });
      let res = await ask();
      // A 5xx is often one bad node behind a balancer (archive.org has them): ask again.
      for (let i = 1; i <= RETRIES && res.status >= 500; i++) {
        await new Promise((r) => setTimeout(r, RETRY_MS * i));
        res = await ask();
      }
      if (res.status === 206) {
        const m = /\/(\d+)\s*$/.exec(res.headers.get('content-range') ?? '');
        if (m) src.size = Number(m[1]);
        return new Uint8Array(await res.arrayBuffer());
      }
      if (res.status === 200) {
        whole = new Uint8Array(await res.arrayBuffer());
        src.size = whole.length;
        return whole.subarray(start, Math.min(end, whole.length));
      }
      throw new SubbotError(`reading ${url} answered ${res.status}`, 'audio_unreadable');
    },
  };
  return src;
}

/**
 * Read-ahead over a source. A demuxer walks headers a few bytes at a time, and a
 * Range request per box would be thousands of round trips; this turns them into one
 * per `chunk` bytes.
 */
export class Reader {
  private cache: { start: number; data: Uint8Array } | null = null;

  constructor(
    readonly src: ByteSource,
    private readonly chunk = 256 * 1024,
  ) {}

  get size(): number | null {
    return this.src.size;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    if (end <= start) return new Uint8Array(0);
    const c = this.cache;
    if (c && start >= c.start && end <= c.start + c.data.length) {
      return c.data.subarray(start - c.start, end - c.start);
    }
    const want = Math.max(end - start, this.chunk);
    const data = await this.src.read(start, start + want);
    this.cache = { start, data };
    if (data.length < end - start) return data;
    return data.subarray(0, end - start);
  }
}

/** Big-endian field reads, the byte order of every container this handles but EBML's vints. */
export const be = {
  u16: (b: Uint8Array, p: number): number => ((b[p] ?? 0) << 8) | (b[p + 1] ?? 0),
  u24: (b: Uint8Array, p: number): number =>
    ((b[p] ?? 0) << 16) | ((b[p + 1] ?? 0) << 8) | (b[p + 2] ?? 0),
  u32: (b: Uint8Array, p: number): number =>
    ((b[p] ?? 0) * 0x1000000 +
      (((b[p + 1] ?? 0) << 16) | ((b[p + 2] ?? 0) << 8) | (b[p + 3] ?? 0))) >>>
    0,
  u64: (b: Uint8Array, p: number): number => be.u32(b, p) * 0x100000000 + be.u32(b, p + 4),
  i32: (b: Uint8Array, p: number): number => be.u32(b, p) | 0,
  fourcc: (b: Uint8Array, p: number): string =>
    String.fromCharCode(b[p] ?? 0, b[p + 1] ?? 0, b[p + 2] ?? 0, b[p + 3] ?? 0),
};

export function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
