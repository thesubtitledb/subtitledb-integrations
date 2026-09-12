import type { PlayerVia } from '@subtitledb/core';
import { BINDINGS, bindingByName, native } from './bindings.js';
import { findVideo } from './probe.js';
import type { PlayerBinding } from './types.js';

/**
 * Working out what a page just handed us.
 *
 * Detection used to be one call, `detectBinding(target)`, which answers only for the
 * player object itself. Framework wrappers never hand you that object: `plyr-react`
 * gives `{plyr}`, `@videojs-player/vue` gives `{player}`, `shaka-player-react` gives
 * `{player, videoElement}`, a `useRef` gives `{current}` and a Vue `ref` gives
 * `{value}`. Every one of those missed all fifteen bindings and landed on `native`,
 * whose detect is satisfied by any object with a video somewhere inside it. So the
 * wrapper was accepted, a native track was added, and for the five players that own
 * their own text-track engine nothing rendered and nothing was reported.
 *
 * The gap was structural rather than a missing case: `probe.ts` descends for an
 * element, `playerFor` ascends for a player, and nothing descended for a player.
 * `findPlayer` below is that missing direction, written to the same rules as
 * `findVideo` so the two walks cannot drift in what they are willing to touch.
 */

/** A player, the binding that recognised it, and which step got there. */
export interface ResolvedPlayer {
  binding: PlayerBinding;
  /**
   * The object the binding matched. Every binding call is made against this, never
   * against the raw argument, so a wrapper is unwrapped exactly once and everything
   * downstream sees the player itself.
   */
  player: unknown;
  via: PlayerVia;
}

/**
 * The binding for this object, excluding `native`.
 *
 * Not `detectBinding`, for a reason that is measurable rather than stylistic:
 * `native.detect` calls `findVideo`, a bounded but real graph walk, and it is last in
 * registration order, so asking `detectBinding` about a node that is not a player
 * runs that walk every time. The resolver asks about a lot of nodes, so it asks the
 * question it actually has, which is "is this a real player", and leaves `native` to
 * the one place that wants it.
 */
function playerBinding(target: unknown): PlayerBinding | undefined {
  if (!target || typeof target !== 'object') return undefined;
  for (const binding of BINDINGS) {
    if (binding.name === 'native') continue;
    try {
      if (binding.detect(target)) return binding;
    } catch {
      // A getter that throws before the player is ready must not stop the search.
    }
  }
  return undefined;
}

/**
 * Properties that hold a player, checked before anything else the object owns.
 *
 * The generic walk below would find most of these anyway; naming them puts the likely
 * answer first, so a wrapper that also holds a video element resolves to the player
 * rather than to whichever key happened to be enumerated first.
 */
const PLAYER_PROPS = [
  'player',
  'plyr',
  'api',
  '_player',
  'instance',
  'xgplayer',
  'dp',
  'art',
  'videojs',
  'playerRef',
  'playerInstance',
  'current',
  'value',
  'core',
];

const PLAYER_GETTERS = ['getPlayer', 'getInternalPlayer', 'getApi'];

/**
 * Keys that lead out of an object rather than into it.
 *
 * A DOM element in a browser has none of these as own enumerable properties, so this
 * costs nothing there. It matters everywhere else: a wrapper holding a container
 * element, or any fixture that models one, would otherwise let this walk climb the
 * document and answer with some unrelated player elsewhere on the page. Descending is
 * this function's whole job. Going up is `playerFor`, deliberately separate, and the
 * two must not quietly become one walk.
 */
const OUTWARD = new Set([
  'parentElement',
  'parentNode',
  'ownerDocument',
  'host',
  'offsetParent',
  'defaultView',
  'window',
  'document',
  'documentElement',
  'body',
  'nextSibling',
  'previousSibling',
  'nextElementSibling',
  'previousElementSibling',
]);

/**
 * The player inside an arbitrary wrapper: the symmetric twin of `findVideo`.
 *
 * Same rules, deliberately. Own enumerable keys only, so a prototype getter is never
 * invoked; a 40-key budget, so a wrapper holding a large state tree cannot turn
 * detection into a graph walk; a visited set; a depth cap; and a try/catch around
 * every read, because a property that throws before the player is ready is normal
 * rather than exceptional.
 *
 * The node handed in is not tested against itself: the caller has already asked that
 * question, and answering it again here would report `descend` for an instance.
 */
export function findPlayer(target: unknown, maxDepth = 3): ResolvedPlayer | null {
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number): ResolvedPlayer | null => {
    if (!node || typeof node !== 'object' || seen.has(node) || depth > maxDepth) return null;
    seen.add(node);

    const obj = node as Record<string, unknown>;
    const next: unknown[] = [];

    const consider = (value: unknown): ResolvedPlayer | null => {
      if (!value || typeof value !== 'object') return null;
      const binding = playerBinding(value);
      if (binding) return { binding, player: value, via: 'descend' };
      next.push(value);
      return null;
    };

    for (const key of PLAYER_PROPS) {
      let value: unknown;
      try {
        value = obj[key];
      } catch {
        continue;
      }
      const found = consider(value);
      if (found) return found;
    }

    for (const key of PLAYER_GETTERS) {
      const fn = obj[key];
      if (typeof fn !== 'function') continue;
      let value: unknown;
      try {
        value = (fn as () => unknown).call(obj);
      } catch {
        continue;
      }
      const found = consider(value);
      if (found) return found;
    }

    let budget = 40;
    for (const key of Object.keys(obj)) {
      if (budget-- <= 0) break;
      if (PLAYER_PROPS.includes(key) || OUTWARD.has(key)) continue;
      let value: unknown;
      try {
        value = obj[key];
      } catch {
        continue;
      }
      const found = consider(value);
      if (found) return found;
    }

    for (const value of next) {
      const found = walk(value, depth + 1);
      if (found) return found;
    }
    return null;
  };

  return walk(target, 0);
}

/**
 * Property names players hang on or near their media element.
 *
 * The point is to reach the player object rather than the bare video element, because
 * a player that owns its text tracks renders nothing from a native one. Duck typed
 * like everything else here: the value found is only used if a binding recognises it,
 * so a page property that happens to share a name is ignored.
 */
const BACKREFS = ['player', 'plyr', 'api', '_player', 'xgplayer', 'dp'];

/** How far up from the video to look for whatever owns it. */
const MAX_CLIMB = 5;

/**
 * One step up the tree, across a shadow boundary when there is one.
 *
 * `parentElement` is null at the top of a shadow root, because the parent there is a
 * DocumentFragment and not an element. Vidstack and Media Chrome both put their video
 * inside one, so the climb stopped exactly one node short of the player it was
 * looking for and reported `native` for the two players whose element is the API.
 * Hopping to the host is the same walk a browser does.
 */
function up(node: unknown): unknown {
  if (!node || typeof node !== 'object') return null;
  try {
    const el = node as { parentElement?: unknown; parentNode?: { host?: unknown } | null };
    if (el.parentElement) return el.parentElement;
    return el.parentNode?.host ?? null;
  } catch {
    return null;
  }
}

/**
 * The best target for this video: the player that owns it when one can be reached,
 * the element itself otherwise.
 *
 * Custom element players (Vidstack, Media Chrome) are found by the climb because the
 * element is the API. Video.js, Plyr and MediaElement.js are found through a back
 * reference. Shaka, Bitmovin, THEOplayer and JW keep their player entirely in
 * JavaScript with nothing pointing back, so they resolve to the video element and the
 * caller has to pass the instance to attachSubtitleDb itself.
 */
export function playerFor(video: unknown): unknown {
  let node: unknown = video;
  for (let depth = 0; node && depth <= MAX_CLIMB; depth++) {
    // The node itself, but never as the plain video: that is the fallback, not a find.
    if (depth > 0 && playerBinding(node)) return node;
    for (const key of BACKREFS) {
      let value: unknown;
      try {
        value = (node as Record<string, unknown>)[key];
      } catch {
        // A getter that throws before the player is ready is not an error here.
        continue;
      }
      if (playerBinding(value)) return value;
    }
    node = up(node);
  }
  return video;
}

/**
 * Reference shapes, unwrapped one layer at a time.
 *
 * `current` is React, `value` is a Vue ref, and `__v_raw` is Vue's own marker for the
 * target behind a reactive proxy, read as a plain property so this needs no
 * dependency on Vue and no `toRaw` import. Chained rather than single, because
 * `ref(reactive(player))` is two layers and a page has no reason to know that.
 *
 * Measured rather than assumed: structural detection survives a Vue reactive proxy
 * untouched, so peeling is about identity, not about being able to see the player.
 * Two proxies of one target are not the same object, and the handle registry is keyed
 * on identity, so resolving to the raw target is what makes one player one handle.
 */
const REF_KEYS = ['current', 'value', '__v_raw'];
const MAX_UNWRAP = 3;

function unwrapped(target: unknown): unknown[] {
  const out: unknown[] = [];
  let node = target;
  for (let i = 0; i < MAX_UNWRAP; i++) {
    if (!node || typeof node !== 'object') break;
    const obj = node as Record<string, unknown>;
    let next: unknown;
    for (const key of REF_KEYS) {
      let value: unknown;
      try {
        value = obj[key];
      } catch {
        continue;
      }
      if (value && typeof value === 'object' && value !== node) {
        next = value;
        break;
      }
    }
    if (!next || next === target || out.includes(next)) break;
    out.push(next);
    node = next;
  }
  return out;
}

/**
 * Which player this target is, and how we got there.
 *
 * First match wins, and the order is deliberate: the page's own answer, then the
 * object itself, then one reference shape at a time, then down, then up, then the
 * floor. `via` records which step answered, because after the fact "the resolver
 * found nothing" and "the resolver was never reached" produce the identical symptom,
 * and that ambiguity is what let this class of bug stay invisible for as long as it
 * did.
 *
 * `native` is still a real answer and not a failure: hls.js, dash.js, jPlayer,
 * Griffith, Kaltura, Jellyfin and Video-React are all correctly served by driving the
 * element directly, and every one of them arrives here.
 */
export function resolvePlayer(
  target: unknown,
  options: { player?: string } = {},
): ResolvedPlayer | undefined {
  // 1. Named. The escape hatch stays first and stays literal: a page that names a
  // binding is telling us what the object is, so nothing else gets a vote.
  if (options.player) {
    const binding = bindingByName(options.player);
    return binding ? { binding, player: target, via: 'named' } : undefined;
  }

  const targets = [target, ...unwrapped(target)];

  // 2 and 3. The object itself, then whatever a reference was holding.
  for (let i = 0; i < targets.length; i++) {
    const node = targets[i];
    const binding = playerBinding(node);
    if (binding) return { binding, player: node, via: i === 0 ? 'instance' : 'ref' };
  }

  // 4. Down. This is the wrapper case: {plyr}, {player}, {player, videoElement}.
  for (const node of targets) {
    const found = findPlayer(node);
    if (found) return found;
  }

  // 5. Up. A container element, or a wrapper holding one, where the player is
  // reachable only from the media element it mounted.
  for (const node of targets) {
    const video = findVideo(node);
    if (!video) continue;
    const owner = playerFor(video);
    const binding = playerBinding(owner);
    if (binding) return { binding, player: owner, via: 'ascend' };
  }

  // 6. The floor.
  for (const node of targets) {
    try {
      if (native.detect(node)) return { binding: native, player: node, via: 'native' };
    } catch {
      // Same rule as everywhere else here: a throwing getter is not an answer.
    }
  }
  return undefined;
}
