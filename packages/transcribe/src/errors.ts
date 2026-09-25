/** One error type for this package, with a machine-readable code alongside the text. */
export type TranscribeErrorCode =
  | 'no_source'
  | 'audio_unreadable'
  | 'fetch_failed'
  | 'decode_failed'
  | 'no_web_audio'
  | 'empty_audio'
  | 'aborted'
  | 'engine_error'
  | 'worker_error'
  | 'unsupported_engine';

export class TranscribeError extends Error {
  readonly code: TranscribeErrorCode;

  constructor(message: string, code: TranscribeErrorCode, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TranscribeError';
    this.code = code;
  }
}
