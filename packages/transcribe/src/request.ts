/**
 * Run one transcription end to end: media element in, WebVTT out.
 *
 * Extract the audio, pick the engine's worker program, drive the worker to a set of
 * cues, and assemble WebVTT. This is what the CDN loader wires the session's
 * `transcriber` to, and what a page bundling the packages calls directly. The audio
 * extractor and the worker spawner are injectable so the whole flow is testable
 * without a browser, a CDN or a real engine.
 */
import type { TranscribeRequest } from '@subtitledb/core';
import { extractAudio } from './audio.js';
import { engineProgram } from './engines/index.js';
import { TranscribeError } from './errors.js';
import { cuesToVtt } from './vtt.js';
import { runInWorker, spawnWorker, type WorkerLike } from './worker.js';

export interface RunDeps {
  /** Override audio extraction. Defaults to the Web Audio path. */
  extractAudio?: typeof extractAudio;
  /** Override worker creation. Defaults to a Blob worker of the engine program. */
  spawn?: (program: string, moduleWorker: boolean) => WorkerLike;
}

export async function runTranscription(
  req: TranscribeRequest,
  deps: RunDeps = {},
): Promise<{ text: string; format: 'vtt' }> {
  const { media, config, signal, onProgress } = req;

  // The engine chunk is already here by the time this runs (the loader awaited it), so
  // the visible cost from here is the audio read, then the model, then the run.
  onProgress?.({ phase: 'engine', loaded: 1, total: 1 });

  const extract = deps.extractAudio ?? extractAudio;
  const audio = await extract(media, {}, signal, config.source);
  if (audio.length === 0) {
    throw new TranscribeError('the media produced no audio to transcribe', 'empty_audio');
  }

  const engine = engineProgram(config);
  const spawn = () =>
    deps.spawn
      ? deps.spawn(engine.program, engine.module)
      : spawnWorker(engine.program, engine.module);

  const cues = await runInWorker(spawn, audio, config, {
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
  });

  return { text: cuesToVtt(cues), format: 'vtt' };
}
