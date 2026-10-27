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
      const res = await fetchFn(url, { headers: { range: `bytes=${start}-${end - 1}` } });
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
