import { createSession, SubtitleDbClient } from '@subtitledb/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleSubtitle, movieBundle, stubFetch } from '../../core/test/fixtures.js';
import { attachSubtitleDb } from '../src/index.js';

/**
 * A DOM shim rather than jsdom.
 *
 * Only five DOM behaviours matter to this adapter: creating a track, appending and
 * removing it, reading `track.mode`, and minting a blob URL. A shim covers those in
 * fifty lines with no dependency, and the parts a shim cannot honestly stand in for,
 * cue parsing and actual rendering, are covered by the Playwright run in a real
 * browser. A jsdom track element does not parse cues either, so the dependency would
 * buy confidence it cannot actually provide.
 */

interface FakeTrack {
  kind: string;
  label: string;
  srclang: string;
  src: string;
  track: { mode: string };
  remove(): void;
  addEventListener(type: string, fn: () => void, opts?: { once?: boolean }): void;
}

const blobs: string[] = [];
let revoked: string[] = [];

type FakeVideo = HTMLVideoElement & {
  emit(type: string): void;
  children: FakeTrack[];
  textTracks: TextTrackList & { emitChange(): void };
};

function installDom(): { video: FakeVideo; tracks: FakeTrack[] } {
  const tracks: FakeTrack[] = [];
  const children: FakeTrack[] = [];

  const g = globalThis as unknown as Record<string, unknown>;
  g.document = {
    createElement(tag: string) {
      if (tag !== 'track') throw new Error(`unexpected element ${tag}`);
      const el: FakeTrack = {
        kind: '',
        label: '',
        srclang: '',
        src: '',
        track: { mode: 'disabled' },
        remove() {
          const i = children.indexOf(el);
          if (i >= 0) children.splice(i, 1);
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
  // Only the two object-URL statics are stubbed. Replacing the whole URL global
  // breaks `new URL()` inside the client, which is how the first version of this
  // shim silently turned every request into a transport error.
  const url = globalThis.URL as unknown as Record<string, unknown>;
  url.createObjectURL = (b: { parts: string[] }) => {
    const u = `blob:${blobs.length}`;
    blobs.push(b.parts.join(''));
    return u;
  };
  url.revokeObjectURL = (u: string) => {
    revoked.push(u);
  };

  const listeners = new Map<string, (() => void)[]>();
  // The browser enables a track by itself and announces it here, without going
  // through the mode setter, so this is the only handle the adapter gets on it.
  const trackListeners: (() => void)[] = [];
  const textTracks = {
    addEventListener(_type: string, fn: () => void) {
      trackListeners.push(fn);
    },
    removeEventListener(_type: string, fn: () => void) {
      const i = trackListeners.indexOf(fn);
      if (i >= 0) trackListeners.splice(i, 1);
    },
    emitChange() {
      for (const fn of [...trackListeners]) fn();
    },
  };
  const video = {
    currentSrc: 'https://cdn.test/The.Matrix.1999.1080p.BluRay.x264-AMIABLE.mkv',
    src: '',
    readyState: 0,
    textTracks,
    append(el: FakeTrack) {
      children.push(el);
    },
    addEventListener(type: string, fn: () => void) {
      const list = listeners.get(type) ?? [];
      list.push(fn);
      listeners.set(type, list);
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
    children,
  } as unknown as FakeVideo;

  return { video, tracks };
}

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nWake up, Neo.\n';

function attach(video: HTMLVideoElement, opts: Record<string, unknown> = {}) {
  const { fetch, calls } = stubFetch([
    {
      match: /by-imdb/,
      body: movieBundle([
        bundleSubtitle({ id: 1, language: 'en', format: 'srt' }),
        bundleSubtitle({ id: 2, language: 'fr', format: 'ass' }),
        bundleSubtitle({ id: 3, language: 'de', format: 'sub' }),
      ]),
    },
    { match: /\/get\/1$/, text: SRT },
  ]);
  const handle = attachSubtitleDb(video, {
    client: new SubtitleDbClient({ fetch, retries: 0 }),
    hint: { imdbId: 'tt0133093' },
    ...opts,
  });
  return { handle, calls };
}

beforeEach(() => {
  blobs.length = 0;
  revoked = [];
});

afterEach(() => {
  const g = globalThis as unknown as Record<string, unknown>;
  g.document = undefined;
});

describe('html5 track adapter', () => {
  it('resolves eagerly on loadedmetadata, with no click and no bytes', async () => {
    const { video, tracks } = installDom();
    const { handle, calls } = attach(video);

    (video as unknown as { emit(t: string): void }).emit('loadedmetadata');
    await handle.refresh();

    expect(calls).toHaveLength(1);
    expect(calls.every((c) => !c.url.includes('/get/'))).toBe(true);
    expect(tracks.length).toBeGreaterThan(0);
    handle.destroy();
  });

  it('offers convertible formats and drops the ones nothing can render', async () => {
    // srt and ass are reachable through the converter; sub is not reachable at all,
    // so offering it would produce a track that silently shows nothing.
    const { video } = installDom();
    const { handle } = attach(video);
    const r = await handle.refresh();

    expect(r.candidates.map((c) => c.subtitle.format).sort()).toEqual(['ass', 'srt']);
    expect(r.unrenderable).toBe(1);
    handle.destroy();
  });

  it('adds tracks with no src so nothing downloads until one is chosen', async () => {
    const { video, tracks } = installDom();
    const { handle, calls } = attach(video);
    await handle.refresh();

    expect(tracks.every((t) => t.src === '')).toBe(true);
    expect(tracks.every((t) => t.track.mode === 'disabled')).toBe(true);
    expect(calls).toHaveLength(1);
    handle.destroy();
  });

  it('converts to WebVTT on select and shows exactly one track', async () => {
    const { video, tracks } = installDom();
    const { handle, calls } = attach(video);
    const r = await handle.refresh();
    const en = r.candidates.find((c) => c.subtitle.language === 'en');
    if (!en) throw new Error('expected an english candidate');

    await handle.select(en);

    expect(calls.filter((c) => c.url.includes('/get/'))).toHaveLength(1);
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.startsWith('WEBVTT')).toBe(true);
    expect(blobs[0]).toContain('00:00:01.000 --> 00:00:02.000');
    expect(tracks.filter((t) => t.track.mode === 'showing')).toHaveLength(1);
    handle.destroy();
  });

  it('a later resolve for the same title leaves the chosen subtitle showing', async () => {
    // A player that loads its media late fires loadedmetadata after the viewer has
    // already picked a subtitle. Rebuilding the track elements there removed the one
    // being watched and revoked its blob, so the subtitle vanished a second after it
    // appeared. Found against NPlayer, which sets its source on mount.
    const { video, tracks } = installDom();
    const { handle } = attach(video);
    const r = await handle.refresh();
    const en = r.candidates.find((c) => c.subtitle.language === 'en');
    if (!en) throw new Error('expected an english candidate');
    await handle.select(en);
    const showing = tracks.find((t) => t.track.mode === 'showing');

    await handle.refresh();

    expect(tracks.find((t) => t.track.mode === 'showing')).toBe(showing);
    expect(showing?.src).not.toBe('');
    expect(revoked).toEqual([]);
    handle.destroy();
  });

  it('reports the conversion through onSelected', async () => {
    const { video } = installDom();
    let seen: { format: string; convertedFrom?: string } | null = null;
    const { handle } = attach(video, {
      onSelected(l: { format: string; convertedFrom?: string }) {
        seen = l;
      },
    });
    const r = await handle.refresh();
    const en = r.candidates.find((c) => c.subtitle.language === 'en');
    if (!en) throw new Error('expected an english candidate');
    await handle.select(en);

    expect(seen).toMatchObject({ format: 'vtt', convertedFrom: 'srt' });
    handle.destroy();
  });

  it('serves only vtt when conversion is turned off', async () => {
    const { video } = installDom();
    const { handle } = attach(video, { convert: false });
    const r = await handle.refresh();

    expect(r.candidates).toHaveLength(0);
    expect(r.unrenderable).toBe(3);
    handle.destroy();
  });

  it('destroy removes the tracks and revokes their blob urls', async () => {
    const { video, tracks } = installDom();
    const { handle } = attach(video);
    const r = await handle.refresh();
    const first = r.candidates[0];
    if (!first) throw new Error('expected a candidate');
    await handle.select(first);

    const children = (video as unknown as { children: FakeTrack[] }).children;
    expect(children.length).toBe(tracks.length);

    handle.destroy();
    expect(children).toHaveLength(0);
    expect(revoked).toHaveLength(1);
  });
});

describe('what a host page gets wrong', () => {
  it('returns the first handle when the same element is attached twice', async () => {
    const { video } = installDom();
    const first = attach(video);
    const second = attach(video);

    // A component that mounts twice, a script tag included twice, React StrictMode in
    // development. Two sessions on one element doubled the track list and the traffic.
    expect(second.handle).toBe(first.handle);
    await first.handle.refresh();
    await second.handle.refresh();
    expect((video as unknown as { children: unknown[] }).children).toHaveLength(2);
    expect(first.calls.filter((c) => c.url.includes('by-imdb'))).toHaveLength(1);
    expect(second.calls).toHaveLength(0);

    first.handle.destroy();
  });

  it('attaches again after the first handle was destroyed', async () => {
    const { video } = installDom();
    const first = attach(video);
    first.handle.destroy();

    const second = attach(video);
    expect(second.handle).not.toBe(first.handle);
    await second.handle.refresh();
    expect((video as unknown as { children: unknown[] }).children.length).toBeGreaterThan(0);
    second.handle.destroy();
  });

  it('says what it wanted when handed something that is not a video', () => {
    installDom();
    for (const junk of [null, undefined, 'video', { play: () => {} }]) {
      // The first mistake a new user makes is passing the player object, or a
      // querySelector that matched nothing. A TypeError from the first line that
      // touches the argument tells them none of that.
      expect(() => attachSubtitleDb(junk as unknown as HTMLVideoElement)).toThrow(
        /expects a <video> element/,
      );
    }
    expect(() => attachSubtitleDb(null as unknown as HTMLVideoElement)).toThrow(
      /@subtitledb\/players/,
    );
  });

  it('turns off the empty track the browser switched on beside a real one', async () => {
    const { video } = installDom();
    const { handle } = attach(video, { autoSelect: true });
    await handle.refresh();

    const children = (video as unknown as { children: FakeTrack[] }).children;
    const shown = children.find((t) => t.src);
    expect(shown?.track.mode).toBe('showing');

    // Chromium runs its automatic text track selection over the list and enables one
    // whose language the viewer prefers, internally, without touching the setter. The
    // page was left with a subtitle on screen and an empty track showing beside it.
    const spare = children.find((t) => !t.src) as FakeTrack;
    spare.track.mode = 'showing';
    video.textTracks.emitChange();

    expect(spare.track.mode).toBe('disabled');
    expect(shown?.track.mode).toBe('showing');
    handle.destroy();
  });

  it('fetches the subtitle when a track is switched on and nothing is showing', async () => {
    const { video } = installDom();
    const { handle, calls } = attach(video);
    await handle.refresh();

    const children = (video as unknown as { children: FakeTrack[] }).children;
    expect(children.every((t) => !t.src)).toBe(true);

    // The player's own captions menu, or the browser's, enabling a track we have not
    // fetched. Nothing is on screen, so this is a request for that subtitle rather
    // than a duplicate of a choice already made: give it the bytes.
    const first = children[0] as FakeTrack;
    first.track.mode = 'showing';
    video.textTracks.emitChange();
    await new Promise((r) => setTimeout(r, 0));

    expect(first.src).toMatch(/^blob:/);
    expect(calls.some((c) => c.url.includes('/get/1'))).toBe(true);
    handle.destroy();
  });

  it('leaves one track showing when two resolves overlap', async () => {
    const { video } = installDom();
    const { handle } = attach(video, { autoSelect: true });

    // A media element fires loadedmetadata while a resolve started by readyState is
    // still in flight. Both used to rebuild the list and select, and the viewer was
    // left with the chosen track showing and an empty one showing beside it.
    await Promise.all([handle.refresh(), handle.refresh(), handle.refresh()]);

    const showing = (
      video as unknown as { children: { track: { mode: string } }[] }
    ).children.filter((t) => t.track.mode === 'showing');
    expect(showing).toHaveLength(1);
    handle.destroy();
  });

  it('answers the same handle superset every adapter here answers', async () => {
    // This package used to return `session` and no `player`, while @subtitledb/players
    // returned `player` and no `session`. One interface now, declared in core, so a
    // host page reads the same fields whichever adapter it happened to reach.
    const { video } = installDom();
    const { handle } = attach(video);

    expect(handle.player).toEqual({
      name: 'native',
      label: 'HTML5 video',
      untested: false,
      via: 'element',
    });
    // A bare element has no player to be partially reachable, so this is null rather
    // than absent: the field means the same thing on every handle.
    expect(handle.degraded).toBeNull();
    expect(handle.media()).toBe(video);
    expect(typeof handle.session.resolve).toBe('function');

    // And `session` is the one actually doing the work, not a spare.
    await handle.refresh();
    expect(handle.session.requestCount).toBeGreaterThan(0);
    handle.destroy();
  });

  it('does not dispose a session it was handed', async () => {
    // @subtitledb/players builds the session before the element exists, so its handle
    // can answer `session` during the wait, then passes it here. If this disposed it
    // the outer handle would be holding a dead session and every later refresh would
    // throw from inside a source-change event.
    const { video } = installDom();
    const { fetch } = stubFetch([{ match: /by-imdb/, body: movieBundle([]) }]);
    const session = createSession({
      client: new SubtitleDbClient({ fetch, retries: 0 }),
      formats: ['vtt'],
    });

    const handle = attachSubtitleDb(video, { session, hint: { imdbId: 'tt0133093' } });
    handle.destroy();

    // A disposed session rejects resolve() outright, so this is the assertion.
    await expect(session.resolve({ imdbId: 'tt0133093' })).resolves.toBeDefined();
    session.dispose();
  });
});

/**
 * The half of reachability that needs no fingerprint.
 *
 * A marker table only catches players somebody already wrote down. A headless Shaka
 * leaves no DOM mark at all, and a player released next year leaves one nobody has
 * seen. This looks at what happened to the track instead, so it keeps working for
 * players that do not exist yet.
 */
describe('did the track survive contact with the player', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function show(opts: Record<string, unknown> = {}) {
    const { video, tracks } = installDom();
    const errors: unknown[] = [];
    const { handle } = attach(video, { onError: (e: unknown) => errors.push(e), ...opts });
    const result = await handle.refresh();
    const candidate = result.candidates.find((c) => c.subtitle.id === 1);
    if (!candidate) throw new Error('no downloadable candidate');
    await handle.select(candidate);
    return { handle, video, tracks, errors, track: tracks[0] as (typeof tracks)[number] };
  }

  it('says so when the player throws the track away', async () => {
    const { handle, track, errors } = await show();
    // What a player that owns its text tracks does to a native one it did not make.
    (track as unknown as { isConnected: boolean }).isConnected = false;
    vi.advanceTimersByTime(2000);

    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toContain('removed from the media element');
    // And it names the fix, because the page cannot see any of this happen.
    expect(String((errors[0] as Error).message)).toContain('@subtitledb/players');
    handle.destroy();
  });

  it('says so when the player turns the track back off', async () => {
    const { handle, track, errors } = await show();
    track.track.mode = 'disabled';
    vi.advanceTimersByTime(2000);

    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toContain('is now disabled');
    handle.destroy();
  });

  it('says nothing at all when the subtitle is still on screen', async () => {
    const { handle, errors } = await show();
    vi.advanceTimersByTime(2000);

    // Zero behaviour change for every page that works, which is the property that
    // makes this safe to ship on by default with no option to turn it off.
    expect(errors).toEqual([]);
    handle.destroy();
  });

  it('looks once however many times the viewer changes language', async () => {
    const { handle, track, errors } = await show();
    const again = (await handle.refresh()).candidates.find((c) => c.subtitle.id === 1);
    if (!again) throw new Error('no downloadable candidate');
    await handle.select(again);
    (track as unknown as { isConnected: boolean }).isConnected = false;
    vi.advanceTimersByTime(2000);

    // One timer, restarted, not one per selection. A viewer clicking through four
    // languages should not produce four copies of the same complaint.
    expect(errors).toHaveLength(1);
    handle.destroy();
  });

  it('never fires after destroy', async () => {
    const { handle, track, errors } = await show();
    (track as unknown as { isConnected: boolean }).isConnected = false;
    handle.destroy();
    vi.advanceTimersByTime(2000);

    expect(errors).toEqual([]);
  });
});
