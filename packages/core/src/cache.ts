/**
 * TTL cache with single-flight.
 *
 * Single-flight is the part that matters. Because integrations resolve eagerly on
 * player init, a page with several players, or a player that fires its ready event
 * more than once, would otherwise issue the same search several times within a few
 * milliseconds. Collapsing concurrent identical lookups into one in-flight promise
 * is the cheapest protection the client side can offer an API that has no rate
 * limiting of its own yet.
 */

export interface CacheOptions {
  /** Milliseconds a resolved value stays fresh. Default 5 minutes. */
  ttlMs?: number;
  /** Hard cap on retained entries. Oldest insertions are evicted first. */
  maxEntries?: number;
  now?: () => number;
}

interface Entry<T> {
  value: T;
  expires: number;
}

export class SingleFlightCache<T> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(opts: CacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.maxEntries = opts.maxEntries ?? 200;
    this.now = opts.now ?? Date.now;
  }

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value;
  }

  /**
   * Is a call for this key already in the air? Single-flight means a second caller
   * costs no request, so anything counting requests has to be able to see that.
   */
  pending(key: string): boolean {
    return this.inflight.has(key);
  }

  set(key: string, value: T): void {
    // Map preserves insertion order, so the first key is the oldest write.
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
  }

  /**
   * Resolve `key`, running `fn` at most once for concurrent callers. A rejection is
   * never cached: the next caller retries. Caching failures would turn one blip into
   * a ttl-long outage for that key.
   */
  async resolve(key: string, fn: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;

    const pending = this.inflight.get(key);
    if (pending) return pending;

    const p = (async () => {
      try {
        const value = await fn();
        this.set(key, value);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, p);
    return p;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
