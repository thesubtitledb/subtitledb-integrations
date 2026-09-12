/**
 * Which player is on this page, read off the DOM rather than off an object.
 *
 * Everything else in this package detects a player structurally, from the object a
 * page handed over. This file answers the question that is left when the page handed
 * over no player at all: something mounted this video element, and the markup it left
 * behind says what.
 *
 * It exists for one narrow purpose. Landing on `native` is usually correct, because
 * hls.js, dash.js, jPlayer, Griffith, Kaltura, Jellyfin and Video-React are all
 * driven properly through the element. But for the five players that own their own
 * text-track engine it is fatal and silent: a native track is added, the player
 * ignores it, and nothing anywhere says so. Evidence here is what separates the two,
 * so a refusal is never a guess.
 *
 * Every marker below was grepped out of the builds vendored in `examples/vendor`,
 * not recalled. Three of five first guesses were wrong, and one of them would have
 * refused this repo's own example page.
 */

// hasClass and chain live in marks.ts, which is the half of this file the CDN loader
// can afford to carry. Keeping one copy is the point: looksOwned there and the
// markers here have to walk the same DOM and read classes the same way, or the cheap
// check and the real one disagree about the same page.
import { chain, hasClass } from './marks.js';

type El = {
  id?: unknown;
  contains?: (other: unknown) => boolean;
};

function global(name: string): unknown {
  try {
    return (globalThis as Record<string, unknown>)[name];
  } catch {
    return undefined;
  }
}

function callSafe(target: unknown, fn: string, ...args: unknown[]): unknown {
  const f = (target as Record<string, unknown> | null)?.[fn];
  if (typeof f !== 'function') return undefined;
  try {
    return (f as (...a: unknown[]) => unknown).call(target, ...args);
  } catch {
    return undefined;
  }
}

function holds(container: unknown, video: unknown): boolean {
  if (container === video) return true;
  try {
    return (container as El)?.contains?.(video) === true;
  } catch {
    return false;
  }
}

/**
 * One player that can be recognised from the page rather than from an object.
 *
 * `fatal` and `degrades` are the whole design. A player that renders nothing from a
 * native track is `fatal`: refusing is strictly better than the silence it would
 * otherwise produce. A player whose subtitles are real DOM children `degrades`: the
 * subtitle appears and only the player's own captions menu is missing, so throwing
 * would turn a working page into an exception. A player that is neither is recovery
 * only, which is the honest answer for a fingerprint nothing has ever been run
 * against.
 */
export interface OwnerMark {
  name: string;
  label: string;
  /** Refuse when this player is present and the instance could not be recovered. */
  fatal?: true;
  /** Report a degraded attach instead of refusing. */
  degrades?: true;
  /** Evidence that this player mounted this element. */
  present(video: unknown, up: unknown[]): boolean;
  /** Ask the player's own registry for the instance it kept. */
  recover?(video: unknown, up: unknown[]): unknown;
  /** How a page passes the instance instead. Quoted verbatim in the refusal. */
  instead?: string;
}

// Group 2: these own their text-track engine and ignore a native track entirely.

const videojsMark: OwnerMark = {
  name: 'videojs',
  label: 'Video.js',
  fatal: true,
  instead: 'the object returned by videojs(...), or videojs.getPlayer(id)',
  // Both, and this is not belt and braces. examples/players.html gives THEOplayer's
  // container `class="player video-js"`, so `.video-js` on its own would refuse this
  // repo's own example page for a player that is not Video.js. `vjs-tech` is set by
  // Video.js on the element it took over and by nothing else.
  present: (video, up) => hasClass(video, 'vjs-tech') && up.some((el) => hasClass(el, 'video-js')),
  recover(video, up) {
    const vjs = global('videojs');
    if (typeof vjs !== 'function') return undefined;
    const box = up.find((el) => hasClass(el, 'video-js'));
    const byElement = callSafe(vjs, 'getPlayer', box);
    if (byElement) return byElement;
    const id = (box as El | undefined)?.id;
    const byId = typeof id === 'string' && id ? callSafe(vjs, 'getPlayer', id) : undefined;
    if (byId) return byId;
    // Last resort, and the reason the registry is worth scanning: a player built
    // without an id, on a container this walk did not recognise, is still in here.
    const all = callSafe(vjs, 'getPlayers') as Record<string, unknown> | undefined;
    for (const player of Object.values(all ?? {})) {
      if (player && holds(callSafe(player, 'el'), video)) return player;
    }
    return undefined;
  },
};

const shakaMark: OwnerMark = {
  name: 'shaka',
  label: 'Shaka Player',
  fatal: true,
  instead: 'the shaka.Player instance you constructed',
  // Only the UI build marks the DOM. `shaka-player.compiled.js`, which is what this
  // repo vendors, contains neither string, so a headless `new shaka.Player()` leaves
  // no fingerprint and is unrefusable by any amount of looking. That is a real limit
  // and it is what the behavioural check in @subtitledb/html5 is for.
  present: (video, up) =>
    hasClass(video, 'shaka-video') || up.some((el) => hasClass(el, 'shaka-video-container')),
  recover(video) {
    // shaka.ui.Overlay hangs itself off the video element.
    const ui = (video as { ui?: unknown }).ui;
    return callSafe(callSafe(ui, 'getControls'), 'getPlayer');
  },
};

const bitmovinMark: OwnerMark = {
  name: 'bitmovin',
  label: 'Bitmovin Player',
  fatal: true,
  instead: 'the object returned by new bitmovin.player.Player(...)',
  present: (_video, up) => up.some((el) => hasClass(el, 'bitmovinplayer-container')),
  // No published registry. Bitmovin keeps its instances entirely in JavaScript, so
  // this one can only be refused, never recovered.
};

const theoplayerMark: OwnerMark = {
  name: 'theoplayer',
  label: 'THEOplayer',
  // Never refuses. THEOplayer's real build publishes no container class at all, so
  // the only evidence available is finding the instance itself, which means "present"
  // and "recovered" are the same event and there is nothing left to refuse over.
  present: (video) => theoplayerFor(video) !== undefined,
  recover: (video) => theoplayerFor(video),
};

function theoplayerFor(video: unknown): unknown {
  const ns = global('THEOplayer') as { players?: unknown[] } | undefined;
  for (const player of ns?.players ?? []) {
    if (holds((player as { element?: unknown })?.element, video)) return player;
  }
  return undefined;
}

const jwplayerMark: OwnerMark = {
  name: 'jwplayer',
  label: 'JW Player',
  // Recovery only. The binding itself is marked untested because JW is commercial and
  // not installable here, so refusing on a fingerprint nothing has ever been run
  // against is the false-refusal risk in person.
  present: (_video, up) => up.some((el) => hasClass(el, 'jwplayer')),
  recover(_video, up) {
    const jw = global('jwplayer');
    if (typeof jw !== 'function') return undefined;
    const box = up.find((el) => hasClass(el, 'jwplayer'));
    const id = (box as El | undefined)?.id;
    if (typeof id !== 'string' || !id) return undefined;
    try {
      const player = (jw as (id: string) => unknown)(id);
      return callSafe(player, 'getContainer') ? player : undefined;
    } catch {
      return undefined;
    }
  },
};

// Group 1: subtitles are real DOM children, so the track renders either way and only
// the player's own captions menu goes missing. Marked so a page can be told, never so
// it can be stopped.

function group1(name: string, label: string, ...classes: string[]): OwnerMark {
  return {
    name,
    label,
    degrades: true,
    instead: `the ${label} instance`,
    present: (_video, up) => up.some((el) => classes.some((c) => hasClass(el, c))),
  };
}

const MARKS: OwnerMark[] = [
  videojsMark,
  shakaMark,
  bitmovinMark,
  theoplayerMark,
  jwplayerMark,
  group1('plyr', 'Plyr', 'plyr'),
  group1('dplayer', 'DPlayer', 'dplayer', 'dplayer-video-wrap'),
  group1('xgplayer', 'xgplayer', 'xgplayer'),
  group1('openplayerjs', 'OpenPlayerJS', 'op-player'),
  group1('flowplayer', 'Flowplayer', 'flowplayer'),
];

export interface OwnerEvidence {
  mark: OwnerMark;
  /** The instance, when the player's own registry handed it back. */
  player?: unknown;
}

/**
 * The player that mounted this element, if the page says so.
 *
 * Returns nothing for a page with no marker, which is the common case and the reason
 * this is evidence-positive: a bare element driven by hls.js is indistinguishable
 * from one driven by nothing, and both are served correctly by the native path.
 */
export function ownerOf(video: unknown): OwnerEvidence | undefined {
  if (!video || typeof video !== 'object') return undefined;
  const up = chain(video);
  for (const mark of MARKS) {
    let present = false;
    try {
      present = mark.present(video, up);
    } catch {
      continue;
    }
    if (!present) continue;
    let player: unknown;
    try {
      player = mark.recover?.(video, up);
    } catch {
      player = undefined;
    }
    return player ? { mark, player } : { mark };
  }
  return undefined;
}

/** What to tell a page that has a player we could see and could not reach. */
export function unreachableMessage(mark: OwnerMark): string {
  return (
    `${mark.label} is on this page and its instance was not reachable from what was ` +
    `passed. ${mark.label} renders nothing from a native text track, so no subtitle ` +
    `would have appeared and nothing would have reported it. Pass ${mark.instead ?? 'the player instance'} ` +
    'to attachSubtitleDb(), or name the binding with player: ' +
    `'${mark.name}' if you are attaching to something this could not see.`
  );
}
