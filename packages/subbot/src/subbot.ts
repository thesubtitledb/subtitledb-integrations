/**
 * The run: open the audio, warm the models, keep cues ahead of the playhead, fill
 * in the rest of the file behind, and hand a complete WebVTT back at the end.
 *
 * Two tiers. The live tier is one worker with the small model, fed a short first
 * window from the playhead and then six second steps, as far ahead as it gets, so
 * the first line is on screen within a few seconds of the click and the lead never
 * runs out. The quality tier is a pool with the bigger model, fifteen second
 * windows, nearest the playhead first and then from the start of the file; its
 * cues replace the live ones as they land. Everything heavy is in workers and every
 * buffer is transferred, so the page's thread only ever moves cues around.
 *
 * The returned promise is the adapter's contract: it resolves with the whole file
 * once every second of it is covered, and the adapter then sets that file as the
 * track's source. Until then the cues are drawn through the track directly.
 *
 * Once the first lines are in, they are looked up in the corpus (`req.identify`, at
 * 30, 60 and 120 words). On a match the run stops, the corpus file replaces the
 * transcription on the track, and the promise resolves with that file instead.
 */
import type {
  Identified,
  IdentifiedText,
  ResolvedTranscribe,
  TranscribeRequest,
} from '@subtitledb/core';
import { agreement, candidateLabel, parseVtt, syntheticCandidate } from '@subtitledb/core';
import {
  audioCtxFor,
  DEFAULT_VAD_URL,
  MODELS,
  modelUrl,
  type Quality,
  type TierModels,
} from './asr/models.js';
import type { AsrOptions } from './asr/protocol.js';
import { quietestAt } from './audio/pcm.js';
import { RATE } from './audio/resample.js';
import { CueStore, held, type Segment, segmentsToCues, type Tier, trimToSpeech } from './cues.js';
import { SubbotError } from './errors.js';
import { type Plan, planFor } from './players.js';
import { TrackRenderer } from './render.js';
import {
  FAR,
  Intervals,
  LIVE,
  nextLive,
  nextQuality,
  QUALITY_WINDOW,
  qualityWorkers,
  type Span,
  type Window,
} from './schedule.js';
import { cuesToVtt } from './vtt.js';
import { takeWarm, warmUp } from './warm.js';
import { type AsrAssets, AsrWorker, AudioWorker, type Spawn, spawnFrom } from './workers.js';

export interface RunDeps {
  /** The worker script, on the CDN. */
  workerUrl: string;
  /** The whisper.cpp build, next to it. */
  wasmUrl: string;
  /** Test seam: how a worker is made. */
  spawn?: Spawn;
  cacheName?: string;
}

export type SubbotState =
  | { state: 'warm'; model: boolean }
  | { state: 'loading'; step: 'engine' | 'model' | 'audio'; loaded: number; total: number }
  | { state: 'listening' }
  | { state: 'live'; covered: number; duration: number; language: string | null }
  | { state: 'paused' }
  | { state: 'complete'; cues: number }
  | { state: 'identified'; identified: Identified }
  | { state: 'error'; error: Error };

/** The fields of the resolved config this engine reads beyond the core ones. */
interface Config {
  model: string;
  task: 'transcribe' | 'translate';
  language: string;
  source?: string;
  quality?: Quality;
  models?: string;
  status?: boolean;
  onState?: (s: SubbotState) => void;
}

/** The models of each tier for a config: an explicit model is one tier, else what `quality` names. */
export function tiersFor(cfg: Pick<Config, 'model' | 'quality'>): TierModels {
  if (cfg.model && cfg.model !== 'auto') return { live: cfg.model, quality: null };
  return MODELS[cfg.quality ?? 'balanced'];
}

function assetsFor(model: string, base: string | undefined, deps: RunDeps): AsrAssets {
  return {
    wasmUrl: deps.wasmUrl,
    modelUrl: modelUrl(model, base),
    vadUrl: DEFAULT_VAD_URL,
    cacheName: deps.cacheName ?? 'subtitledb-subbot',
  };
}

/** Decode cost per second of audio, by tier, until measured. Single-thread WASM. */
const MS_PER_SEC: Record<Tier, number> = { live: 350, quality: 850 };
/** How far behind a seek the live worker's current window may be before it is dropped. */
const RESTART_MS = 1500;
/** Words heard before each corpus lookup; after the last miss the transcription stays. */
export const IDENTIFY_WORDS = [30, 60, 120];
/** Lines sent per lookup, the route's cap. */
const IDENTIFY_CUES = 80;
/**
 * A match is shown once the words heard from 30 s past the lookup's first line agree
 * with the file: a show's theme or intro matches another episode, its dialogue after
 * does not. Bench (2026-10-27, TehTranScriber transcripts against whole files): right
 * matches agreed on 50-100% of those trigrams, a wrong episode on 0-31%.
 */
export const VERIFY_AFTER_MS = 30_000;
/** Trigrams heard before deciding, and the most before giving up on a match. */
export const VERIFY_MIN = 12;
export const VERIFY_MAX = 30;
export const VERIFY_SHARE = 0.35;
/** One word per character where a script has no spaces, as the corpus index counts them. */
const WORDS = /[\u0e00-\u0eff\u1000-\u109f\u1780-\u17ff\u3040-\u30ff\u3400-\u9fff]|[\p{L}\p{N}]+/gu;

export function wordCount(cues: ReadonlyArray<{ text: string }>): number {
  let n = 0;
  for (const c of cues) n += c.text.match(WORDS)?.length ?? 0;
  return n;
}

export class Subbot {
  private readonly media: HTMLMediaElement;
  private readonly cfg: Config;
  private readonly signal: AbortSignal | undefined;
  private readonly spawn: Spawn;
  private readonly store = new CueStore();
  private readonly renderer: TrackRenderer;
  private readonly covered = new Intervals();
  private readonly qualityCovered = new Intervals();
  private inflight: Array<Window & { tier: Tier }> = [];
  private audio: AudioWorker | null = null;
  private live: AsrWorker | null = null;
  private pool: AsrWorker[] = [];
  private readonly liveModel: string;
  private qualityModel: string | null;
  private language: string | null = null;
  /** The language the last window with speech was heard in, before two agree. */
  private heard: string | null = null;
  private duration = 0;
  private fresh = true;
  private stopped = false;
  /** Captions off in the browser's menu: no new windows until the row is picked again. */
  private paused = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  private unhook: (() => void) | null = null;
  private rate: Record<Tier, number> = { ...MS_PER_SEC };
  private firstCueAt: number | null = null;
  private readonly startedAt = performance.now();
  private readonly loaded: Record<string, [number, number]> = {};
  private asked = 0;
  /** The lookup in the air, if any. A run that finishes waits for it. */
  private lookup: Promise<void> | null = null;
  private swapped: IdentifiedText | null = null;
  /** A match waiting for the words after it to agree. */
  private pending: { r: IdentifiedText; key: string; after: number; from: number } | null = null;
  /** Title, season and episode of matches the words after did not bear out. */
  private readonly rejected = new Set<string>();

  constructor(
    private readonly req: TranscribeRequest,
    private readonly deps: RunDeps,
  ) {
    this.media = req.media;
    this.cfg = req.config as unknown as Config;
    this.signal = req.signal;
    this.spawn = deps.spawn ?? spawnFrom(deps.workerUrl);
    const tiers = tiersFor(this.cfg);
    this.liveModel = tiers.live;
    this.qualityModel = tiers.quality;
    const lang = this.cfg.language === 'auto' ? 'und' : this.cfg.language;
    this.renderer = new TrackRenderer(
      this.media,
      candidateLabel(syntheticCandidate(this.cfg.language)),
      lang,
      this.cfg.status !== false,
      (off) => this.setPaused(off),
    );
    this.store.listen((added, removed) => {
      this.renderer.apply(added, removed);
      if (added.length && this.firstCueAt === null) {
        this.firstCueAt = performance.now() - this.startedAt;
      }
      this.verify(false);
      this.maybeIdentify();
    });
  }

  private emit(s: SubbotState): void {
    try {
      this.cfg.onState?.(s);
    } catch {
      // A listener's bug is not the run's.
    }
    if (s.state === 'loading' && s.step !== 'audio') {
      this.req.onProgress?.({ phase: s.step, loaded: s.loaded, total: s.total });
    } else if (s.state === 'live') {
      this.req.onProgress?.({ phase: 'transcribe', loaded: s.covered, total: s.duration });
    }
  }

  /** Ask the corpus for these lines once enough words are in. One lookup at a time. */
  private maybeIdentify(): void {
    const ask = this.req.identify;
    const need = IDENTIFY_WORDS[this.asked];
    if (!ask || need === undefined || this.lookup || this.pending || this.swapped || this.stopped)
      return;
    if (this.cfg.task !== 'transcribe') return;
    const lang = this.language ?? (this.cfg.language === 'auto' ? null : this.cfg.language);
    if (!lang || wordCount(this.store.cues) < need) return;
    this.asked++;
    const cues = this.store.cues.slice(0, IDENTIFY_CUES).map((c) => ({
      start_ms: Math.round(c.start * 1000),
      text: c.text.slice(0, 500),
    }));
    // The session reports a failed lookup and answers null; either way the
    // transcription carries on.
    this.lookup = ask(lang, cues)
      .then((r) => {
        if (!r || this.stopped) return;
        const id = r.identified;
        const key = `${id.imdb_id}:${id.season}:${id.episode}`;
        if (this.rejected.has(key)) return;
        if (!r.reference) {
          this.swapIn(r);
          return;
        }
        const first = cues[0]?.start_ms ?? 0;
        const after = cues[cues.length - 1]?.start_ms ?? 0;
        this.pending = { r, key, after, from: first + VERIFY_AFTER_MS };
        this.verify(false);
      })
      .catch(() => {})
      .finally(() => {
        this.lookup = null;
        this.maybeIdentify();
      });
  }

  /**
   * Show the pending match once enough later words agree with it; drop it once enough
   * do not. `final`: no more words are coming, so decide on what there is.
   */
  private verify(final: boolean): void {
    const p = this.pending;
    if (!p || this.swapped || this.stopped) return;
    const heard: Array<{ start_ms: number; text: string }> = [];
    for (const c of this.store.cues) {
      const ms = Math.round(c.start * 1000);
      if (ms > p.after && ms >= p.from) heard.push({ start_ms: ms, text: c.text });
    }
    const { hits, total } = agreement(p.r.reference ?? [], heard);
    if (total >= VERIFY_MIN && hits >= total * VERIFY_SHARE) {
      this.pending = null;
      this.swapIn(p.r);
    } else if (total >= VERIFY_MAX || final) {
      this.pending = null;
      this.rejected.add(p.key);
      if (!final) this.maybeIdentify();
    }
  }

  /** The corpus file replaces the transcription on the track, and the run stops. */
  private swapIn(r: IdentifiedText): void {
    this.swapped = r;
    const cues = parseVtt(r.text).map((c) => ({
      start: c.start / 1000,
      end: c.end / 1000,
      text: c.text,
      tier: 'quality' as const,
    }));
    this.store.clear();
    this.store.replace(0, Number.POSITIVE_INFINITY, cues, 'quality');
    this.stop();
  }

  private finishSwap(r: IdentifiedText): { text: string; format: 'vtt'; identified: Identified } {
    this.emit({ state: 'identified', identified: r.identified });
    this.renderer.handover('Matched');
    return { text: r.text, format: 'vtt', identified: r.identified };
  }

  private progress(what: string, loaded: number, total: number): void {
    this.loaded[what] = [loaded, total];
    let l = 0;
    let t = 0;
    for (const [a, b] of Object.values(this.loaded)) {
      l += a;
      t += b;
    }
    const step = what === 'wasm' ? 'engine' : 'model';
    this.emit({ state: 'loading', step, loaded: l, total: t });
    this.renderer.status('Downloading', t > 0 ? Math.min(0.99, l / t) : 0);
  }

  private assets(model: string): AsrAssets {
    return assetsFor(model, this.cfg.models, this.deps);
  }

  /** The worker warmed ahead of the click, if it is for this run's live model. */
  private adoptWarm(): AsrWorker | null {
    const w = takeWarm(this.assets(this.liveModel));
    if (!w) return null;
    w.onProgress = (what, l, t) => this.progress(what, l, t);
    w.onFail = (e) => this.fail(e);
    w.load();
    return w;
  }

  private spawnAsr(model: string, report: boolean): AsrWorker {
    return new AsrWorker(
      this.spawn,
      this.assets(model),
      report ? (what, l, t) => this.progress(what, l, t) : () => {},
      (e) => this.fail(e),
    );
  }

  private fail(e: Error): void {
    if (this.stopped) return;
    this.failure = e;
    this.stop();
  }

  private stop(): void {
    this.stopped = true;
    this.wake?.();
    this.unhook?.();
    this.unhook = null;
    this.live?.terminate();
    for (const w of this.pool) w.terminate();
    this.pool = [];
    this.audio?.terminate();
    this.media.removeEventListener('seeking', this.onSeek);
  }

  private setPaused(paused: boolean): void {
    if (this.stopped || paused === this.paused) return;
    this.paused = paused;
    if (paused) {
      this.renderer.status(null);
      this.emit({ state: 'paused' });
      return;
    }
    // Back on: from where the viewer is now, with the short first window.
    this.fresh = true;
    this.wake?.();
  }

  private readonly onSeek = (): void => {
    this.fresh = true;
    const live = this.live;
    const b = live?.busy;
    if (live && b) {
      const expect = (b.t1 - b.t0) * this.rate.live;
      const remaining = expect - (performance.now() - b.started);
      const far = Math.abs(this.media.currentTime - b.t0) > FAR;
      // A window far from where the viewer went, with most of its cost still ahead,
      // is not worth finishing. Terminating is the only way to stop a decode.
      if (far && remaining > RESTART_MS) {
        live.terminate();
        this.live = this.spawnAsr(this.liveModel, false);
      }
    }
    this.wake?.();
  };

  private async openAudio(): Promise<void> {
    const plan = planFor(this.media, this.req.player, this.cfg.source);
    const lang = this.cfg.language === 'auto' ? undefined : this.cfg.language;
    const tryPlan = async (p: Plan): Promise<void> => {
      const audio = new AudioWorker(this.spawn, (e) => this.fail(e));
      this.audio = audio;
      this.unhook = p.hook ? p.hook((bytes, init, start) => audio.feed(bytes, init, start)) : null;
      try {
        await audio.open(p.spec, lang);
      } catch (e) {
        audio.terminate();
        this.unhook?.();
        this.unhook = null;
        if (p.fallback && !this.stopped) {
          await tryPlan(p.fallback);
          return;
        }
        throw e;
      }
    };
    this.emit({ state: 'loading', step: 'audio', loaded: 0, total: 1 });
    await tryPlan(plan);
    const opened = this.audio?.opened;
    const d = opened?.duration || this.media.duration;
    this.duration = Number.isFinite(d) && d > 0 ? d : 0;
  }

  private audioUntil(t: number): number {
    const a = this.audio;
    if (!a?.opened) return t;
    if (a.opened.random) return this.duration || Number.POSITIVE_INFINITY;
    const iv = new Intervals();
    for (const [x, y] of a.coverage) iv.add(x, y);
    return iv.until(t);
  }

  /**
   * What a tier counts as taken: `base` and its own windows in flight. Not the other
   * tier's: a quality window at the playhead takes many times longer than a live one,
   * and a live tier that stepped round it left the viewer waiting on the big model.
   */
  private merged(base: Intervals, tier: Tier): Intervals {
    const iv = new Intervals();
    iv.spans = base.spans.map((s) => [s[0], s[1]] as Span);
    for (const w of this.inflight) if (w.tier === tier) iv.add(w.t0, w.t1);
    return iv;
  }

  private complete(): boolean {
    if (!this.duration) return false;
    const done = this.qualityModel ? this.qualityCovered : this.covered;
    return done.total() >= this.duration - 0.5;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
    });
  }

  private async work(worker: AsrWorker, w: Window, tier: Tier): Promise<void> {
    const job = { ...w, tier };
    this.inflight.push(job);
    try {
      await worker.ready;
      const audio = this.audio as AudioWorker;
      const read = await audio.read(w.t0, w.t1);
      let pcm = read.pcm;
      let len = pcm.length / RATE;
      // Cut a full window at its quietest point near the end, so a line is not split
      // across two windows and transcribed as two halves.
      if (w.t1 < this.duration - 0.1 && len > 2.5) {
        const cut = quietestAt(pcm, len - 1, len);
        if (cut < len - 0.1) {
          pcm = pcm.subarray(0, Math.round(cut * RATE));
          len = cut;
        }
      }
      const t0 = read.t0;
      const t1 = t0 + len;
      if (len < 0.3) {
        this.mark(tier, w.t0, w.t1);
        return;
      }
      const opts: AsrOptions = {
        language: this.language ?? this.cfg.language,
        translate: this.cfg.task === 'translate',
        audioCtx: audioCtxFor(len),
        tokenTimestamps: true,
        maxLen: 0,
        singleSegment: len <= 6.5,
        maxTokens: Math.ceil(len * 10) + 10,
      };
      const started = performance.now();
      const r = await worker.transcribe(pcm, t0, t1, opts);
      const ms = performance.now() - started;
      this.rate[tier] = 0.7 * this.rate[tier] + 0.3 * (ms / len);
      const cues = trimToSpeech(
        segmentsToCues(r.segments as Segment[], tier, t0, t1),
        r.spans ?? [],
      );
      // Whisper names a language for music too: Kingsman's opening came back Japanese,
      // twice, as lines the junk filter dropped. Take a language once two windows that
      // gave lines agree on it.
      if (
        !this.language &&
        this.cfg.language === 'auto' &&
        r.lang &&
        r.lang !== 'auto' &&
        cues.length > 0
      ) {
        if (r.lang === this.heard) this.language = r.lang;
        else this.heard = r.lang;
      }
      if (this.stopped) return;
      this.store.replace(t0, t1, cues, tier);
      // The window was asked from w.t0; what came back may start a little earlier or
      // later by a codec frame. Cover what was asked for, so no sliver is re-done.
      this.mark(tier, Math.min(w.t0, t0), Math.max(t1, w.t1 - 0.05));
    } catch (e) {
      if (e instanceof SubbotError && e.code === 'aborted') return;
      throw e;
    } finally {
      this.inflight = this.inflight.filter((x) => x !== job);
    }
  }

  private mark(tier: Tier, t0: number, t1: number): void {
    this.covered.add(t0, t1);
    if (tier === 'quality') this.qualityCovered.add(t0, t1);
    // A window that was in flight when captions went off: kept, but not reported.
    if (this.paused) return;
    // How far to the complete file: what `complete()` waits for.
    if (this.duration) {
      const done = (this.qualityModel ? this.qualityCovered : this.covered).total();
      this.renderer.status('Transcribing', Math.min(0.99, done / this.duration));
    }
    this.emit({
      state: 'live',
      covered: this.covered.total(),
      duration: this.duration,
      language: this.language,
    });
  }

  private async liveLoop(): Promise<void> {
    while (!this.stopped && !this.complete()) {
      if (this.paused) {
        await this.sleep(400);
        continue;
      }
      const live = this.live as AsrWorker;
      const playhead = this.media.currentTime;
      const merged = this.merged(this.covered, 'live');
      let w = nextLive(
        playhead,
        merged,
        (t) => this.audioUntil(t),
        this.duration,
        LIVE,
        this.fresh,
      );
      // With no quality tier the live worker fills the rest of the file itself.
      if (!w && !this.qualityModel) {
        w = nextQuality(playhead, merged, (t) => this.audioUntil(t), this.duration, LIVE.step);
      }
      if (!w) {
        await this.sleep(400);
        continue;
      }
      this.fresh = false;
      await this.work(live, w, 'live');
      if (this.live !== live) {
        // Restarted under us by a seek. The new one is picked up on the next turn.
        this.fresh = true;
      }
    }
  }

  private async qualityLoop(worker: AsrWorker): Promise<void> {
    while (!this.stopped && !this.complete()) {
      if (this.paused) {
        await this.sleep(500);
        continue;
      }
      const playhead = this.media.currentTime;
      const merged = this.merged(this.qualityCovered, 'quality');
      const w = nextQuality(
        playhead,
        merged,
        (t) => this.audioUntil(t),
        this.duration,
        QUALITY_WINDOW,
      );
      if (!w) {
        await this.sleep(500);
        continue;
      }
      await this.work(worker, w, 'quality');
    }
  }

  private startPool(): void {
    if (!this.qualityModel) return;
    const cores = navigator.hardwareConcurrency || 2;
    const mem = (navigator as { deviceMemory?: number }).deviceMemory;
    const n = qualityWorkers(cores, mem);
    // A machine too small for a pool gets the live tier alone, which then covers the
    // file itself and is what completion waits for.
    if (n === 0) {
      this.qualityModel = null;
      return;
    }
    for (let i = 0; i < n; i++) this.pool.push(this.spawnAsr(this.qualityModel, false));
  }

  async run(): Promise<{ text: string; format: 'vtt'; identified?: Identified }> {
    if (this.signal?.aborted) throw new SubbotError('transcription was cancelled', 'aborted');
    const onAbort = () => this.fail(new SubbotError('transcription was cancelled', 'aborted'));
    this.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      this.renderer.status('Starting');
      // The model download and the audio open overlap; whichever is slower sets the
      // first cue.
      this.live = this.adoptWarm() ?? this.spawnAsr(this.liveModel, true);
      await this.openAudio();
      this.throwIfFailed();
      await this.live.ready;
      this.throwIfFailed();
      this.renderer.status('Listening');
      this.emit({ state: 'listening' });
      this.media.addEventListener('seeking', this.onSeek);

      // The first window alone, so the quality models do not share the network or
      // the cores with the one window that decides how soon a cue appears.
      const first = this.firstWindow();
      if (first) await this.work(this.live, first, 'live');
      if (this.swapped) return this.finishSwap(this.swapped);
      this.throwIfFailed();
      this.startPool();
      await Promise.all([this.liveLoop(), ...this.pool.map((w) => this.qualityLoop(w))]);
      // A short file can be covered while its lookup is still out; the answer decides.
      while (this.lookup && !this.swapped) await this.lookup;
      this.verify(true);
      if (this.swapped) return this.finishSwap(this.swapped);
      this.throwIfFailed();
      if (!this.complete())
        throw new SubbotError('the audio could not all be read', 'audio_unreadable');

      const text = cuesToVtt(held(this.store.cues));
      this.emit({ state: 'complete', cues: this.store.cues.length });
      this.renderer.handover();
      return { text, format: 'vtt' };
    } catch (e) {
      const err =
        this.failure ?? (e instanceof Error ? e : new SubbotError(String(e), 'worker_failed'));
      this.renderer.dispose();
      this.emit({ state: 'error', error: err });
      throw err;
    } finally {
      this.signal?.removeEventListener('abort', onAbort);
      this.stop();
    }
  }

  private firstWindow(): Window | null {
    const w = nextLive(
      this.media.currentTime,
      this.merged(this.covered, 'live'),
      (t) => this.audioUntil(t),
      this.duration,
      LIVE,
      true,
    );
    this.fresh = false;
    return w;
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure;
    if (this.stopped) throw new SubbotError('transcription was cancelled', 'aborted');
  }

  /** Milliseconds from the call to the first cue on screen, for the bench. */
  get timeToFirstCue(): number | null {
    return this.firstCueAt;
  }
}

/**
 * Get the live worker ready before the row is selected: engine compiled, model in
 * memory when this device already has it. Never downloads a model. `onState` hears
 * `warm` once it is as ready as it can get, with `model` saying whether the model is
 * in.
 */
export async function warmTranscription(cfg: ResolvedTranscribe, deps: RunDeps): Promise<void> {
  const c = cfg as unknown as Config;
  const spawn = deps.spawn ?? spawnFrom(deps.workerUrl);
  const model = await warmUp(spawn, assetsFor(tiersFor(c).live, c.models, deps));
  try {
    c.onState?.({ state: 'warm', model });
  } catch {
    // A listener's bug is not the warm-up's.
  }
}
