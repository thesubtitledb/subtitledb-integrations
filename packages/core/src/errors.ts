import type { ApiErrorBody } from './types.js';

/**
 * Every failure this library raises. `status` is 0 for transport failures, which is
 * the common case in a browser rather than an exotic one: the API rejects
 * wrong-host requests before its CORS hook runs, so those arrive as opaque network
 * errors with no readable body. Nothing here may depend on reading an error body.
 */
export class SubtitleDbError extends Error {
  readonly status: number;
  readonly code: string;
  readonly hint: string | undefined;
  readonly url: string;

  constructor(opts: {
    message: string;
    status?: number;
    code?: string;
    hint?: string;
    url?: string;
    cause?: unknown;
  }) {
    super(opts.message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'SubtitleDbError';
    this.status = opts.status ?? 0;
    this.code = opts.code ?? 'transport_error';
    this.hint = opts.hint;
    this.url = opts.url ?? '';
  }

  /** True when the caller asking again later could plausibly succeed. */
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }

  static fromBody(status: number, url: string, body: unknown): SubtitleDbError {
    const b = (body ?? {}) as Partial<ApiErrorBody>;
    return new SubtitleDbError({
      message: b.message ?? `request failed with ${status}`,
      status,
      code: b.error ?? 'http_error',
      hint: b.hint,
      url,
    });
  }
}

/**
 * Raised when an adapter is handed something it cannot attach to.
 *
 * Lives here rather than in one adapter because every adapter needs to raise it and
 * a host page should be able to catch one type. The message is expected to name what
 * the caller should pass instead: this is the error a new user hits first.
 */
export class UnknownPlayerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnknownPlayerError';
  }
}

/**
 * Raised when a player is demonstrably on the page and could not be reached.
 *
 * A subclass rather than a sibling, deliberately: this is a stricter statement than
 * "I do not know what this is", and a page already catching `UnknownPlayerError`
 * keeps catching it, so adding the refusal breaks nobody's error handling.
 *
 * Only raised on evidence, and only for players that render nothing from a native
 * track. Those five would otherwise show no subtitles and report nothing at all, so
 * throwing is strictly better than what happens in silence. A player whose subtitles
 * are real DOM children is never refused: the track renders, only its own captions
 * menu is missing, and turning that into an exception would break a working page.
 */
export class PlayerNotReachableError extends UnknownPlayerError {
  /** Binding name of the player that was seen. */
  readonly player: string;

  constructor(player: string, message: string) {
    super(message);
    this.name = 'PlayerNotReachableError';
    this.player = player;
  }
}

/** Raised when a caller aborts. Kept distinct so adapters can ignore it silently. */
export class SubtitleDbAbort extends Error {
  constructor(message = 'aborted') {
    super(message);
    this.name = 'SubtitleDbAbort';
  }
}
