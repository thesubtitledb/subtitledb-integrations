/**
 * On-device transcription for SubtitleDB.
 *
 * `runTranscription` is the whole public surface a caller needs: hand it a
 * {@link TranscribeRequest} (built by the session on a synthetic select) and it
 * returns WebVTT. The config and request types live in `@subtitledb/core`, so a caller
 * imports them from there and this package stays the engine alone.
 */
export type { AudioDecoder, AudioDeps, DecodedAudio } from './audio.js';
export { downmix, extractAudio, resampleLinear, TARGET_RATE } from './audio.js';
export type { EngineProgram } from './engines/index.js';
export { engineProgram } from './engines/index.js';
export {
  TRANSFORMERS_CDN,
  transformersProgram,
} from './engines/transformers.js';
export {
  WHISPER_CPP_CDN,
  WHISPER_CPP_MODELS,
  whisperCppProgram,
} from './engines/whisper-cpp.js';
export type { TranscribeErrorCode } from './errors.js';
export { TranscribeError } from './errors.js';
export type { RunDeps } from './request.js';
export { runTranscription } from './request.js';
export type { Cue } from './vtt.js';
export { cuesToVtt, formatTimestamp } from './vtt.js';
export type { WorkerLike, WorkerMessage, WorkerRun } from './worker.js';
export { runInWorker, spawnWorker } from './worker.js';
