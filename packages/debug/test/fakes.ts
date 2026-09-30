/**
 * A media element, a clock and a network, enough to drive the collector through
 * the event sequences a browser produces.
 *
 * The element is an EventTarget with the properties the collector reads and
 * nothing else. The sequences below follow the HTML media spec's order of events,
 * which is what the collector's rules are written against: `play` before
 * `playing`, `pause` before `ended`, `seeking` before `seeked`.
 */
import { Collector } from '../src/collector.js';
import { Sender } from '../src/send.js';
import type { Snapshot } from '../src/snapshot.js';

export const KEY = 'sdbg_abcdefghijklmnopqrstuvwx';
export const LOAD = '0A1B2C3D4E5F6071';
export const EPOCH0 = 1_790_000_000_000;

export class FakeVideo extends EventTarget {
  readonly tagName = 'VIDEO';
  readonly nodeName = 'VIDEO';
  currentSrc = 'https://media.example.test/films/matrix.mp4?token=s3cret#t=5';
  src = '';
  currentTime = 0;
  duration = Number.NaN;
  paused = true;
  ended = false;
  seeking = false;
  readyState = 0;
  videoWidth = 0;
  videoHeight = 0;
  muted = false;
  volume = 1;
  playbackRate = 1;
  autoplay = false;
  isConnected = true;
  error: { code: number; message: string } | null = null;
  readonly textTracks = Object.assign(new EventTarget(), {
    length: 0,
  }) as unknown as TextTrackList &
    Record<number, { kind: string; mode: string; label: string; language: string }>;
  quality = { droppedVideoFrames: 0, totalVideoFrames: 0 };

  getVideoPlaybackQuality() {
    return this.quality;
  }

  emit(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}

/** A Storage in memory, with a switch that makes every call throw. */
export function memoryStorage(): Storage & { map: Map<string, string>; broken: boolean } {
  const map = new Map<string, string>();
  const s = {
    map,
    broken: false,
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem(k: string) {
      if (s.broken) throw new Error('SecurityError');
      return map.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      if (s.broken) throw new Error('QuotaExceededError');
      map.set(k, String(v));
    },
    removeItem(k: string) {
      map.delete(k);
    },
    clear() {
      map.clear();
    },
  };
  return s;
}

export interface Rig {
  video: FakeVideo;
  collector: Collector;
  sender: Sender;
  storage: ReturnType<typeof memoryStorage>;
  /** Every body posted, parsed, in order. */
  sent: Snapshot[];
  /** And the raw bodies with the fetch options they went with. */
  posts: { url: string; init: RequestInit }[];
  /** What the next answer says in x-sdb-trace, or null for no header. */
  answer: { rule: string | null; ok: boolean; fail: boolean };
  doc: EventTarget & { visibilityState: string; fullscreenElement: unknown };
  win: EventTarget;
  advance(ms: number): void;
  now(): number;
  /** Let the fetch promises settle. */
  settle(): Promise<void>;
}

export function rig(setup: (v: FakeVideo) => void = () => {}): Rig {
  let clock = 1000;
  const video = new FakeVideo();
  setup(video);
  const storage = memoryStorage();
  const sent: Snapshot[] = [];
  const posts: { url: string; init: RequestInit }[] = [];
  const answer = { rule: null as string | null, ok: true, fail: false };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    posts.push({ url, init });
    sent.push(JSON.parse(String(init.body)));
    if (answer.fail) throw new TypeError('Failed to fetch');
    return {
      ok: answer.ok,
      status: answer.ok ? 204 : 500,
      headers: new Headers(answer.rule === null ? {} : { 'x-sdb-trace': answer.rule }),
    } as Response;
  }) as unknown as typeof fetch;
  const sender = new Sender({ fetch: fetchImpl, storage, epoch: () => EPOCH0 + clock });
  const doc = Object.assign(new EventTarget(), {
    visibilityState: 'visible',
    fullscreenElement: null,
  });
  const win = new EventTarget();
  const collector = new Collector(video as unknown as HTMLVideoElement, {
    key: KEY,
    loadId: LOAD,
    visitor: 'CAFEBABE0000FEED',
    sender,
    now: () => clock,
    epoch: () => EPOCH0 + clock,
    doc: doc as unknown as Document,
    win: win as unknown as Window,
  });
  return {
    video,
    collector,
    sender,
    storage,
    sent,
    posts,
    answer,
    doc,
    win,
    advance(ms) {
      clock += ms;
    },
    now: () => clock,
    settle: () => new Promise((r) => setTimeout(r, 0)),
  };
}

// ---- what a browser does, in the order it does it ----------------------------------

export function load(r: Rig, duration = 600, height = 720): void {
  const v = r.video;
  v.emit('loadstart');
  v.duration = duration;
  v.videoWidth = Math.round((height * 16) / 9);
  v.videoHeight = height;
  v.readyState = 4;
  v.emit('loadedmetadata');
}

/** Press play, wait `startupMs`, first frame. */
export function play(r: Rig, startupMs = 500): void {
  const v = r.video;
  v.paused = false;
  v.ended = false;
  v.emit('play');
  r.advance(startupMs);
  v.emit('playing');
}

/** Play forward `seconds` of media in real time, ticking as a browser does. */
export function playFor(r: Rig, seconds: number): void {
  const v = r.video;
  for (let i = 0; i < seconds * 4; i++) {
    r.advance(250);
    v.currentTime += 0.25;
    v.emit('timeupdate');
  }
}

export function pause(r: Rig): void {
  r.video.paused = true;
  r.video.emit('pause');
}

export function resume(r: Rig): void {
  r.video.paused = false;
  r.video.emit('play');
  r.video.emit('playing');
}

export function seek(r: Rig, to: number, bufferMs = 0): void {
  const v = r.video;
  v.seeking = true;
  v.currentTime = to;
  v.emit('seeking');
  if (bufferMs) {
    v.emit('waiting');
    r.advance(bufferMs);
  }
  v.seeking = false;
  v.emit('seeked');
  if (!v.paused) v.emit('playing');
}

export function stall(r: Rig, ms: number): void {
  r.video.emit('waiting');
  r.advance(ms);
  r.video.emit('playing');
}

/** The duration moves on, as an MSE player's does when it appends past the old end. */
export function grow(r: Rig, by: number): void {
  r.video.duration += by;
  r.video.emit('durationchange');
}

export function end(r: Rig): void {
  const v = r.video;
  v.currentTime = v.duration;
  v.paused = true;
  v.ended = true;
  v.emit('pause');
  v.emit('ended');
}

export function hide(r: Rig): void {
  r.doc.visibilityState = 'hidden';
  r.doc.dispatchEvent(new Event('visibilitychange'));
}

export interface FakeTrack {
  kind: string;
  mode: string;
  label: string;
  language: string;
}

type TrackList = Record<number, FakeTrack | undefined> & { length: number };

/** A subtitle track on the element, as a player adds one. */
export function addTrack(r: Rig, language: string, label = language): FakeTrack {
  const list = r.video.textTracks as unknown as TrackList;
  const t = { kind: 'subtitles', mode: 'disabled', label, language };
  list[list.length] = t;
  list.length++;
  return t;
}

/** Show one track and hide the rest, or hide them all, as a player menu does. */
export function showTrack(r: Rig, track: FakeTrack | null): void {
  const list = r.video.textTracks as unknown as TrackList;
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t) t.mode = t === track ? 'showing' : 'disabled';
  }
  r.video.textTracks.dispatchEvent(new Event('change'));
}

/** Take a track off the element, as a player does when it lets go of a subtitle. */
export function removeTrack(r: Rig, track: FakeTrack): void {
  const list = r.video.textTracks as unknown as TrackList;
  const kept: FakeTrack[] = [];
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t && t !== track) kept.push(t);
    list[i] = undefined;
  }
  kept.forEach((t, i) => {
    list[i] = t;
  });
  list.length = kept.length;
  r.video.textTracks.dispatchEvent(new Event('removetrack'));
}

export const last = (r: Rig): Snapshot => {
  const s = r.sent[r.sent.length - 1];
  if (!s) throw new Error('nothing sent');
  return s;
};
