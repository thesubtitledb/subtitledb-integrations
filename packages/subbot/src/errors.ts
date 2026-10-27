export type SubbotErrorCode =
  | 'no_source'
  | 'audio_unreadable'
  | 'unsupported_container'
  | 'unsupported_codec'
  | 'no_audio_track'
  | 'decode_failed'
  | 'no_webcodecs'
  | 'model_download'
  | 'worker_failed'
  | 'aborted';

/** Every failure this package raises, with a code a page can switch on. */
export class SubbotError extends Error {
  readonly code: SubbotErrorCode;
  constructor(message: string, code: SubbotErrorCode, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SubbotError';
    this.code = code;
  }
}
