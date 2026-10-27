/**
 * SubBot: on-device subtitle transcription for SubtitleDB.
 *
 * `runTranscription` is the engine contract from `@subtitledb/core`: a request built
 * by the session on a synthetic select, WebVTT back when the whole file is done,
 * cues on the element's own track from the first seconds in between.
 */
import type { TranscribeRequest } from '@subtitledb/core';
import { type RunDeps, Subbot } from './subbot.js';

export type { Quality, TierModels } from './asr/models.js';
export {
  audioCtxFor,
  DEFAULT_MODELS_URL,
  DEFAULT_VAD_URL,
  MODEL_BYTES,
  MODELS,
  modelUrl,
} from './asr/models.js';
export type { AsrOptions, FromAsr, FromAudio, SourceSpec, ToAsr, ToAudio } from './asr/protocol.js';
export type { Cue, Segment, Tier } from './cues.js';
export { CueStore, segmentsToCues } from './cues.js';
export type { SubbotErrorCode } from './errors.js';
export { SubbotError } from './errors.js';
export type { Plan } from './players.js';
export { planFor } from './players.js';
export { TrackRenderer } from './render.js';
export type { LivePlan, Span, Window } from './schedule.js';
export {
  Intervals,
  LIVE,
  nextLive,
  nextQuality,
  QUALITY_WINDOW,
  qualityWorkers,
} from './schedule.js';
export type { RunDeps, SubbotState } from './subbot.js';
export { Subbot } from './subbot.js';
export { cuesToVtt, formatTimestamp } from './vtt.js';
export type { Spawn, WorkerLike } from './workers.js';
export { AsrWorker, AudioWorker, spawnFrom } from './workers.js';

export function runTranscription(
  req: TranscribeRequest,
  deps: RunDeps,
): Promise<{ text: string; format: 'vtt' }> {
  return new Subbot(req, deps).run();
}
