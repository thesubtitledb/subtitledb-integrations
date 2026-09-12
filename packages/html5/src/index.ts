import {
  type Candidate,
  candidateLabel,
  createSession,
  type DegradedInfo,
  EMPTY_RESULT,
  elementIdentity,
  handleFor,
  type LoadedSubtitle,
  type MediaHint,
  type MediaRef,
  type PlayerInfo,
  type PlayerVia,
  type ResolveResult,
  registerHandle,
  type SessionOptions,
  type SubtitleDbHandle,
  type SubtitleSession,
  UnknownPlayerError,
} from '@subtitledb/core';

/**
 * The lowest common denominator adapter: a bare `<video>` element.
 *
 * This is what makes client side conversion worth having. A `<track>` element renders
 * WebVTT and nothing else, and WebVTT is 2,487 of 6,864,222 rows, 0.036% of the
 * corpus. Converting srt, ass and ssa in the browser takes the reachable share to
 * roughly 94% and brings every player whose subtitle support is a `<track>` element,
 * Plyr and Shaka among them, into range without an API change.
 *
 * Players that wrap a real `<video>` are supported by passing their underlying
 * element. They pick the added tracks up because the tracks are real DOM children.
 */

export interface SubtitleDbHtml5Options
  extends Partial<Omit<SessionOptions, 'formats' | 'convertTo'>> {
  /**
   * Formats the host renders without help. Defaults to WebVTT only, which is the
   * honest answer for a `<track>` element; everything else is converted.
   */
  formats?: string[];
  /**
   * Convert srt, ass and ssa to WebVTT in the browser. On by default, because with it
   * off this adapter can reach almost nothing.
   */
  convert?: boolean;
  /** Explicit identity, when the host page knows it. Skips all the guessing. */
  hint?: MediaHint;
  /** Cap on how many `<track>` elements are added. */
  maxTracks?: number;
  /**
   * Add tracks in `disabled` mode and let the browser or the host UI enable one.
   * Default true, which is what keeps the eager resolve from downloading anything.
   */
  disabled?: boolean;
  onResolved?: (result: ResolveResult) => void;
  onSelected?: (loaded: LoadedSubtitle) => void;

  /**
   * Called after the track elements for a resolve have been added, and after they
   * have been cleared on destroy. Exists for players that keep their own captions
   * menu: adding a track to the element is enough to render a subtitle, but a
   * player that built its menu at setup will not list it without being told.
   */
  onTracks?: (tracks: HTMLTrackElement[], candidates: Candidate[]) => void;
  /** Called once a chosen track has been given its bytes and set to showing. */
  onShow?: (track: HTMLTrackElement, index: number, loaded: LoadedSubtitle) => void;

  /**
   * Use this session instead of building one from the options above.
   *
   * The caller then owns its lifetime: destroy() will not dispose a session it did
   * not create. `@subtitledb/players` passes one so that its handle can answer
   * `session` from the moment of attach, including while it is still waiting for a
   * player to mount its video element.
   */
  session?: SubtitleSession;
}

/**
 * The same handle every adapter here returns. Declared in core, so the four of them
 * cannot drift apart again.
 *
 * Kept as a named alias because it is the documented return type of this package's
 * attach, and renaming it would be a breaking change for no gain.
 */
export type SubtitleDbHtml5Handle = SubtitleDbHandle;

const DEFAULT_FORMATS = ['vtt'];

/**
 * What this package reports as the player.
 *
 * A bare `<video>` has no binding, and saying so plainly is better than leaving the
 * field out: a page that logs `handle.player.name` gets the same shape whichever
 * adapter it happened to reach.
 */
const NATIVE_PLAYER = Object.freeze({
  name: 'native',
  label: 'HTML5 video',
  untested: false,
  via: 'element',
} as const);

/**
 * A `<track src>` pointing at the API would be a cross-origin fetch, and a cross
 * origin track without permissive CORS fails by rendering nothing at all rather than
 * by erroring. A blob URL is same-origin by construction, and the bytes are already
 * in memory from the session cache, so this also avoids a second download.
 */
function blobUrl(text: string): string {
  return URL.createObjectURL(new Blob([text], { type: 'text/vtt;charset=utf-8' }));
}

export function attachSubtitleDb(
  video: HTMLVideoElement,
  options: SubtitleDbHtml5Options = {},
): SubtitleDbHtml5Handle {
  // The first thing a new user gets wrong is passing a player object, or the result
  // of a querySelector that matched nothing. Saying so beats a TypeError from the
  // first line that happens to touch the argument.
  if (!video || typeof (video as { addEventListener?: unknown }).addEventListener !== 'function') {
    throw new UnknownPlayerError(
      'attachSubtitleDb expects a <video> element. ' +
        `Received ${video === null ? 'null' : typeof video}. ` +
        'For a player object use attachSubtitleDb from @subtitledb/players instead.',
    );
  }

  // A component that mounts twice, or a script tag included twice, calls this twice
  // on the same element. Without this that produced two independent sessions on one
  // video: the track list doubled and so did the traffic, and React StrictMode does
  // it on every mount in development. The registry is shared with every other adapter
  // in this repo, so a player attached through @subtitledb/players and then again
  // through this element answers with one handle rather than two.
  const already = handleFor(video);
  if (already) return already;

  // A session supplied by the caller is theirs to dispose. Only one built here is
  // disposed here, so a handle cannot pull the session out from under the package
  // that made it and is still using it.
  const owned = options.session === undefined;
  const convert = options.convert !== false;
  const session =
    options.session ??
    createSession({
      ...options,
      formats: options.formats ?? DEFAULT_FORMATS,
      ...(convert ? { convertTo: 'vtt' as const } : {}),
    } as SessionOptions);

  const objectUrls: string[] = [];
  const added: HTMLTrackElement[] = [];
  let latest: ResolveResult | null = null;
  let offered: Candidate[] = [];
  let chosen: Candidate | null = null;
  let destroyed = false;
  let lastSrc = '';
  let inflight: Promise<ResolveResult> | null = null;

  const sameSet = (a: Candidate[], b: Candidate[]): boolean =>
    a.length === b.length && a.every((c, i) => c.subtitle.id === b[i]?.subtitle.id);

  function clearTracks(): void {
    chosen = null;
    for (const t of added) t.remove();
    added.length = 0;
    for (const u of objectUrls) URL.revokeObjectURL(u);
    objectUrls.length = 0;
  }

  /**
   * Tracks are added with an empty src and filled in on selection. A `<track>` with a
   * src fetches immediately, so adding all of them populated would download every
   * language on page load, which is exactly what the eager/lazy split exists to stop.
   */
  function addTrack(c: Candidate): HTMLTrackElement {
    const el = document.createElement('track');
    el.kind = 'subtitles';
    el.label = candidateLabel(c);
    el.srclang = c.subtitle.language;
    video.append(el);
    added.push(el);
    if (el.track) el.track.mode = 'disabled';
    return el;
  }

  /**
   * How long the player gets to do something to the track before we look.
   *
   * Long enough for a `<track>` to fetch a blob URL and parse, short enough that a
   * viewer turning subtitles straight back off is not mistaken for a player doing it.
   */
  const VERIFY_MS = 1500;
  let verifyTimer: ReturnType<typeof setTimeout> | undefined;

  /**
   * The half of reachability that needs no fingerprint.
   *
   * A marker table only catches players somebody has already written down. A headless
   * Shaka leaves no DOM mark at all, and a player released next year leaves one nobody
   * has seen. So this is behavioural: one look, a beat after a subtitle was shown, at
   * whether the track survived contact with whatever owns this element.
   *
   * Reported through `onError` and never thrown, and it adds no option. A page with no
   * `onError` sees nothing new, so this is zero behaviour change for every existing
   * consumer, and it is what keeps the fingerprint table from being the only defence.
   */
  function verify(el: HTMLTrackElement): void {
    if (destroyed) return;
    const track = el.track as (TextTrack & { readyState?: number }) | undefined;
    const label = el.label || el.srclang || 'the subtitle';

    if (el.isConnected === false) {
      report(`${label} was added and then removed from the media element. `);
      return;
    }
    if (track && track.mode !== 'showing') {
      report(`${label} was shown and is now ${track.mode}. `);
      return;
    }
    // readyState 2 is LOADED. Zero cues at that point is not the player at all: the
    // bytes arrived and nothing parsed out of them, which is a conversion problem and
    // is worded differently on purpose.
    if (track?.readyState === 2 && (track.cues?.length ?? 0) === 0) {
      options.onError?.(
        new UnknownPlayerError(
          `${label} loaded and the browser parsed no cues from it. The file reached ` +
            'the element and was not readable as WebVTT, so this is a conversion ' +
            'problem rather than a player one.',
        ),
      );
    }
  }

  function report(what: string): void {
    options.onError?.(
      new UnknownPlayerError(
        `${what}Something on this page owns the text tracks of this element and ` +
          'ignores native ones. Pass that player to attachSubtitleDb() from ' +
          '@subtitledb/players so its own captions API is used instead.',
      ),
    );
  }

  async function select(c: Candidate): Promise<void> {
    // Pass the element for a synthetic candidate: transcription reads the audio from
    // it. A real candidate ignores it and downloads as before.
    const loaded = await session.load(c, { media: video });
    if (!loaded || destroyed) return;

    const idx = offered.indexOf(c);
    const el = added[idx] ?? addTrack(c);
    const url = blobUrl(loaded.text);
    objectUrls.push(url);
    el.src = url;

    for (const other of added) {
      if (other.track) other.track.mode = other === el ? 'showing' : 'disabled';
    }
    // The TextTrack object is replaced when src changes, so set the mode again once
    // the browser has parsed the cues. Without this the track loads and stays hidden.
    el.addEventListener(
      'load',
      () => {
        if (el.track) el.track.mode = 'showing';
      },
      { once: true },
    );
    if (el.track) el.track.mode = 'showing';

    // One timer, restarted on every selection, so a viewer clicking through four
    // languages produces one look and not four.
    clearTimeout(verifyTimer);
    verifyTimer = setTimeout(() => verify(el), VERIFY_MS);

    chosen = c;
    // A player hook that throws is the player's problem, not the host page's. These
    // run inside whatever the page was doing when it called select(), and a binding
    // that hands a track to a player mid-teardown can throw from deep inside it.
    try {
      options.onShow?.(el, added.indexOf(el), loaded);
    } catch (err) {
      options.onError?.(err);
    }
    options.onSelected?.(loaded);
  }

  /**
   * One resolve at a time.
   *
   * The session already collapses duplicate requests, but the work here is a DOM
   * rebuild and a selection, and two of those interleaved left the element with two
   * tracks set to showing: the chosen one and an empty one. A media element fires
   * loadedmetadata while a resolve started by readyState is still in flight, so this
   * is the ordinary case, not a corner.
   */
  async function resolveNow(): Promise<ResolveResult> {
    if (!inflight) inflight = resolveOnce().finally(() => (inflight = null));
    return inflight;
  }

  async function resolveOnce(): Promise<ResolveResult> {
    // Destroyed handles answer rather than throw. A media element fires events during
    // teardown, and the session rejects every call once disposed.
    if (destroyed) return EMPTY_RESULT;

    const result = await session.resolve(options.hint ?? elementIdentity(video));
    if (destroyed) return result;

    latest = result;
    const next = result.candidates.slice(0, options.maxTracks ?? 30);

    // Rebuilding the track elements throws away the one the viewer is watching, so
    // only do it when the offer actually changed. Players fire loadedmetadata after
    // a selection often enough that always rebuilding makes a chosen subtitle vanish
    // a second after it appeared, which is what this guard is for.
    if (added.length > 0 && sameSet(next, offered)) {
      if (result.selected && !chosen) await select(result.selected.candidate);
      options.onResolved?.(result);
      return result;
    }

    clearTracks();
    offered = next;
    for (const c of offered) addTrack(c);
    options.onTracks?.([...added], offered);

    if (result.selected) await select(result.selected.candidate);
    options.onResolved?.(result);
    return result;
  }

  /**
   * The browser turns a track on by itself.
   *
   * Chromium runs the automatic text track selection algorithm over the list and
   * enables one whose language matches the viewer's preferences. It does that
   * internally, not through the `mode` setter, so nothing here sees it happen; what
   * the page ends up with is a second showing track holding no bytes. Two cases, and
   * they want opposite answers.
   */
  const onTrackChange = () => {
    if (destroyed) return;
    const empty = added.filter((t) => !t.src && t.track?.mode === 'showing');
    if (empty.length === 0) return;

    // Something is already on screen, so this is the browser's duplicate of a choice
    // that has been made. An empty track showing beside a real one renders nothing
    // and makes the player's own menu show two languages enabled at once.
    if (added.some((t) => t.src && t.track?.mode === 'showing')) {
      for (const t of empty) {
        if (t.track) t.track.mode = 'disabled';
      }
      return;
    }

    // Nothing is on screen, so a track being on is a request for it: either the
    // browser's language preference or the viewer picking from the player's captions
    // menu. Both want the subtitle, so fetch it rather than fighting over the mode.
    const first = empty[0];
    const candidate = first ? offered[added.indexOf(first)] : undefined;
    if (candidate) void select(candidate);
  };

  const onLoadedMetadata = () => {
    void resolveNow();
  };
  // Source changes do not always fire loadedmetadata, and a player that swaps src
  // without touching the element fires nothing at all. The session caches by identity,
  // so a duplicate trigger is free and needs no debouncing.
  const onEmptied = () => {
    const src = video.currentSrc || video.src;
    if (src === lastSrc) return;
    lastSrc = src;
    void resolveNow();
  };

  video.addEventListener('loadedmetadata', onLoadedMetadata);
  video.addEventListener('emptied', onEmptied);
  video.addEventListener('loadstart', onEmptied);
  video.textTracks?.addEventListener?.('change', onTrackChange);

  // A player may already be past loadedmetadata by the time this runs.
  if (video.readyState >= 1) void resolveNow();

  const handle: SubtitleDbHtml5Handle = {
    player: NATIVE_PLAYER,
    // A bare element cannot be a partially reachable player: there is no player to
    // be partially reachable. Always null here, and typed rather than omitted so the
    // field means the same thing on every handle.
    degraded: null,
    session,
    // Fixed for the life of this handle, unlike the player adapters: this one is
    // bound to one element and every listener below is on that element.
    media: () => video,
    current: () => latest,
    tracks: () => offered,
    refresh: resolveNow,
    select,
    destroy() {
      destroyed = true;
      clearTimeout(verifyTimer);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('emptied', onEmptied);
      video.removeEventListener('loadstart', onEmptied);
      video.textTracks?.removeEventListener?.('change', onTrackChange);
      clearTracks();
      options.onTracks?.([], []);
      if (owned) session.dispose();
    },
  };
  return registerHandle(handle, [video]);
}

export type {
  Candidate,
  DegradedInfo,
  LoadedSubtitle,
  MediaHint,
  MediaRef,
  PlayerInfo,
  PlayerVia,
  ResolveResult,
  SessionOptions,
  SubtitleDbHandle,
  SubtitleSession,
};
