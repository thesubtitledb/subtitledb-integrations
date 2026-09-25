/**
 * Turn a playing media element into the mono 16 kHz PCM Whisper expects.
 *
 * The path is: fetch the media's own source, decode it with Web Audio, downmix to one
 * channel and resample to 16 kHz. Fetching rather than tapping the element keeps this
 * off the playback graph and lets it run without the video playing, but it means the
 * media has to be readable: same-origin, or served with permissive CORS. A tainted
 * cross-origin source cannot be read, and that failure is surfaced with a message that
 * says so rather than an empty caption track.
 *
 * The downmix and resample are pure and unit-tested; the fetch and decode are the DOM
 * boundary and are injectable so the orchestration can be tested without a browser.
 */
import { TranscribeError } from './errors.js';

/** What Whisper models are trained on. */
export const TARGET_RATE = 16_000;

/** Average the channels into one. A single channel is returned as-is. */
export function downmix(channels: Float32Array[]): Float32Array {
  const first = channels[0];
  if (!first) return new Float32Array(0);
  if (channels.length === 1) return first;
  const n = first.length;
  const out = new Float32Array(n);
  const k = channels.length;
  for (const ch of channels) {
    for (let i = 0; i < n; i++) out[i] = (out[i] ?? 0) + (ch[i] ?? 0) / k;
  }
  return out;
}

/**
 * Linear resample. Good enough for speech at 16 kHz and dependency-free; a
 * band-limited resampler would be sharper but is not worth the bytes for a transcript
 * whose model is itself the dominant error term.
 */
export function resampleLinear(input: Float32Array, inRate: number, outRate: number): Float32Array {
  if (inRate === outRate || input.length === 0) return input;
  const outLen = Math.max(1, Math.round((input.length * outRate) / inRate));
  const out = new Float32Array(outLen);
  const step = outLen > 1 ? (input.length - 1) / (outLen - 1) : 0;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const frac = pos - i0;
    out[i] = (input[i0] ?? 0) * (1 - frac) + (input[i1] ?? 0) * frac;
  }
  return out;
}

/** The slice of an AudioBuffer this reads. Kept minimal so tests need no Web Audio. */
export interface DecodedAudio {
  numberOfChannels: number;
  sampleRate: number;
  getChannelData(channel: number): Float32Array;
}

/** The slice of an AudioContext this reads. */
export interface AudioDecoder {
  decodeAudioData(data: ArrayBuffer): Promise<DecodedAudio>;
  close?(): Promise<void> | void;
}

type AudioContextCtor = new () => AudioDecoder;

export interface AudioDeps {
  fetch?: typeof fetch;
  /** Build a decoder. Defaults to the platform AudioContext. */
  decoder?: () => AudioDecoder;
}

function defaultDecoder(): AudioDecoder {
  const g = globalThis as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  if (!Ctor)
    throw new TranscribeError('Web Audio is not available in this browser', 'no_web_audio');
  return new Ctor();
}

/**
 * Read, decode, downmix and resample the media's audio to mono 16 kHz PCM.
 *
 * `source` overrides where the audio is fetched from, for a media element whose own
 * source a `fetch` cannot read (a cross-origin `<video>` served without CORS). The
 * element still plays from its own URL; only the read for transcription is redirected.
 */
export async function extractAudio(
  media: Pick<HTMLMediaElement, 'currentSrc' | 'src'>,
  deps: AudioDeps = {},
  signal?: AbortSignal,
  source?: string,
): Promise<Float32Array> {
  const src = source || media.currentSrc || media.src;
  if (!src)
    throw new TranscribeError('the media element has no source to read audio from', 'no_source');

  const doFetch = deps.fetch ?? globalThis.fetch;
  let data: ArrayBuffer;
  try {
    const res = await doFetch(src, signal ? { signal } : {});
    if (!res.ok) {
      throw new TranscribeError(`fetching the media returned ${res.status}`, 'fetch_failed');
    }
    data = await res.arrayBuffer();
  } catch (cause) {
    if (cause instanceof TranscribeError) throw cause;
    throw new TranscribeError(
      'could not read the media audio. It must be same-origin, or served with CORS that lets this page read it.',
      'audio_unreadable',
      { cause },
    );
  }

  const decoder = (deps.decoder ?? defaultDecoder)();
  try {
    const decoded = await decoder.decodeAudioData(data);
    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
    return resampleLinear(downmix(channels), decoded.sampleRate, TARGET_RATE);
  } catch (cause) {
    if (cause instanceof TranscribeError) throw cause;
    throw new TranscribeError('the browser could not decode the media audio', 'decode_failed', {
      cause,
    });
  } finally {
    await decoder.close?.();
  }
}
