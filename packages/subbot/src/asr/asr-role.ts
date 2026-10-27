/**
 * The ASR role of the worker: one whisper.cpp instance, fed windows, answering
 * segments as they are decoded.
 *
 * Single-threaded by construction (no SharedArrayBuffer on a page we do not
 * control), so the parallelism is in how many of these the main thread spawns, not
 * inside one. A call blocks this worker until the window is done; the main thread
 * never blocks.
 */
import createSubbot, { type SubbotModule } from '../../wasm/dist/subbot.js';
import { toFloat32 } from '../audio/resample.js';
import type { Segment } from '../cues.js';
import { fetchCached } from './fetch-cached.js';
import { MODEL_BYTES } from './models.js';
import type { AsrOptions, FromAsr, ToAsr } from './protocol.js';

type Post = (m: FromAsr, transfer?: Transferable[]) => void;

export class AsrRole {
  private mod: SubbotModule | null = null;
  private vadLoaded = false;

  constructor(private readonly post: Post) {}

  async handle(m: ToAsr): Promise<void> {
    try {
      if (m.type === 'init') await this.init(m);
      else if (m.type === 'transcribe') this.transcribe(m.id, m.pcm, m.t0, m.opts);
      else if (m.type === 'vad') this.vad(m.id, m.pcm, m.t0);
      else if (m.type === 'detect') this.detect(m.id, m.pcm);
    } catch (err) {
      const id = 'id' in m ? m.id : undefined;
      this.post({ type: 'error', id, message: err instanceof Error ? err.message : String(err) });
    }
  }

  private async init(m: Extract<ToAsr, { type: 'init' }>): Promise<void> {
    const progress = (what: 'wasm' | 'model' | 'vad') => (loaded: number, total: number) =>
      this.post({ type: 'progress', what, loaded, total });
    // The model is the long download; the engine is compiled and its heap grown
    // while that is in flight, so a cached model is in memory within a few hundred
    // milliseconds of this message.
    const modelP = fetchCached(m.modelUrl, m.cacheName, progress('model'));
    const vadP = m.vadUrl
      ? fetchCached(m.vadUrl, m.cacheName, progress('vad'))
      : Promise.resolve(null);
    // The engine is not fetched by hand: given its URL the glue streams it through
    // WebAssembly.instantiateStreaming, which compiles as the bytes arrive and, in
    // Chromium, keeps the optimised code in the code cache against the URL. The next
    // run then starts on fast code rather than on the baseline tier for its first
    // seconds, which is most of the first window. The HTTP cache holds the file.
    const engine = progress('wasm');
    engine(0, 1);
    const mod = await createSubbot({
      // Never let the glue look for the .wasm next to a blob: URL.
      locateFile: () => m.wasmUrl,
      print: () => {},
      printErr: () => {},
    });
    engine(1, 1);
    // The model's weights, the decoder state and room to work: one growth, not the
    // dozen the allocator would ask for one by one under the load.
    const name = /ggml-([\w.-]+)\.bin/.exec(m.modelUrl)?.[1] ?? '';
    mod.reserve((MODEL_BYTES[name] ?? 100_000_000) + 64_000_000);
    const [model, vad] = await Promise.all([modelP, vadP]);
    if (!mod.load_model(model, true)) throw new Error('whisper could not read the model file');
    if (vad && !mod.load_vad(vad)) throw new Error('whisper could not read the VAD model');
    this.vadLoaded = Boolean(vad);
    this.mod = mod;
    this.post({ type: 'ready' });
  }

  private need(): SubbotModule {
    if (!this.mod) throw new Error('ASR worker used before init');
    return this.mod;
  }

  private transcribe(id: number, pcm: Int16Array, t0: number, opts: AsrOptions): void {
    const mod = this.need();
    const started = performance.now();
    const audio = toFloat32(pcm);
    // Silence and music cost nothing: a window with no speech in it is answered empty
    // without the model seeing it. It is also what keeps "Thank you." off a quiet scene.
    let spans: Array<[number, number]> | undefined;
    if (this.vadLoaded) {
      const r = JSON.parse(
        mod.vad(audio, JSON.stringify({ threshold: 0.35, min_silence_ms: 200, pad_ms: 60 })),
      ) as unknown;
      spans = Array.isArray(r)
        ? (r as Array<[number, number]>).map(([a, b]) => [a + t0, b + t0])
        : undefined;
      if (spans && spans.length === 0) {
        this.post({
          type: 'done',
          id,
          segments: [],
          lang: opts.language,
          ms: performance.now() - started,
        });
        return;
      }
    }
    mod.onSegment = (json) => {
      const s = JSON.parse(json) as Segment;
      this.post({ type: 'segment', id, segment: { ...s, t0: s.t0 + t0, t1: s.t1 + t0 } });
    };
    const r = JSON.parse(
      mod.transcribe(
        audio,
        JSON.stringify({
          language: opts.language,
          translate: opts.translate,
          audio_ctx: opts.audioCtx,
          token_timestamps: opts.tokenTimestamps,
          max_len: opts.maxLen,
          single_segment: opts.singleSegment,
          max_tokens: opts.maxTokens,
          no_context: true,
          time_offset: t0,
          ...(opts.prompt ? { prompt: opts.prompt } : {}),
        }),
      ),
    ) as { error?: string; lang?: string; segments?: Segment[] };
    mod.onSegment = undefined;
    if (r.error) throw new Error(r.error);
    this.post({
      type: 'done',
      id,
      segments: r.segments ?? [],
      ...(spans ? { spans } : {}),
      lang: r.lang ?? opts.language,
      ms: performance.now() - started,
    });
  }

  private vad(id: number, pcm: Int16Array, t0: number): void {
    const mod = this.need();
    const r = JSON.parse(
      mod.vad(toFloat32(pcm), JSON.stringify({ threshold: 0.35, min_silence_ms: 200, pad_ms: 60 })),
    ) as Array<[number, number]> | { error: string };
    if (!Array.isArray(r)) throw new Error(r.error);
    this.post({ type: 'spans', id, spans: r.map(([a, b]) => [a + t0, b + t0]) });
  }

  private detect(id: number, pcm: Int16Array): void {
    const mod = this.need();
    const r = JSON.parse(mod.detect_language(toFloat32(pcm))) as {
      error?: string;
      lang: string;
      p: number;
    };
    if (r.error) throw new Error(r.error);
    this.post({ type: 'lang', id, lang: r.lang, p: r.p });
  }
}
