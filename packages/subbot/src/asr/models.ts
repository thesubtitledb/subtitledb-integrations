/**
 * The models, by tier, and where they come from.
 *
 * q8_0 on purpose: on single-thread WASM it is the fastest quantisation measured
 * (tiny 0.4x realtime, base 0.8x, against 0.5x and 1.1x for q5_1 and 0.8x and 1.9x
 * for f16), and it is within a point of f16 on accuracy. The Cloudflare Pages tree
 * cannot hold files this size, so by default they come from the whisper.cpp mirror on
 * HuggingFace; `assets.models` points at a self-hosted copy.
 */
export const DEFAULT_MODELS_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';
export const DEFAULT_VAD_URL =
  'https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin';

export type Quality = 'fast' | 'balanced' | 'best';

export interface TierModels {
  /** The model behind the first cues and the lead ahead of the playhead. */
  live: string;
  /** The model that re-does every window in the background, or null to skip it. */
  quality: string | null;
}

export const MODELS: Record<Quality, TierModels> = {
  fast: { live: 'tiny-q8_0', quality: null },
  balanced: { live: 'tiny-q8_0', quality: 'base-q8_0' },
  best: { live: 'base-q8_0', quality: 'small-q8_0' },
};

/** Approximate download sizes, for the loading dialog before Content-Length arrives. */
export const MODEL_BYTES: Record<string, number> = {
  'tiny-q8_0': 43_550_000,
  'tiny.en-q8_0': 43_550_000,
  'base-q8_0': 81_770_000,
  'base.en-q8_0': 81_770_000,
  'small-q8_0': 264_000_000,
};

export function modelUrl(name: string, base = DEFAULT_MODELS_URL): string {
  if (/^https?:/.test(name)) return name;
  return `${base.replace(/\/?$/, '/')}ggml-${name}.bin`;
}

/** Encoder context for a window: the model's 30 s is 1500 frames, scaled and rounded. */
export function audioCtxFor(seconds: number): number {
  return Math.max(64, Math.ceil((1500 * seconds) / 30 / 8) * 8);
}
