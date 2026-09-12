/**
 * The cheap half of the ownership question, and the DOM walk both halves share.
 *
 * `ownerOf` in owners.ts answers "which player mounted this element" precisely, and
 * answering it costs the whole bindings module. Something that has to decide whether
 * to fetch that module cannot ask it first, so this is the part of the question that
 * is answerable from a tag name and some class names alone.
 *
 * `looksOwned` is deliberately over-eager. A false positive costs one wasted module
 * load. A false negative puts a native text track on a player that renders nothing
 * from one and reports success, which is the exact silent failure owners.ts exists to
 * prevent, so the two are not symmetric and this leans hard toward yes.
 *
 * `packages/players/test/marks.test.ts` pins the direction rather than the list:
 * every fixture `ownerOf` recognises, this recognises too. A marker added to owners.ts
 * without a class here fails there as soon as it has a fixture, which every marker
 * has.
 */

export { isVideoElement } from './probe.js';

type El = {
  classList?: { contains?: (name: string) => boolean };
  className?: unknown;
  parentElement?: unknown;
  parentNode?: { host?: unknown } | null;
};

/**
 * `className` as well as `classList`, because an SVG element and several test shims
 * have one and not the other, and a marker check that quietly answers false is worse
 * than no marker at all.
 */
export function hasClass(node: unknown, name: string): boolean {
  if (!node || typeof node !== 'object') return false;
  const el = node as El;
  try {
    if (el.classList?.contains?.(name)) return true;
    const raw = typeof el.className === 'string' ? el.className : '';
    return raw.split(/\s+/).includes(name);
  } catch {
    return false;
  }
}

/** The element and everything above it, across a shadow boundary, bounded. */
export function chain(video: unknown, max = 8): unknown[] {
  const out: unknown[] = [];
  let node: unknown = video;
  for (let i = 0; node && i <= max; i++) {
    out.push(node);
    const el = node as El;
    let next: unknown;
    try {
      next = el.parentElement ?? el.parentNode?.host ?? null;
    } catch {
      next = null;
    }
    node = next;
  }
  return out;
}

/**
 * Every class name any marker in owners.ts reads, flattened.
 *
 * Flat on purpose. Video.js is only really present when `vjs-tech` and `video-js`
 * are both there, and owners.ts checks for both, but either one alone is enough
 * reason to go and ask properly.
 */
export const OWNER_CLASSES: readonly string[] = [
  'vjs-tech',
  'video-js',
  'shaka-video',
  'shaka-video-container',
  'bitmovinplayer-container',
  'jwplayer',
  'plyr',
  'dplayer',
  'dplayer-video-wrap',
  'xgplayer',
  'op-player',
  'flowplayer',
];

/**
 * THEOplayer publishes no container class at all, so the only evidence it leaves on
 * the page is its own instance registry. Checking that the registry exists and holds
 * something is as cheap as a class check and is the only way this player is visible
 * without loading the bindings.
 */
function theoplayerMounted(): boolean {
  try {
    const ns = (globalThis as Record<string, unknown>).THEOplayer as
      | { players?: { length?: number } }
      | undefined;
    return Number(ns?.players?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * A real `<video>` tag, as opposed to something that only answers like one.
 *
 * `isVideoElement` duck types on `textTracks`, deliberately, so a media element from
 * an iframe or a test shim still counts. That is right for a probe looking for
 * somewhere to put a track and wrong for the question this file exists to answer.
 * Vidstack's `<media-player>` keeps a `textTracks` list of its own, so it passes that
 * check while being a player with a binding, and the element engine appending a
 * `<track>` to it is the same silent failure as any other.
 */
export function isVideoTag(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const tag = (node as { tagName?: unknown }).tagName;
  return typeof tag === 'string' && tag.toUpperCase() === 'VIDEO';
}

/** Might a player we know about have mounted this element? Errs toward yes. */
export function looksOwned(video: unknown): boolean {
  if (!video || typeof video !== 'object') return false;
  // Something that answered yes to isVideoElement without being tagged VIDEO is a
  // player wearing an element's shape, and only the bindings know which one. No
  // class walk can see this: the marker is the tag name itself.
  if (!isVideoTag(video)) return true;
  if (theoplayerMounted()) return true;
  for (const node of chain(video)) {
    for (const name of OWNER_CLASSES) {
      if (hasClass(node, name)) return true;
    }
  }
  return false;
}
