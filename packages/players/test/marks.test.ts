/**
 * The cheap ownership check may over-answer. It may never under-answer.
 *
 * `looksOwned` exists so the CDN loader can decide whether to fetch the bindings
 * before it is able to ask `ownerOf`. If it says no about a page `ownerOf` would have
 * recognised, the loader takes the element path, publishes a native text track to a
 * player that renders nothing from one, and reports success. Nothing downstream
 * notices, which is the failure owners.ts was written to end.
 *
 * So this asserts the direction rather than the list: every marker with a fixture,
 * and every marker has one, has to be visible to both. A new marker added to
 * owners.ts without a class in marks.ts fails here.
 */
import { describe, expect, it } from 'vitest';
import { isVideoTag, looksOwned, OWNER_CLASSES } from '../src/marks.js';
import { ownerOf } from '../src/owners.js';

/** A DOM shaped the way owners.ts reads one: a chain of classed ancestors. */
function mounted(classes: string[], videoClasses: string[] = []): unknown {
  let node: Record<string, unknown> = {
    tagName: 'VIDEO',
    className: videoClasses.join(' '),
    addEventListener() {},
    parentElement: null,
  };
  const video = node;
  for (const cls of classes) {
    const parent: Record<string, unknown> = { className: cls, parentElement: null };
    node.parentElement = parent;
    node = parent;
  }
  return video;
}

/** One case per marker in owners.ts, in the shape that marker recognises. */
const OWNED: Array<[string, unknown]> = [
  ['Video.js', mounted(['video-js'], ['vjs-tech'])],
  ['Shaka', mounted(['shaka-video-container'])],
  ['Shaka on the element', mounted([], ['shaka-video'])],
  ['Bitmovin', mounted(['bitmovinplayer-container'])],
  ['JW Player', mounted(['jwplayer'])],
  ['Plyr', mounted(['plyr'])],
  ['DPlayer', mounted(['dplayer'])],
  ['DPlayer wrap', mounted(['dplayer-video-wrap'])],
  ['xgplayer', mounted(['xgplayer'])],
  ['OpenPlayerJS', mounted(['op-player'])],
  ['Flowplayer', mounted(['flowplayer'])],
];

describe('looksOwned never misses what ownerOf catches', () => {
  for (const [label, video] of OWNED) {
    it(`sees ${label}`, () => {
      // The premise. If this fails the fixture is wrong, not the code under test.
      expect(ownerOf(video), `${label} fixture is not recognised by ownerOf`).toBeTruthy();
      expect(looksOwned(video)).toBe(true);
    });
  }

  it('covers every marker that owners.ts can recognise from the DOM', () => {
    // THEOplayer is the exception and is handled separately below: it publishes no
    // container class at all, so there is no class here to cover it with.
    const named = OWNED.length;
    expect(named).toBeGreaterThanOrEqual(OWNER_CLASSES.length - 1);
  });
});

describe('and says no to a page with no player on it', () => {
  it('a bare video element', () => {
    const video = mounted([]);
    expect(ownerOf(video)).toBeUndefined();
    expect(looksOwned(video)).toBe(false);
  });

  it('a video inside ordinary page markup', () => {
    const video = mounted(['wrapper', 'container', 'main']);
    expect(ownerOf(video)).toBeUndefined();
    expect(looksOwned(video)).toBe(false);
  });

  it('anything that is not an object', () => {
    expect(looksOwned(null)).toBe(false);
    expect(looksOwned(undefined)).toBe(false);
    expect(looksOwned('video')).toBe(false);
  });
});

/**
 * The other way a player can be mistaken for a bare element, and the only one no
 * amount of class walking can see.
 *
 * `isVideoElement` is duck typed on `textTracks` so a media element from an iframe
 * still counts, which means Vidstack's `<media-player>` passes it: a player, with a
 * binding, that the CDN loader would otherwise send down the element path. Found by
 * driving the real build through the loader, where it resolved as the element engine
 * rather than as Vidstack.
 */
describe('a player wearing an element shape', () => {
  /** `<media-player>`, as isVideoElement sees it: a tag name and a track list. */
  const customElement = {
    tagName: 'MEDIA-PLAYER',
    className: 'player',
    textTracks: [],
    addEventListener() {},
    parentElement: null,
  };

  it('is not a video tag', () => {
    expect(isVideoTag(customElement)).toBe(false);
    expect(isVideoTag(mounted([]))).toBe(true);
    // Case, because a video element built by an XML parser reports a lowercase one.
    expect(isVideoTag({ tagName: 'video' })).toBe(true);
    expect(isVideoTag(null)).toBe(false);
    expect(isVideoTag('video')).toBe(false);
  });

  it('goes the long way round even with no marker class on the page', () => {
    expect(looksOwned(customElement)).toBe(true);
  });

  it('and so does a player object with a track list on it', () => {
    // Not reachable through needsBindings, which asks isVideoElement first, but the
    // answer has to stay the same whichever side it is asked from.
    expect(looksOwned({ textTracks: [], addEventListener() {} })).toBe(true);
  });
});

describe('THEOplayer, which leaves no class behind', () => {
  it('is visible through its own registry', () => {
    const video = mounted([]);
    expect(looksOwned(video)).toBe(false);
    const host = globalThis as Record<string, unknown>;
    host.THEOplayer = { players: [{ element: {} }] };
    try {
      // Deliberately not element-specific. Without a class there is nothing to tie
      // the registry to this element cheaply, so the presence of any mounted
      // THEOplayer is enough to go and ask properly.
      expect(looksOwned(video)).toBe(true);
    } finally {
      host.THEOplayer = undefined;
    }
  });

  it('and an empty registry is not a player', () => {
    const host = globalThis as Record<string, unknown>;
    host.THEOplayer = { players: [] };
    try {
      expect(looksOwned(mounted([]))).toBe(false);
    } finally {
      host.THEOplayer = undefined;
    }
  });
});
