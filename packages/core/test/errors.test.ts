import { describe, expect, it } from 'vitest';
import {
  PlayerNotReachableError,
  SubtitleDbAbort,
  SubtitleDbError,
  UnknownPlayerError,
} from '../src/errors.js';

describe('SubtitleDbError.retryable', () => {
  // Callers and the session decide whether to ask again from this alone.
  it('is true only for a failure that asking again could fix', () => {
    const cases: [{ status?: number; code?: string }, boolean][] = [
      [{}, true],
      [{ code: 'transport_error' }, true],
      [{ code: 'timeout' }, true],
      [{ code: 'bad_request' }, false],
      [{ code: 'key_required' }, false],
      [{ code: 'budget_exhausted' }, false],
      [{ status: 400, code: 'bad_request' }, false],
      [{ status: 401, code: 'bad_key' }, false],
      [{ status: 404, code: 'not_found' }, false],
      [{ status: 429 }, true],
      [{ status: 500 }, true],
      [{ status: 503 }, true],
    ];
    for (const [opts, want] of cases) {
      expect(new SubtitleDbError({ message: 'x', ...opts }).retryable, JSON.stringify(opts)).toBe(
        want,
      );
    }
  });
});

describe('SubtitleDbError.fromBody', () => {
  it('takes code, message and hint from the API body', () => {
    const err = SubtitleDbError.fromBody(404, 'https://x.test/v1/by-imdb/tt1', {
      error: 'not_found',
      message: 'no title',
      hint: 'try by-title',
    });
    expect(err).toMatchObject({
      name: 'SubtitleDbError',
      status: 404,
      code: 'not_found',
      message: 'no title',
      hint: 'try by-title',
      url: 'https://x.test/v1/by-imdb/tt1',
    });
  });

  it('still names the failure when there is no body', () => {
    for (const body of [undefined, null, {}]) {
      expect(SubtitleDbError.fromBody(502, '', body)).toMatchObject({
        status: 502,
        code: 'http_error',
        message: 'request failed with 502',
      });
    }
  });
});

describe('error classes', () => {
  it('keeps an abort apart from a failure', () => {
    const abort = new SubtitleDbAbort();
    expect(abort.name).toBe('SubtitleDbAbort');
    expect(abort).not.toBeInstanceOf(SubtitleDbError);
  });

  it('makes a refusal to reach a player catchable as UnknownPlayerError', () => {
    // A page already catching UnknownPlayerError keeps working.
    const err = new PlayerNotReachableError('videojs', 'no tech');
    expect(err).toBeInstanceOf(UnknownPlayerError);
    expect(err).toMatchObject({ name: 'PlayerNotReachableError', player: 'videojs' });
  });

  it('carries the cause of a transport failure', () => {
    const cause = new TypeError('Failed to fetch');
    expect(new SubtitleDbError({ message: 'x', cause }).cause).toBe(cause);
  });
});
