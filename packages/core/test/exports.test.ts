import { describe, expect, it } from 'vitest';
import * as entry from '../src/index.js';

/**
 * The entry, not the modules behind it: a function the entry does not export cannot be
 * imported from @subtitledb/core at all. Every name here is in the core README or the
 * integration guide, so dropping one breaks a caller. npm-publish.sh checks a few of
 * them again against the built dist.
 */
const DOCUMENTED = [
  'query',
  'createClient',
  'SubtitleDbClient',
  'DEFAULT_API_BASE',
  'backoffMs',
  'normaliseImdb',
  'createSession',
  'SubtitleSession',
  'findSubtitles',
  'candidateLabel',
  'similarity',
  'identify',
  'isResolvable',
  'parseFilename',
  'basename',
  'localeLanguages',
  'corpusLanguage',
  'languageName',
  'hasLanguageName',
  'toVtt',
  'srtToVtt',
  'assToVtt',
  'subtitleMime',
  'CONVERTIBLE',
  'parseVtt',
  'serialize',
  'shift',
  'rescale',
  'decodeBytes',
  'SingleFlightCache',
  'SubtitleDbError',
  'SubtitleDbAbort',
  'ConvertError',
  'UnknownPlayerError',
  'PlayerNotReachableError',
] as const;

describe('the package entry', () => {
  it('exports every documented name', () => {
    const missing = DOCUMENTED.filter((name) => (entry as Record<string, unknown>)[name] == null);
    expect(missing).toEqual([]);
  });
});
