/**
 * Fetch a large file through the Cache API with progress.
 *
 * Models are tens of megabytes and the same on every page that uses them, so the
 * second visit must not download them again. The Cache API is the store that is
 * keyed by URL, shared across the origin's pages and workers, and evicted by the
 * browser under pressure rather than by us. A browser without it (a private window
 * in some builds) just fetches.
 */
export type Progress = (loaded: number, total: number) => void;

export async function fetchCached(
  url: string,
  cacheName: string,
  onProgress?: Progress,
): Promise<Uint8Array> {
  let cache: Cache | null = null;
  try {
    cache = (await caches?.open(cacheName)) ?? null;
    const hit = cache && (await cache.match(url));
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      onProgress?.(bytes.length, bytes.length);
      return bytes;
    }
  } catch {
    cache = null;
  }

  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url} answered ${res.status}`);
  const total = Number(res.headers.get('content-length') ?? 0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.length;
    onProgress?.(loaded, total || loaded);
  }
  const bytes = new Uint8Array(loaded);
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  if (cache) {
    // Stored as its own response, so a redirect or an opaque filter on the original
    // never stops it being readable next time.
    try {
      await cache.put(
        url,
        new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } }),
      );
    } catch {
      // Quota or a private window. The bytes are in hand either way.
    }
  }
  return bytes;
}

/** Whether `url` is already stored, without fetching. */
export async function isCached(url: string, cacheName: string): Promise<boolean> {
  try {
    const cache = await caches?.open(cacheName);
    return Boolean(cache && (await cache.match(url)));
  } catch {
    return false;
  }
}
