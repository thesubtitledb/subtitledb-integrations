/**
 * Finding the `<video>` inside an arbitrary player object.
 *
 * Every player in group one of docs/players.md keeps its media element on some
 * property, and they disagree about which: `video`, `media`, `$video`, `el`,
 * `domRef.player`, `core.activePlayback.el`, `getMedia()`. A binding names the path
 * it knows, and this is the fallback for the rest, including versions of a player
 * that moved the property.
 *
 * Probing is bounded and side-effect free: a fixed list of names, a fixed list of
 * zero-argument getters, a depth cap and a visited set. It never calls a method
 * that could start playback or mutate the player.
 */

/**
 * Duck typing, not `instanceof`. The adapters run against elements from other
 * realms (an iframe, a test shim) where `instanceof HTMLVideoElement` is false for
 * something that is, for every purpose here, a video element.
 */
export function isVideoElement(x: unknown): x is HTMLVideoElement {
  if (!x || typeof x !== 'object') return false;
  const el = x as { tagName?: unknown; textTracks?: unknown; addEventListener?: unknown };
  // Every branch requires addEventListener, because Clappr gives its playback and
  // container objects a tagName of 'video' and they are not elements. Without this
  // the probe hands back a plain object and the adapter fails on first use.
  if (typeof el.addEventListener !== 'function') return false;
  if (typeof el.tagName === 'string' && el.tagName.toUpperCase() === 'VIDEO') return true;
  return 'textTracks' in el;
}

const PROPS = [
  'video',
  'media',
  '$video',
  'videoEl',
  'mediaEl',
  'el',
  'element',
  'node',
  'originalNode',
  'player',
  'core',
  'activePlayback',
  'playback',
  'container',
  'mediaControl',
  'domRef',
  'tech_',
];

const GETTERS = [
  'getMedia',
  'getElement',
  'getVideo',
  'getContainer',
  'getMediaElement',
  'getVideoElement',
];

function query(x: unknown): HTMLVideoElement | null {
  const el = x as { querySelector?: (s: string) => unknown };
  if (typeof el?.querySelector !== 'function') return null;
  const found = el.querySelector('video');
  return isVideoElement(found) ? found : null;
}

/** Depth-first, breadth-preferring: check every candidate at this level first. */
export function findVideo(target: unknown, maxDepth = 4): HTMLVideoElement | null {
  const seen = new Set<unknown>();

  const walk = (node: unknown, depth: number): HTMLVideoElement | null => {
    if (!node || typeof node !== 'object' || seen.has(node) || depth > maxDepth) return null;
    seen.add(node);

    if (isVideoElement(node)) return node;

    const direct = query(node);
    if (direct) return direct;

    const obj = node as Record<string, unknown>;
    const next: unknown[] = [];

    for (const key of PROPS) {
      const value = obj[key];
      if (!value || typeof value !== 'object') continue;
      if (isVideoElement(value)) return value;
      next.push(value);
    }

    for (const key of GETTERS) {
      const fn = obj[key];
      if (typeof fn !== 'function') continue;
      let value: unknown;
      try {
        value = (fn as () => unknown).call(obj);
      } catch {
        // A getter that throws before the player is ready is not an error here.
        continue;
      }
      if (isVideoElement(value)) return value;
      if (value && typeof value === 'object') next.push(value);
    }

    // Then anything else the object owns. Own enumerable keys only, so a getter
    // defined on a prototype is never invoked, and capped so a player holding a
    // large state tree cannot turn detection into a graph walk.
    let budget = 40;
    for (const key of Object.keys(obj)) {
      if (budget-- <= 0) break;
      if (PROPS.includes(key)) continue;
      let value: unknown;
      try {
        value = obj[key];
      } catch {
        continue;
      }
      if (isVideoElement(value)) return value;
      if (value && typeof value === 'object') next.push(value);
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
 * Property present, whatever it currently holds.
 *
 * Detection cannot require a player's media element to exist: `new Plyr(el)` returns
 * with `media` still null, and a page that attaches on the next line was told it had
 * no player at all. `in` also never invokes a getter, so a property that throws
 * before the player is ready costs nothing here.
 */
export function hasKey(target: unknown, ...members: string[]): boolean {
  if (!target || typeof target !== 'object') return false;
  return members.every((m) => m in (target as object));
}

export function hasFn(target: unknown, ...members: string[]): boolean {
  if (!target || typeof target !== 'object') return false;
  const obj = target as Record<string, unknown>;
  return members.every((m) => typeof obj[m] === 'function');
}
