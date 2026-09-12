import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachedTo, attachSubtitleDb } from '../src/attach.js';
import { BINDINGS } from '../src/bindings.js';
import { findVideo } from '../src/probe.js';
import { playerFor, resolvePlayer } from '../src/resolve.js';
import { clearDom, client, FAKES, installDom, resetFakes } from './fakes.js';

/**
 * The regression gate for framework wrappers.
 *
 * Measured before the resolver existed: 15 of 15 wrapper shapes resolved to the wrong
 * binding, and the way they failed was the worst available. For the nine players
 * whose subtitles are real DOM children the track still rendered and only the
 * player's own captions menu went missing. For the five that own their text-track
 * engine, `native` added a track the player ignores: no subtitles, no error, and a
 * page that looks correctly wired up.
 *
 * A wrapper is not exotic. `plyr-react` hands back `{plyr}`, `@videojs-player/vue`
 * hands back `{player}`, `shaka-player-react` hands back `{player, videoElement}`,
 * and a `useRef` or a Vue `ref` wraps whichever of those the component chose. So this
 * drives every binding through every shape rather than spot-checking the two that
 * were reported.
 */

/** The media element for a fake, asked for the way the adapter asks for it. */
function mediaOf(name: string, player: unknown): unknown {
  const binding = BINDINGS.find((b) => b.name === name);
  return binding?.media?.(player) ?? findVideo(player);
}

function make(name: string): { player: unknown; media: unknown } {
  const factory = FAKES[name];
  if (!factory) throw new Error(`no fake for ${name}`);
  const player = factory();
  return { player, media: mediaOf(name, player) };
}

/**
 * A container element holding the player, the way a component that keeps its player
 * private leaves the page holding one.
 *
 * The back reference is what every real one of these has: Video.js writes `player` on
 * its container element, Plyr and MediaElement.js do the equivalent. Without one the
 * player is genuinely unreachable and recovering it needs the player's own registry,
 * which is a separate piece of work.
 */
function containerFor(player: unknown, media: unknown): unknown {
  const container = {
    tagName: 'DIV',
    player,
    querySelector: (selector: string) => (selector === 'video' ? media : null),
  };
  (media as { parentElement?: unknown }).parentElement = container;
  return container;
}

const SHAPES: Record<string, (player: unknown, media: unknown) => unknown> = {
  /** The player itself. This one always worked and is here as the control. */
  instance: (player) => player,
  /** shaka-player-react: the player and its element side by side. */
  sibling: (player, media) => ({ player, videoElement: media }),
  /** A component holding the player under a name nothing could have anticipated. */
  nested: (player) => ({ playerForThisParticularComponent: player }),
  /** A React ref. */
  reactRef: (player) => ({ current: player }),
  /** A Vue ref holding a reactive proxy: two layers, which a page has no reason to know. */
  vueRef: (player) => ({ value: { __v_raw: player } }),
  /** The container element, with the player reachable only from it. */
  container: (player, media) => containerFor(player, media),
  /** The media element, with the player reachable only by climbing to its container. */
  element: (player, media) => {
    containerFor(player, media);
    return media;
  },
};

describe('framework wrappers', () => {
  it('resolves every binding through every wrapper shape', () => {
    const wrong: string[] = [];

    for (const name of Object.keys(FAKES)) {
      for (const [shape, wrap] of Object.entries(SHAPES)) {
        const { player, media } = make(name);
        // A fake whose media element cannot be found at all has nothing to wrap, and
        // that is a fixture problem rather than a resolver result worth asserting.
        if (!media && shape !== 'instance' && shape !== 'nested') continue;
        const resolved = resolvePlayer(wrap(player, media));
        if (resolved?.binding.name !== name) {
          wrong.push(`${name}/${shape} resolved to ${resolved?.binding.name ?? 'nothing'}`);
        }
      }
    }

    // Listed rather than counted, so a failure names the player and the shape instead
    // of reporting that some number moved.
    expect(wrong).toEqual([]);
  });

  it('reports which step answered, so a miss and a never-looked are distinguishable', () => {
    const plyr = make('plyr');
    expect(resolvePlayer(plyr.player)?.via).toBe('instance');
    expect(resolvePlayer({ plyr: plyr.player })?.via).toBe('descend');
    expect(resolvePlayer({ current: plyr.player })?.via).toBe('ref');
    expect(resolvePlayer({ value: { __v_raw: plyr.player } })?.via).toBe('ref');

    const climbed = make('plyr');
    containerFor(climbed.player, climbed.media);
    expect(resolvePlayer(climbed.media)?.via).toBe('ascend');

    // Naming a binding skips resolution entirely. It is the escape hatch, and it
    // stays literal: the page is telling us what the object is.
    expect(resolvePlayer(plyr.player, { player: 'dplayer' })?.via).toBe('named');
    expect(resolvePlayer(plyr.player, { player: 'nothing-by-that-name' })).toBeUndefined();
  });

  it('still answers native for the players that are correctly driven natively', () => {
    // hls.js, dash.js, jPlayer, Griffith, Kaltura, Jellyfin and Video-React all hand
    // over a bare element and are served correctly by driving it. Refusing to resolve
    // them, or claiming one of the other bindings, would break every one.
    const { media } = make('native');
    const hls = { media, loadSource: () => {}, attachMedia: () => {}, levels: [] };

    for (const target of [media, hls, { current: hls }]) {
      const resolved = resolvePlayer(target);
      expect(resolved?.binding.name).toBe('native');
      expect(resolved?.via).toBe('native');
    }
  });

  it('climbs out of a shadow root, where parentElement is null', () => {
    // Vidstack and Media Chrome put their video inside a shadow root, and the parent
    // there is a DocumentFragment, so parentElement is null and the climb stopped one
    // node short of the player it was looking for.
    const { player, media } = make('plyr');
    const host = {
      tagName: 'DIV',
      player,
      querySelector: (selector: string) => (selector === 'video' ? media : null),
    };
    (media as { parentNode?: unknown }).parentNode = { host };

    expect(playerFor(media)).toBe(player);
    expect(resolvePlayer(media)?.binding.name).toBe('plyr');
  });

  it('gives one handle to the wrapper, the player and the element alike', async () => {
    installDom();
    const { client: c } = client();
    const { player, media } = make('plyr');
    const wrapper = { current: player };

    const first = attachSubtitleDb(wrapper, { client: c, hint: { imdbId: 'tt0133093' } });
    await first.refresh();

    // Every name for one player answers with the same handle. Without this a page
    // that holds a ref and a component that holds the instance open two sessions on
    // one video: two track lists, two menus, two downloads on select.
    expect(attachSubtitleDb(player, { client: c })).toBe(first);
    expect(attachedTo(wrapper)).toBe(first);
    expect(attachedTo(player)).toBe(first);
    expect(attachedTo(media)).toBe(first);

    first.destroy();
    expect(attachedTo(wrapper)).toBeUndefined();
    expect(attachedTo(player)).toBeUndefined();
    expect(attachedTo(media)).toBeUndefined();
  });

  it('drives the player it resolved to, not the wrapper it was handed', async () => {
    installDom();
    const { client: c } = client();
    // Video.js is the case that mattered: it ignores a native track entirely, so
    // resolving a wrapper to `native` produced no subtitles and no error at all.
    const { player } = make('videojs');
    const handle = attachSubtitleDb(
      { player, videoElement: mediaOf('videojs', player) },
      { client: c, languages: ['en'], hint: { imdbId: 'tt0133093' } },
    );
    await handle.refresh();
    const candidate = handle.tracks().find((c) => c.subtitle.id === 1);
    if (!candidate) throw new Error('no downloadable candidate');
    await handle.select(candidate);

    expect(handle.player.name).toBe('videojs');
    // Through Video.js's own API. Resolving this wrapper to `native` added a track
    // element the player ignores, so this list stayed empty and nothing said so.
    expect((player as { __got: unknown[] }).__got.length).toBe(1);
    handle.destroy();
  });

  beforeEach(() => {
    resetFakes();
  });

  afterEach(() => {
    clearDom();
  });
});
