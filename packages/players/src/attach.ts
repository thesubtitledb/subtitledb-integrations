import {
  type Candidate,
  candidateLabel,
  createSession,
  type DegradedInfo,
  EMPTY_RESULT,
  elementIdentity,
  handleForAny,
  type LoadedSubtitle,
  type PlayerInfo,
  PlayerNotReachableError,
  type ResolveResult,
  registerHandle,
  type SessionOptions,
  type SubtitleSession,
  subtitleMime,
  UnknownPlayerError,
} from '@subtitledb/core';
import { attachSubtitleDb as attachToVideo } from '@subtitledb/html5';
import { ownerOf, unreachableMessage } from './owners.js';
import { findVideo } from './probe.js';
import { type ResolvedPlayer, resolvePlayer } from './resolve.js';
import type { AttachHandle, AttachOptions, PlayerBinding, TrackSpec } from './types.js';

const DEFAULT_FORMATS = ['vtt'];

// Re-exported so a page catching this does not have to know which package raised it.
// PlayerNotReachableError is a subclass, so an existing `catch (e instanceof
// UnknownPlayerError)` keeps catching everything it used to.
export { PlayerNotReachableError, UnknownPlayerError };

/**
 * Attach SubtitleDB to any supported player.
 *
 * Pass the player object, or its video element, and the binding is detected. Pass
 * `player: 'videojs'` to skip detection when the host page already knows.
 *
 * Behaviour is identical across every binding, which is the point of this package:
 * resolve when the player is ready and on every source change, publish the track
 * list without fetching a byte, and fetch and convert exactly one subtitle when one
 * is chosen.
 */
export function attachSubtitleDb(target: unknown, options: AttachOptions = {}): AttachHandle {
  const existing = handleForAny([target]);
  if (existing) return existing;

  // One resolver, used by every entry point, so the element path, the api path,
  // observeSubtitleDb() and both framework packages cannot disagree about what a
  // target is. It is what accepts a framework wrapper: {plyr}, {player}, a React ref
  // and a Vue ref all reach the player here instead of falling through to `native`.
  const resolved = resolvePlayer(target, options);
  if (!resolved) {
    throw new UnknownPlayerError(
      options.player
        ? `no binding named ${options.player}`
        : 'could not identify this player, and found no video element inside it. ' +
            'Pass the video element directly, name a binding with player: "...", or use ' +
            'observeSubtitleDb() if the player does not exist yet.',
    );
  }
  const { binding, player, via, degraded } = reach(resolved, options);

  // The same player reached by a different reference. A resolved player already has a
  // handle when the page passed the wrapper first and the instance second, and a
  // <video> already attached through @subtitledb/html5 is the same attachment too.
  // Going ahead in either case would put a second session on it: double the track
  // list, double the traffic, and a captions menu listing everything twice. The
  // player and its element are only knowable once resolution has run, which is why
  // this is a second look rather than part of the one above.
  const onPlayer = handleForAny([player, binding.media?.(player) ?? null]);
  if (onPlayer) return onPlayer;

  const seen = info(binding, via);
  const handle = binding.api
    ? attachViaApi(player, binding, seen, degraded, options)
    : attachViaElement(player, binding, seen, degraded, options);

  // Attaching twice to the same player is a page bug that looks like a plugin bug: two
  // sets of tracks, two menus, two downloads on select. A script tag included twice, a
  // component that mounts under StrictMode, a route that runs its setup again on the
  // way back are all ordinary and all end here. The second call gets the first handle.
  //
  // Three keys, because one player has three names: the wrapper the page held, the
  // player inside it, and the media element underneath. Two proxies of one Vue target
  // are not the same object, so keying on the resolved player is what makes the
  // reactive double-attach impossible rather than merely documented.
  return registerHandle(handle, [target, player, handle.media()]);
}

/**
 * The live handle for this player, element or wrapper, if it already has one.
 *
 * Reads the registry shared with every adapter in this repo, so a video attached
 * through `@subtitledb/html5` answers here too. That is the point: one player, one
 * handle, whichever package you happen to ask.
 */
export function attachedTo(target: unknown): AttachHandle | undefined {
  return handleForAny([target]);
}

/**
 * How long a player gets to mount its video element before we stop looking.
 *
 * Attaching before the element exists is the normal case, not the exceptional one:
 * `new Plyr('#v')` returns before its media is in place, a framework effect runs
 * before layout, and a lazy player mounts on scroll. Throwing there put the burden
 * on every host page to find the one event that means ready, which is a different
 * event on every player. Waiting is bounded so a page that never mounts anything
 * reports it through onError instead of holding a session open forever.
 */
const MEDIA_WAIT_MS = 15_000;
const POLL_MS = 50;

/**
 * The session for an element-path attach, built here rather than inside
 * `@subtitledb/html5`.
 *
 * It has to exist before the element does. A handle now answers `session` from the
 * moment of attach, and on this path the element can be up to MEDIA_WAIT_MS away, so
 * letting html5 build it would leave the field null for that whole window and make
 * the type a lie. html5 takes the session and, because it did not create it, does not
 * dispose it: this handle does.
 */
function elementSession(binding: PlayerBinding, options: AttachOptions): SubtitleSession {
  const convert = options.convert !== false;
  return createSession({
    ...options,
    formats: renders(binding, options),
    ...(convert ? { convertTo: 'vtt' as const } : {}),
  } as SessionOptions);
}

/**
 * What this player renders without help.
 *
 * The page wins, then the binding, then WebVTT. `convert` means "convert what this
 * player cannot render", so this list is the whole input to that decision: widen it
 * and a file is handed over untouched, narrow it and the same file is rewritten.
 */
function renders(binding: PlayerBinding, options: AttachOptions): string[] {
  return options.formats ?? binding.formats ?? DEFAULT_FORMATS;
}

/** Players that are a video element plus a UI. The html5 engine does the work. */
function attachViaElement(
  target: unknown,
  binding: PlayerBinding,
  seen: PlayerInfo,
  degraded: DegradedInfo | null,
  options: AttachOptions,
): AttachHandle {
  const session = elementSession(binding, options);
  const media = () => binding.media?.(target) ?? null;

  const html5 = (video: HTMLVideoElement) =>
    attachToVideo(video, {
      ...options,
      session,
      formats: renders(binding, options),
      onShow: (track, index) => binding.shown?.(target, index, track),
    });

  const ready = media();
  if (ready) return elementHandle(seen, degraded, session, media, html5(ready));

  // Not mounted yet. Hand back a working handle now and fill it in when the element
  // arrives: a caller that immediately calls refresh() or select() gets the result,
  // and one that calls destroy() before then never starts a session at all.
  let inner: ReturnType<typeof attachToVideo> | null = null;
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  let settle: ((h: ReturnType<typeof attachToVideo> | null) => void) | undefined;
  const waiting = new Promise<ReturnType<typeof attachToVideo> | null>((resolve) => {
    settle = resolve;
    const started = Date.now();
    const look = (): void => {
      if (destroyed) {
        resolve(null);
        return;
      }
      const video = media();
      if (video) {
        inner = html5(video);
        resolve(inner);
        return;
      }
      if (Date.now() - started >= MEDIA_WAIT_MS) {
        options.onError?.(
          new UnknownPlayerError(
            `${binding.label} was recognised but never mounted a video element. ` +
              `Waited ${MEDIA_WAIT_MS}ms. Attach once the player is ready, or use ` +
              'observeSubtitleDb() to attach when it appears.',
          ),
        );
        resolve(null);
        return;
      }
      timer = setTimeout(look, POLL_MS);
    };
    look();
  });

  return {
    player: seen,
    degraded,
    session,
    media,
    async refresh() {
      const h = await waiting;
      return h ? h.refresh() : EMPTY_RESULT;
    },
    async select(candidate) {
      const h = await waiting;
      await h?.select(candidate);
    },
    tracks: () => inner?.tracks() ?? [],
    current: () => inner?.current() ?? null,
    destroy() {
      destroyed = true;
      clearTimeout(timer);
      // Settle the wait as well as stopping it. Without this the cancelled poll left
      // every awaiting refresh() and select() pending for the life of the page, and
      // held the player object with them.
      settle?.(null);
      inner?.destroy();
      // This handle built the session, so this handle disposes it. Without this, an
      // attach that timed out waiting for an element left a session alive with no
      // inner handle to ever dispose it.
      session.dispose();
    },
  };
}

function elementHandle(
  seen: PlayerInfo,
  degraded: DegradedInfo | null,
  session: SubtitleSession,
  media: () => HTMLVideoElement | null,
  inner: ReturnType<typeof attachToVideo>,
): AttachHandle {
  return {
    player: seen,
    degraded,
    session,
    // The binding's own lookup, not the element html5 was handed: a player that
    // swaps its element on a source change reports the new one here, and the inner
    // handle is the one bound to a single element.
    media,
    refresh: inner.refresh,
    select: inner.select,
    tracks: inner.tracks,
    current: inner.current,
    destroy() {
      inner.destroy();
      session.dispose();
    },
  };
}

/**
 * Players that own their text tracks. Same two-phase shape as the element path,
 * written against the binding's API instead of the DOM.
 */
function attachViaApi(
  target: unknown,
  binding: PlayerBinding,
  seen: PlayerInfo,
  degraded: DegradedInfo | null,
  options: AttachOptions,
): AttachHandle {
  const api = binding.api;
  if (!api) throw new UnknownPlayerError(`${binding.name} has no api binding`);

  const session = elementSession(binding, options);
  // Read live on every call. These players mount their element late and replace it on
  // a source change, so anything captured here goes stale with no symptom other than
  // the wrong answer. findVideo is the fallback for a binding with no media().
  const media = () => binding.media?.(target) ?? findVideo(target);

  const objectUrls: string[] = [];
  let latest: ResolveResult | null = null;
  let offered: Candidate[] = [];
  let destroyed = false;

  function release(): void {
    api?.clear(target);
    for (const u of objectUrls) URL.revokeObjectURL(u);
    objectUrls.length = 0;
  }

  async function select(candidate: Candidate): Promise<void> {
    // The element is read live for a synthetic candidate, whose audio is transcribed
    // on the device. These players mount and swap their element late, so this is the
    // same live lookup resolve uses, not a reference captured at attach.
    const loaded: LoadedSubtitle | null = await session.load(candidate, { media: media() });
    if (!loaded || destroyed) return;

    // Blob rather than the API URL for the same reason as the element path: the
    // bytes are already in memory, and a same-origin URL sidesteps the whole class
    // of cross-origin track failures that render as an empty caption track.
    //
    // Typed from the file rather than always text/vtt: a binding that declares its
    // own `formats` gets the subtitle untouched, and a player that sniffs the blob
    // then picks its parser from this header.
    const type = `${subtitleMime(loaded.format)};charset=utf-8`;
    const url = URL.createObjectURL(new Blob([loaded.text], { type }));
    objectUrls.push(url);

    const spec: TrackSpec = {
      url,
      format: loaded.format,
      label: candidateLabel(candidate),
      language: candidate.subtitle.language,
      candidate,
    };

    // A binding may add asynchronously, Shaka does, so await whatever comes back
    // before handing it to show(). A player that throws from its own publish call,
    // typically because it was disposed underneath us, is reported and not rethrown:
    // refresh() calls this, and refresh() is called from an event handler.
    try {
      const added = await api?.add(target, spec);
      if (destroyed) return;
      api?.show(target, added, spec);
    } catch (err) {
      options.onError?.(err);
      return;
    }
    options.onSelected?.(loaded);
  }

  async function refresh(): Promise<ResolveResult> {
    // A handle whose player is gone answers instead of throwing, which is what the
    // documentation promises and what an event that arrives during teardown needs.
    if (destroyed) return EMPTY_RESULT;

    // Read the element at resolve time, not at attach time: these players mount it
    // late and replace it on a source change. Same default as the element path, from
    // the same helper, because the option set is meant to mean one thing everywhere.
    // Passing {} here, which is what this did, left Video.js, Shaka, Vidstack and
    // Bitmovin identifying nothing at all unless the host page named the title.
    const result = await session.resolve(options.hint ?? elementIdentity(media()));
    if (destroyed) return result;

    latest = result;
    offered = result.candidates.slice(0, options.maxTracks ?? 30);

    // Nothing is published to the player until it is chosen. These players fetch a
    // track the moment it is registered, so registering all of them would download
    // every language on load, which is exactly what the eager/lazy split prevents.
    if (result.selected) await select(result.selected.candidate);
    options.onResolved?.(result);
    return result;
  }

  const unsubscribe = api.events?.(target, () => {
    void refresh();
  });

  // Resolve on attach, exactly like the element path does for a ready element. Three
  // of the five api bindings have no event to subscribe to at all, so without this
  // they never resolved unless the host page called refresh() by hand, which is what
  // the example page was quietly doing.
  void refresh();

  return {
    player: seen,
    degraded,
    session,
    media,
    refresh,
    select,
    tracks: () => offered,
    current: () => latest,
    destroy() {
      destroyed = true;
      unsubscribe?.();
      release();
      session.dispose();
    },
  };
}

/** What resolution settled on, after asking the page whether it can be believed. */
interface Reached extends ResolvedPlayer {
  degraded: DegradedInfo | null;
}

/**
 * The last look, and the only place this package refuses anything.
 *
 * Only runs when resolution landed on `native`, because that is the one answer that
 * can be both correct and catastrophic. It is correct for hls.js, dash.js, jPlayer,
 * Griffith, Kaltura, Jellyfin and Video-React. It is catastrophic for the five
 * players that own their text-track engine: the track is added, ignored, and nothing
 * reports it.
 *
 * So the evidence has to be positive. A page with no marker gets `native` in silence,
 * exactly as before, which is what stops this being a blanket refusal that would
 * break every working page in the first list.
 */
function reach(resolved: ResolvedPlayer, options: AttachOptions): Reached {
  if (resolved.via !== 'native') return { ...resolved, degraded: null };

  const video = resolved.binding.media?.(resolved.player) ?? null;
  const owner = video ? ownerOf(video) : undefined;
  if (!owner) return { ...resolved, degraded: null };

  // The player's own registry handed the instance back, so nothing failed at all:
  // resolve again on what we now have and carry on as though the page had passed it.
  // Recorded as `ascend`, because that is what happened, by way of the player rather
  // than the DOM.
  if (owner.player) {
    const again = resolvePlayer(owner.player);
    if (again && again.via !== 'native') return { ...again, via: 'ascend', degraded: null };
  }

  if (owner.mark.fatal || (owner.mark.degrades && options.strict)) {
    throw new PlayerNotReachableError(owner.mark.name, unreachableMessage(owner.mark));
  }

  // Seen but not reachable, and not fatal. A recovery-only mark says nothing more:
  // its binding has never been run against a real instance, so a fingerprint is not
  // enough to claim anything about the page.
  if (!owner.mark.degrades) return { ...resolved, degraded: null };

  // Subtitles will render. What will not happen is the player's own captions menu
  // listing them, because that menu was built at setup and is never told. Reported
  // rather than thrown, because turning a working page into an exception is a
  // regression whatever it is called.
  const degraded: DegradedInfo = { player: owner.mark.name, reason: 'menu' };
  options.onDegraded?.(degraded);
  return { ...resolved, degraded };
}

function info(binding: PlayerBinding, via: PlayerInfo['via']): PlayerInfo {
  return {
    name: binding.name,
    label: binding.label,
    untested: binding.untested === true,
    via,
  };
}
