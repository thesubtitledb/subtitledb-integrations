/**
 * Where the rest of the code is.
 *
 * This is the one thing in this package that cannot go wrong quietly, so it is the
 * first file. A classic `<script>` resolves `import()` against the **page**, not
 * against the script: a loader served from cdn.thesubtitledb.org and included by
 * example.com would ask example.com for its own chunks, get that site's HTML 404 page
 * back with an HTML content type, and fail with a module parse error that names
 * neither this package nor the real cause. Every host page would break the same way.
 *
 * `document.currentScript` is only non-null while a script's top level is running, so
 * it is read on import and never again. Anything that waits for a call, an event or
 * even a microtask has already lost it.
 */

/**
 * The absolute base stamped in by build.mjs, used when nothing else answers: an
 * inlined bundle, a `<script>` element built by hand with no `src`, or a worker.
 * Overwritten per build so `/latest/` and `/v/x.y.z/` each name their own tree.
 */
declare const __SDB_BASE__: string;

/**
 * True in the `/latest/` build only, and the reason that build is safe.
 *
 * `/latest/subtitle-helper.js` is overwritten on every release; the chunks under `/v/x.y.z/`
 * never are. If the latest entry took its base from its own directory it would ask
 * for chunks under `/latest/`, which would have to be overwritten too, and a browser
 * holding a cached entry from ten minutes ago would then pair it with chunks from a
 * different release. Two versions of the bindings on one page share neither
 * module-level WeakMap they depend on. So the mutable entry is pinned at build time
 * to the immutable tree it was built from, and only the versioned entry, which cannot
 * go stale against anything, is free to work out where it lives.
 */
declare const __SDB_PIN__: boolean;

/** Captured on import. See the note above; moving this line breaks the package. */
const FROM_SCRIPT: string = (() => {
  try {
    const doc = (globalThis as { document?: { currentScript?: { src?: unknown } | null } })
      .document;
    const src = doc?.currentScript?.src;
    return typeof src === 'string' ? src : '';
  } catch {
    return '';
  }
})();

let override = '';

/** The directory part of a URL, keeping the trailing slash and dropping any query. */
export function dirOf(url: string): string {
  const clean = url.split('#')[0]?.split('?')[0] ?? '';
  const cut = clean.lastIndexOf('/');
  return cut < 0 ? '' : clean.slice(0, cut + 1);
}

/** Always exactly one trailing slash, so joining is concatenation and nothing else. */
export function withSlash(path: string): string {
  if (!path) return '';
  return path.endsWith('/') ? path : `${path}/`;
}

/**
 * Point the loader at a different copy of the chunks.
 *
 * For self-hosting, and for a page whose CSP names one origin for scripts. Must be
 * called before the first attach: a chunk already requested is not re-requested.
 */
export function setBasePath(path: string): void {
  override = withSlash(String(path ?? ''));
}

/**
 * @param moduleUrl `import.meta.url`, passed by the ESM entry only. The IIFE build
 * has no import.meta, which is why this is an argument rather than read here.
 */
export function basePath(moduleUrl?: string): string {
  if (override) return override;
  if (__SDB_PIN__) return withSlash(__SDB_BASE__);
  const own = moduleUrl || FROM_SCRIPT;
  const dir = own ? dirOf(own) : '';
  return withSlash(dir || __SDB_BASE__);
}
