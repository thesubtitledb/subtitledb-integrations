import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachSubtitleDb,
  observeSubtitleDb,
  playerFor,
  UnknownPlayerError,
} from '../src/index.js';
import { clearDom, client, fakeVideo, installDom, resetFakes } from './fakes.js';

/**
 * When the page loads, and in what order, is not something an integration gets to
 * decide. A player can exist before this code runs, or long after it. It can be
 * built, torn down and built again on a route change. The same script can be on the
 * page twice. Everything here is a load pattern that has to work, written as a test
 * rather than as a paragraph in the documentation.
 */

beforeEach(resetFakes);
afterEach(() => {
  clearDom();
  vi.useRealTimers();
});

/** A player whose media element arrives later, which is most of them. */
function latePlayer(): { player: unknown; mount(): void } {
  let video: unknown = null;
  const player = {
    // Plyr's shape. media is null until the player has replaced the element.
    get media() {
      return video;
    },
    toggleCaptions: () => {},
    currentTrack: -1,
  };
  return {
    player,
    mount() {
      video = fakeVideo();
    },
  };
}

describe('a player that mounts later', () => {
  it('attaches before the element exists and resolves once it appears', async () => {
    installDom();
    const { client: api, calls } = client();
    const late = latePlayer();

    // This is the call a host page makes right after constructing the player, before
    // the player has done anything. It used to throw.
    const handle = attachSubtitleDb(late.player, {
      client: api,
      languages: ['en'],
      hint: { imdbId: 'tt0133093' },
    });
    expect(handle.player.name).toBe('plyr');
    expect(handle.tracks()).toEqual([]);
    expect(calls).toHaveLength(0);

    late.mount();
    const result = await handle.refresh();

    expect(result.candidates.length).toBeGreaterThan(0);
    expect(handle.tracks().length).toBeGreaterThan(0);
    expect(calls.filter((c) => c.url.includes('/get/'))).toHaveLength(0);
    handle.destroy();
  });

  it('reports through onError when the element never arrives, and starts nothing', async () => {
    vi.useFakeTimers();
    installDom();
    const { client: api, calls } = client();
    const errors: unknown[] = [];
    const handle = attachSubtitleDb(latePlayer().player, {
      client: api,
      languages: ['en'],
      onError: (e) => errors.push(e),
    });

    const pending = handle.refresh();
    await vi.advanceTimersByTimeAsync(16_000);
    const result = await pending;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(UnknownPlayerError);
    expect(String((errors[0] as Error).message)).toContain('never mounted');
    // An empty result, not a throw: a page that mounts no player is not a crash.
    expect(result.candidates).toEqual([]);
    expect(calls).toHaveLength(0);
    handle.destroy();
  });

  it('destroying before the element arrives never opens a session', async () => {
    vi.useFakeTimers();
    installDom();
    const { client: api, calls } = client();
    const late = latePlayer();
    const handle = attachSubtitleDb(late.player, { client: api, languages: ['en'] });

    handle.destroy();
    late.mount();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(calls).toHaveLength(0);
    expect(handle.tracks()).toEqual([]);
    expect(handle.current()).toBeNull();
  });
});

describe('the same player attached twice', () => {
  it('is one session, not two sets of tracks', async () => {
    installDom();
    const { client: api, calls } = client();
    const video = fakeVideo();
    const opts = { client: api, languages: ['en'], hint: { imdbId: 'tt0133093' } };

    const first = attachSubtitleDb(video, opts);
    const second = attachSubtitleDb(video, opts);
    expect(second).toBe(first);

    await first.refresh();
    // One fan-out, one language, one request. A second attach would have doubled it.
    expect(calls.filter((c) => c.url.includes('by-imdb'))).toHaveLength(1);
    const count = first.tracks().length;
    expect(count).toBeGreaterThan(0);
    expect(second.tracks()).toHaveLength(count);

    first.destroy();
    // Destroy releases the player, so a later attach is a real one again.
    const third = attachSubtitleDb(video, opts);
    expect(third).not.toBe(first);
    third.destroy();
  });
});

describe('the media changes under a live handle', () => {
  it('re-resolves when the player loads a different file', async () => {
    installDom();
    const { client: api, calls } = client();
    const video = fakeVideo();
    const handle = attachSubtitleDb(video, { client: api, languages: ['en'] });
    await handle.refresh();

    expect(handle.current()?.hint.title?.toLowerCase()).toBe('the matrix');
    (video as unknown as { currentSrc: string }).currentSrc =
      'https://cdn.test/Interstellar.2014.1080p.BluRay.x264-SPARKS.mkv';
    (video as unknown as { emit(t: string): void }).emit('loadstart');

    // The new identity, not the old one, and still no subtitle bytes.
    await vi.waitFor(() =>
      expect(handle.current()?.hint.title?.toLowerCase()).toBe('interstellar'),
    );
    expect(calls.filter((c) => c.url.includes('/get/'))).toHaveLength(0);
    handle.destroy();
  });
});

describe('finding the player that owns a video', () => {
  it('prefers a player reachable from the element over the bare video', () => {
    const video = fakeVideo();
    // Video.js and MediaElement.js both leave the player on el.player.
    const owner = {
      player: {
        addRemoteTextTrack: () => ({ track: {} }),
        removeRemoteTextTrack: () => {},
        remoteTextTracks: () => ({ length: 0 }),
        textTracks: () => ({ length: 0 }),
      },
      parentElement: null,
    };
    (video as unknown as { parentElement: unknown }).parentElement = owner;
    expect(playerFor(video)).toBe(owner.player);
  });

  it('finds a custom element player by climbing to it', () => {
    const video = fakeVideo();
    const host = {
      tagName: 'MEDIA-PLAYER',
      startLoading: () => {},
      textTracks: Object.assign([] as unknown[], { add: () => {}, remove: () => {} }),
      parentElement: null,
    };
    (video as unknown as { parentElement: unknown }).parentElement = host;
    expect(playerFor(video)).toBe(host);
  });

  it('falls back to the video when nothing owns it', () => {
    const video = fakeVideo();
    (video as unknown as { parentElement: unknown }).parentElement = { parentElement: null };
    expect(playerFor(video)).toBe(video);
  });
});

describe('watching a page for players', () => {
  it('attaches to what is already there, once per player', async () => {
    installDom();
    const { client: api } = client();
    const one = fakeVideo();
    const two = fakeVideo('https://cdn.test/Interstellar.2014.1080p.BluRay.x264-SPARKS.mkv');
    const root = { querySelectorAll: (s: string) => (s === 'video' ? [one, two] : []) };

    const attached: unknown[] = [];
    const observer = observeSubtitleDb({
      root: root as unknown as ParentNode,
      client: api,
      languages: ['en'],
      onAttach: (_h, target) => attached.push(target),
    });

    expect(observer.handles()).toHaveLength(2);
    expect(attached).toEqual([one, two]);

    // Running the scan again must not double up: attach is idempotent per player.
    const again = observeSubtitleDb({ root: root as unknown as ParentNode, client: api });
    expect(again.handles()).toHaveLength(0);

    observer.destroy();
    expect(observer.handles()).toHaveLength(0);
    again.destroy();
  });

  it('survives a video nothing can bind', () => {
    installDom();
    const errors: unknown[] = [];
    const junk = { tagName: 'VIDEO' };
    const root = { querySelectorAll: () => [junk] };

    const observer = observeSubtitleDb({
      root: root as unknown as ParentNode,
      onError: (e) => errors.push(e),
    });
    // Not an element, so nothing attaches, and nothing throws out of the observer.
    expect(observer.handles()).toHaveLength(0);
    observer.destroy();
  });

  it('does not attach twice when a player wraps a video it already owns', async () => {
    installDom();
    const { client: api } = client();
    const video = fakeVideo();
    const root = { querySelectorAll: () => [video] };

    const observer = observeSubtitleDb({ root: root as unknown as ParentNode, client: api });
    expect(observer.handles()).toHaveLength(1);

    // A lazy player wraps the element after the first scan, which is the ordinary
    // case: the video is in the markup and the player upgrades it a moment later.
    // The second scan then finds the player rather than the video, and a check keyed
    // only on what it was handed saw a target it had never seen.
    (video as unknown as { parentElement: unknown }).parentElement = {
      player: {
        addRemoteTextTrack: () => ({ track: {} }),
        removeRemoteTextTrack: () => {},
        remoteTextTracks: () => ({ length: 0 }),
        textTracks: () => ({ length: 0 }),
        on: () => {},
        off: () => {},
      },
      parentElement: null,
    };
    const again = observeSubtitleDb({ root: root as unknown as ParentNode, client: api });
    expect([observer.handles().length, again.handles().length]).toEqual([1, 0]);

    observer.destroy();
    again.destroy();
  });
});

describe('teardown in the middle of a load pattern', () => {
  it('answers a refresh() on a handle destroyed before its media arrived', async () => {
    installDom();
    const { client: api } = client();
    const late = latePlayer();
    const handle = attachSubtitleDb(late.player, { client: api, languages: ['en'] });

    // A component unmounted between construction and mount. The deferred path was
    // holding the promise for a media element that is never coming, so a host page
    // awaiting refresh() waited for the life of the tab.
    handle.destroy();
    const settled = await Promise.race([
      handle.refresh().then(() => 'settled'),
      new Promise((r) => setTimeout(() => r('hung'), 500)),
    ]);
    expect(settled).toBe('settled');
  });

  it('charges one download to the budget for a selection, not two', async () => {
    installDom();
    const { client: api, calls } = client();
    const errors: unknown[] = [];
    const handle = attachSubtitleDb(fakeVideo(), {
      client: api,
      hint: { imdbId: 'tt0133093' },
      languages: ['en'],
      autoSelect: 'en',
      maxRequests: 3,
      onError: (e) => errors.push(e),
    });
    await handle.refresh();

    // One search and one download. The budget was charged for the cached read as
    // well, so a page with a tight maxRequests reported a limit it had not reached.
    expect([calls.length, errors.map(String)]).toEqual([2, []]);
    handle.destroy();
  });
});
