/**
 * One copy of the integration per page, whatever the page does to include it twice.
 *
 * This is not defensive tidiness. `PUBLISHED` in bindings.ts and `HANDLES` in
 * registry.ts are module-level WeakMaps, so two copies of the code do not share the
 * registry that makes "one player, one handle" true. Two copies means two sessions on
 * one video: the track list doubles, the traffic doubles, the captions menu lists
 * everything twice, and each copy's `destroy()` removes only its own tracks. Nothing
 * about that is visible in a unit test, and a CMS where a theme and a plugin both
 * embed the snippet is the ordinary case rather than a strange one.
 *
 * The first loader on the page wins for the whole page, including when the second is
 * a newer version. Deferring to whoever is already holding live handles is the only
 * choice that cannot orphan one.
 */
import type { AttachOptions } from '@subtitledb/players';
import type { DeferredHandle } from './deferred.js';

const KEY = '__subtitledb__';

export interface Incumbent {
  version: string;
  attach(target: unknown, options?: AttachOptions): DeferredHandle;
}

type Host = Record<string, unknown>;

/**
 * Claim the page, or report who already has it.
 *
 * Called once at import. Returns undefined when this copy is the first, and the
 * incumbent when it is not.
 */
export function claim(mine: Incumbent): Incumbent | undefined {
  let host: Host;
  try {
    host = globalThis as unknown as Host;
  } catch {
    return undefined;
  }
  const held = host[KEY] as Incumbent | undefined;
  if (held && typeof held.attach === 'function') return held;
  try {
    Object.defineProperty(host, KEY, {
      value: mine,
      writable: false,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // A frozen global, or a page that defined the property itself. Not reachable
    // through anything this package does, and not worth failing an attach over.
  }
  return undefined;
}

/** What the second copy tells the page, once, through the call that found out. */
export function mismatch(mine: string, theirs: string): string {
  return (
    `SubtitleDB ${mine} loaded on a page already running ${theirs}. ` +
    'The first one handles this attach: two copies do not share the registry that ' +
    'keeps one player to one handle, and would put two sessions on the same video. ' +
    'Include one version.'
  );
}
