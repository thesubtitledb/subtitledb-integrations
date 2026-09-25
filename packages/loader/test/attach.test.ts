/**
 * Which chunk a target needs, and what happens after it lands.
 *
 * The chunk fixtures are real modules on disk, imported through the real code path.
 * Nothing here stubs the dynamic import, because the dynamic import is the thing
 * being tested: the loader builds its specifier at runtime precisely so no bundler
 * can follow it, and a test that intercepted it would be testing a different program.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const FIXTURES = new URL('./fixtures/', import.meta.url).href;

/** A video element the way the probe duck-types one, in a chain of classed parents. */
function video(classes: string[] = [], own = ''): unknown {
  let node: Record<string, unknown> = {
    tagName: 'VIDEO',
    className: own,
    addEventListener() {},
    parentElement: null,
  };
  const el = node;
  for (const cls of classes) {
    const parent: Record<string, unknown> = { className: cls, parentElement: null };
    node.parentElement = parent;
    node = parent;
  }
  return el;
}

/** A fresh copy of the loader, with the chunk cache and the page guard both empty. */
async function fresh() {
  vi.resetModules();
  // The guard defines its slot writable:false, so this has to be a delete. Assigning
  // to it throws, which is the property the guard is there for.
  Reflect.deleteProperty(globalThis, '__subtitledb__');
  const base = await import('../src/base.js');
  base.setBasePath(FIXTURES);
  const attach = await import('../src/attach.js');
  const engine = await import('./fixtures/engine.mjs');
  const players = await import('./fixtures/players.mjs');
  engine.calls.length = 0;
  players.calls.length = 0;
  return { ...attach, engine, players };
}

describe('needsBindings', () => {
  it('a bare video element does not need them', async () => {
    const { needsBindings } = await fresh();
    expect(needsBindings(video(), {})).toBe(false);
  });

  it('a player object does', async () => {
    const { needsBindings } = await fresh();
    expect(needsBindings({ addRemoteTextTrack() {} }, {})).toBe(true);
  });

  it('a named binding does, even on a bare element', async () => {
    const { needsBindings } = await fresh();
    expect(needsBindings(video(), { player: 'videojs' })).toBe(true);
  });

  it('and so does an element a player has visibly mounted', async () => {
    const { needsBindings } = await fresh();
    // The one that matters. Video.js has taken this element over, so the element
    // path would publish a track it renders nothing from and report success.
    expect(needsBindings(video(['video-js'], 'vjs-tech'), {})).toBe(true);
    expect(needsBindings(video(['plyr']), {})).toBe(true);
  });

  it('null and undefined are not video elements', async () => {
    const { needsBindings } = await fresh();
    expect(needsBindings(null, {})).toBe(true);
    expect(needsBindings(undefined, {})).toBe(true);
  });
});

describe('attach fetches the smaller half when it can', () => {
  it('a bare video loads the element chunk and not the bindings', async () => {
    const { attach, engine, players } = await fresh();
    const handle = attach(video(), {});
    await handle.ready;
    expect(engine.calls).toHaveLength(1);
    expect(players.calls).toHaveLength(0);
  });

  it('a player object loads the bindings', async () => {
    const { attach, engine, players } = await fresh();
    const handle = attach({ addRemoteTextTrack() {} }, {});
    await handle.ready;
    expect(players.calls).toHaveLength(1);
    expect(engine.calls).toHaveLength(0);
  });

  it('a mounted element loads the bindings rather than taking the short path', async () => {
    const { attach, engine, players } = await fresh();
    const handle = attach(video(['video-js'], 'vjs-tech'), {});
    await handle.ready;
    expect(players.calls).toHaveLength(1);
    expect(engine.calls).toHaveLength(0);
  });

  it('two attaches in the same tick share one request', async () => {
    const { attach, engine } = await fresh();
    const a = attach(video(), {});
    const b = attach(video(), {});
    await Promise.all([a.ready, b.ready]);
    // Two attaches, two calls into the chunk, one module.
    expect(engine.calls).toHaveLength(2);
    expect(a.player?.name).toBe('native');
    expect(b.player?.name).toBe('native');
  });
});

describe('what the chunk is handed', () => {
  it('a client name naming the release, so the API logs can tell CDN traffic apart', async () => {
    const { attach, engine } = await fresh();
    await attach(video(), {}).ready;
    expect(engine.calls[0].options.clientName).toBe('cdn/0.0.0-test');
  });

  it('and the page can override it, along with everything else', async () => {
    const { attach, engine } = await fresh();
    await attach(video(), { clientName: 'mine', languages: ['fr'] }).ready;
    expect(engine.calls[0].options.clientName).toBe('mine');
    expect(engine.calls[0].options.languages).toEqual(['fr']);
  });
});

describe('a chunk that does not answer', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('says what it asked for, because the browser will not', async () => {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, '__subtitledb__');
    const base = await import('../src/base.js');
    base.setBasePath(new URL('./nowhere/', import.meta.url).href);
    const { attach } = await import('../src/attach.js');

    const handle = attach(video(), {});
    // A real 404 comes back as HTML and fails as a module parse error naming
    // neither this package nor the URL, which is why the message is built here.
    await expect(handle.ready).rejects.toThrow(/could not load .*engine\.mjs/);
    await expect(handle.ready).rejects.toThrow(/setBasePath/);
  });

  it('and the next attempt is allowed to try again', async () => {
    vi.resetModules();
    Reflect.deleteProperty(globalThis, '__subtitledb__');
    const base = await import('../src/base.js');
    base.setBasePath(new URL('./nowhere/', import.meta.url).href);
    const { attach } = await import('../src/attach.js');
    const { resetChunks } = await import('../src/chunks.js');

    await expect(attach(video(), {}).ready).rejects.toThrow();
    // The failed promise must not be the cached one: a page that recovers by
    // pointing setBasePath somewhere real would otherwise keep getting the old
    // failure back forever.
    resetChunks();
    base.setBasePath(FIXTURES);
    await expect(attach(video(), {}).ready).resolves.toBeTruthy();
  });
});
