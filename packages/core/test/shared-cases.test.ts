/**
 * The shared cases, run against the TypeScript rules.
 *
 * plugins/shared/match-cases.json is the same file the Python, C# and Lua suites
 * read. A rule changed in one language and not the others fails here, rather than
 * quietly giving a Kodi user a different subtitle from a browser user.
 *
 * Title resolution moved to the server (the by-* lookup verbs), so the cases cover
 * only what still runs client-side: language names, release-name similarity, and
 * subtitle ranking.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { hasLanguageName, languageName } from '../src/languages.js';
import { carriesRelease, rank, similarity } from '../src/match.js';
import type { BundleSubtitle, LanguageCode } from '../src/types.js';
import { bundleSubtitle } from './fixtures.js';

interface SimilarityCase {
  a: string;
  b: string;
  min?: number;
  max?: number;
  why?: string;
}

interface LanguageCase {
  input: string;
  code: string | null;
  name: string | null;
}

interface ReleaseCase {
  release: string;
  title?: string;
  episode_title?: string;
  expect: boolean;
  why?: string;
}

interface SubtitleCase {
  why: string;
  options: {
    title?: string;
    languages?: string[];
    formats?: string[];
    hearing_impaired?: boolean;
    release?: string;
    season?: number;
    episode?: number;
  };
  subtitles: Partial<BundleSubtitle>[];
  expect_order: number[];
  expect_unrenderable?: number;
  expect_same_release?: number[];
}

interface Cases {
  similarity: SimilarityCase[];
  languages: LanguageCase[];
  carries_release: ReleaseCase[];
  subtitle_ranking: SubtitleCase[];
}

const here = dirname(fileURLToPath(import.meta.url));
const cases: Cases = JSON.parse(
  readFileSync(join(here, '../../../plugins/shared/match-cases.json'), 'utf8'),
);

describe('similarity', () => {
  for (const c of cases.similarity) {
    it(c.why ?? `${c.a} against ${c.b}`, () => {
      const got = similarity(c.a, c.b);
      if (c.min !== undefined) expect(got).toBeGreaterThanOrEqual(c.min - 1e-9);
      if (c.max !== undefined) expect(got).toBeLessThanOrEqual(c.max + 1e-9);
    });
  }
});

describe('carries a release', () => {
  for (const c of cases.carries_release) {
    it(c.why ?? c.release, () => {
      expect(carriesRelease(c.release, c.title, c.episode_title)).toBe(c.expect);
    });
  }
});

describe('language names', () => {
  // The web bindings take a code from their own config and never resolve a spelling,
  // so only the names are shared here. Three-letter and regional forms are a media
  // server's problem, and the Python client carries the table for them.
  for (const c of cases.languages) {
    if (!c.code || !hasLanguageName(c.code)) continue;
    it(`${c.code} reads as ${c.name}`, () => {
      expect(languageName(c.code as string)).toBe(c.name);
    });
  }
});

describe('subtitle ranking', () => {
  for (const c of cases.subtitle_ranking) {
    it(c.why, () => {
      const subs = c.subtitles.map((s) =>
        bundleSubtitle({
          ...s,
          language: (s.language ?? 'en') as LanguageCode,
          // The fixture leaves these null, which is what the API sends for a row
          // sub_meta has no entry for. A case that names them means them.
          season: s.season ?? null,
          episode: s.episode ?? null,
        }),
      );
      const { candidates, dropped } = rank(subs, {
        hint: {
          ...(c.options.title !== undefined ? { title: c.options.title } : {}),
          ...(c.options.release !== undefined ? { release: c.options.release } : {}),
          ...(c.options.season !== undefined ? { season: c.options.season } : {}),
          ...(c.options.episode !== undefined ? { episode: c.options.episode } : {}),
        },
        formats: c.options.formats ?? ['srt'],
        ...(c.options.languages ? { languages: c.options.languages } : {}),
        ...(c.options.hearing_impaired !== undefined
          ? { hearingImpaired: c.options.hearing_impaired }
          : {}),
      });

      expect(candidates.map((x) => x.subtitle.id)).toEqual(c.expect_order);
      if (c.expect_unrenderable !== undefined) expect(dropped).toBe(c.expect_unrenderable);
      if (c.expect_same_release !== undefined) {
        const same = candidates.filter((x) => x.reason.includes('same release'));
        expect(same.map((x) => x.subtitle.id)).toEqual(c.expect_same_release);
      }
    });
  }
});
