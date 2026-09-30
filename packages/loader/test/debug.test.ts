/**
 * The debugger's two ways in: the `debug` option of one attach, and
 * `SubtitleDB.debug()` for the whole page.
 *
 * Like attach.test.ts, the chunk is a real module on disk loaded through the real
 * dynamic import. The debugger chunk here is a fixture that records what the loader
 * asked of it; the debugger itself is tested in its own package.
 */
import { describe, expect, it, vi } from 'vitest';

const FIXTURES = new URL('./fixtures/', import.meta.url).href;
const KEY = 'sdbg_abcdefghijklmnopqrstuvwx';

function video(): Record<string, unknown> {
  return { tagName: 'VIDEO', className: '', addEventListener() {}, parentElement: null };
}

/** How many times the debugger fixture has been evaluated, across module resets. */
const loads = () => (globalThis as { __sdbDebugLoads?: number }).__sdbDebugLoads ?? 0;

const settle = () => new Promise((r) => setTimeout(r, 0));

/** A fresh copy of the loader and the engine fixture, and no debugger fixture yet. */
async function loader(base = FIXTURES) {
  vi.resetModules();
  Reflect.deleteProperty(globalThis, '__subtitledb__');
  const b = await import('../src/base.js');
  b.setBasePath(base);
  const attach = await import('../src/attach.js');
  const debug = await import('../src/debug.js');
  const { ANTISPAM_ID } = await import('../src/ids.js');
  const engine = await import('./fixtures/engine.mjs');
  engine.calls.length = 0;
  engine.order.length = 0;
  engine.hooks.attached = null;
  return { ...attach, ...debug, ANTISPAM_ID, engine };
}

/**
 * The same, with the debugger fixture imported before the loader asks for it, as
 * attach.test.ts does with the engine. Imported while the loader's own import of it
 * is still in flight, a test can be handed a second copy that records nothing.
 */
async function fresh(base = FIXTURES) {
  const l = await loader(base);
  const chunk = await import('./fixtures/debug.mjs');
  chunk.calls.length = 0;
  chunk.pages.length = 0;
  return { ...l, chunk };
}

describe('the debug option', () => {
  it('without a key, the debugger chunk is never fetched', async () => {
    const { attach } = await loader();
    const before = loads();
    await attach(video(), {}).ready;
    await settle();
    expect(loads()).toBe(before);
  });

  it('with one, it loads beside the engine and watches the element the attach settled on', async () => {
    const { attach, engine, ANTISPAM_ID, chunk } = await fresh();
    const { setBasePath } = await import('../src/base.js');
    const el = video();
    const handle = attach(el, { debug: KEY });
    // Anything asked for from here on comes from a release with no debugger in it, so
    // the debugger has to have been asked for already, beside the engine.
    setBasePath(new URL('./fixtures/no-debug/', import.meta.url).href);
    await handle.ready;
    const d = chunk;
    await vi.waitFor(() => expect(d.calls).toHaveLength(1));
    expect(d.calls[0]).toMatchObject({
      media: el,
      key: KEY,
      loadId: ANTISPAM_ID,
      player: 'native',
    });
    // The key is the loader's; the integration never sees it.
    expect(engine.calls[0]?.options).not.toHaveProperty('debug');
  });

  it("hands it what was resolved and selected, even from before it started, and the page's own handlers still run", async () => {
    const { attach, engine, chunk } = await fresh();
    const resolved = { hint: {}, title: null, tier: 'explicit-imdb', candidates: [] };
    const early = { candidate: { subtitle: { id: 7, language: 'fr' }, synthetic: false } };
    // Inside the attach, so before the debugger can possibly be running.
    engine.hooks.attached = (o: { onResolved(r: unknown): void; onSelected(s: unknown): void }) => {
      o.onResolved(resolved);
      o.onSelected(early);
    };
    const seen: unknown[] = [];
    const handle = attach(video(), {
      debug: KEY,
      onResolved: (r) => seen.push(r),
      onSelected: (s) => seen.push(s),
    });
    await handle.ready;
    const d = chunk;
    await vi.waitFor(() => expect(d.calls).toHaveLength(1));
    expect(d.calls[0]?.resolved).toEqual([resolved]);
    expect(d.calls[0]?.selected).toEqual([early]);

    const later = { candidate: { subtitle: { id: 8, language: 'en' }, synthetic: true } };
    engine.calls[0]?.options.onSelected(later);
    expect(d.calls[0]?.selected).toEqual([early, later]);
    expect(seen).toEqual([resolved, early, later]);
  });

  it("a debugger that throws never stops the page's own handlers, or its destroy", async () => {
    const { attach, engine } = await loader(
      new URL('./fixtures/broken-debug/', import.meta.url).href,
    );
    const broken = await import('./fixtures/broken-debug/debug.mjs');
    const seen: unknown[] = [];
    const handle = attach(video(), {
      debug: KEY,
      onResolved: (r) => seen.push(r),
      onSelected: (s) => seen.push(s),
    });
    await handle.ready;
    await vi.waitFor(() => expect(broken.calls).toHaveLength(1));
    const resolved = { hint: {}, title: null, tier: 'explicit-imdb', candidates: [] };
    const picked = { candidate: { subtitle: { id: 7, language: 'fr' }, synthetic: false } };
    engine.calls[0]?.options.onResolved(resolved);
    engine.calls[0]?.options.onSelected(picked);
    expect(seen).toEqual([resolved, picked]);
    handle.destroy();
    expect(engine.order).toEqual(['stop', 'destroy']);
  });

  it('destroy sends the final snapshot before the element is taken away', async () => {
    const { attach, engine, chunk } = await fresh();
    const handle = attach(video(), { debug: KEY });
    await handle.ready;
    const d = chunk;
    await vi.waitFor(() => expect(d.calls).toHaveLength(1));
    handle.destroy();
    expect(engine.order).toEqual(['stop', 'destroy']);
  });

  it('a destroy before the debugger starts means it never does', async () => {
    const { attach, chunk } = await fresh();
    const handle = attach(video(), { debug: KEY });
    handle.destroy();
    await handle.ready;
    await settle();
    await settle();
    const d = chunk;
    expect(d.calls).toHaveLength(0);
  });

  it('a key of the wrong shape goes to onError, and subtitles attach without it', async () => {
    const { attach, engine } = await loader();
    const before = loads();
    const errors: Error[] = [];
    const handle = attach(video(), {
      debug: `sdb_${'a'.repeat(36)}`,
      onError: (e) => errors.push(e),
    });
    await handle.ready;
    await settle();
    expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/debugger key/)]);
    expect(engine.calls).toHaveLength(1);
    expect(loads()).toBe(before);
  });

  it('a debugger chunk that will not load is reported, and subtitles attach without it', async () => {
    const { attach, engine } = await fresh(new URL('./fixtures/no-debug/', import.meta.url).href);
    const errors: Error[] = [];
    const handle = attach(video(), { debug: KEY, onError: (e) => errors.push(e) });
    await expect(handle.ready).resolves.toBeTruthy();
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    expect(errors[0]?.message).toMatch(/could not start the debugger/);
    expect(engine.calls).toHaveLength(1);
  });
});

describe('SubtitleDB.debug', () => {
  it('throws at once on a key of the wrong shape, rather than failing later out of sight', async () => {
    const { debug } = await fresh();
    for (const key of ['', 'sdbg_x', `sdb_${'a'.repeat(36)}`]) {
      expect(() => debug(key)).toThrow(TypeError);
    }
  });

  it('watches the page once its code is in, under the page-load id', async () => {
    const { debug, ANTISPAM_ID, chunk } = await fresh();
    const h = debug(KEY);
    await h.ready;
    const d = chunk;
    expect(d.pages).toEqual([{ key: KEY, loadId: ANTISPAM_ID, stopped: 0 }]);
    h.stop();
    expect(d.pages[0]?.stopped).toBe(1);
  });

  it('passes the page its hint, so every video is filed under what is playing', async () => {
    const { debug, ANTISPAM_ID, chunk } = await fresh();
    const hint = { imdbId: 'tt0133093' };
    await debug(KEY, { hint }).ready;
    expect(chunk.pages).toEqual([{ key: KEY, loadId: ANTISPAM_ID, hint, stopped: 0 }]);
  });

  it('stopped before its code arrives, it never starts', async () => {
    const { debug, chunk } = await fresh();
    const h = debug(KEY);
    h.stop();
    await h.ready;
    const d = chunk;
    expect(d.pages).toHaveLength(0);
  });

  it('says through ready when its code cannot load, and nothing else is disturbed', async () => {
    const { debug } = await fresh(new URL('./fixtures/no-debug/', import.meta.url).href);
    const h = debug(KEY);
    await expect(h.ready).rejects.toThrow(/could not load .*debug\.mjs/);
    expect(() => h.stop()).not.toThrow();
  });
});
