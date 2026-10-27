/**
 * What crosses the worker boundary, both ways, for the ASR and audio roles.
 *
 * One worker script serves both roles. The main thread posts `init` with the role,
 * then requests by id and reads answers by id. Audio buffers are transferred, never
 * copied: a 15 s window is 480 KB of int16, and a copy per window would add up.
 */
import type { AudioCodec, EncodedChunk } from '../audio/codec.js';
import type { Segment } from '../cues.js';

export interface AsrOptions {
  language: string;
  translate: boolean;
  /** Encoder context for the window: 1500 * seconds / 30, rounded up to 8. */
  audioCtx: number;
  tokenTimestamps: boolean;
  maxLen: number;
  singleSegment: boolean;
  maxTokens: number;
  prompt?: string;
}

export type ToAsr =
  | {
      type: 'init';
      role: 'asr';
      wasmUrl: string;
      modelUrl: string;
      vadUrl: string | null;
      cacheName: string;
    }
  | { type: 'transcribe'; id: number; pcm: Int16Array; t0: number; opts: AsrOptions }
  | { type: 'vad'; id: number; pcm: Int16Array; t0: number }
  | { type: 'detect'; id: number; pcm: Int16Array };

export type FromAsr =
  | { type: 'progress'; what: 'wasm' | 'model' | 'vad'; loaded: number; total: number }
  | { type: 'ready' }
  | { type: 'segment'; id: number; segment: Segment }
  | {
      type: 'done';
      id: number;
      segments: Segment[];
      lang: string;
      ms: number;
      /** Where the VAD heard speech, in file time. */
      spans?: Array<[number, number]>;
    }
  | { type: 'spans'; id: number; spans: Array<[number, number]> }
  | { type: 'lang'; id: number; lang: string; p: number }
  | { type: 'error'; id?: number; message: string; code?: string };

/** How the audio worker is told where the bytes are. */
export type SourceSpec =
  | { kind: 'blob'; blob: Blob }
  | { kind: 'url'; url: string }
  | { kind: 'hls'; url: string }
  | { kind: 'dash'; url: string }
  | { kind: 'feed'; container: 'mp4' | 'ts' };

export type ToAudio =
  | { type: 'init'; role: 'audio'; source: SourceSpec; language?: string }
  | { type: 'read'; id: number; t0: number; t1: number }
  | { type: 'feed'; bytes: Uint8Array; init: boolean; start: number | null }
  | { type: 'trim'; keep: Array<[number, number]> };

export type FromAudio =
  | { type: 'opened'; duration: number; codec: AudioCodec; container: string; random: boolean }
  | { type: 'pcm'; id: number; t0: number; pcm: Int16Array }
  | { type: 'coverage'; spans: Array<[number, number]> }
  | { type: 'error'; id?: number; message: string; code?: string };

export type { AudioCodec, EncodedChunk };
