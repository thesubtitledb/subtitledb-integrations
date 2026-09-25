/**
 * The handle that exists before the code behind it does.
 *
 * Everything here is about the window between the call and the chunk landing. It is
 * short on a warm cache and long on a cold one over mobile data, and it is the only
 * part of the CDN distribution that behaves differently from every other way of using
 * these packages. A page that unmounts inside that window, or reads the handle inside
 * it, has to get the same answers it would get from a live handle.
 */
import type { AttachHandle } from '@subtitledb/players';
import { describe, expect, it, vi } from 'vitest';
import { deferHandle } from '../src/deferred.js';

/** A handle that records what was called on it, resolved on demand. */
function later() {
  const calls: string[] = [];
  const real = {
    player: { name: 'videojs', label: 'Video.js', untested: false, via: 'binding' },
    degraded: null,
    session: { requestCount: 1 },
    media: () => ({ tagName: 'VIDEO' }),
    refresh: async () => {
      calls.push('refresh');
      return { candidates: [{ id: 1 }] };
    },
    select: async (c: unknown) => {
      calls.push(`select:${(c as { id: number }).id}`);
    },
    tracks: () => [{ id: 1 }],
    current: () => ({ candidates: [{ id: 1 }] }),
    destroy: () => {
      calls.push('destroy');
    },
  };
  let release!: () => void;
  const arrived = new Promise<void>((r) => {
    release = r;
  });
  const handle = deferHandle(async () => {
    await arrived;
    return real as unknown as AttachHandle;
  });
  return { handle, calls, release, real };
}

describe('before the chunk lands', () => {
  it('reads the way a live handle reads before its first resolve', () => {
    const { handle } = later();
    // Both of these are states a real handle is genuinely in between attach and the
    // first resolve, which is why they are honest answers rather than stand-ins.
    expect(handle.tracks()).toEqual([]);
    expect(handle.current()).toBeNull();
  });

  it('says nothing it does not know', () => {
    const { handle } = later();
    // No invented player name. A page that logs handle.player would otherwise record
    // a guess as a fact, and the guess is the thing it asked us to find out.
    expect(handle.player).toBeNull();
    expect(handle.degraded).toBeNull();
    expect(handle.session).toBeNull();
    expect(handle.media()).toBeNull();
  });

  it('queues a refresh rather than dropping it', async () => {
    const { handle, calls, release } = later();
    const pending = handle.refresh();
    expect(calls).toEqual([]);
    release();
    await expect(pending).resolves.toEqual({ candidates: [{ id: 1 }] });
    expect(calls).toEqual(['refresh']);
  });

  it('queues a selection, which is a click the viewer already made', async () => {
    const { handle, calls, release } = later();
    // The realistic case is a page restoring a remembered choice as it mounts. A
    // dropped select there is a viewer whose language preference silently did not
    // apply.
    const pending = handle.select({ id: 7 } as never);
    release();
    await pending;
    expect(calls).toEqual(['select:7']);
  });
});

describe('after it lands', () => {
  it('answers from the real handle', async () => {
    const { handle, release } = later();
    release();
    await handle.ready;
    expect(handle.player?.name).toBe('videojs');
    expect(handle.session).toEqual({ requestCount: 1 });
    expect(handle.tracks()).toEqual([{ id: 1 }]);
    expect(handle.current()).toEqual({ candidates: [{ id: 1 }] });
    expect(handle.media()).toEqual({ tagName: 'VIDEO' });
  });

  it('calls straight through, with no promise in the way', async () => {
    const { handle, calls, release } = later();
    release();
    await handle.ready;
    await handle.refresh();
    expect(calls).toEqual(['refresh']);
  });
});

describe('destroy before it lands', () => {
  it('is remembered and applied on arrival', async () => {
    const { handle, calls, release } = later();
    // A component that mounts and unmounts inside the download window. Without this
    // the chunk arrives, attaches, and leaves a live session and its timers behind
    // with nothing holding the handle that could stop them.
    handle.destroy();
    expect(calls).toEqual([]);
    release();
    await handle.ready;
    expect(calls).toEqual(['destroy']);
  });

  it('and the handle still resolves, because the caller may be awaiting it', async () => {
    const { handle, release } = later();
    handle.destroy();
    release();
    await expect(handle.ready).resolves.toBeTruthy();
  });

  it('a second destroy after arrival is not a second teardown of the first', async () => {
    const { handle, calls, release } = later();
    handle.destroy();
    release();
    await handle.ready;
    handle.destroy();
    expect(calls).toEqual(['destroy', 'destroy']);
  });
});

describe('a load that fails', () => {
  it('does not become an unhandled rejection in the host page', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      // Nobody reads `ready`, which is the ordinary case for a fire-and-forget
      // attach in a snippet. Node reports an unhandled rejection against the page,
      // not against this package, and the page owner has no idea what it is.
      deferHandle(async () => {
        throw new Error('chunk 404');
      });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('but is still reported to anyone who does read it', async () => {
    const handle = deferHandle(async () => {
      throw new Error('chunk 404');
    });
    await expect(handle.ready).rejects.toThrow('chunk 404');
  });

  it('and the synchronous readers keep answering rather than throwing', async () => {
    const handle = deferHandle(async () => {
      throw new Error('chunk 404');
    });
    await handle.ready.catch(() => {});
    expect(handle.tracks()).toEqual([]);
    expect(handle.current()).toBeNull();
    expect(handle.player).toBeNull();
    expect(() => handle.destroy()).not.toThrow();
  });
});
