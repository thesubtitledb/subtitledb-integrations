/**
 * Decoded audio to what Whisper eats: one channel, 16 kHz, 16-bit.
 *
 * Downmix is a plain average. The resampler low-passes with a short windowed sinc
 * before interpolating, because a bare linear resample from 48 kHz folds everything
 * above 8 kHz back into the band the model listens to, and sibilants are up there.
 */
export const RATE = 16_000;

export function downmix(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const n = first.length;
  const out = new Float32Array(n);
  const k = 1 / channels.length;
  for (const ch of channels) {
    for (let i = 0; i < n; i++) out[i] = (out[i] as number) + (ch[i] ?? 0) * k;
  }
  return out;
}

const taps = new Map<number, Float32Array>();

/** A Hann-windowed sinc low-pass at `cutoff` of the input rate, 33 taps. */
function lowpass(ratio: number): Float32Array {
  const key = Math.round(ratio * 10000);
  const held = taps.get(key);
  if (held) return held;
  const N = 33;
  const fc = Math.min(0.5, 0.45 * ratio);
  const h = new Float32Array(N);
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const x = i - (N - 1) / 2;
    const sinc = x === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * x) / (Math.PI * x);
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));
    h[i] = sinc * w;
    sum += h[i] as number;
  }
  for (let i = 0; i < N; i++) h[i] = (h[i] as number) / sum;
  taps.set(key, h);
  return h;
}

/** Resample mono float audio from `inRate` to `outRate`. */
export function resample(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate || input.length === 0) return input;
  let src = input;
  if (outRate < inRate) {
    const h = lowpass(outRate / inRate);
    const half = (h.length - 1) >> 1;
    src = new Float32Array(input.length);
    for (let i = 0; i < input.length; i++) {
      let acc = 0;
      for (let k = 0; k < h.length; k++) {
        const j = i + k - half;
        if (j >= 0 && j < input.length) acc += (h[k] as number) * (input[j] as number);
      }
      src[i] = acc;
    }
  }
  const outLen = Math.max(1, Math.round((input.length * outRate) / inRate));
  const out = new Float32Array(outLen);
  const step = inRate / outRate;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, src.length - 1);
    const frac = pos - i0;
    out[i] = (src[i0] ?? 0) * (1 - frac) + (src[i1] ?? 0) * frac;
  }
  return out;
}

export function toInt16(f: Float32Array): Int16Array {
  const out = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i] as number));
    out[i] = Math.round(v < 0 ? v * 32768 : v * 32767);
  }
  return out;
}

export function toFloat32(i: Int16Array): Float32Array {
  const out = new Float32Array(i.length);
  for (let k = 0; k < i.length; k++) out[k] = (i[k] as number) / 32768;
  return out;
}
