import type {
  Candidate,
  DegradedInfo,
  LoadedSubtitle,
  MediaHint,
  ResolveResult,
  SessionOptions,
  SubtitleDbHandle,
} from '@subtitledb/core';

/** What a binding needs to know to publish one track. */
export interface TrackSpec {
  /** Blob URL holding the subtitle, already converted if it needed converting. */
  url: string;
  /**
   * What is actually in that blob: usually `vtt`, but a binding that declares
   * `formats` gets the file untouched and has to tell its player what it is.
   */
  format: string;
  label: string;
  language: string;
  candidate: Candidate;
}

/**
 * A binding is the only player-specific code in this package. It answers three
 * questions and nothing else: is this object my player, where is its video element,
 * and how do I tell it a track exists.
 *
 * Two shapes, because players split cleanly in two:
 *
 *   `media`  the player is a <video> plus a user interface. Adding a <track> is
 *            enough to render, and `shown` only exists for the players that keep
 *            their own idea of which track is on.
 *   `api`    the player owns text tracks itself and hides native ones, so nothing
 *            renders until its API is called.
 *
 * A binding must never import its player. Everything is structural, so this package
 * stays dependency free and works against any version that keeps the same surface.
 */
export interface PlayerBinding<T = unknown> {
  /** Stable name, usable as `player: 'videojs'` and reported on the handle. */
  name: string;
  /** Human readable, for menus and error messages. */
  label: string;
  /**
   * Formats this player renders on its own. Defaults to WebVTT, which is what a
   * bare `<track>` takes and therefore what almost every player here needs.
   *
   * It is a property of the player, not a preference, so it belongs on the binding
   * rather than in the options: ArtPlayer parses srt and ass itself, and converting
   * an ASS file for it would throw away styling it can actually show. `options.formats`
   * still overrides, for a page that knows better than the default.
   */
  formats?: string[];
  /**
   * True when this object is that player. Detection is by shape, checked in the
   * order bindings are registered, most specific first.
   */
  detect(target: unknown): boolean;

  /** Element based players. Return null when the element is not mounted yet. */
  media?(target: T): HTMLVideoElement | null;
  /** Called when one native track has been shown, for players that track it separately. */
  shown?(target: T, index: number, track: HTMLTrackElement): void;

  /** Players that own their text tracks. */
  api?: {
    /** Publish one track. May return a handle the player later needs back. */
    add(target: T, spec: TrackSpec): unknown;
    /** Show the track previously added, identified by the value `add` returned. */
    show(target: T, added: unknown, spec: TrackSpec): void;
    /** Remove everything this adapter added. Must not touch the player's own tracks. */
    clear(target: T): void;
    /** Subscribe to whatever the player calls "the source changed". */
    events?(target: T, onChange: () => void): () => void;
  };

  /**
   * Set when the binding is written to a published API we cannot exercise here,
   * because the player is commercial and not installable. Surfaced on the handle
   * and in the docs rather than left for somebody to discover.
   */
  untested?: true;
}

/**
 * The configuration surface. One object, the same one for every player.
 *
 * This is the whole public API of the integration, and it is deliberately flat:
 * there are no per-player option bags, no `videojs: {...}` sections, and a binding
 * cannot read an option of its own. Anything a binding needs to know is either
 * structural, which it works out from the player object, or it belongs here and
 * applies to all sixteen bindings. `packages/players/test/uniform.test.ts` drives every
 * binding through this exact object and fails if one of them stops honouring it.
 *
 * Inherited from `SessionOptions`, and identical on both paths:
 *
 *   `languages`        preference order, best first. One request per language.
 *   `hearingImpaired`  prefer HI subtitles when true.
 *   `autoSelect`       true for the top candidate, or a language code to pin one.
 *   `limit`            candidates asked for per language.
 *   `cacheTtlMs`       how long a resolve is reused.
 *   `maxRequests`      hard ceiling on network calls per session.
 *   `apiBase`          point at a different SubtitleDB deployment.
 *   `client` / `fetch` / `clientName`  bring your own transport or identify yourself.
 *   `onError`          every non-abort failure. Errors never escape resolve().
 */
export interface AttachOptions extends Partial<Omit<SessionOptions, 'formats' | 'convertTo'>> {
  /** Force a binding by name. Otherwise the target is detected. */
  player?: string;
  /** Formats the player renders natively. Defaults to WebVTT, which every player takes. */
  formats?: string[];
  /** Convert srt, ass and ssa to WebVTT in the browser. On by default. */
  convert?: boolean;
  /**
   * Explicit identity, when the host page knows what is playing. Without it every
   * binding falls back to the same thing: the media element, its current source and
   * the page metadata, read through `elementIdentity` so no player guesses better or
   * worse than another.
   */
  hint?: MediaHint;
  /** Cap on tracks offered to the player. Default 30. */
  maxTracks?: number;
  /**
   * Fired once when a player was recognised on the page but could not be reached.
   *
   * Only ever fires for players whose subtitles are real DOM children, so the track
   * renders and it is the player's own captions menu that will not list it. The
   * players that own their text-track engine cannot degrade this way: they render
   * nothing, so they throw instead.
   */
  onDegraded?: (info: DegradedInfo) => void;
  /**
   * Turn that degradation into a thrown error. Off by default.
   *
   * For a page that would rather fail its own tests than ship a missing captions
   * menu. It never changes what is refused for the players that render nothing;
   * those are refused either way.
   */
  strict?: boolean;
  /** Fired after every resolve, including one that found nothing. */
  onResolved?: (result: ResolveResult) => void;
  /** Fired once a subtitle has been fetched, converted and handed to the player. */
  onSelected?: (loaded: LoadedSubtitle) => void;
}

/**
 * The same handle every adapter in this repo returns. Declared in core so the four
 * of them cannot drift apart again: this one used to carry `player` and no
 * `session`, while `html5` and `artplayer` carried `session` and no `player`.
 *
 * Kept as a named alias because it is this package's documented return type.
 */
export type AttachHandle = SubtitleDbHandle;
