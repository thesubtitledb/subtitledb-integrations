import type { SubtitleDbHandle } from './handle.js';

/**
 * Every live handle, by every object that identifies it.
 *
 * There were three of these, one private to each adapter, and the split was not
 * harmless. `@subtitledb/players` attaching to a bare `<video>` delegates to
 * `@subtitledb/html5`, so that element ended up in two maps holding two different
 * handles, and which one a caller got back depended on which package they happened
 * to ask. One map means one handle per player, whoever asks.
 *
 * A WeakMap so a page that drops a player without calling destroy() does not leak
 * it. That is a page bug, but it should not be our leak.
 */
const HANDLES = new WeakMap<object, SubtitleDbHandle>();

function keyable(v: unknown): v is object {
  return (typeof v === 'object' && v !== null) || typeof v === 'function';
}

/**
 * Register one handle under every object that should find it.
 *
 * Several keys, not one, because a single player is reachable by several names: the
 * wrapper the page held, the instance inside it, and the media element underneath.
 * All of them have to answer with the same handle or "attached twice" becomes a
 * matter of which reference the second caller happened to have. Duplicate and
 * non-object keys are ignored rather than rejected, so callers can pass whatever
 * they have without testing it first.
 *
 * The returned handle owns its own removal: `destroy()` clears every key it was
 * registered under before delegating. Clearing first is what makes React's simulated
 * StrictMode unmount survivable, because the second effect then finds nothing and
 * builds a fresh handle rather than returning a dead one.
 *
 * The returned handle is a copy, so a plain data property on `handle` is snapshotted
 * here and later writes to it are invisible to every caller. That is fine for what
 * handles carry today, all of it either frozen (`player`) or a reference whose target
 * is what changes (`session`), and it is the reason anything that can change over the
 * life of an attachment has to be a method reading closure state rather than a field
 * written after the fact.
 */
export function registerHandle<H extends SubtitleDbHandle>(handle: H, keys: unknown[]): H {
  const objs = [...new Set(keys.filter(keyable))];
  if (objs.length === 0) return handle;

  const registered: H = {
    ...handle,
    destroy() {
      // Only drop keys still pointing at this handle. A key re-registered by a later
      // attach belongs to that handle now, and deleting it here would silently
      // detach a live session that this one has nothing to do with.
      for (const k of objs) {
        if (HANDLES.get(k) === registered) HANDLES.delete(k);
      }
      handle.destroy();
    },
  };

  for (const k of objs) HANDLES.set(k, registered);
  return registered;
}

/** The live handle for this player, element or wrapper, if it has one. */
export function handleFor(key: unknown): SubtitleDbHandle | undefined {
  return keyable(key) ? HANDLES.get(key) : undefined;
}

/**
 * The first registered handle among these keys.
 *
 * Used at the top of every attach: a wrapper, the player inside it and the element
 * underneath are all asked before deciding this is a new attach.
 */
export function handleForAny(keys: unknown[]): SubtitleDbHandle | undefined {
  for (const k of keys) {
    const h = handleFor(k);
    if (h) return h;
  }
  return undefined;
}
