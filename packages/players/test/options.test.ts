import { SubtitleDbClient } from '@subtitledb/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundleSubtitle, movieBundle, stubFetch } from '../../core/test/fixtures.js';
import { attachSubtitleDb } from '../src/index.js';
import {
  blobs,
  clearDom,
  client,
  FAKES,
  installDom,
  ownsTracks,
  published,
  resetFakes,
  SRT,
} from './fakes.js';

/**
 * The options that decide what the viewer actually gets, exercised through the facade
 * rather than through the html5 engine underneath it.
 *
 * uniform.test.ts proves every binding answers the same options. This proves the
 * options themselves do what the documentation says, on both paths: an element player
 * that is handed <track> children, and a player that owns its text tracks and is only
 * ever told about the chosen one.
 */

beforeEach(resetFakes);
afterEach(clearDom);

/** One of each path. Everything below runs against both. */
const PATHS = ['native', 'videojs'] as const;
const HINT = { imdbId: 'tt0133093' };

describe('autoSelect', () => {
  for (const name of PATHS) {
    it(`${name}: fetches and shows one track during the eager resolve`, async () => {
      installDom();
      const { client: api, calls } = client();
      const target = FAKES[name]?.();

      const handle = attachSubtitleDb(target, {
        client: api,
        hint: HINT,
        languages: ['en'],
        autoSelect: 'en',
      });
      await handle.refresh();

      // Exactly one subtitle downloaded, unprompted, and it is the pinned language.
      const bytes = calls.filter((c) => c.url.includes('/get/'));
      expect(bytes).toHaveLength(1);
      expect(bytes[0]?.url).toMatch(/\/get\/1$$/);
      expect(blobs.at(-1)).toContain('WEBVTT');
      expect(published(target).length).toBeGreaterThan(0);
      handle.destroy();
    });
  }
});

describe('convert', () => {
  for (const name of PATHS) {
    it(`${name}: convert false hands the player the stored bytes untouched`, async () => {
      installDom();
      const { client: api } = client();
      const target = FAKES[name]?.();

      // A player that renders SubRip itself: say so, and nothing is rewritten.
      const handle = attachSubtitleDb(target, {
        client: api,
        hint: HINT,
        languages: ['en'],
        convert: false,
        formats: ['srt'],
      });
      const result = await handle.refresh();

      expect(result.candidates.every((c) => c.subtitle.format === 'srt')).toBe(true);
      const first = handle.tracks()[0];
      if (!first) throw new Error('no srt candidate');
      await handle.select(first);

      expect(blobs.at(-1)).toBe(SRT);
      expect(blobs.at(-1)).not.toContain('WEBVTT');
      handle.destroy();
    });

    it(`${name}: convert false with the default formats offers nothing, and says so`, async () => {
      installDom();
      const { client: api, calls } = client();
      const resolved: number[] = [];

      // The corpus is 0.036% WebVTT, so this is the honest empty case rather than a
      // silent one: the resolve still happens, still reports, and still costs nothing.
      const handle = attachSubtitleDb(FAKES[name]?.(), {
        client: api,
        hint: HINT,
        languages: ['en'],
        convert: false,
        onResolved: (r) => resolved.push(r.candidates.length),
      });
      // The api path resolves on attach, the element path on a media event this fake
      // never fires. One resolve either way, and it reports the empty offer.
      if (ownsTracks(name)) await vi.waitFor(() => expect(resolved).toHaveLength(1));
      else await handle.refresh();

      expect(resolved).toEqual([0]);
      expect(handle.tracks()).toEqual([]);
      expect(calls.filter((c) => c.url.includes('/get/'))).toHaveLength(0);
      handle.destroy();
    });
  }
});

describe('formats', () => {
  for (const name of PATHS) {
    it(`${name}: a format the player cannot render is never offered`, async () => {
      installDom();
      const { client: api } = client();

      // sub is in the fixture and is not convertible, so it must not reach the player
      // whatever else is on offer.
      const handle = attachSubtitleDb(FAKES[name]?.(), {
        client: api,
        hint: HINT,
        languages: ['en', 'fr'],
        formats: ['vtt'],
      });
      const result = await handle.refresh();

      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates.some((c) => c.subtitle.format === 'sub')).toBe(false);
      handle.destroy();
    });
  }
});

describe('onError', () => {
  for (const name of PATHS) {
    it(`${name}: an unreachable API is reported, not thrown`, async () => {
      installDom();
      const errors: unknown[] = [];
      const { fetch } = stubFetch([{ match: /./, throws: true }]);
      const api = new SubtitleDbClient({ fetch, retries: 0 });

      const handle = attachSubtitleDb(FAKES[name]?.(), {
        client: api,
        hint: HINT,
        languages: ['en'],
        onError: (e) => errors.push(e),
      });
      const result = await handle.refresh();

      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toBeInstanceOf(Error);
      expect(result.candidates).toEqual([]);
      expect(handle.tracks()).toEqual([]);
      handle.destroy();
    });

    it(`${name}: a subtitle that will not download is reported, and the rest survive`, async () => {
      installDom();
      const errors: unknown[] = [];
      const { fetch } = stubFetch([
        {
          match: /by-imdb/,
          body: movieBundle([bundleSubtitle({ id: 1, language: 'en', format: 'srt' })]),
        },
        { match: /\/get\//, status: 500, body: { error: 'server_error', message: 'nope' } },
      ]);
      const api = new SubtitleDbClient({ fetch, retries: 0 });
      const target = FAKES[name]?.();

      const handle = attachSubtitleDb(target, {
        client: api,
        hint: HINT,
        languages: ['en'],
        onError: (e) => errors.push(e),
      });
      const result = await handle.refresh();
      expect(result.candidates).toHaveLength(1);

      const first = handle.tracks()[0];
      if (!first) throw new Error('no candidate');
      await handle.select(first);

      // The offer is still standing, so the viewer can pick something else.
      expect(errors.length).toBeGreaterThan(0);
      expect(handle.tracks()).toHaveLength(1);
      handle.destroy();
    });
  }
});
