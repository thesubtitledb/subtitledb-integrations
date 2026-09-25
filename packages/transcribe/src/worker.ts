/**
 * The Web Worker seam.
 *
 * The engines run in a module worker, off the main thread, because a Whisper run is
 * seconds of solid compute and doing it inline freezes the page it is captioning. No
 * worker file is shipped: the engine program is a string, wrapped in a Blob and spawned
 * as a module worker, so it stays one lazily loaded chunk with nothing extra to host.
 * The worker's own `import()` of the engine from a CDN is what pulls the heavy code,
 * and only once this runs.
 */
import type { ResolvedTranscribe, TranscribeProgress } from '@subtitledb/core';
import { TranscribeError } from './errors.js';
import type { Cue } from './vtt.js';

/** Posted to the worker to start a run. The audio buffer is transferred, not copied. */
export interface WorkerRun {
  type: 'run';
  audio: Float32Array;
  model: string;
  task: string;
  device: string;
  language: string;
}

/** Everything a worker posts back. */
export type WorkerMessage =
  | { type: 'progress'; phase: 'model' | 'transcribe'; loaded: number; total: number }
  | { type: 'result'; cues: Cue[] }
  | { type: 'error'; message: string };

/** The slice of a Worker this uses. A real Worker matches it; a test double is trivial. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: { data: WorkerMessage }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

/** Wrap a program string in a worker, module or classic per the engine. */
export function spawnWorker(program: string, moduleWorker = true): WorkerLike {
  const url = URL.createObjectURL(new Blob([program], { type: 'text/javascript' }));
  const worker = new Worker(
    url,
    moduleWorker ? { type: 'module' } : undefined,
  ) as unknown as WorkerLike;
  // Revoke once the worker has had a chance to start fetching from the URL. Revoking
  // synchronously breaks the module load in some browsers; a generous delay costs one
  // dead URL entry for a few seconds and nothing else.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return worker;
}

function messageOf(ev: unknown): string {
  if (ev && typeof ev === 'object' && 'message' in ev) {
    const m = (ev as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return 'the transcription worker failed';
}

/**
 * Drive one worker to completion: post the audio, forward progress, resolve with the
 * cues, and always terminate. Rejects on an engine error, a worker error or an abort,
 * so a caller sees one clear failure however the run fell over.
 */
export function runInWorker(
  spawn: () => WorkerLike,
  audio: Float32Array,
  config: ResolvedTranscribe,
  opts: { signal?: AbortSignal; onProgress?: (p: TranscribeProgress) => void } = {},
): Promise<Cue[]> {
  return new Promise<Cue[]>((resolve, reject) => {
    const { signal, onProgress } = opts;
    if (signal?.aborted) {
      reject(new TranscribeError('transcription was cancelled', 'aborted'));
      return;
    }

    const worker = spawn();
    let settled = false;

    const onAbort = () =>
      finish(() => reject(new TranscribeError('transcription was cancelled', 'aborted')));

    function cleanup(): void {
      signal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
    function finish(act: () => void): void {
      if (settled) return;
      settled = true;
      cleanup();
      act();
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        onProgress?.({ phase: data.phase, loaded: data.loaded, total: data.total });
      } else if (data.type === 'result') {
        finish(() => resolve(data.cues));
      } else if (data.type === 'error') {
        finish(() => reject(new TranscribeError(data.message, 'engine_error')));
      }
    };
    worker.onerror = (ev) =>
      finish(() => reject(new TranscribeError(messageOf(ev), 'worker_error')));

    const run: WorkerRun = {
      type: 'run',
      audio,
      model: config.model,
      task: config.task,
      device: config.device,
      language: config.language,
    };
    worker.postMessage(run, [audio.buffer]);
  });
}
