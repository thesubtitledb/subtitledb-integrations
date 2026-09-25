import type { ResolvedTranscribe, TranscribeRequest } from '@subtitledb/core';
import { describe, expect, it } from 'vitest';
import type { Cue, WorkerLike, WorkerMessage } from '../src/index.js';
import { runTranscription } from '../src/request.js';

const CONFIG: ResolvedTranscribe = {
  when: 'no-match',
  engine: 'transformers',
  model: 'onnx-community/whisper-tiny.en',
  task: 'transcribe',
  device: 'auto',
  language: 'en',
};

function media(): HTMLMediaElement {
  return { currentSrc: 'https://example.test/clip.webm', src: '' } as unknown as HTMLMediaElement;
}

const someAudio = async () => new Float32Array([0.1, -0.1, 0.2]);

interface FakeOpts {
  cues?: Cue[];
  error?: string;
}

/** A worker double that replays a fixed progress/result (or error) on the next tick. */
function fakeWorkers(opts: FakeOpts) {
  const created: Array<{ terminated: boolean }> = [];
  const spawn = (): WorkerLike => {
    const state = { terminated: false };
    created.push(state);
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage() {
        queueMicrotask(() => {
          const emit = (m: WorkerMessage) => worker.onmessage?.({ data: m });
          emit({ type: 'progress', phase: 'model', loaded: 1, total: 2 });
          if (opts.error) emit({ type: 'error', message: opts.error });
          else emit({ type: 'result', cues: opts.cues ?? [] });
        });
      },
      terminate() {
        state.terminated = true;
      },
    };
    return worker;
  };
  return { spawn, created };
}

describe('runTranscription', () => {
  it('extracts audio, runs the worker and returns WebVTT', async () => {
    const { spawn, created } = fakeWorkers({ cues: [{ start: 0, end: 2, text: 'hello there' }] });
    const phases: string[] = [];
    const req: TranscribeRequest = {
      media: media(),
      config: CONFIG,
      onProgress: (p) => phases.push(p.phase),
    };

    const out = await runTranscription(req, { extractAudio: someAudio, spawn });

    expect(out.format).toBe('vtt');
    expect(out.text).toContain('hello there');
    expect(phases).toContain('engine');
    expect(phases).toContain('model');
    // The worker is always torn down, success or not.
    expect(created[0]?.terminated).toBe(true);
  });

  it('fails loudly when the media produced no audio', async () => {
    const { spawn } = fakeWorkers({});
    const req: TranscribeRequest = { media: media(), config: CONFIG };
    await expect(
      runTranscription(req, { extractAudio: async () => new Float32Array(0), spawn }),
    ).rejects.toMatchObject({ code: 'empty_audio' });
  });

  it('surfaces an engine error as a rejection', async () => {
    const { spawn } = fakeWorkers({ error: 'model failed to load' });
    const req: TranscribeRequest = { media: media(), config: CONFIG };
    await expect(runTranscription(req, { extractAudio: someAudio, spawn })).rejects.toThrow(
      /model failed to load/,
    );
  });

  it('hands the config source override to the audio extractor', async () => {
    const { spawn } = fakeWorkers({ cues: [] });
    let seen: string | undefined = 'unset';
    const capture = (async (_media: unknown, _deps: unknown, _signal: unknown, source?: string) => {
      seen = source;
      return new Float32Array([0.1]);
    }) as unknown as typeof someAudio;
    const req: TranscribeRequest = {
      media: media(),
      config: { ...CONFIG, source: 'https://cors.test/clip.mp4' },
    };
    await runTranscription(req, { extractAudio: capture, spawn });
    expect(seen).toBe('https://cors.test/clip.mp4');
  });

  it('rejects an already-cancelled run without spawning a worker', async () => {
    const { spawn, created } = fakeWorkers({ cues: [] });
    const ac = new AbortController();
    ac.abort();
    const req: TranscribeRequest = { media: media(), config: CONFIG, signal: ac.signal };
    await expect(runTranscription(req, { extractAudio: someAudio, spawn })).rejects.toThrow(
      /cancelled/,
    );
    expect(created).toHaveLength(0);
  });
});
