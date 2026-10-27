/**
 * Compressed frames to 16 kHz mono int16, through WebCodecs.
 *
 * Every window is decoded on its own, from a lead-in before it so the first frames'
 * overlap-add has something to overlap. The decoder is configured once per source
 * and reset per window, which is cheap, and the output format is read as the
 * decoder gives it rather than asked for, because conversion in `copyTo` is the
 * part of the API browsers disagree on.
 */
import type { AudioCodec, EncodedChunk } from './codec.js';
import { downmix, RATE, resample, toInt16 } from './resample.js';

declare const AudioDecoder: {
  new (init: { output: (d: AudioDataLike) => void; error: (e: Error) => void }): AudioDecoderLike;
  isConfigSupported(config: AudioDecoderConfigLike): Promise<{ supported: boolean }>;
};
declare const EncodedAudioChunk: new (init: {
  type: 'key' | 'delta';
  timestamp: number;
  duration?: number;
  data: Uint8Array;
}) => unknown;

interface AudioDecoderConfigLike {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  description?: Uint8Array;
}

interface AudioDecoderLike {
  configure(config: AudioDecoderConfigLike): void;
  decode(chunk: unknown): void;
  flush(): Promise<void>;
  reset(): void;
  close(): void;
  state: 'unconfigured' | 'configured' | 'closed';
}

interface AudioDataLike {
  format: string | null;
  sampleRate: number;
  numberOfFrames: number;
  numberOfChannels: number;
  timestamp: number;
  allocationSize(o: { planeIndex: number }): number;
  copyTo(dest: ArrayBufferView, o: { planeIndex: number }): void;
  close(): void;
}

export function hasWebCodecs(): boolean {
  return typeof AudioDecoder === 'function' && typeof EncodedAudioChunk === 'function';
}

function config(codec: AudioCodec): AudioDecoderConfigLike {
  return {
    codec: codec.codec,
    sampleRate: codec.sampleRate,
    numberOfChannels: codec.channels,
    ...(codec.description ? { description: codec.description } : {}),
  };
}

export async function canDecode(codec: AudioCodec): Promise<boolean> {
  if (!hasWebCodecs()) return false;
  try {
    return (await AudioDecoder.isConfigSupported(config(codec))).supported;
  } catch {
    return false;
  }
}

/** One AudioData's channels as float32 planes, whatever format it arrived in. */
function planes(d: AudioDataLike): Float32Array[] {
  const n = d.numberOfFrames;
  const ch = d.numberOfChannels;
  const fmt = d.format ?? 'f32-planar';
  const planar = fmt.endsWith('-planar');
  const out: Float32Array[] = [];
  const convert = (raw: ArrayBufferView, into: Float32Array, stride: number, offset: number) => {
    if (fmt.startsWith('f32')) {
      const a = raw as Float32Array;
      for (let i = 0; i < n; i++) into[i] = a[i * stride + offset] as number;
    } else if (fmt.startsWith('s16')) {
      const a = raw as Int16Array;
      for (let i = 0; i < n; i++) into[i] = (a[i * stride + offset] as number) / 32768;
    } else if (fmt.startsWith('s32')) {
      const a = raw as Int32Array;
      for (let i = 0; i < n; i++) into[i] = (a[i * stride + offset] as number) / 2147483648;
    } else {
      const a = raw as Uint8Array;
      for (let i = 0; i < n; i++) into[i] = ((a[i * stride + offset] as number) - 128) / 128;
    }
  };
  const make = (bytes: number): ArrayBufferView => {
    if (fmt.startsWith('f32')) return new Float32Array(bytes / 4);
    if (fmt.startsWith('s16')) return new Int16Array(bytes / 2);
    if (fmt.startsWith('s32')) return new Int32Array(bytes / 4);
    return new Uint8Array(bytes);
  };
  if (planar) {
    for (let c = 0; c < ch; c++) {
      const raw = make(d.allocationSize({ planeIndex: c }));
      d.copyTo(raw, { planeIndex: c });
      const f = new Float32Array(n);
      convert(raw, f, 1, 0);
      out.push(f);
    }
  } else {
    const raw = make(d.allocationSize({ planeIndex: 0 }));
    d.copyTo(raw, { planeIndex: 0 });
    for (let c = 0; c < ch; c++) {
      const f = new Float32Array(n);
      convert(raw, f, ch, c);
      out.push(f);
    }
  }
  return out;
}

export class PcmDecoder {
  private decoder: AudioDecoderLike | null = null;
  private outputs: Array<{ ts: number; mono: Float32Array; rate: number }> = [];
  private failed: Error | null = null;

  constructor(readonly codec: AudioCodec) {}

  private open(): AudioDecoderLike {
    if (this.decoder && this.decoder.state !== 'closed') return this.decoder;
    this.decoder = new AudioDecoder({
      output: (d) => {
        try {
          this.outputs.push({
            ts: d.timestamp / 1e6,
            mono: downmix(planes(d)),
            rate: d.sampleRate,
          });
        } finally {
          d.close();
        }
      },
      error: (e) => {
        this.failed = e;
      },
    });
    this.decoder.configure(config(this.codec));
    return this.decoder;
  }

  /**
   * Decode a run of frames. Returns 16 kHz mono starting at the first frame's time.
   * `from` trims the lead-in: samples before it are dropped.
   */
  async decode(chunks: EncodedChunk[], from: number): Promise<{ t0: number; pcm: Int16Array }> {
    if (chunks.length === 0) return { t0: from, pcm: new Int16Array(0) };
    const dec = this.open();
    this.outputs = [];
    this.failed = null;
    const first = chunks[0] as EncodedChunk;
    for (const c of chunks) {
      dec.decode(
        new EncodedAudioChunk({
          type: 'key',
          timestamp: Math.round(c.ts * 1e6),
          ...(c.dur > 0 ? { duration: Math.round(c.dur * 1e6) } : {}),
          data: c.data,
        }),
      );
    }
    await dec.flush();
    if (this.failed) {
      const err = this.failed;
      dec.close();
      this.decoder = null;
      throw err;
    }
    const outs = this.outputs;
    this.outputs = [];
    if (outs.length === 0) return { t0: from, pcm: new Int16Array(0) };
    const rate = outs[0]?.rate ?? this.codec.sampleRate;
    let n = 0;
    for (const o of outs) n += o.mono.length;
    const all = new Float32Array(n);
    let p = 0;
    for (const o of outs) {
      all.set(o.mono, p);
      p += o.mono.length;
    }
    // Time the run by the first chunk, not the decoder's first output: some decoders
    // stamp outputs from zero whatever the input said.
    const skip = Math.max(0, Math.round((from - first.ts) * rate));
    const kept = all.subarray(Math.min(skip, all.length));
    return { t0: Math.max(from, first.ts), pcm: toInt16(resample(kept, rate, RATE)) };
  }

  close(): void {
    try {
      this.decoder?.close();
    } catch {
      // Already closed.
    }
    this.decoder = null;
  }
}
