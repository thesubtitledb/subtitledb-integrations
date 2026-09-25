/**
 * The one call, and the decision about how much code it needs.
 *
 * Two chunks exist because two things are being asked for. A page that hands over a
 * `<video>` needs the element engine and the API client. A page that hands over a
 * player object needs those plus sixteen bindings and the resolver that picks one,
 * which is the larger half. Fetching the bindings for a bare element would double the
 * bytes for the simplest and most common case, which is the case this whole package
 * exists to make simple.
 *
 * The trap is that "bare element" is not the same question as "no player". A `<video>`
 * that Video.js has taken over is still a `<video>`, and putting a native text track
 * on it publishes a track the player renders nothing from and reports success. That
 * is the exact silent failure owners.ts exists to catch, and owners.ts lives in the
 * chunk being skipped. So `looksOwned` answers the cheap half here, errs toward yes,
 * and anything it flags goes the long way round to get the real answer.
 */
import type { AttachHandle, AttachOptions } from '@subtitledb/players';
import { isVideoElement, looksOwned } from '@subtitledb/players/marks';
import { chunk } from './chunks.js';
import { type DeferredHandle, deferHandle } from './deferred.js';
import { claim, type Incumbent, mismatch } from './guard.js';

declare const __SDB_VERSION__: string;

/**
 * Named so the API logs can tell CDN traffic from a page that bundled the packages
 * itself. A query parameter rather than a header because a header would make every
 * request a preflight, and it names the release, never the visitor.
 */
const CLIENT = `cdn/${__SDB_VERSION__}`;

/**
 * Claimed at import rather than at the first attach: two loaders racing to attach
 * would otherwise both find the slot empty and both take it.
 */
const incumbent: Incumbent | undefined = claim({
  version: __SDB_VERSION__,
  attach: (target, options) => attach(target, options),
});

/**
 * Which chunk this target needs.
 *
 * Naming a binding always needs the bindings. Anything that is not a video element is
 * a player object or a wrapper around one, and only the resolver knows how to get
 * through it. A video element that some player has visibly mounted goes the long way
 * so `ownerOf` can refuse or recover properly, and so does anything that passed
 * `isVideoElement` on its track list rather than on its tag name: `looksOwned`
 * answers both, because both are the same mistake.
 */
export function needsBindings(target: unknown, options: AttachOptions): boolean {
  if (options.player) return true;
  if (!isVideoElement(target)) return true;
  return looksOwned(target);
}

function report(options: AttachOptions, message: string): void {
  try {
    options.onError?.(new Error(message));
  } catch {
    // A page whose own error handler throws is not a reason to fail the attach.
  }
}

export function attach(
  target: unknown,
  options: AttachOptions = {},
  moduleUrl?: string,
): DeferredHandle {
  if (incumbent) {
    report(options, mismatch(__SDB_VERSION__, incumbent.version));
    return incumbent.attach(target, options);
  }

  const opts: AttachOptions = { clientName: CLIENT, ...options };

  // Wire the transcription engine lazily. `transcribe` is the page's declarative
  // request; this is the engine behind it, and it is the loader's job because only the
  // loader owns chunk(). The transcribe chunk, and through it the model, load on the
  // first synthetic select and never before: this closure is not called until then.
  if (options.transcribe && !opts.transcriber) {
    opts.transcriber = (req) => chunk('transcribe', moduleUrl).then((m) => m.runTranscription(req));
  }

  return deferHandle(async (): Promise<AttachHandle> => {
    if (needsBindings(target, options)) {
      const players = await chunk('players', moduleUrl);
      return players.attachSubtitleDb(target, opts);
    }
    const engine = await chunk('engine', moduleUrl);
    return engine.attachSubtitleDb(target as HTMLVideoElement, opts);
  });
}

/**
 * Fetch both chunks now rather than on the first attach.
 *
 * For a page that knows a player is coming and would rather spend the request while
 * the viewer is still reading. Everything is memoised, so a later attach uses what
 * this fetched and the call is free to make more than once.
 */
export function preload(moduleUrl?: string): Promise<unknown> {
  return Promise.all([chunk('engine', moduleUrl), chunk('players', moduleUrl)]);
}
