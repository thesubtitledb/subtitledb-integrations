import { SubtitleDbClient } from '@subtitledb/core';
import { bundleSubtitle, movieBundle, stubFetch } from '../../core/test/fixtures.js';
import { BINDINGS } from '../src/index.js';
import { findVideo } from '../src/probe.js';

/**
 * Fake players, shaped from each library's public surface.
 *
 * A fake proves the binding picks the right object and calls the right method. It
 * cannot prove the real player accepts the call, which is what the Playwright run
 * over examples/players.html is for, against the real libraries in a real browser.
 */

export const blobs: string[] = [];
export const revoked: string[] = [];

export function fakeVideo(src = 'https://cdn.test/The.Matrix.1999.1080p.BluRay.x264-AMIABLE.mkv') {
  const children: unknown[] = [];
  const listeners = new Map<string, (() => void)[]>();
  return {
    tagName: 'VIDEO',
    currentSrc: src,
    src: '',
    readyState: 0,
    textTracks: [],
    children,
    append(el: unknown) {
      (el as { parent?: unknown[] }).parent = children;
      children.push(el);
    },
    querySelector: () => null,
    addEventListener(type: string, fn: () => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((f) => f !== fn),
      );
    },
    emit(type: string) {
      for (const fn of listeners.get(type) ?? []) fn();
    },
  } as unknown as HTMLVideoElement & { children: unknown[]; emit(t: string): void };
}

export function installDom() {
  const tracks: { src: string; label: string; srclang: string; track: { mode: string } }[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    // identify() scrapes the page for og: and JSON-LD when no hint is given, so a
    // document that cannot be queried is not a realistic fake.
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement(tag: string) {
      if (tag !== 'track') throw new Error(`unexpected element ${tag}`);
      const el = {
        kind: '',
        label: '',
        srclang: '',
        src: '',
        track: { mode: 'disabled' },
        parent: undefined as unknown[] | undefined,
        remove() {
          const at = this.parent?.indexOf(this) ?? -1;
          if (at >= 0) this.parent?.splice(at, 1);
        },
        addEventListener() {},
      };
      tracks.push(el);
      return el;
    },
  };
  g.Blob = class {
    constructor(readonly parts: string[]) {}
  };
  const url = globalThis.URL as unknown as Record<string, unknown>;
  url.createObjectURL = (b: { parts: string[] }) => {
    const u = `blob:${blobs.length}`;
    blobs.push(b.parts.join(''));
    return u;
  };
  url.revokeObjectURL = (u: string) => {
    revoked.push(u);
  };
  return tracks;
}

export const SRT = '1\n00:00:01,000 --> 00:00:02,000\nWake up, Neo.\n';

/**
 * True for a player that owns its text tracks.
 *
 * The two paths differ in when the first resolve happens, and a test that hides that
 * behind an explicit refresh() cannot see it disappear: the api path used to never
 * resolve on its own at all.
 */
export const ownsTracks = (name: string): boolean =>
  Boolean(BINDINGS.find((b) => b.name === name)?.api);

export function client() {
  const { fetch, calls } = stubFetch([
    {
      match: /by-imdb/,
      body: movieBundle([
        bundleSubtitle({ id: 1, language: 'en', format: 'srt' }),
        bundleSubtitle({ id: 2, language: 'fr', format: 'ass' }),
        bundleSubtitle({ id: 3, language: 'de', format: 'sub' }),
        bundleSubtitle({ id: 4, language: 'en', format: 'ass' }),
        bundleSubtitle({ id: 5, language: 'fr', format: 'srt' }),
      ]),
    },
    { match: /\/get\/1$/, text: SRT },
  ]);
  return { client: new SubtitleDbClient({ fetch, retries: 0 }), calls };
}

// Shapes taken from each library's documented surface. Kept in one place so a
// binding that starts matching two players shows up as a detection test failure.
export const FAKES: Record<string, () => unknown> = {
  videojs: () => {
    const remote: { track: { mode: string } }[] = [];
    const media = fakeVideo();
    return {
      __got: remote,
      addRemoteTextTrack: (opts: unknown) => {
        const entry = { ...(opts as object), track: { mode: 'disabled' } };
        remote.push(entry);
        return entry;
      },
      removeRemoteTextTrack: (t: unknown) => {
        const at = remote.indexOf(t as (typeof remote)[number]);
        if (at >= 0) remote.splice(at, 1);
      },
      remoteTextTracks: () => Object.assign([...remote], { length: remote.length }),
      textTracks: () => Object.assign([...remote.map((r) => r.track)], { length: remote.length }),
      el: () => ({ querySelector: () => media }),
      on: () => {},
      off: () => {},
    };
  },
  // Shaka 5. It dropped setTextTrackVisibility and kept setTextVisibility, which is
  // the branch the shipped library actually takes. Version 4 is covered separately.
  shaka: () => {
    const got: unknown[] = [];
    const media = fakeVideo();
    return {
      __got: got,
      addTextTrackAsync: async (url: string) => {
        got.push(url);
        return { id: got.length };
      },
      selectTextTrack: () => {},
      setTextVisibility: () => {},
      getTextTracks: () => [],
      getMediaElement: () => media,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  },
  vidstack: () => {
    // The real TextTrackList.add appends and returns the list, which is what the
    // binding's "take the one just appended" depends on.
    const tracks = [] as unknown[] & { add?: unknown; remove?: unknown };
    Object.assign(tracks, {
      add: (init: unknown) => {
        tracks.push({ ...(init as object), mode: 'disabled' });
        return tracks;
      },
      remove: (t: unknown) => {
        const at = tracks.indexOf(t);
        if (at >= 0) tracks.splice(at, 1);
      },
    });
    return { tagName: 'MEDIA-PLAYER', el: fakeVideo(), startLoading: () => {}, textTracks: tracks };
  },
  bitmovin: () => {
    const list: { id?: string }[] = [];
    const media = fakeVideo();
    return {
      __got: list,
      subtitles: {
        add: (t: { id?: string }) => list.push(t),
        enable: () => {},
        remove: (id: string) => {
          const at = list.findIndex((t) => t.id === id);
          if (at >= 0) list.splice(at, 1);
        },
        list: () => list,
      },
      getVideoElement: () => media,
    };
  },
  jwplayer: () => {
    const media = fakeVideo();
    return {
      getCaptionsList: () => [],
      setCurrentCaptions: () => {},
      getContainer: () => ({ querySelector: () => media }),
    };
  },
  // A real THEOplayer always has a source once it is playing anything, and the
  // binding publishes by rewriting it. A fake without one made every assertion pass
  // while the player received nothing at all.
  theoplayer: () => ({
    textTracks: [] as unknown[],
    play: () => {},
    element: fakeVideo(),
    source: { sources: [{ src: 'https://cdn.test/stream.m3u8' }], textTracks: [] as unknown[] },
  }),
  plyr: () => ({ media: fakeVideo(), toggleCaptions: () => {}, currentTrack: -1 }),
  dplayer: () => ({ video: fakeVideo(), seek: () => {}, notice: () => {} }),
  clappr: () => ({
    core: { activePlayback: { el: fakeVideo() } },
    getPlugin: () => {},
    play: () => {},
  }),
  xgplayer: () => ({ video: fakeVideo(), root: {}, play: () => {} }),
  mediaelement: () => ({ media: { originalNode: fakeVideo() }, setPlayerSize: () => {} }),
  openplayerjs: () => {
    const media = fakeVideo();
    return { getMedia: () => ({}), getElement: () => media };
  },
  mediachrome: () => {
    const media = fakeVideo();
    return { tagName: 'MEDIA-CONTROLLER', querySelector: () => media };
  },
  // ArtPlayer keeps one subtitle at a time, in template.$track, and replaces that
  // element on every switch. The fake models exactly that, so "the player is holding
  // a track" and "clear took it back" are both read off the same one slot.
  artplayer: () => {
    const got: unknown[] = [];
    const template: Record<string, unknown> = {
      $video: fakeVideo(),
      $track: undefined,
      $subtitle: { innerHTML: '' },
    };
    return {
      __got: got,
      on: () => {},
      off: () => {},
      template,
      setting: { add: () => {} },
      subtitle: {
        show: false,
        switch(url: string, opt?: Record<string, unknown>) {
          got.length = 0;
          got.push({ url, ...opt });
          template.$track = {
            src: url,
            remove() {
              got.length = 0;
              template.$track = undefined;
            },
          };
        },
      },
    };
  },
  // Flowplayer wraps a container element and renders through native tracks, so the
  // binding reaches its video through the probe rather than a named property.
  flowplayer: () => {
    const media = fakeVideo();
    return { setOpts: () => {}, togglePlay: () => {}, root: { querySelector: () => media } };
  },
  native: () => fakeVideo(),
};

/**
 * What a fake player received, however that player stores it.
 *
 * Every binding is asserted through this rather than through its own call log, so
 * "the option was honoured" and "the player got a track" are separate claims and the
 * second one cannot be satisfied by the adapter talking to itself.
 */
export function published(target: unknown): unknown[] {
  const own = (target as { __got?: unknown[] }).__got;
  if (own) return own;

  const source = (target as { source?: { textTracks?: unknown[] } }).source;
  if (source?.textTracks) return source.textTracks;

  // A bare media element is handed <track> children. Its own textTracks list is the
  // browser's live mirror of those children, which a fake cannot maintain, so read
  // the children for a video and the list for players that own their text tracks.
  const video = findVideo(target) as unknown as { children?: unknown[] } | null;
  if ((target as { tagName?: string }).tagName === 'VIDEO') return video?.children ?? [];

  const tracks = (target as { textTracks?: unknown }).textTracks;
  if (Array.isArray(tracks)) return tracks;

  return video?.children ?? [];
}

/** Recorders are module state, so every test file resets them itself. */
export function resetFakes(): void {
  blobs.length = 0;
  revoked.length = 0;
}

/** Undo installDom(), which puts a document on globalThis. */
export function clearDom(): void {
  (globalThis as unknown as Record<string, unknown>).document = undefined;
}
