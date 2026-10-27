/**
 * The live worker, started before the click.
 *
 * A row offered in the picker means a select may follow. The engine is compiled and
 * its heap grown now, and the model loaded into it when a past run left it on this
 * device; a model that is not there is never downloaded here, that still waits for
 * the select. A run that starts while this is warm takes the worker over, so the
 * first cue is the first window's cost alone. One warm worker per page, dropped after
 * a few minutes without a select so a page that offers the row and is never asked
 * does not hold a model in memory for the rest of its life.
 */
import { isCached } from './asr/fetch-cached.js';
import { type AsrAssets, AsrWorker, type Spawn } from './workers.js';

export const WARM_TTL_MS = 5 * 60_000;

interface Warm {
  key: string;
  worker: AsrWorker;
  timer: ReturnType<typeof setTimeout>;
}

let warm: Warm | null = null;

function keyOf(a: AsrAssets): string {
  return `${a.wasmUrl}|${a.modelUrl}|${a.vadUrl}|${a.cacheName}`;
}

/** Start, or keep, the warm worker for these assets. Resolves once it is as ready as it can get without a download: `true` with the model loaded. */
export async function warmUp(spawn: Spawn, assets: AsrAssets): Promise<boolean> {
  const key = keyOf(assets);
  if (warm && (warm.key !== key || warm.worker.dead)) dropWarm();
  if (!warm) {
    const worker = new AsrWorker(
      spawn,
      assets,
      () => {},
      () => {
        if (warm?.worker === worker) dropWarm();
      },
      false,
    );
    warm = { key, worker, timer: setTimeout(dropWarm, WARM_TTL_MS) };
  } else {
    clearTimeout(warm.timer);
    warm.timer = setTimeout(dropWarm, WARM_TTL_MS);
  }
  const w = warm.worker;
  if (!(await isCached(assets.modelUrl, assets.cacheName))) return false;
  w.load();
  return w.ready.then(
    () => true,
    () => false,
  );
}

/** Hand over the warm worker for these assets, if there is one. */
export function takeWarm(assets: AsrAssets): AsrWorker | null {
  if (!warm || warm.key !== keyOf(assets) || warm.worker.dead) return null;
  clearTimeout(warm.timer);
  const w = warm.worker;
  warm = null;
  return w;
}

export function dropWarm(): void {
  if (!warm) return;
  clearTimeout(warm.timer);
  warm.worker.terminate();
  warm = null;
}
