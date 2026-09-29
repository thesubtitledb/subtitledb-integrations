/**
 * Watching one video element, and turning what it does into plays.
 *
 * Everything here is read from the element's own media events and properties, so
 * it works the same under any player that keeps a real `<video>`. It never calls a
 * media method, never changes a property, and never throws into the page: a bug in
 * a debugger must not become a bug in the player it is watching.
 *
 * ## When a snapshot goes
 *
 * At the first frame, every ten minutes of playback, on pause, and on anything that
 * could be the last chance: the play ending, an error, a new source, the tab being
 * hidden, and the page going away. On a phone a hidden tab is often discarded
 * without another event, so hidden counts as a possible end. About four per play.
 *
 * ## What is not counted as what
 *
 * Waiting before the first frame is startup, not a stall. Waiting while seeking is
 * the seek. A pause that the end of the media causes is not a pause. Watch time is
 * wall-clock time spent actually playing: not paused, not stalled, not seeking.
 */
import { Play } from './play.js';
import type { Sender } from './send.js';
import { type EventKind, encode, FLAGS, type Snapshot, type TraceEvent } from './snapshot.js';

/** Marks a watched element. Symbol.for, so two copies of this code on a page share it. */
export const MARK = Symbol.for('subtitledb.debug');

const CADENCE_MS = 10 * 60 * 1000;
/** Below this, a pause right after another snapshot waits for the next one. */
const MIN_GAP_MS = 2000;
/** Per play. A viewer mashing pause cannot turn one play into thousands of posts. */
const MAX_SNAPSHOTS = 500;
/** More media time than this between two ticks is a jump, not playback. */
const MAX_TICK_S = 2;
/** Per page load: the play number is one byte on the wire. */
const MAX_PLAYS = 255;
/** Events kept from before the first play opens: the attach, the source, the offer. */
const PENDING = 10;

const MEDIA_ERRORS: Record<number, string> = {
  1: 'aborted',
  2: 'network',
  3: 'decode',
  4: 'source not supported',
};

/** Play numbers are unique across every element on the page, not per element. */
let plays = 0;

/** What SubtitleDB knows about the media, when the element was attached through it. */
export interface Context {
  player?: string;
  imdb?: number;
  tmdb?: number;
  season?: number;
  episode?: number;
}

/** A subtitle SubtitleDB put in front of the viewer. */
export interface Chosen {
  id: number;
  language: string;
  /** `sdb` for a corpus file, `ai` for an on-device transcription. */
  source: string;
}

export interface CollectorOptions {
  key: string;
  /** 16 hex characters, one per page load. */
  loadId: string;
  visitor?: string | undefined;
  sender: Sender;
  /** Monotonic milliseconds. */
  now?: () => number;
  /** Epoch milliseconds. */
  epoch?: () => number;
  doc?: Document | null;
  win?: Window | null;
}

type Quality = { droppedVideoFrames: number; totalVideoFrames: number };

/** What some engines have and others lack; every read of these is optional. */
type Watched = HTMLVideoElement & {
  [MARK]?: Collector;
  getVideoPlaybackQuality?: () => Quality;
  audioTracks?: ArrayLike<{ enabled: boolean; language: string }>;
  remote?: EventTarget;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

/** `m:ss` or `h:mm:ss`. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${ss}` : `${mm}:${ss}`;
}

/**
 * A source as a person reads it, without its query string or fragment: signed media
 * URLs carry their credentials there, and a trace is shown to whoever owns the key.
 */
export function describeSource(src: string): string {
  if (src.startsWith('blob:')) return 'media source (blob)';
  if (src.startsWith('data:')) return 'inline data';
  try {
    const u = new URL(src);
    const path = u.pathname.length > 80 ? `...${u.pathname.slice(-77)}` : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return src.split(/[?#]/)[0]?.slice(0, 100) ?? '';
  }
}

function showingTrack(v: HTMLVideoElement): TextTrack | null {
  const list = v.textTracks as TextTrackList | undefined;
  for (let i = 0; i < (list?.length ?? 0); i++) {
    const t = list?.[i];
    if (t && t.mode === 'showing' && (t.kind === 'subtitles' || t.kind === 'captions')) return t;
  }
  return null;
}

export class Collector {
  #play: Play | null = null;
  readonly #t0: number;
  #pending: TraceEvent[] = [];
  #ctx: Context = {};
  #chosen: Chosen | null = null;
  #src = '';
  #track = '';
  #intentAt: number | null = null;
  #started = false;
  #resumed = false;
  #playingSince: number | null = null;
  #stallSince: number | null = null;
  #subSince: number | null = null;
  #lastPos = 0;
  #lastSentAt = Number.NEGATIVE_INFINITY;
  #height = 0;
  #base = { dropped: 0, frames: 0 };
  readonly #off: (() => void)[] = [];
  readonly #now: () => number;
  readonly #epoch: () => number;
  readonly #doc: Document | null;

  readonly #o: CollectorOptions;

  constructor(
    readonly video: HTMLVideoElement,
    o: CollectorOptions,
  ) {
    this.#o = o;
    const g = globalThis as { document?: Document; window?: Window };
    this.#now = o.now ?? (() => performance.now());
    this.#epoch = o.epoch ?? Date.now;
    this.#doc = o.doc === undefined ? (g.document ?? null) : o.doc;
    const win = o.win === undefined ? (g.window ?? null) : o.win;
    this.#t0 = this.#now();
    (video as Watched)[MARK] = this;

    const v = video as Watched;
    const on = (target: EventTarget | null | undefined, type: string, fn: () => void) => {
      if (!target?.addEventListener) return;
      const safe = () => {
        try {
          fn();
        } catch {
          // Never into the host page. See the note at the top.
        }
      };
      target.addEventListener(type, safe);
      this.#off.push(() => target.removeEventListener(type, safe));
    };

    on(v, 'loadstart', () => this.#onSource());
    on(v, 'emptied', () => this.#close());
    on(v, 'loadedmetadata', () => this.#onMetadata());
    on(v, 'play', () => this.#onPlay());
    on(v, 'playing', () => this.#onPlaying());
    on(v, 'timeupdate', () => this.#onTime());
    on(v, 'waiting', () => this.#onWaiting());
    on(v, 'pause', () => this.#onPause());
    on(v, 'seeking', () => this.#onSeeking());
    on(v, 'seeked', () => this.#reconcile());
    on(v, 'ended', () => this.#onEnded());
    on(v, 'error', () => this.#onError());
    on(v, 'resize', () => this.#onResize());
    on(v, 'volumechange', () => this.#checkMuted());
    on(v, 'enterpictureinpicture', () => this.#flag(FLAGS.pip));
    on(v, 'webkitbeginfullscreen', () => this.#flag(FLAGS.fullscreen));
    on(v, 'webkitcurrentplaybacktargetiswirelesschanged', () => {
      if (v.webkitCurrentPlaybackTargetIsWireless) this.#flag(FLAGS.cast);
    });
    on(v.remote, 'connect', () => this.#flag(FLAGS.cast));
    on(v.textTracks as unknown as EventTarget, 'change', () => this.#onTracks());
    on(this.#doc, 'fullscreenchange', () => this.#onFullscreen());
    on(this.#doc, 'webkitfullscreenchange', () => this.#onFullscreen());
    on(this.#doc, 'visibilitychange', () => {
      if (this.#doc?.visibilityState === 'hidden') this.#send(true);
    });
    on(win, 'pagehide', () => this.#send(true));

    this.#note('attach', 0, '');
    this.#onSource();
    if (v.readyState >= 1) this.#onMetadata();
    // Watched mid-play: the play is real, its startup is unknown, and 0 says so.
    if (!v.paused && !v.ended && v.readyState >= 3) {
      this.#open();
      this.#firstFrame(false);
    }
  }

  /** What SubtitleDB resolved, from the loader's onResolved. */
  context(ctx: Context): void {
    this.#ctx = { ...this.#ctx, ...ctx };
  }

  /** A line in the trace from outside the element: the loader's offer, for one. */
  record(kind: EventKind, detail: string): void {
    this.#note(kind, this.#now() - this.#t0, detail);
  }

  /** The subtitle SubtitleDB handed the player, from the loader's onSelected. */
  select(chosen: Chosen | null): void {
    this.#chosen = chosen;
    this.record(
      'track',
      chosen
        ? `SubtitleDB ${chosen.language} #${chosen.id}${chosen.source === 'ai' ? ' (AI)' : ''}`
        : 'off',
    );
    this.#reconcile();
  }

  /** The final snapshot, then let go of the element. */
  stop(): void {
    this.#close();
    for (const undo of this.#off.splice(0)) undo();
    const v = this.video as Watched;
    if (v[MARK] === this) delete v[MARK];
  }

  // ---- the element's events -------------------------------------------------

  #onSource(): void {
    const src = this.video.currentSrc || this.video.src || '';
    if (!src || src === this.#src) return;
    this.#src = src;
    this.record('source', describeSource(src));
  }

  #onMetadata(): void {
    const v = this.video;
    const d = v.duration;
    const length = d === Number.POSITIVE_INFINITY ? 'live' : Number.isFinite(d) ? clock(d) : '?';
    this.record('manifest', `${length}, ${v.videoWidth}x${v.videoHeight}`);
    this.#height = v.videoHeight || this.#height;
  }

  #onPlay(): void {
    if (!this.#play) this.#open();
    if (this.#intentAt === null) this.#intentAt = this.#now();
  }

  #onPlaying(): void {
    if (!this.#play) this.#open();
    this.#endStall();
    if (!this.#started) this.#firstFrame(true);
    else if (this.#resumed) this.record('playing', `at ${clock(this.video.currentTime)}`);
    this.#resumed = false;
    this.#reconcile();
  }

  #onTime(): void {
    const play = this.#play;
    const v = this.video;
    if (!play) return;
    const pos = v.currentTime;
    const from = this.#lastPos;
    // Some engines never send `playing` after a stall or even at the start; time
    // moving forward is the same news.
    if (pos > from && !v.paused && !v.seeking) {
      if (!this.#started) this.#firstFrame(true);
      else if (this.#stallSince !== null) this.#endStall();
    }
    if (this.#playingSince !== null && pos > from && pos - from < MAX_TICK_S) {
      // Every second the playhead passed through since the last tick, so a sparse
      // tick in a background tab misses none. 10.0 exactly has only finished second
      // 9. A bigger jump is a seek, and a seek's seconds were not watched.
      for (let s = Math.floor(from); s < Math.ceil(pos); s++) play.seconds.add(s);
      play.maxPos = Math.max(play.maxPos, Math.floor(pos));
    }
    this.#lastPos = pos;
    this.#reconcile();
    if (this.#started && this.#now() - this.#lastSentAt >= CADENCE_MS) this.#send(false);
  }

  #onWaiting(): void {
    const play = this.#play;
    if (!play || !this.#started || this.video.seeking || this.#stallSince !== null) return;
    this.#stallSince = this.#now();
    play.stalls++;
    this.record('stall_start', `at ${clock(this.video.currentTime)}`);
    this.#reconcile();
  }

  #onPause(): void {
    const play = this.#play;
    if (!play) return;
    this.#endStall();
    if (this.#started && !this.video.ended) {
      play.pauses++;
      this.#resumed = true;
      this.record('pause', `at ${clock(this.video.currentTime)}`);
    }
    this.#reconcile();
    if (this.#started && !this.video.ended) this.#send(false);
  }

  #onSeeking(): void {
    const play = this.#play;
    if (!play || !this.#started) return;
    this.#endStall();
    play.seeks++;
    this.record('seek', `${clock(this.#lastPos)} to ${clock(this.video.currentTime)}`);
    this.#lastPos = this.video.currentTime;
    this.#reconcile();
  }

  #onEnded(): void {
    if (!this.#play) return;
    this.#flag(FLAGS.ended);
    this.record('ended', `at ${clock(this.video.currentTime)}`);
    this.#close();
  }

  #onError(): void {
    if (!this.#play) this.#open();
    const play = this.#play;
    if (!play) return;
    const err = this.video.error;
    const code = err?.code ?? 0;
    play.error = Math.max(play.error, code);
    const label = MEDIA_ERRORS[code] ?? `code ${code}`;
    this.record('error', err?.message ? `${label}: ${err.message}` : label);
    this.#close();
  }

  #onResize(): void {
    const h = this.video.videoHeight;
    if (!h) return;
    if (this.#play && this.#started && this.#height && h !== this.#height) {
      this.record('level', `${this.#height}p to ${h}p`);
    }
    this.#height = h;
    if (this.#play) this.#play.maxHeight = Math.max(this.#play.maxHeight, h);
  }

  #onTracks(): void {
    const t = showingTrack(this.video);
    const id = t ? `${t.language}|${t.label}` : '';
    if (id === this.#track) return;
    this.#track = id;
    if (this.#play) this.#play.subSwitches++;
    this.record('track', t ? t.label || t.language || 'on' : 'off');
    this.#reconcile();
  }

  #onFullscreen(): void {
    const doc = this.#doc as (Document & { webkitFullscreenElement?: Element | null }) | null;
    const el = doc?.fullscreenElement ?? doc?.webkitFullscreenElement ?? null;
    if (el && (el === this.video || el.contains?.(this.video))) this.#flag(FLAGS.fullscreen);
  }

  // ---- plays ------------------------------------------------------------------

  #open(): void {
    if (plays >= MAX_PLAYS) return;
    const play = new Play(++plays, Math.floor(this.#epoch() / 1000));
    this.#play = play;
    this.#started = false;
    this.#resumed = false;
    this.#intentAt = null;
    this.#lastSentAt = Number.NEGATIVE_INFINITY;
    for (const e of this.#pending.splice(0)) play.events.push(e);
    const q = (this.video as Watched).getVideoPlaybackQuality?.();
    this.#base = { dropped: q?.droppedVideoFrames ?? 0, frames: q?.totalVideoFrames ?? 0 };
    const activation = (globalThis as { navigator?: { userActivation?: { isActive: boolean } } })
      .navigator?.userActivation;
    // Started with no click or key press in the last moments: autoplay, whether by
    // the attribute or by the page's own script.
    if (activation ? !activation.isActive : this.video.autoplay) this.#flag(FLAGS.autoplay);
  }

  #firstFrame(measured: boolean): void {
    const play = this.#play;
    if (!play) return;
    this.#started = true;
    play.flags |= FLAGS.started;
    const t = this.#now();
    // Whole milliseconds: the clock has finer steps, and the trace line must say
    // the number the report carries, which is always whole.
    play.startupMs =
      measured && this.#intentAt !== null ? Math.max(1, Math.round(t - this.#intentAt)) : 0;
    this.record('first_frame', play.startupMs ? `after ${play.startupMs} ms` : '');
    this.#lastPos = this.video.currentTime;
    this.#onResize();
    this.#checkMuted();
    this.#onTracks();
    this.#reconcile();
    this.#send(false, true);
  }

  /** Send what the open play has, if anything, and forget it. */
  #close(): void {
    if (!this.#play) return;
    this.#endStall();
    this.#reconcile(true);
    this.#send(true);
    this.#play = null;
    this.#started = false;
    this.#intentAt = null;
  }

  // ---- clocks -------------------------------------------------------------------

  #endStall(): void {
    const play = this.#play;
    if (!play || this.#stallSince === null) return;
    const ms = this.#now() - this.#stallSince;
    play.stallMs += ms;
    this.#stallSince = null;
    this.record('stall_end', `after ${(ms / 1000).toFixed(1)} s`);
  }

  /**
   * Start or stop the watch and subtitle clocks to match the element. Called after
   * every event, so no single event has to know which clock it affects.
   */
  #reconcile(stopAll = false): void {
    const play = this.#play;
    const v = this.video;
    const t = this.#now();
    const on =
      !stopAll &&
      play !== null &&
      this.#started &&
      !v.paused &&
      !v.ended &&
      !v.seeking &&
      this.#stallSince === null;
    if (on && this.#playingSince === null) this.#playingSince = t;
    if (!on && this.#playingSince !== null) {
      if (play) play.watchMs += t - this.#playingSince;
      this.#playingSince = null;
    }
    const sub = on && (this.#chosen !== null || showingTrack(v) !== null);
    if (sub && this.#subSince === null) this.#subSince = t;
    if (!sub && this.#subSince !== null) {
      if (play) play.subMs += t - this.#subSince;
      this.#subSince = null;
    }
  }

  #flag(bit: number): void {
    if (this.#play) this.#play.flags |= bit;
  }

  #checkMuted(): void {
    if (this.#play && this.#started && (this.video.muted || this.video.volume === 0)) {
      this.#flag(FLAGS.muted);
    }
  }

  #note(kind: EventKind, t: number, detail: string): void {
    if (this.#play) this.#play.note(kind, t, detail);
    else if (this.#pending.length < PENDING) {
      this.#pending.push({ k: kind, t: Math.max(0, Math.round(t)), d: detail.slice(0, 120) });
    }
  }

  // ---- sending ------------------------------------------------------------------

  /**
   * One snapshot of the open play. `last` marks one that could be the play's final
   * word, which is the only kind that carries the trace; `force` skips the gap.
   */
  #send(last: boolean, force = false): void {
    const play = this.#play;
    if (!play) return;
    const t = this.#now();
    if (!last && !force && t - this.#lastSentAt < MIN_GAP_MS) return;
    if (!last && play.seq >= MAX_SNAPSHOTS) return;

    // Fold the running clocks in without stopping them.
    if (this.#playingSince !== null) {
      play.watchMs += t - this.#playingSince;
      this.#playingSince = t;
    }
    if (this.#subSince !== null) {
      play.subMs += t - this.#subSince;
      this.#subSince = t;
    }
    const v = this.video as Watched;
    const q = v.getVideoPlaybackQuality?.();
    if (q) {
      play.dropped = Math.max(play.dropped, q.droppedVideoFrames - this.#base.dropped);
      play.frames = Math.max(play.frames, q.totalVideoFrames - this.#base.frames);
    }
    const d = v.duration;
    const live = d === Number.POSITIVE_INFINITY;
    const shown = showingTrack(v);
    const chosen = this.#chosen;
    let audio = '';
    for (let i = 0; i < (v.audioTracks?.length ?? 0); i++) {
      const a = v.audioTracks?.[i];
      if (a?.enabled) audio = a.language;
    }
    const where = (globalThis as { location?: Location }).location;

    const snap: Snapshot = {
      v: 1,
      k: this.#o.key,
      l: this.#o.loadId,
      p: play.no,
      s: play.seq,
      ps: play.startedAt,
      u: this.#o.visitor,
      pa: where ? `${where.pathname}${where.search}` : '',
      im: this.#ctx.imdb ?? 0,
      tm: this.#ctx.tmdb ?? 0,
      se: this.#ctx.season ?? 0,
      ep: this.#ctx.episode ?? 0,
      du: live || !Number.isFinite(d) ? 0 : Math.round(d),
      li: live ? 1 : 0,
      st: play.startupMs,
      wa: play.watchMs,
      un: play.seconds.count,
      mp: play.maxPos,
      sk: play.seeks,
      pu: play.pauses,
      sn: play.stalls,
      sm: play.stallMs + (this.#stallSince === null ? 0 : t - this.#stallSince),
      er: play.error,
      mh: play.maxHeight,
      dr: play.dropped,
      fr: play.frames,
      fl: play.flags,
      pl: this.#ctx.player ?? '',
      ss: chosen ? chosen.source : shown ? 'page' : '',
      sl: chosen ? chosen.language : (shown?.language ?? ''),
      sb: play.subMs,
      sw: play.subSwitches,
      si: chosen?.id ?? 0,
      al: audio,
    };
    if (last && this.#o.sender.wantsTrace(play.problem, this.#o.loadId, play.no)) {
      snap.ev = play.events;
    }
    play.seq++;
    this.#lastSentAt = t;
    this.#o.sender.send(encode(snap), `${this.#o.loadId}:${play.no}`);
  }
}

/** Test seam: play numbers start again from 1. */
export function resetPlays(): void {
  plays = 0;
}
