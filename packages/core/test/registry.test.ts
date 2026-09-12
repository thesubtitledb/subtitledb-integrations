import { describe, expect, it } from 'vitest';
import type { SubtitleDbHandle } from '../src/handle.js';
import { handleFor, handleForAny, registerHandle } from '../src/registry.js';

/**
 * A handle is a big interface and none of it matters here. What the registry does is
 * key objects to one value and clean up on destroy, so the stub is a destroy hook
 * with the rest cast on.
 *
 * The counter lives outside the object on purpose: registerHandle returns a copy, so
 * a count kept as a property of the handle would be snapshotted at registration and
 * the assertion would read zero forever while the code under test worked fine.
 */
function stub(onDestroy: () => void = () => {}): SubtitleDbHandle {
  return { destroy: onDestroy } as unknown as SubtitleDbHandle;
}

describe('the shared handle registry', () => {
  it('answers with one handle for every reference to the same player', () => {
    // The wrapper the page held, the instance inside it and the element underneath
    // are three references to one attachment. When they were three private maps, one
    // per package, a <video> reached through @subtitledb/players and then through
    // @subtitledb/html5 got two handles and two sessions on one element.
    const wrapper = { player: null as unknown };
    const player = {};
    const video = {};
    const handle = stub();

    const got = registerHandle(handle, [wrapper, player, video]);
    expect(handleFor(wrapper)).toBe(got);
    expect(handleFor(player)).toBe(got);
    expect(handleFor(video)).toBe(got);
    expect(handleForAny([{}, video])).toBe(got);
  });

  it('releases every key it took, so a page can attach again after destroy', () => {
    const player = {};
    const video = {};
    let destroyed = 0;
    const got = registerHandle(
      stub(() => {
        destroyed++;
      }),
      [player, video],
    );

    got.destroy();
    expect(handleFor(player)).toBeUndefined();
    expect(handleFor(video)).toBeUndefined();
    // Delegated exactly once, not once per key.
    expect(destroyed).toBe(1);
  });

  it('never detaches a live handle that took over one of its keys', () => {
    // The element outlives the player. A page that destroys an old player after
    // mounting a new one on the same <video> would otherwise wipe the new handle's
    // registration and leave the live session unreachable, with no error anywhere.
    const video = {};
    const first = registerHandle(stub(), [video]);
    const second = registerHandle(stub(), [video]);
    expect(handleFor(video)).toBe(second);

    first.destroy();
    expect(handleFor(video)).toBe(second);
  });

  it('ignores keys it cannot hold, rather than making the caller filter them', () => {
    // Callers pass whatever they have: media() is null before the element mounts,
    // and a binding may be named rather than an object. A WeakMap throws on both.
    const player = {};
    const got = registerHandle(stub(), [null, undefined, 'plyr', 42, player]);
    expect(handleFor(player)).toBe(got);
    expect(handleFor(null)).toBeUndefined();
    expect(handleFor('plyr')).toBeUndefined();
    got.destroy();
  });

  it('registers a function target, which is what a class-based player is', () => {
    const asFunction = () => {};
    const got = registerHandle(stub(), [asFunction]);
    expect(handleFor(asFunction)).toBe(got);
    got.destroy();
  });

  it('hands the handle straight back when there is nothing to key it on', () => {
    // No object among the keys means no registration, and the caller still gets a
    // working handle rather than a thrown error over a bookkeeping detail.
    const handle = stub();
    expect(registerHandle(handle, [null, 'x'])).toBe(handle);
  });
});
