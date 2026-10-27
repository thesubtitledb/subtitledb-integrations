/**
 * The main-thread side of the workers: spawning, and typed request/response over
 * postMessage with ids.
 *
 * The worker script is on the CDN, another origin from the page, and a Worker will
 * not take a cross-origin URL. A blob module that imports it will: the import is an
 * ordinary cross-origin module fetch, CORS-checked like every other chunk, and the
 * module's own relative imports resolve against its real URL. The glue's `.wasm`
 * is never found relative to the blob; its URL is passed in and the bytes fetched
 * by hand.
 */
import type { AsrOptions, FromAsr, FromAudio, SourceSpec, ToAsr, ToAudio } from './asr/protocol.js';
import type { AudioCodec } from './audio/codec.js';
import type { Segment } from './cues.js';
import { SubbotError } from './errors.js';

export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type Spawn = () => WorkerLike;

export function spawnFrom(workerUrl: string): Spawn {
  return () => {
    const program = `import ${JSON.stringify(workerUrl)};`;
    const url = URL.createObjectURL(new Blob([program], { type: 'text/javascript' }));
    const worker = new Worker(url, { type: 'module' }) as unknown as WorkerLike;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return worker;
  };
}

function messageOf(ev: unknown): string {
  if (ev && typeof ev === 'object' && 'message' in ev) {
    const m = (ev as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return 'the worker failed';
}

/** Request/response by id over one worker, with a stream hook for segments. */
class Client<Out, In extends { type: string; id?: number }> {
  private worker: WorkerLike;
  private nextId = 1;
  private waiting = new Map<
    number,
    {
      resolve: (m: In) => void;
      reject: (e: Error) => void;
      done: (m: In) => boolean;
      stream?: (m: In) => void;
    }
  >();
  private listeners = new Set<(m: In) => void>();
  dead = false;
  /** Stopped on purpose, as against died. */
  terminated = false;

  constructor(
    spawn: Spawn,
    private readonly onFail: (e: Error) => void,
  ) {
    this.worker = spawn();
    this.worker.onmessage = ({ data }) => this.receive(data as In);
    this.worker.onerror = (ev) => this.fail(new SubbotError(messageOf(ev), 'worker_failed'));
  }

  on(fn: (m: In) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private receive(m: In): void {
    for (const fn of this.listeners) fn(m);
    if (m.id === undefined) {
      if (m.type === 'error') {
        const e = m as { message?: string; code?: string };
        this.fail(
          new SubbotError(
            e.message ?? 'worker error',
            (e.code as SubbotError['code']) ?? 'worker_failed',
          ),
        );
      }
      return;
    }
    const w = this.waiting.get(m.id);
    if (!w) return;
    if (m.type === 'error') {
      this.waiting.delete(m.id);
      const e = m as unknown as { message: string; code?: string };
      w.reject(new SubbotError(e.message, (e.code as SubbotError['code']) ?? 'worker_failed'));
      return;
    }
    if (w.done(m)) {
      this.waiting.delete(m.id);
      w.resolve(m);
    } else w.stream?.(m);
  }

  private fail(e: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const w of this.waiting.values()) w.reject(e);
    this.waiting.clear();
    this.onFail(e);
  }

  post(m: Out, transfer: Transferable[] = []): void {
    if (this.dead) return;
    this.worker.postMessage(m, transfer);
  }

  request<T extends In>(
    make: (id: number) => Out,
    done: (m: In) => m is T,
    transfer: Transferable[] = [],
    stream?: (m: In) => void,
  ): Promise<T> {
    if (this.dead) {
      return Promise.reject(
        new SubbotError('the worker is gone', this.terminated ? 'aborted' : 'worker_failed'),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.waiting.set(id, { resolve: resolve as (m: In) => void, reject, done, stream });
      this.worker.postMessage(make(id), transfer);
    });
  }

  terminate(): void {
    if (this.terminated) return;
    this.dead = true;
    this.terminated = true;
    this.worker.onmessage = null;
    this.worker.onerror = null;
    this.worker.terminate();
    const e = new SubbotError('the worker was stopped', 'aborted');
    for (const w of this.waiting.values()) w.reject(e);
    this.waiting.clear();
  }
}

export interface AsrAssets {
  wasmUrl: string;
  modelUrl: string;
  vadUrl: string | null;
  cacheName: string;
}

export type LoadProgress = (what: 'wasm' | 'model' | 'vad', loaded: number, total: number) => void;

export interface Done {
  segments: Segment[];
  spans?: Array<[number, number]>;
  lang: string;
  ms: number;
}

/** One whisper.cpp instance. */
export class AsrWorker {
  private client: Client<ToAsr, FromAsr>;
  readonly ready: Promise<void>;
  private rejectReady: ((e: Error) => void) | null = null;
  busy: { t0: number; t1: number; started: number } | null = null;

  constructor(
    spawn: Spawn,
    readonly assets: AsrAssets,
    onProgress: LoadProgress,
    onFail: (e: Error) => void,
  ) {
    this.client = new Client<ToAsr, FromAsr>(spawn, onFail);
    this.ready = new Promise<void>((resolve, reject) => {
      const off = this.client.on((m) => {
        if (m.type === 'progress') onProgress(m.what, m.loaded, m.total);
        else if (m.type === 'ready') {
          off();
          resolve();
        } else if (m.type === 'error' && m.id === undefined) {
          off();
          reject(new SubbotError(m.message, 'model_download'));
        }
      });
      this.rejectReady = reject;
    });
    // Observed through work(), not here: a worker stopped before it was ready must not
    // be an unhandled rejection.
    this.ready.catch(() => {});
    this.client.post({ type: 'init', role: 'asr', ...assets });
  }

  get dead(): boolean {
    return this.client.dead;
  }

  async transcribe(
    pcm: Int16Array,
    t0: number,
    t1: number,
    opts: AsrOptions,
    onSegment?: (s: Segment) => void,
  ): Promise<Done> {
    this.busy = { t0, t1, started: performance.now() };
    try {
      const m = await this.client.request(
        (id) => ({ type: 'transcribe', id, pcm, t0, opts }),
        (x): x is Extract<FromAsr, { type: 'done' }> => x.type === 'done',
        [pcm.buffer],
        (x) => {
          if (x.type === 'segment') onSegment?.(x.segment);
        },
      );
      return {
        segments: m.segments,
        lang: m.lang,
        ms: m.ms,
        ...(m.spans ? { spans: m.spans } : {}),
      };
    } finally {
      this.busy = null;
    }
  }

  async detect(pcm: Int16Array): Promise<{ lang: string; p: number }> {
    const m = await this.client.request(
      (id) => ({ type: 'detect', id, pcm }),
      (x): x is Extract<FromAsr, { type: 'lang' }> => x.type === 'lang',
      [pcm.buffer],
    );
    return { lang: m.lang, p: m.p };
  }

  terminate(): void {
    this.client.terminate();
    this.rejectReady?.(new SubbotError('the worker was stopped', 'aborted'));
  }
}

export interface Opened {
  duration: number;
  codec: AudioCodec;
  container: string;
  random: boolean;
}

/** The audio reader. */
export class AudioWorker {
  private client: Client<ToAudio, FromAudio>;
  coverage: Array<[number, number]> = [];
  opened: Opened | null = null;
  private onOpened: ((o: Opened) => void) | null = null;

  constructor(spawn: Spawn, onFail: (e: Error) => void) {
    this.client = new Client<ToAudio, FromAudio>(spawn, onFail);
    this.client.on((m) => {
      if (m.type === 'coverage') this.coverage = m.spans;
      if (m.type === 'opened') {
        this.opened = m;
        if (m.random) this.coverage = [[0, m.duration]];
        this.onOpened?.(m);
      }
    });
  }

  /** Open the source. Resolves on the first `opened`, which for a feed waits for bytes. */
  open(source: SourceSpec, language?: string): Promise<Opened> {
    return new Promise<Opened>((resolve, reject) => {
      this.onOpened = resolve;
      const off = this.client.on((m) => {
        if (m.type === 'error' && m.id === undefined) {
          off();
          reject(new SubbotError(m.message, (m.code as SubbotError['code']) ?? 'audio_unreadable'));
        }
      });
      this.client.post({ type: 'init', role: 'audio', source, language });
    });
  }

  async read(t0: number, t1: number): Promise<{ t0: number; pcm: Int16Array }> {
    const m = await this.client.request(
      (id) => ({ type: 'read', id, t0, t1 }),
      (x): x is Extract<FromAudio, { type: 'pcm' }> => x.type === 'pcm',
    );
    return { t0: m.t0, pcm: m.pcm };
  }

  feed(bytes: Uint8Array, init: boolean, start: number | null): void {
    this.client.post({ type: 'feed', bytes, init, start });
  }

  trim(keep: Array<[number, number]>): void {
    this.client.post({ type: 'trim', keep });
  }

  terminate(): void {
    this.client.terminate();
  }
}
