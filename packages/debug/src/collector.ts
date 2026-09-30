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
 * hidden, the page going away, and an autoplay the browser refused. On a phone a
 * hidden tab is often discarded without another event, so hidden counts as a
 * possible end. About four per play.
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
/** Times a duration must grow, by a second or more, after the first frame to be a live window. */
const LIVE_AFTER_GROWING = 2;
/** How long an autoplay that could play through may sit paused at the start before it counts as refused. */
const BLOCKED_AFTER_MS = 800;
/** Dropped frames within one window of playback that make a line in the trace. */
const FRAMES_BURST = 30;
const FRAMES_WINDOW_MS = 5000;

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
  audioTracks?: ArrayLike<{ enabled: boolean; language: string }> & Partial<EventTarget>;
  remote?: EventTarget;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
};

/** The ways a video leaves the page's own box, each a flag and a line in the trace. */
type Mode = 'fullscreen' | 'pip' | 'cast';

/** A subtitle on screen: where it came from, its language, its SubtitleDB id, and how the trace names it. */
interface Shown {
  src: string;
  lang: string;
  id: number;
  text: string;
}

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

function listed(v: HTMLVideoElement, track: TextTrack): boolean {
  const list = v.textTracks as TextTrackList | undefined;
  for (let i = 0; i < (list?.length ?? 0); i++) if (list?.[i] === track) return true;
  return false;
}

function audioLanguage(v: Watched): string {
  let lang = '';
  for (let i = 0; i < (v.audioTracks?.length ?? 0); i++) {
    const a = v.audioTracks?.[i];
    if (a?.enabled) lang = a.language;
  }
  return lang;
}

export class Collector {
  #play: Play | null = null;
  readonly #t0: number;
  #pending: TraceEvent[] = [];
  #ctx: Context = {};
  #chosen: Chosen | null = null;
  /**
   * The text track SubtitleDB's pick shows in, when the player shows it in one. Its
   * mode is how a viewer turning it off can be seen. A player that draws subtitles
   * itself has none, and its pick is taken to stay on until the next.
   */
  #own: TextTrack | null = null;
  /** How the trace named what was on screen last; '' for nothing. */
  #shown = '';
  #src = '';
  #intentAt: number | null = null;
  #started = false;
  #resumed = false;
  #stallSince: number | null = null;
  #lastPos = 0;
  #lastSentAt = Number.NEGATIVE_INFINITY;
  #height = 0;
  /** The duration when last seen, to tell a live window moving on from a film. */
  #dur = Number.NaN;
  #base = { dropped: 0, frames: 0 };
  /** Where the last look for a burst of dropped frames left off. */
  #burst = { at: 0, dropped: 0, frames: 0 };
  #blockTimer: ReturnType<typeof setTimeout> | undefined;
  #rate: number;
  #quiet: boolean;
  #audio: string;
  readonly #modes: Record<Mode, boolean> = { fullscreen: false, pip: false, cast: false };
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
    this.#rate = v.playbackRate;
    this.#quiet = v.muted || v.volume === 0;
    this.#audio = audioLanguage(v);
    const on = (target: Partial<EventTarget> | null | undefined, type: string, fn: () => void) => {
      if (!target?.addEventListener) return;
      const safe = () => {
        try {
          fn();
        } catch {
          // Never into the host page. See the note at the top.
        }
      };
      target.addEventListener(type, safe);
      this.#off.push(() => target.removeEventListener?.(type, safe));
    };

    on(v, 'loadstart', () => this.#onSource());
    on(v, 'emptied', () => this.#close());
    on(v, 'loadedmetadata', () => this.#onMetadata());
    on(v, 'durationchange', () => this.#onDuration());
    on(v, 'canplay', () => this.#armBlocked());
    on(v, 'canplaythrough', () => this.#armBlocked());
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
    on(v, 'ratechange', () => this.#onRate());
    on(v, 'volumechange', () => this.#onVolume());
    on(v, 'enterpictureinpicture', () => this.#mode('pip', true));
    on(v, 'leavepictureinpicture', () => this.#mode('pip', false));
    on(v, 'webkitbeginfullscreen', () => this.#mode('fullscreen', true));
    on(v, 'webkitendfullscreen', () => this.#mode('fullscreen', false));
    on(v, 'webkitcurrentplaybacktargetiswirelesschanged', () =>
      this.#mode('cast', !!v.webkitCurrentPlaybackTargetIsWireless),
    );
    on(v.remote, 'connect', () => this.#mode('cast', true));
    on(v.remote, 'disconnect', () => this.#mode('cast', false));
    on(v.textTracks as unknown as EventTarget, 'change', () => this.#onSubtitle());
    on(v.textTracks as unknown as EventTarget, 'removetrack', () => this.#onSubtitle());
    on(v.audioTracks, 'change', () => this.#onAudio());
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
    } else if (v.readyState >= 3) {
      this.#armBlocked();
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
    // The player has just shown it, so a track showing now in its language is its track.
    const t = chosen ? showingTrack(this.video) : null;
    this.#own = t && t.language === chosen?.language ? t : null;
    this.#onSubtitle();
  }

  /** The final snapshot, then let go of the element. */
  stop(): void {
    clearTimeout(this.#blockTimer);
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
    // A new source can be refused autoplay afresh.
    clearTimeout(this.#blockTimer);
    this.#blockTimer = undefined;
  }

  #onMetadata(): void {
    const v = this.video;
    const d = v.duration;
    const length = d === Number.POSITIVE_INFINITY ? 'live' : Number.isFinite(d) ? clock(d) : '?';
    this.record('manifest', `${length}, ${v.videoWidth}x${v.videoHeight}`);
    this.#height = v.videoHeight || this.#height;
  }

  /**
   * A live stream usually says so with an infinite duration. hls.js, by default, and
   * players built the same way give it a finite one instead: the end of the window so
   * far, moved on at each playlist refresh. A film's duration is set before it plays
   * and at most corrected once near the end, so one that keeps growing is live.
   */
  #onDuration(): void {
    const play = this.#play;
    const d = this.video.duration;
    if (!play || !this.#started || !Number.isFinite(d)) return;
    if (d >= this.#dur + 1) {
      play.grew++;
      if (play.grew >= LIVE_AFTER_GROWING) play.live = true;
    }
    this.#dur = d;
  }

  /**
   * A refused autoplay fires no event at all: the element just stays paused at the
   * start. So once it could play through, which is when an allowed autoplay begins,
   * wait a moment and look. A play() from the page's own script that the browser
   * refuses cannot be seen from here.
   */
  #armBlocked(): void {
    if (!this.video.autoplay || this.#started || this.#blockTimer) return;
    this.#blockTimer = setTimeout(() => {
      this.#blockTimer = undefined;
      try {
        this.#checkBlocked();
      } catch {
        // Never into the host page.
      }
    }, BLOCKED_AFTER_MS);
  }

  #checkBlocked(): void {
    const v = this.video;
    if (this.#started || !v.paused || v.ended || v.currentTime > 0 || v.readyState < 4) return;
    if (!this.#play) this.#open();
    const play = this.#play;
    if (!play || play.flags & FLAGS.blocked) return;
    play.flags |= FLAGS.blocked;
    this.record('blocked', 'autoplay refused');
    // The viewer may never press play, so this could be the play's last word.
    this.#send(true);
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
    if (play.watch.since !== null && pos > from && pos - from < MAX_TICK_S) {
      // Every second the playhead passed through since the last tick, so a sparse
      // tick in a background tab misses none. 10.0 exactly has only finished second
      // 9. A bigger jump is a seek, and a seek's seconds were not watched.
      for (let s = Math.floor(from); s < Math.ceil(pos); s++) play.seconds.add(s);
      play.maxPos = Math.max(play.maxPos, Math.floor(pos));
      this.#checkFrames();
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
    const play = this.#play;
    if (!h) return;
    if (play && this.#started && this.#height && h !== this.#height) {
      this.record('level', `${this.#height}p to ${h}p`);
      if (h < this.#height) play.picDowns++;
    }
    this.#height = h;
    if (play) play.maxHeight = Math.max(play.maxHeight, h);
    this.#reconcile();
  }

  #onRate(): void {
    const r = this.video.playbackRate;
    if (r === this.#rate) return;
    this.#rate = r;
    this.record('rate', `${Math.round(r * 100) / 100}x`);
    if (r !== 1) this.#flag(FLAGS.rate);
  }

  #onVolume(): void {
    const v = this.video;
    const quiet = v.muted || v.volume === 0;
    if (quiet !== this.#quiet) {
      this.#quiet = quiet;
      this.record('volume', quiet ? 'muted' : `on at ${Math.round(v.volume * 100)}%`);
    }
    this.#checkMuted();
  }

  #onAudio(): void {
    const lang = audioLanguage(this.video as Watched);
    if (lang === this.#audio) return;
    this.#audio = lang;
    this.record('audio', lang || 'no language');
  }

  #onFullscreen(): void {
    const doc = this.#doc as (Document & { webkitFullscreenElement?: Element | null }) | null;
    const el = doc?.fullscreenElement ?? doc?.webkitFullscreenElement ?? null;
    this.#mode('fullscreen', !!el && (el === this.video || !!el.contains?.(this.video)));
  }

  #mode(mode: Mode, on: boolean): void {
    if (this.#modes[mode] === on) return;
    this.#modes[mode] = on;
    this.record(mode, on ? 'on' : 'off');
    if (on) this.#flag(FLAGS[mode]);
  }

  /**
   * What is on screen: SubtitleDB's pick while its track shows, or while it has no
   * track to watch; otherwise a showing track of the page's own; otherwise nothing.
   */
  #onScreen(): Shown | null {
    const c = this.#chosen;
    const own = this.#own;
    const v = this.video;
    if (c && (!own || (own.mode === 'showing' && listed(v, own)))) {
      const text = `SubtitleDB ${c.language} #${c.id}${c.source === 'ai' ? ' (AI)' : ''}`;
      return { src: c.source, lang: c.language, id: c.id, text };
    }
    const t = showingTrack(v);
    return t ? { src: 'page', lang: t.language, id: 0, text: t.label || t.language || 'on' } : null;
  }

  /**
   * The subtitle on screen may have changed. A change is a line in the trace, and a
   * switch once the play has started: turning subtitles on, off, or to another.
   */
  #onSubtitle(): void {
    const text = this.#onScreen()?.text ?? '';
    if (text === this.#shown) return;
    this.#shown = text;
    if (this.#play && this.#started) this.#play.subSwitches++;
    this.record('track', text || 'off');
    this.#reconcile();
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
    // Where this play starts. Left where the last one ended, a replay on an engine that
    // never says `playing` would not be seen to start until it got that far again.
    this.#lastPos = this.video.currentTime;
    for (const e of this.#pending.splice(0)) play.events.push(e);
    const q = (this.video as Watched).getVideoPlaybackQuality?.();
    this.#base = { dropped: q?.droppedVideoFrames ?? 0, frames: q?.totalVideoFrames ?? 0 };
    const activation = (globalThis as { navigator?: { userActivation?: { isActive: boolean } } })
      .navigator?.userActivation;
    // Started with no click or key press in the last moments: autoplay, whether by
    // the attribute or by the page's own script.
    if (activation ? !activation.isActive : this.video.autoplay) this.#flag(FLAGS.autoplay);
    // Whatever was already so before this play opened is so for it too.
    for (const mode of Object.keys(this.#modes) as Mode[]) {
      if (this.#modes[mode]) this.#flag(FLAGS[mode]);
    }
    if (this.#rate !== 1) this.#flag(FLAGS.rate);
  }

  #firstFrame(measured: boolean): void {
    const play = this.#play;
    if (!play) return;
    // What is on screen as the play begins is where it starts, not a switch.
    this.#onSubtitle();
    this.#started = true;
    play.flags |= FLAGS.started;
    const t = this.#now();
    // Whole milliseconds: the clock has finer steps, and the trace line must say
    // the number the report carries, which is always whole.
    play.startupMs =
      measured && this.#intentAt !== null ? Math.max(1, Math.round(t - this.#intentAt)) : 0;
    this.record('first_frame', play.startupMs ? `after ${play.startupMs} ms` : '');
    this.#lastPos = this.video.currentTime;
    this.#dur = this.video.duration;
    const q = (this.video as Watched).getVideoPlaybackQuality?.();
    this.#burst = { at: t, dropped: q?.droppedVideoFrames ?? 0, frames: q?.totalVideoFrames ?? 0 };
    this.#onResize();
    this.#checkMuted();
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
   * Start or stop the play's clocks to match the element. Called after every event,
   * so no single event has to know which clock it affects.
   */
  #reconcile(stopAll = false): void {
    const play = this.#play;
    if (!play) return;
    const v = this.video;
    const t = this.#now();
    const on =
      !stopAll && this.#started && !v.paused && !v.ended && !v.seeking && this.#stallSince === null;
    play.watch.set(on, t);
    const shown = on ? this.#onScreen() : null;
    play.sub.set(shown !== null, t);
    if (shown) {
      play.subSource = shown.src;
      play.subLang = shown.lang;
      play.subId = shown.id;
    }
    play.low.set(on && this.#height > 0 && this.#height < play.maxHeight, t);
  }

  /** A burst of dropped frames: FRAMES_BURST or more within one window of playback. */
  #checkFrames(): void {
    const t = this.#now();
    const b = this.#burst;
    if (t - b.at < FRAMES_WINDOW_MS) return;
    const q = (this.video as Watched).getVideoPlaybackQuality?.();
    if (!q) return;
    const n = q.droppedVideoFrames - b.dropped;
    if (n >= FRAMES_BURST) {
      const of = q.totalVideoFrames - b.frames;
      this.record('frames', `${n} of ${of} dropped by ${clock(this.video.currentTime)}`);
    }
    this.#burst = { at: t, dropped: q.droppedVideoFrames, frames: q.totalVideoFrames };
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

    const v = this.video as Watched;
    const q = v.getVideoPlaybackQuality?.();
    if (q) {
      play.dropped = Math.max(play.dropped, q.droppedVideoFrames - this.#base.dropped);
      play.frames = Math.max(play.frames, q.totalVideoFrames - this.#base.frames);
    }
    const d = v.duration;
    const live = play.live || d === Number.POSITIVE_INFINITY;
    const du = live || !Number.isFinite(d) ? 0 : Math.round(d);
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
      du,
      li: live ? 1 : 0,
      st: play.startupMs,
      wa: play.watch.read(t),
      un: play.seconds.count,
      mp: play.maxPos,
      cv: play.seconds.parts(du),
      sk: play.seeks,
      pu: play.pauses,
      sn: play.stalls,
      sm: play.stallMs + (this.#stallSince === null ? 0 : t - this.#stallSince),
      er: play.error,
      mh: play.maxHeight,
      qd: play.picDowns,
      ql: play.low.read(t),
      dr: play.dropped,
      fr: play.frames,
      fl: play.flags,
      pl: this.#ctx.player ?? '',
      ss: play.subSource,
      sl: play.subLang,
      sb: play.sub.read(t),
      sw: play.subSwitches,
      si: play.subId,
      al: audioLanguage(v),
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
