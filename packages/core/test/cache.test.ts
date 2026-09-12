import { describe, expect, it } from 'vitest';
import { SingleFlightCache } from '../src/cache.js';

describe('SingleFlightCache', () => {
  it('returns a cached value without re-running the loader', async () => {
    let runs = 0;
    const c = new SingleFlightCache<number>();
    const load = async () => {
      runs++;
      return 42;
    };
    expect(await c.resolve('k', load)).toBe(42);
    expect(await c.resolve('k', load)).toBe(42);
    expect(runs).toBe(1);
  });

  it('collapses concurrent identical lookups into one call', async () => {
    // This is the property that protects an API with no rate limiting from an
    // eagerly loading plugin: several players resolving the same title in the same
    // tick must produce one request, not several.
    let runs = 0;
    const c = new SingleFlightCache<string>();
    const load = () =>
      new Promise<string>((resolve) => {
        runs++;
        setTimeout(() => resolve('v'), 10);
      });

    const all = await Promise.all([
      c.resolve('same', load),
      c.resolve('same', load),
      c.resolve('same', load),
      c.resolve('same', load),
    ]);

    expect(all).toEqual(['v', 'v', 'v', 'v']);
    expect(runs).toBe(1);
  });

  it('expires entries once the ttl passes', async () => {
    let now = 1000;
    let runs = 0;
    const c = new SingleFlightCache<number>({ ttlMs: 100, now: () => now });
    const load = async () => ++runs;

    expect(await c.resolve('k', load)).toBe(1);
    now = 1050;
    expect(await c.resolve('k', load)).toBe(1);
    now = 1200;
    expect(await c.resolve('k', load)).toBe(2);
  });

  it('does not cache a rejection, so one blip is not a ttl-long outage', async () => {
    let runs = 0;
    const c = new SingleFlightCache<string>();
    const load = async () => {
      runs++;
      if (runs === 1) throw new Error('blip');
      return 'ok';
    };

    await expect(c.resolve('k', load)).rejects.toThrow('blip');
    expect(await c.resolve('k', load)).toBe('ok');
    expect(runs).toBe(2);
  });

  it('evicts the oldest entry when full', async () => {
    const c = new SingleFlightCache<number>({ maxEntries: 2 });
    await c.resolve('a', async () => 1);
    await c.resolve('b', async () => 2);
    await c.resolve('c', async () => 3);

    expect(c.size).toBe(2);
    expect(c.get('a')).toBeUndefined();
    expect(c.get('c')).toBe(3);
  });

  it('clears both entries and in-flight state', async () => {
    const c = new SingleFlightCache<number>();
    await c.resolve('a', async () => 1);
    c.clear();
    expect(c.size).toBe(0);
    expect(c.get('a')).toBeUndefined();
  });
});

describe('in-flight visibility', () => {
  it('reports a call that is still in the air, so nothing charges for it twice', async () => {
    // The budget in SubtitleSession counts network calls. Single-flight means a
    // duplicate resolve makes none, and the only way to know that is to ask.
    const cache = new SingleFlightCache<string>();
    let release = () => {};
    const slow = new Promise<string>((r) => {
      release = () => r('value');
    });

    expect(cache.pending('k')).toBe(false);
    const first = cache.resolve('k', () => slow);
    expect(cache.pending('k')).toBe(true);

    release();
    await first;
    expect(cache.pending('k')).toBe(false);
    expect(cache.get('k')).toBe('value');
  });
});
