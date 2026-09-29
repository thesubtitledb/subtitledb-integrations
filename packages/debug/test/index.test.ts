/**
 * The two ways in, as a page uses them: one element, or every element on the page.
 *
 * These run through the real sender with fetch and localStorage replaced, because
 * what matters here is what the page sees: which elements are watched, how many
 * times, and what lands in its storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MARK, resetPlays } from '../src/collector.js';
import { OUTBOX, resetDebug, toLoadId, VISITOR, watch, watchPage } from '../src/index.js';
import { FakeVideo, KEY, memoryStorage } from './fakes.js';

const UUID = '0a1b2c3d-4e5f-6071-8293-a4b5c6d7e8f9';

let storage: ReturnType<typeof memoryStorage>;
let written: Set<string>;
let posts: string[];

beforeEach(() => {
  resetDebug();
  resetPlays();
  storage = memoryStorage();
  written = new Set();
  const set = storage.setItem;
  storage.setItem = (k: string, v: string) => {
    written.add(k);
    set(k, v);
  };
  posts = [];
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      posts.push(String(init.body));
      return { ok: true, status: 204, headers: new Headers() } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Metadata, play, first frame. */
function start(v: FakeVideo): void {
  v.duration = 60;
  v.readyState = 4;
  v.emit('loadedmetadata');
  v.paused = false;
  v.emit('play');
  v.emit('playing');
}

const el = (v: FakeVideo) => v as unknown as HTMLVideoElement;

describe('watch', () => {
  it('refuses anything but a debugger key, before touching the page', () => {
    for (const key of ['', 'sdbg_short', `sdb_${'a'.repeat(36)}`, `sdbg_${'a'.repeat(23)}!`]) {
      expect(() => watch(el(new FakeVideo()), { key, loadId: UUID })).toThrow(TypeError);
    }
    expect(posts).toHaveLength(0);
    expect(written.size).toBe(0);
  });

  it('writes the visitor id and the outbox to storage, and nothing else', async () => {
    const v = new FakeVideo();
    watch(el(v), { key: KEY, loadId: UUID });
    start(v);
    v.paused = true;
    v.emit('pause');
    await settle();
    expect(posts.length).toBeGreaterThan(0);
    expect([...written].sort()).toEqual([OUTBOX, VISITOR].sort());
    // Every snapshot was answered, so the outbox is gone again.
    expect(storage.getItem(OUTBOX)).toBeNull();
    const body = JSON.parse(posts[0] ?? '{}');
    expect(body.l).toBe('0A1B2C3D4E5F6071');
    expect(body.u).toBe(storage.getItem(VISITOR)?.split('.')[0]);
  });

  it('watches an element once, however many times it is asked, and marks it for any copy', () => {
    const v = new FakeVideo();
    const first = watch(el(v), { key: KEY, loadId: UUID });
    expect(watch(el(v), { key: KEY, loadId: UUID })).toBe(first);
    expect((v as unknown as Record<symbol, unknown>)[Symbol.for('subtitledb.debug')]).toBe(first);
    start(v);
    expect(posts).toHaveLength(1);
  });

  it('leaves alone an element another copy watches through an interface it does not know', () => {
    const v = new FakeVideo();
    (v as unknown as Record<symbol, unknown>)[MARK] = { version: 99 };
    const w = watch(el(v), { key: KEY, loadId: UUID });
    w.context({ imdb: 1 });
    w.select(null);
    start(v);
    w.stop();
    expect(posts).toHaveLength(0);
  });

  it('lets go of the element on stop, so it can be watched again', () => {
    const v = new FakeVideo();
    const first = watch(el(v), { key: KEY, loadId: UUID });
    first.stop();
    expect(MARK in v).toBe(false);
    expect(watch(el(v), { key: KEY, loadId: UUID })).not.toBe(first);
  });

  it('sends what an earlier page load left unanswered, once', async () => {
    storage.setItem(
      OUTBOX,
      JSON.stringify([{ i: 'FFFFFFFFFFFFFFFF:1', b: '{"left":1}', a: Date.now() }]),
    );
    watch(el(new FakeVideo()), { key: KEY, loadId: UUID });
    watch(el(new FakeVideo()), { key: KEY, loadId: UUID });
    await settle();
    expect(posts).toEqual(['{"left":1}']);
  });
});

describe('toLoadId', () => {
  it('is the first 16 hex characters of a UUID, and random for anything else', () => {
    expect(toLoadId(UUID)).toBe('0A1B2C3D4E5F6071');
    const made = toLoadId('not a uuid');
    expect(made).toMatch(/^[0-9A-F]{16}$/);
    expect(toLoadId('not a uuid')).not.toBe(made);
  });
});

/** Just enough of a document and a MutationObserver to add and remove videos. */
class FakeObserver {
  static last: FakeObserver | undefined;
  target: unknown = null;
  disconnected = false;
  constructor(
    readonly fn: (records: { addedNodes: unknown[]; removedNodes: unknown[] }[]) => void,
  ) {
    FakeObserver.last = this;
  }
  observe(target: unknown): void {
    this.target = target;
  }
  disconnect(): void {
    this.disconnected = true;
  }
  change(added: unknown[], removed: unknown[] = []): void {
    this.fn([{ addedNodes: added, removedNodes: removed }]);
  }
}

function page(videos: FakeVideo[]) {
  return {
    nodeName: '#document',
    documentElement: { nodeName: 'HTML' },
    querySelectorAll: () => videos,
  } as unknown as Document;
}

describe('watchPage', () => {
  beforeEach(() => {
    vi.stubGlobal('MutationObserver', FakeObserver);
  });

  it('watches every video on the page, and each one added later', () => {
    const a = new FakeVideo();
    const b = new FakeVideo();
    const p = watchPage({ key: KEY, loadId: UUID }, page([a, b]));
    expect(MARK in a && MARK in b).toBe(true);

    const c = new FakeVideo();
    const d = new FakeVideo();
    const wrapper = { nodeName: 'DIV', querySelectorAll: () => [d] };
    FakeObserver.last?.change([c, wrapper]);
    expect(MARK in c && MARK in d).toBe(true);

    p.stop();
    expect(FakeObserver.last?.disconnected).toBe(true);
    expect([a, b, c, d].some((v) => MARK in v)).toBe(false);
  });

  it('leaves an element that is already watched to whoever watches it', () => {
    const attached = new FakeVideo();
    const w = watch(el(attached), { key: KEY, loadId: UUID });
    const p = watchPage({ key: KEY, loadId: UUID }, page([attached]));
    p.stop();
    expect((attached as unknown as Record<symbol, unknown>)[MARK]).toBe(w);
  });

  it('sends the final snapshot of a video taken off the page', () => {
    const a = new FakeVideo();
    watchPage({ key: KEY, loadId: UUID }, page([a]));
    start(a);
    const before = posts.length;
    a.isConnected = false;
    FakeObserver.last?.change([], [a]);
    expect(posts.length).toBe(before + 1);
    expect(MARK in a).toBe(false);
  });

  it('refuses anything but a debugger key', () => {
    expect(() => watchPage({ key: 'nope', loadId: UUID }, page([]))).toThrow(TypeError);
  });
});
