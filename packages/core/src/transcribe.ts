/**
 * On-device transcription: the config surface, the engine contract, and the synthetic
 * candidate that stands in for a subtitle the corpus does not have.
 *
 * Core stays engine-agnostic. It knows how to *offer* a transcription (a synthetic
 * candidate in the picker) and how to *ask for one* (call the injected `transcriber`
 * when that candidate is selected), and nothing about Whisper, WebGPU or WASM. The
 * engine is not in this repository: the CDN loader lazy-loads it, so none of it downloads
 * until a viewer actually clicks the row. See the CDN loader for the wiring, and the
 * plan's Part C for why the default is transformers.js with `whisper-tiny.en`.
 */
import type { Candidate } from './match.js';
import type { BundleSubtitle } from './types.js';

/**
 * When the transcription row is offered.
 *
 *   'no-match'  the corpus returned nothing renderable for this title. The default:
 *               the fallback exists for exactly the "no key, no account, no quota,
 *               and still no captions" case.
 *   'always'    offered alongside whatever the corpus found.
 *   'off'       never. Same as leaving `transcribe` unset; here so a config object can
 *               disable it without being rewritten to a boolean.
 */
export type TranscribeWhen = 'no-match' | 'always' | 'off';
export type TranscribeEngine = 'transformers' | 'whisper-cpp';
export type TranscribeTask = 'transcribe' | 'translate';
export type TranscribeDevice = 'auto' | 'webgpu' | 'wasm';

/** Progress for the one-time engine fetch, model download, and the run itself. */
export interface TranscribeProgress {
  phase: 'engine' | 'model' | 'transcribe';
  loaded: number;
  total: number;
}

/**
 * Opt-in, on-device speech-to-text. Off by default, and `true` means every default.
 *
 * The invariant that makes this safe to leave on: nothing heavy loads until a viewer
 * selects the transcription row. Offering it costs a placeholder in a menu; the engine
 * chunk and the model download only on an explicit select.
 */
export interface TranscribeOptions {
  when?: TranscribeWhen;
  engine?: TranscribeEngine;
  /** Defaults per engine. transformers: `onnx-community/whisper-tiny.en`. */
  model?: string;
  /** `translate` targets English only, whatever the audio language. */
  task?: TranscribeTask;
  device?: TranscribeDevice;
  /** Tag for the produced track. Defaults from the model, which is English-only. */
  language?: string;
  /**
   * Where to read the audio from, when the media element's own source is not readable
   * from this page. The audio is fetched and decoded, which needs same-origin or
   * CORS-enabled bytes; a `<video>` happily plays a cross-origin source that a `fetch`
   * cannot read (archive.org's `/download/` redirects to a node that drops the CORS
   * header is the case this exists for). Point this at a CORS-readable copy of the same
   * audio and playback keeps its own URL. Defaults to the element's `currentSrc`.
   */
  source?: string;
  onProgress?: (p: TranscribeProgress) => void;
}

/** A {@link TranscribeOptions} with every default filled in. */
export interface ResolvedTranscribe {
  when: TranscribeWhen;
  engine: TranscribeEngine;
  model: string;
  task: TranscribeTask;
  device: TranscribeDevice;
  language: string;
  /** A CORS-readable override for the audio source. Absent means read the element. */
  source?: string;
}

/**
 * What the engine is handed when a synthetic candidate is selected.
 *
 * `media` is the playing element, the source of the audio. Typed as the DOM media
 * element because that is what every adapter already holds; the engine reads its
 * current source, or captures it directly, and returns WebVTT.
 */
export interface TranscribeRequest {
  media: HTMLMediaElement;
  config: ResolvedTranscribe;
  signal?: AbortSignal;
  onProgress?: (p: TranscribeProgress) => void;
}

/**
 * The engine, injected rather than imported so core carries none of its weight.
 *
 * The CDN loader wires this to a function that lazy-loads that engine;
 * a page bundling the packages itself passes one built from that package directly.
 * Returns WebVTT text, which rides the same blob-URL path as a fetched subtitle.
 */
export type Transcriber = (req: TranscribeRequest) => Promise<{ text: string; format: 'vtt' }>;

/** Extra context for {@link SubtitleSession.load}, only read for a synthetic candidate. */
export interface LoadContext {
  /** The media element whose audio a synthetic candidate transcribes. */
  media?: HTMLMediaElement | null;
}

/** Defaults are English-only tiny models: the smallest useful download for each engine. */
export const DEFAULT_MODELS: Record<TranscribeEngine, string> = {
  transformers: 'onnx-community/whisper-tiny.en',
  'whisper-cpp': 'tiny.en-q5_1',
};

/**
 * The sentinel id every synthetic candidate carries. Negative so it can never collide
 * with a real subtitle id, and stable so the session can cache one transcription per
 * title the same way it caches a download.
 */
export const SYNTHETIC_ID = -1;

/**
 * Normalise the public `transcribe` option into a config with defaults, or null when
 * transcription is off. `false`, `undefined` and `{ when: 'off' }` are all off.
 */
export function resolveTranscribe(
  opt: boolean | TranscribeOptions | undefined,
): ResolvedTranscribe | null {
  if (!opt) return null;
  const o: TranscribeOptions = opt === true ? {} : opt;
  const when = o.when ?? 'no-match';
  if (when === 'off') return null;
  const engine = o.engine ?? 'transformers';
  return {
    when,
    engine,
    model: o.model ?? DEFAULT_MODELS[engine],
    task: o.task ?? 'transcribe',
    device: o.device ?? 'auto',
    // English-only by default because the default model is English-only. A caller that
    // points `model` at a multilingual Whisper should set `language` to match.
    language: o.language ?? 'en',
    ...(o.source ? { source: o.source } : {}),
  };
}

/**
 * Build the placeholder candidate. It looks enough like a `BundleSubtitle` to flow
 * through the pickers and the blob-URL injection unchanged, but carries no
 * `download_url`, so a stray attempt to fetch it would fail loudly rather than hit a
 * wrong host.
 */
export function syntheticCandidate(language: string): Candidate {
  const subtitle: BundleSubtitle = {
    id: SYNTHETIC_ID,
    language,
    format: 'vtt',
    season: null,
    episode: null,
    cues: 0,
    duration_s: 0,
    bytes: 0,
    encoding: 'utf-8',
    release_name: '',
    uploader: '',
    hearing_impaired: false,
    fps: null,
    added_at: '',
    download_url: '',
  };
  return {
    subtitle,
    score: Number.NEGATIVE_INFINITY,
    reason: 'on-device transcription',
    synthetic: true,
  };
}
