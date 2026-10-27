/**
 * In-process stand-ins for the two worker roles, driven by a script of "truth"
 * lines, so the orchestrator can be run under vitest with no WASM and no WebCodecs.
 */
import type { FromAsr, FromAudio, ToAsr, ToAudio } from '../src/asr/protocol.js';
import { RATE } from '../src/audio/resample.js';
import type { Segment } from '../src/cues.js';
import type { Spawn, WorkerLike } from '../src/workers.js';

export interface Truth {
  t0: number;
  t1: number;
  text: string;
}

export interface FakeOptions {
  truth: Truth[];
  duration: number;
  /** Milliseconds of fake decode per second of audio, by model name. */
  msPerSec?: Record<string, number>;
  /** Append this to every line from the named model, to tell the tiers apart. */
  suffix?: Record<string, string>;
  /** Fail the audio open with this code. */
  audioError?: string;
  random?: boolean;
  lang?: string;
}

export interface FakeLog {
  spawned: number;
  terminated: number;
  /** `load` messages: models asked for after the engine, by a worker taken over warm. */
  loads: number;
  windows: Array<{ model: string; t0: number; t1: number }>;
  reads: Array<[number, number]>;
}

class FakeWorker implements WorkerLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private role: 'asr' | 'audio' | null = null;
  private model = '';
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private dead = false;

  constructor(
    private readonly o: FakeOptions,
    private readonly log: FakeLog,
  ) {}

  private reply(m: FromAsr | FromAudio, delay = 0): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (!this.dead) this.onmessage?.({ data: m });
    }, delay);
    this.timers.add(t);
  }

  postMessage(message: unknown): void {
    const m = message as ToAsr | ToAudio;
    if (m.type === 'init') {
      this.role = m.role;
      if (m.role === 'asr') {
        this.model = /ggml-(.+)\.bin/.exec(m.modelUrl)?.[1] ?? m.modelUrl;
        this.reply({ type: 'progress', what: 'wasm', loaded: 1, total: 1 }, 1);
        if (m.load) this.loadModel();
      } else {
        if (this.o.audioError) {
          this.reply({ type: 'error', message: 'cannot open', code: this.o.audioError }, 1);
          return;
        }
        this.reply(
          {
            type: 'opened',
            duration: this.o.duration,
            codec: { kind: 'aac', codec: 'mp4a.40.2', sampleRate: 48000, channels: 2 },
            container: 'mp4',
            random: this.o.random ?? true,
          },
          1,
        );
      }
      return;
    }
    if (m.type === 'load') {
      this.log.loads++;
      this.loadModel();
      return;
    }
    if (this.role === 'audio') {
      if (m.type === 'read') {
        const t1 = Math.min(m.t1, this.o.duration);
        this.log.reads.push([m.t0, t1]);
        const pcm = new Int16Array(Math.max(0, Math.round((t1 - m.t0) * RATE))).fill(1000);
        this.reply({ type: 'pcm', id: m.id, t0: m.t0, pcm }, 1);
      }
      return;
    }
    if (m.type === 'transcribe') {
      const len = m.pcm.length / RATE;
      const t1 = m.t0 + len;
      this.log.windows.push({ model: this.model, t0: m.t0, t1 });
      const suffix = this.o.suffix?.[this.model] ?? '';
      const segments: Segment[] = this.o.truth
        .filter((l) => l.t0 >= m.t0 - 0.05 && l.t0 < t1)
        .map((l) => ({
          t0: l.t0,
          t1: Math.min(l.t1, t1),
          text: l.text + suffix,
          nsp: 0.1,
          p: 0.9,
        }));
      const ms = len * (this.o.msPerSec?.[this.model] ?? 10);
      for (const s of segments) this.reply({ type: 'segment', id: m.id, segment: s }, ms / 2);
      this.reply({ type: 'done', id: m.id, segments, lang: this.o.lang ?? 'en', ms }, ms);
    } else if (m.type === 'detect') {
      this.reply({ type: 'lang', id: m.id, lang: this.o.lang ?? 'en', p: 0.9 }, 1);
    }
  }

  private loadModel(): void {
    this.reply({ type: 'progress', what: 'model', loaded: 10, total: 100 }, 1);
    this.reply({ type: 'progress', what: 'model', loaded: 100, total: 100 }, 2);
    this.reply({ type: 'ready' }, 3);
  }

  terminate(): void {
    this.dead = true;
    this.log.terminated++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}

export function fakeSpawn(o: FakeOptions): { spawn: Spawn; log: FakeLog } {
  const log: FakeLog = { spawned: 0, terminated: 0, loads: 0, windows: [], reads: [] };
  const spawn: Spawn = () => {
    log.spawned++;
    return new FakeWorker(o, log);
  };
  return { spawn, log };
}

/** The least of a media element the orchestrator reads. */
export function fakeMedia(currentTime = 0, duration = Number.NaN): HTMLMediaElement {
  const listeners = new Map<string, Set<() => void>>();
  const el = {
    currentSrc: 'https://x.test/a.mp4',
    src: 'https://x.test/a.mp4',
    currentTime,
    duration,
    parentElement: null,
    textTracks: { length: 0 },
    querySelectorAll: () => [],
    addEventListener(type: string, fn: () => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.get(type)?.delete(fn);
    },
    seek(t: number) {
      el.currentTime = t;
      for (const fn of listeners.get('seeking') ?? []) fn();
    },
  };
  return el as unknown as HTMLMediaElement;
}
