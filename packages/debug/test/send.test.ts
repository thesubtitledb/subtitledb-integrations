/**
 * Getting a snapshot there, and what the browser keeps until it has.
 *
 * The post has to be a CORS simple request carrying no cookies, and what is kept in
 * storage has to be exactly two keys and small. A page owner who reads their
 * storage panel after turning the debugger on should find nothing they would not
 * have agreed to.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ENDPOINT, OUTBOX, parseRule, Sender, VISITOR } from '../src/send.js';
import { visitorId } from '../src/visitor.js';
import { memoryStorage } from './fakes.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = 1_790_000_000_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A network whose answers a test sets: refused (not ok), failed (throws), or a trace rule. */
function net() {
  const posts: { url: string; init: RequestInit }[] = [];
  const state = {
    ok: true,
    fail: (_body: string) => false,
    rule: null as string | null,
  };
  const fetch = (async (url: string, init: RequestInit) => {
    posts.push({ url, init });
    if (state.fail(String(init.body))) throw new TypeError('Failed to fetch');
    return {
      ok: state.ok,
      status: state.ok ? 204 : 500,
      headers: new Headers(state.rule === null ? {} : { 'x-sdb-trace': state.rule }),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { posts, state, fetch };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function outbox(storage: Storage): { i: string; b: string; a: number }[] {
  return JSON.parse(storage.getItem(OUTBOX) ?? '[]');
}

describe('the post', () => {
  it('is a simple request: text, no custom header, no cookies, and it outlives the page', () => {
    const n = net();
    new Sender({ fetch: n.fetch, storage: memoryStorage() }).send('{"v":1}', 'L:1');
    expect(n.posts).toHaveLength(1);
    const { url, init } = n.posts[0] ?? { url: '', init: {} };
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"v":1}');
    expect(init.credentials).toBe('omit');
    expect(init.keepalive).toBe(true);
    expect(init.mode).toBe('cors');
    // A string body with no headers goes as text/plain, which needs no preflight.
    expect(init.headers).toBeUndefined();
  });

  it('never falls back to a beacon while fetch works, because a beacon carries cookies', async () => {
    const n = net();
    const beacon = vi.fn(() => true);
    new Sender({ fetch: n.fetch, beacon, storage: memoryStorage() }).send('{}', 'L:1');
    await settle();
    expect(beacon).not.toHaveBeenCalled();
  });

  it('nor after a post that failed or was refused: that one waits in the outbox', async () => {
    const n = net();
    const storage = memoryStorage();
    const beacon = vi.fn(() => true);
    n.state.fail = () => true;
    new Sender({ fetch: n.fetch, beacon, storage }).send('{"s":0}', 'A:1');
    n.state.fail = () => false;
    n.state.ok = false;
    new Sender({ fetch: n.fetch, beacon, storage }).send('{"s":0}', 'A:2');
    await settle();
    expect(beacon).not.toHaveBeenCalled();
    expect(outbox(storage).map((e) => e.i)).toEqual(['A:1', 'A:2']);
  });

  it('uses a beacon where fetch is missing, and one where it throws before sending', async () => {
    vi.stubGlobal('fetch', undefined);
    const storage = memoryStorage();
    const beacon = vi.fn(() => true);
    new Sender({ beacon, storage }).send('{"a":1}', 'L:1');
    expect(beacon).toHaveBeenCalledWith(ENDPOINT, '{"a":1}');
    expect(storage.getItem(OUTBOX)).toBeNull();

    const refused = vi.fn(() => false);
    const blocked = (() => {
      throw new TypeError('blocked by the page');
    }) as unknown as typeof fetch;
    new Sender({ fetch: blocked, beacon: refused, storage }).send('{"a":2}', 'L:2');
    expect(refused).toHaveBeenCalledOnce();
    // The browser would not queue it, so it waits in the outbox for the next page.
    expect(outbox(storage).map((e) => e.i)).toEqual(['L:2']);
  });

  it('survives a beacon that throws over its quota', () => {
    vi.stubGlobal('fetch', undefined);
    const beacon = () => {
      throw new Error('quota');
    };
    expect(() => new Sender({ beacon, storage: memoryStorage() }).send('{}', 'L:1')).not.toThrow();
  });
});

describe('the outbox', () => {
  it('holds a snapshot until it is answered, then lets it go', async () => {
    const n = net();
    const storage = memoryStorage();
    new Sender({ fetch: n.fetch, storage }).send('{"s":0}', 'L:1');
    expect(outbox(storage).map((e) => e.b)).toEqual(['{"s":0}']);
    await settle();
    expect(storage.getItem(OUTBOX)).toBeNull();
  });

  it('keeps one that failed or was refused, and the next page load sends it once', async () => {
    const n = net();
    const storage = memoryStorage();
    n.state.fail = () => true;
    new Sender({ fetch: n.fetch, storage, epoch: () => T0 }).send('{"s":1}', 'A:1');
    n.state.fail = () => false;
    n.state.ok = false;
    new Sender({ fetch: n.fetch, storage, epoch: () => T0 }).send('{"s":2}', 'A:2');
    await settle();
    expect(outbox(storage).map((e) => e.i)).toEqual(['A:1', 'A:2']);

    n.state.ok = true;
    n.posts.length = 0;
    const next = new Sender({ fetch: n.fetch, storage, epoch: () => T0 + 60_000 });
    next.flush('B');
    next.flush('B');
    expect(n.posts.map((p) => p.init.body)).toEqual(['{"s":1}', '{"s":2}']);
    await settle();
    expect(storage.getItem(OUTBOX)).toBeNull();
  });

  it("leaves this page load's own snapshots alone: they are still in flight", () => {
    const n = net();
    const storage = memoryStorage();
    n.state.fail = () => true;
    const s = new Sender({ fetch: n.fetch, storage });
    s.send('{}', 'A:1');
    n.posts.length = 0;
    new Sender({ fetch: n.fetch, storage }).flush('A');
    expect(n.posts).toHaveLength(0);
  });

  it('keeps the newest snapshot of at most five plays', async () => {
    const n = net();
    const storage = memoryStorage();
    n.state.fail = () => true;
    const s = new Sender({ fetch: n.fetch, storage });
    for (let p = 1; p <= 7; p++) s.send(`{"p":${p},"s":0}`, `A:${p}`);
    s.send('{"p":7,"s":1}', 'A:7');
    await settle();
    const kept = outbox(storage);
    expect(kept.map((e) => e.i)).toEqual(['A:3', 'A:4', 'A:5', 'A:6', 'A:7']);
    expect(kept.at(-1)?.b).toBe('{"p":7,"s":1}');
  });

  it('never lets the answer to an older snapshot clear a newer one of the same play', async () => {
    const n = net();
    const storage = memoryStorage();
    // The first arrives; the second, sent before the first was answered, does not.
    n.state.fail = (body) => body.includes('"s":1');
    const s = new Sender({ fetch: n.fetch, storage });
    s.send('{"s":0}', 'A:1');
    s.send('{"s":1}', 'A:1');
    await settle();
    expect(outbox(storage).map((e) => e.b)).toEqual(['{"s":1}']);
  });

  it('drops what is more than a day old unsent: it would be filed under the wrong day', () => {
    const n = net();
    const storage = memoryStorage();
    storage.setItem(
      OUTBOX,
      JSON.stringify([
        { i: 'A:1', b: '{"old":1}', a: T0 - DAY - 1 },
        { i: 'A:2', b: '{"new":1}', a: T0 - DAY + 60_000 },
      ]),
    );
    new Sender({ fetch: n.fetch, storage, epoch: () => T0 }).flush('B');
    expect(n.posts.map((p) => p.init.body)).toEqual(['{"new":1}']);
    expect(outbox(storage).map((e) => e.i)).toEqual(['A:2']);
  });

  it('shrugs off an outbox it cannot read', () => {
    const n = net();
    const storage = memoryStorage();
    storage.setItem(OUTBOX, '{not json');
    expect(() => new Sender({ fetch: n.fetch, storage }).flush('B')).not.toThrow();
    storage.setItem(OUTBOX, JSON.stringify([{ i: 1 }, null, 'x']));
    expect(() => new Sender({ fetch: n.fetch, storage }).flush('C')).not.toThrow();
    expect(n.posts).toHaveLength(0);
  });

  it('still posts where storage is blocked or missing, and nothing throws', async () => {
    const n = net();
    const storage = memoryStorage();
    storage.broken = true;
    expect(() => new Sender({ fetch: n.fetch, storage }).send('{}', 'A:1')).not.toThrow();
    new Sender({ fetch: n.fetch, storage: null }).send('{}', 'A:2');
    await settle();
    expect(n.posts).toHaveLength(2);
  });

  it('is the only key it writes', async () => {
    const n = net();
    const storage = memoryStorage();
    const written = new Set<string>();
    const set = storage.setItem;
    storage.setItem = (k: string, v: string) => {
      written.add(k);
      set(k, v);
    };
    n.state.fail = () => true;
    const s = new Sender({ fetch: n.fetch, storage });
    for (let p = 1; p <= 3; p++) s.send('{}', `A:${p}`);
    await settle();
    expect([...written]).toEqual([OUTBOX]);
  });
});

describe('the trace rule', () => {
  it('is learned from the answer, and a missing or unreadable one changes nothing', async () => {
    const n = net();
    const s = new Sender({ fetch: n.fetch, storage: null });
    expect(s.rule).toBe('problems');
    n.state.rule = 'all';
    s.send('{}', 'A:1');
    await settle();
    expect(s.rule).toBe('all');
    n.state.rule = '30';
    s.send('{}', 'A:1');
    await settle();
    expect(s.rule).toBe(30);
    n.state.rule = 'everything';
    s.send('{}', 'A:1');
    n.state.rule = null;
    s.send('{}', 'A:1');
    await settle();
    expect(s.rule).toBe(30);
  });

  it('reads the three names and a whole percentage, and nothing else', () => {
    expect(parseRule('none')).toBe('none');
    expect(parseRule('problems')).toBe('problems');
    expect(parseRule('all')).toBe('all');
    expect(parseRule('0')).toBe(0);
    expect(parseRule('100')).toBe(100);
    expect(parseRule('250')).toBe(100);
    for (const bad of [null, '', 'ALL', '1.5', '-1', '1000', ' 5'])
      expect(parseRule(bad)).toBeNull();
  });

  it('decides which plays keep a trace', () => {
    const s = new Sender({ fetch: net().fetch, storage: null });
    expect(s.wantsTrace(false, 'L', 1)).toBe(false);
    expect(s.wantsTrace(true, 'L', 1)).toBe(true);
    s.rule = 'none';
    expect(s.wantsTrace(true, 'L', 1)).toBe(false);
    s.rule = 'all';
    expect(s.wantsTrace(false, 'L', 1)).toBe(true);
    s.rule = 30;
    // Buckets 42 and 23, the vectors the receiving side pins.
    expect(s.wantsTrace(false, '0A1B2C3D4E5F6071', 1)).toBe(false);
    expect(s.wantsTrace(false, '0A1B2C3D4E5F6071', 2)).toBe(true);
    s.rule = 0;
    expect(s.wantsTrace(true, '0A1B2C3D4E5F6071', 3)).toBe(false);
  });
});

describe('the visitor id', () => {
  it('is 16 hex characters, kept for a year and then replaced', () => {
    const storage = memoryStorage();
    const id = visitorId(storage, T0);
    expect(id).toMatch(/^[0-9A-F]{16}$/);
    expect(storage.getItem(VISITOR)).toBe(`${id}.${T0}`);
    expect(visitorId(storage, T0 + 364 * DAY)).toBe(id);
    const next = visitorId(storage, T0 + 366 * DAY);
    expect(next).toMatch(/^[0-9A-F]{16}$/);
    expect(next).not.toBe(id);
    expect(storage.getItem(VISITOR)).toBe(`${next}.${T0 + 366 * DAY}`);
  });

  it('replaces anything stored under its name that is not one', () => {
    const storage = memoryStorage();
    for (const junk of ['junk', 'cafebabe0000feed.1', 'CAFEBABE0000FEED', 'CAFEBABE0000FEED.x']) {
      storage.setItem(VISITOR, junk);
      const id = visitorId(storage, T0);
      expect(id).toMatch(/^[0-9A-F]{16}$/);
      expect(storage.getItem(VISITOR)).toBe(`${id}.${T0}`);
    }
  });

  it('is left out where storage is blocked or missing, and nothing throws', () => {
    const storage = memoryStorage();
    storage.broken = true;
    expect(visitorId(storage, T0)).toBeUndefined();
    expect(visitorId(null, T0)).toBeUndefined();
  });

  it('is the only other key written', () => {
    const storage = memoryStorage();
    visitorId(storage, T0);
    expect([...storage.map.keys()]).toEqual([VISITOR]);
  });
});
