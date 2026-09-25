/**
 * Fetching the two halves of the integration, once each.
 *
 * The specifier is built at runtime from the base and a name stamped in at build
 * time. It has to be: a literal would be resolved and rewritten by whatever bundler a
 * host page runs, and a page that bundles this loader would then look for our chunks
 * inside its own output. Building the string here also means esbuild leaves the
 * `import()` alone rather than inlining the graph, which is the whole point.
 *
 * `latest/` and `v/x.y.z/` both stamp an exact version into the base, so a loader
 * never pairs itself with chunks from a different release. That is the failure this
 * layout exists to prevent: two versions of the bindings on one page share neither of
 * the module-level WeakMaps they rely on.
 */
import { basePath } from './base.js';

/** Filled in by build.mjs with the content-hashed names esbuild actually emitted. */
declare const __SDB_CHUNKS__: Record<'engine' | 'players' | 'transcribe', string>;

export type ChunkName = 'engine' | 'players' | 'transcribe';

type Engine = typeof import('@subtitledb/html5');
type Players = typeof import('@subtitledb/players');
type Transcribe = typeof import('@subtitledb/transcribe');

interface Loaded {
  engine: Engine;
  players: Players;
  // The heaviest chunk, and the last-loaded: pulled only when a viewer selects the
  // transcription row, and it stands alone because it shares no runtime code with the
  // other two.
  transcribe: Transcribe;
}

const inFlight = new Map<ChunkName, Promise<unknown>>();

/**
 * Memoises the promise rather than the module, so two attaches in the same tick
 * share one request instead of racing two.
 */
export function chunk<N extends ChunkName>(name: N, moduleUrl?: string): Promise<Loaded[N]> {
  const held = inFlight.get(name);
  if (held) return held as Promise<Loaded[N]>;

  const file = __SDB_CHUNKS__[name];
  const url = basePath(moduleUrl) + file;
  const load = import(/* @vite-ignore */ url).catch((cause: unknown) => {
    // A 404 here arrives as a module parse error, because the thing that came back
    // was a 404 page and it was HTML. Saying what was asked for is the difference
    // between a five minute fix and an afternoon.
    inFlight.delete(name);
    throw new Error(
      `SubtitleDB could not load ${url}. ` +
        'Check that the loader and its chunks are served from the same directory, ' +
        'or set SubtitleDB.setBasePath("https://.../") if they are not.',
      { cause },
    );
  });
  inFlight.set(name, load);
  return load as Promise<Loaded[N]>;
}

/** Test seam. Nothing in the shipped path calls this. */
export function resetChunks(): void {
  inFlight.clear();
}
