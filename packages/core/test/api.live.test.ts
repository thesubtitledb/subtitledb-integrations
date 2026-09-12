import { describe, expect, it } from 'vitest';
import { createClient } from '../src/client.js';
import { findSubtitles } from '../src/match.js';
import { createSession } from '../src/session.js';
import type { LookupBundle } from '../src/types.js';

/**
 * These run against the real https://api.thesubtitledb.org.
 *
 * They are the only thing that proves the wire types in src/types.ts still describe
 * what actually ships. Unit tests use fixtures, and a fixture is just a copy of what
 * the API looked like the day somebody wrote it down.
 *
 * They assert the contract, not the current state of the data. Coverage gaps that are
 * known and being worked on (the partial tmdb map, unpopulated season/episode) are
 * tolerated here on purpose, so that fixing them upstream does not turn this suite red.
 */

const client = createClient({ client: 'subtitledb-integrations-tests/0.1.0', timeoutMs: 20_000 });

// The Matrix. Stable, heavily subtitled, and a film.
const FILM_IMDB = 'tt0133093';
// Game of Thrones. A series, so it comes back as a tree and needs a slug to narrow.
const SERIES_IMDB = 'tt0944947';

/** The page for the scope that was asked for. Every bundle carries one, at every scope. */
function scopePage(b: LookupBundle) {
  return b.subtitles;
}

describe('live API contract', () => {
  it('is healthy and reports a populated corpus', async () => {
    const h = await client.health();
    expect(h.ok).toBe(true);
    expect(h.clickhouse).toBe('up');
    expect(h.titles).toBeGreaterThan(400_000);
    expect(h.indexed_subtitles).toBeGreaterThan(6_000_000);
  });

  it('resolves free text to the closest title bundle', async () => {
    const b = await client.byTitle('the matrix');
    expect(b.title.name).toMatch(/matrix/i);
    // by-title carries a match block naming which title won.
    expect(b.match && 'imdb' in b.match ? b.match.imdb : b.title.imdb).toMatch(/^tt\d{7,}$/);
  });

  it('returns one bundle shape at every scope, with no key to narrow on', async () => {
    // A movie, a whole series and an episode drill. All three carry title + subtitles +
    // seasons, and seasons is the only field that varies: the tree, or null.
    const [movie, series, episode] = await Promise.all([
      client.byImdb(FILM_IMDB, { limit: 1 }),
      client.byImdb(SERIES_IMDB, { limit: 1 }),
      client.byImdb(SERIES_IMDB, { season: 1, episode: 1, limit: 1 }),
    ]);
    for (const b of [movie, series, episode]) {
      expect(Object.keys(b)).toEqual(expect.arrayContaining(['title', 'subtitles', 'seasons']));
      expect(b.subtitles.items).toBeInstanceOf(Array);
    }
    expect(movie.seasons).toBeNull();
    expect(episode.seasons).toBeNull();
    expect(Array.isArray(series.seasons)).toBe(true);
    expect(series.seasons?.[0]?.episodes.length).toBeGreaterThan(0);
  });

  it('resolves a film by imdb id and returns subtitles', async () => {
    const b = await client.byImdb(FILM_IMDB, { lang: 'en', limit: 5 });
    expect(b.title.imdb).toBe(FILM_IMDB);
    expect(b.title.name).toMatch(/matrix/i);

    const page = scopePage(b);
    expect(page.total).toBeGreaterThan(0);
    expect(page.items.length).toBeGreaterThan(0);

    const s = page.items[0];
    if (!s) throw new Error('expected a subtitle');
    expect(s.language).toBe('en');
    expect(s.cues).toBeGreaterThan(0);
    expect(s.bytes).toBeGreaterThan(0);
    // /d/ and /dl/ were removed; /get/:id on the API host is the only byte path, and it
    // 302s to the files host. Pinning the shape here is what catches the next move.
    expect(s.download_url).toContain('/get/');
  });

  it('narrows a series to one episode with the season/episode slug', async () => {
    // The rung every media-server plugin and the Stremio addon lands on: a series id
    // plus the numbers. An episode-level imdb id resolves to its SERIES now, so the
    // slug is the only way to reach one episode's files.
    const b = await client.byImdb(SERIES_IMDB, { season: 1, episode: 1, lang: 'en', limit: 5 });
    expect(b.title.imdb).toBe(SERIES_IMDB);
    expect(b.title.name).toMatch(/game of thrones/i);
    // An episode drill puts the episode's own files in the top-level page and sends
    // seasons: null. There is no `episode` key; the SDK narrowed on one for two days.
    expect(b.seasons).toBeNull();
    expect(scopePage(b).items.length).toBeGreaterThan(0);
    expect(scopePage(b).items.every((s) => s.language === 'en')).toBe(true);
  });

  it('accepts the bare-digit imdb spelling the other ports send', async () => {
    // The TypeScript client pads to tt0133093; the python, dotnet and lua ports all send
    // bare digits. Nothing else asserts live that the second spelling still resolves.
    const b = await client.byImdb('133093', { limit: 1 });
    expect(b.title.imdb).toBe(FILM_IMDB);
  });

  it('takes a comma separated lang list on a leaf', async () => {
    // lang used to be one code and a list was silently dropped. It now takes up to 16,
    // which is why the fan-out in match.ts is a cost we choose rather than one we owe.
    const b = await client.byImdb(SERIES_IMDB, {
      season: 1,
      episode: 1,
      lang: 'en,fr',
      limit: 100,
    });
    const langs = new Set(scopePage(b).items.map((s) => s.language));
    expect(langs.has('en')).toBe(true);
    expect(langs.has('fr')).toBe(true);
    expect([...langs].every((l) => l === 'en' || l === 'fr')).toBe(true);
  });

  it('404s an unmapped id with a readable body', async () => {
    // by-tmdb is the verb that 404s cleanly on an id it cannot resolve. by-imdb does NOT:
    // an id with rows but no title row answers 200 with a partial title (below).
    const err = await client.byTmdb(999_999_999).catch((e) => e);
    expect(err.status).toBe(404);
    expect(typeof err.message).toBe('string');
  });

  it('answers an id with rows but no metadata with an empty title, not a 404', async () => {
    // tt9999999 has 24 corpus rows and no usable title behind them. The API answers 200
    // with an empty name and a null year. A caller that reads any 200 as "resolved"
    // shows a blank title, which is why this shape is pinned rather than assumed away.
    const b = await client.byImdb('tt9999999');
    expect(b.title.imdb).toBe('tt9999999');
    expect(b.title.name).toBe('');
    expect(b.title.year).toBeNull();
    expect(b.title.tmdb_id).toBeNull();
    expect(scopePage(b).items.length).toBeGreaterThan(0);
  });

  it('by-tmdb either resolves the same title or 404s', async () => {
    // The imdb->tmdb map is only partial in production, so this can 404 today. Written
    // to accept either outcome so that filling the map does not break this suite.
    const r = await client.byTmdb(603, { limit: 1 }).catch((e) => e);
    if (r instanceof Error) {
      expect((r as { status: number }).status).toBe(404);
    } else {
      expect(r.title.imdb).toBe(FILM_IMDB);
    }
  });

  it('honours the lang filter on the bundle', async () => {
    // Part A threaded lang/format/sort onto the by-* leaves. A single-language ask must
    // come back single-language, which is what the per-language fan-out depends on.
    const b = await client.byImdb(FILM_IMDB, { lang: 'en', limit: 10 });
    const page = scopePage(b);
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((s) => s.language === 'en')).toBe(true);
  });

  it('downloads real subtitle bytes through the redirect, untouched', async () => {
    const b = await client.byImdb(FILM_IMDB, { lang: 'en', format: 'srt', limit: 1 });
    const s = scopePage(b).items[0];
    if (!s) throw new Error('expected a subtitle');

    const got = await client.fetchSubtitleText(s);
    expect(got.format).toBe('srt');
    expect(got.text.length).toBeGreaterThan(100);
    // Served exactly as stored: SRT cue timings, not converted to WebVTT.
    expect(got.text).toMatch(/\d{2}:\d{2}:\d{2},\d{3}\s*-->\s*\d{2}:\d{2}:\d{2},\d{3}/);
    expect(got.text.startsWith('WEBVTT')).toBe(false);
  });

  it('serves poster bytes through our own proxy with an image content type', async () => {
    // poster_path is TMDB enrichment, so response_class has to ask for it: the default
    // minimal class omits every enrichment field rather than sending it null.
    const b = await client.byImdb(FILM_IMDB, { limit: 1, response_class: 'standard' });
    const url = client.posterUrl(b.title.poster_path, 'w185');
    if (!url) throw new Error('expected a poster path for The Matrix');

    const res = await fetch(url);
    expect(res.ok).toBe(true);
    expect(res.headers.get('content-type')).toMatch(/^image\//);
    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBeGreaterThan(1000);
  });

  it('omits the whole enrichment block at the default response class', async () => {
    const b = await client.byImdb(FILM_IMDB, { limit: 1 });
    expect(b.title.poster_path).toBeUndefined();
    expect(b.title.overview).toBeUndefined();
    expect(b.title.name).toBe('The Matrix');
  });
});

describe('live matching', () => {
  it('matches a film from a bare release filename', async () => {
    const { identify } = await import('../src/identify.js');
    const hint = identify({ src: 'The.Matrix.1999.1080p.BluRay.x264-AMIABLE.mkv', doc: null });
    expect(hint.title).toBe('The Matrix');

    const r = await findSubtitles({ client, hint, formats: ['srt'], languages: ['en'] });
    expect(r.tier).toBe('title');
    expect(r.title?.imdb).toBe(FILM_IMDB);
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.candidates[0]?.subtitle.language).toBe('en');
  });

  it('honours the format filter against real data', async () => {
    // The corpus is ~90% srt and only 0.036% vtt, so asking for vtt only should
    // usually drop everything for a given title. Either way, nothing unrenderable
    // may survive the filter.
    const r = await findSubtitles({
      client,
      hint: { imdbId: FILM_IMDB },
      formats: ['srt'],
      limit: 20,
    });
    expect(r.candidates.every((c) => c.subtitle.format === 'srt')).toBe(true);
  });
});

describe('live session traffic budget', () => {
  it('an eager attach costs exactly one request and downloads nothing', async () => {
    let requests = 0;
    const counting: typeof fetch = (input, init) => {
      requests++;
      return fetch(input as RequestInfo, init);
    };

    const s = createSession({
      apiBase: 'https://api.thesubtitledb.org',
      clientName: 'subtitledb-integrations-tests/0.1.0',
      fetch: counting,
      formats: ['srt'],
      languages: ['en'],
    });

    const r = await s.resolve({ imdbId: FILM_IMDB });
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(requests).toBe(1);

    const pick = r.candidates[0];
    if (!pick) throw new Error('expected a candidate');
    const loaded = await s.load(pick);
    expect(loaded?.text.length).toBeGreaterThan(100);
    // One more request for the bytes, and the redirect is followed transparently.
    expect(requests).toBe(2);
    s.dispose();
  });
});
