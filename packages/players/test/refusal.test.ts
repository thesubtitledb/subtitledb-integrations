import { UnknownPlayerError } from '@subtitledb/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachSubtitleDb, PlayerNotReachableError } from '../src/attach.js';
import { ownerOf } from '../src/owners.js';
import { clearDom, client, FAKES, fakeVideo, installDom, resetFakes } from './fakes.js';

/**
 * Refusing, and much more importantly not refusing.
 *
 * Landing on `native` is the right answer far more often than it is the wrong one.
 * hls.js, dash.js, jPlayer, Griffith, Kaltura, Jellyfin and Video-React are all
 * served correctly by driving the element, and a blanket refusal would break every
 * one of them. So refusal is evidence-positive: it happens only where a player that
 * renders nothing from a native track can be shown to be present.
 *
 * Half of these tests exist to prove the negative. That is deliberate, and it is why
 * the marker table was grepped out of the vendored builds rather than recalled: three
 * of the first five guesses were wrong, and one of them would have refused this
 * repo's own example page.
 */

type Node = {
  tagName: string;
  className: string;
  classList: { contains(name: string): boolean };
  id: string;
  parentElement: unknown;
  querySelector(selector: string): unknown;
  contains(other: unknown): boolean;
  [key: string]: unknown;
};

function node(className: string, video: unknown, id = ''): Node {
  const classes = className.split(/\s+/).filter(Boolean);
  return {
    tagName: 'DIV',
    className,
    classList: { contains: (name: string) => classes.includes(name) },
    id,
    parentElement: null,
    querySelector: (selector: string) => (selector === 'video' ? video : null),
    contains: (other: unknown) => other === video,
  };
}

/** A media element carrying classes, which the plain fake has no reason to have. */
function markedVideo(className = ''): ReturnType<typeof fakeVideo> {
  const video = fakeVideo();
  const classes = className.split(/\s+/).filter(Boolean);
  Object.assign(video, {
    className,
    classList: { contains: (name: string) => classes.includes(name) },
    isConnected: true,
  });
  return video;
}

/** A container holding a video, the way every one of these players leaves the page. */
function mounted(containerClass: string, videoClass = '', id = '') {
  const video = markedVideo(videoClass);
  const container = node(containerClass, video, id);
  (video as unknown as { parentElement: unknown }).parentElement = container;
  return { container, video };
}

const globals = globalThis as Record<string, unknown>;

beforeEach(resetFakes);
afterEach(() => {
  clearDom();
  globals.videojs = undefined;
  globals.THEOplayer = undefined;
  globals.jwplayer = undefined;
});

describe('players we can see and cannot reach', () => {
  it('refuses a Video.js page, and says what to pass instead', () => {
    installDom();
    const { client: c } = client();
    const { container } = mounted('video-js', 'vjs-tech');

    let raised: unknown;
    try {
      attachSubtitleDb(container, { client: c });
    } catch (err) {
      raised = err;
    }

    expect(raised).toBeInstanceOf(PlayerNotReachableError);
    // A subclass, so a page already catching the general case keeps catching this one.
    expect(raised).toBeInstanceOf(UnknownPlayerError);
    expect((raised as PlayerNotReachableError).player).toBe('videojs');
    expect(String((raised as Error).message)).toContain('videojs.getPlayer');
  });

  it('does not refuse the THEOplayer container in this repo, which carries video-js', () => {
    installDom();
    const { client: c } = client();
    // examples/players.html:392 sets `class="player video-js"` on THEOplayer's
    // container. `.video-js` alone as evidence would refuse a page that works, which
    // is why the element itself has to carry vjs-tech as well.
    const { container } = mounted('player video-js');

    const handle = attachSubtitleDb(container, { client: c });
    expect(handle.player.name).toBe('native');
    expect(handle.degraded).toBeNull();
    handle.destroy();
  });

  it('does not refuse a bare element driven by hls.js', () => {
    installDom();
    const { client: c } = client();
    const video = markedVideo();
    const hls = { media: video, loadSource: () => {}, attachMedia: () => {}, levels: [] };

    const handle = attachSubtitleDb(hls, { client: c });
    expect(handle.player.via).toBe('native');
    expect(handle.degraded).toBeNull();
    handle.destroy();
  });

  it('refuses Bitmovin, which publishes no way to get its instance back', () => {
    installDom();
    const { client: c } = client();
    const { container } = mounted('bitmovinplayer-container');

    expect(() => attachSubtitleDb(container, { client: c })).toThrow(PlayerNotReachableError);
  });

  it('takes the instance back from Video.js rather than refusing, when it can', () => {
    installDom();
    const { client: c } = client();
    const { container } = mounted('video-js', 'vjs-tech', 'player-1');
    const real = FAKES.videojs?.();
    globals.videojs = Object.assign(() => real, {
      getPlayer: (what: unknown) => (what === container || what === 'player-1' ? real : undefined),
      getPlayers: () => ({}),
    });

    const handle = attachSubtitleDb(container, { client: c });
    // Recovered, so this is not a failure at all: the page gets the real binding and
    // Video.js's own captions API, from a container it never passed a player for.
    expect(handle.player.name).toBe('videojs');
    expect(handle.player.via).toBe('ascend');
    expect(handle.degraded).toBeNull();
    handle.destroy();
  });

  it('finds THEOplayer in its own registry, and never refuses when it cannot', () => {
    installDom();
    const { client: c } = client();
    const { container, video } = mounted('player');
    const real = FAKES.theoplayer?.() as { element: unknown };
    real.element = video;
    globals.THEOplayer = { players: [real] };

    const handle = attachSubtitleDb(container, { client: c });
    expect(handle.player.name).toBe('theoplayer');
    handle.destroy();

    // THEOplayer's real build publishes no container class, so with the registry gone
    // there is no evidence at all and nothing to refuse over. The first marker I
    // assumed for it does not exist in the shipped library.
    globals.THEOplayer = undefined;
    const second = attachSubtitleDb(mounted('player').container, { client: c });
    expect(second.player.name).toBe('native');
    second.destroy();
  });

  it('reports a JW Player page rather than refusing it', () => {
    installDom();
    const { client: c } = client();
    // The JW binding is marked untested, because JW is commercial and not installable
    // here. Refusing on a fingerprint nothing has ever been run against is the
    // false-refusal risk in person, so this one recovers or says nothing.
    const { container } = mounted('jwplayer');

    const handle = attachSubtitleDb(container, { client: c });
    expect(handle.player.name).toBe('native');
    expect(handle.degraded).toBeNull();
    handle.destroy();
  });
});

describe('players we can see and only partly reach', () => {
  it('reports a Plyr page as degraded, and still renders', () => {
    installDom();
    const { client: c } = client();
    const { container } = mounted('plyr');
    const seen: unknown[] = [];

    const handle = attachSubtitleDb(container, { client: c, onDegraded: (d) => seen.push(d) });

    // Not an error. Plyr's subtitles are real DOM children, so the track appears and
    // it is Plyr's own captions menu that will not list it. Throwing here would turn
    // a working page into an exception.
    expect(handle.degraded).toEqual({ player: 'plyr', reason: 'menu' });
    expect(seen).toEqual([{ player: 'plyr', reason: 'menu' }]);
    expect(handle.player.name).toBe('native');
    handle.destroy();
  });

  it('promotes that to a throw only when the page asked for strict', () => {
    installDom();
    const { client: c } = client();
    const { container } = mounted('plyr');

    expect(() => attachSubtitleDb(container, { client: c, strict: true })).toThrow(
      PlayerNotReachableError,
    );
  });

  it('leaves an unmarked page alone in every direction', () => {
    const video = markedVideo();
    expect(ownerOf(video)).toBeUndefined();
    expect(ownerOf(null)).toBeUndefined();
    expect(ownerOf({})).toBeUndefined();
  });
});
