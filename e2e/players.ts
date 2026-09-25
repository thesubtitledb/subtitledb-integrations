/**
 * What examples/players.html mounts, what each mount has to be detected as, and the
 * test surface the page publishes for reading the answer.
 *
 * Shared rather than written twice. `players.spec.ts` drives this list through the
 * vendored packages and an import map; `cdn.spec.ts` drives the same list through the
 * published loader on a second origin. Two copies would drift the first time a player
 * was added to one of them, and the CDN run would then quietly cover less than the
 * one it exists to mirror.
 *
 * A plain module and not a spec on purpose: importing one spec file from another
 * registers its tests a second time, under the importing file.
 */

/**
 * The players this page mounts from a real build with no licence needed.
 *
 * Fluid Player is missing on purpose: it publishes sources and no browser bundle, so
 * it cannot be loaded without a bundler and stays covered by the unit fake. The four
 * commercial players are in EXPECT_COMMERCIAL, under what a licence does and does not
 * gate.
 */
export const PLAYERS = [
  'native',
  'hlsjs',
  'plyr',
  'videojs',
  'shaka',
  'vidstack',
  'dplayer',
  'clappr',
  'xgplayer',
  'mediaelement',
  'openplayerjs',
  'mediachrome',
  'artplayer',
] as const;

/** The binding each one must be detected as, without being told which it is. */
export const EXPECTED_BINDING: Record<string, string> = {
  native: 'native',
  // A playback engine with no text-track surface, so the native binding is correct.
  hlsjs: 'native',
  plyr: 'plyr',
  videojs: 'videojs',
  shaka: 'shaka',
  vidstack: 'vidstack',
  dplayer: 'dplayer',
  clappr: 'clappr',
  xgplayer: 'xgplayer',
  mediaelement: 'mediaelement',
  openplayerjs: 'openplayerjs',
  mediachrome: 'mediachrome',
  artplayer: 'artplayer',
};

/**
 * Players that render captions through the media element's own text tracks.
 *
 * "The browser parsed cues out of it" is true of a track the player has already
 * hidden: Clappr wipes its caption selection on the first play and hides every track
 * that does not match an id only its own setter writes, so the subtitle appeared,
 * playback started, and it vanished. Cues survive that. A viewer does not.
 *
 * Vidstack, Video.js and Shaka are not here because they render text themselves and
 * are entitled to leave the element's track hidden or hold no element track at all.
 */
export const ELEMENT_TRACK_PLAYERS = [
  'native',
  'hlsjs',
  'plyr',
  'dplayer',
  'clappr',
  'xgplayer',
  'mediaelement',
  'openplayerjs',
  'mediachrome',
] as const;

/** The commercial four, and the binding each is detected as with or without a key. */
export const EXPECT_COMMERCIAL: Record<string, string> = {
  bitmovin: 'bitmovin',
  theoplayer: 'theoplayer',
  flowplayer: 'flowplayer',
  jwplayer: 'jwplayer',
};

/** What the page reports about a commercial player on this machine. */
export interface Commercial {
  name: string;
  licensed: boolean;
  loadable: boolean;
}

/**
 * One track list, as the page reads it for whichever player is mounted.
 *
 * `count` and `cues` are the parse: a track was published and something that is not
 * ours built cues out of it. `showing`, `first` and `active` are the picture. The
 * commercial bindings report the first pair only, because without a licence there is
 * no source and so nothing to be on screen.
 */
export interface PlayerState {
  count: number;
  cues: number | null;
  /** Tracks currently on. Exactly one, for a player that renders through them. */
  showing?: number;
  /** Cues live at the current time. The only field that means text on screen. */
  active?: number;
  /** Start time of the first cue, or -1 when nothing has been published yet. */
  first?: number;
  error?: string;
}

declare global {
  interface Window {
    __pickFirst: () => Promise<void>;
    __state: () => PlayerState;
    __free: string[];
    __players: string[];
    __commercial: Commercial[];
    /** The media element the adapter wrote to, which is not always the one in the markup. */
    __video: () => HTMLVideoElement | null;
  }
}
