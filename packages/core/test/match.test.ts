import { describe, expect, it } from 'vitest';
import { SubtitleDbClient } from '../src/client.js';
import { findSubtitles, similarity } from '../src/match.js';
import type { BundleSubtitle } from '../src/types.js';
import { bundleSubtitle, episodeBundle, lookupTitle, movieBundle, stubFetch } from './fixtures.js';

const SRT_ONLY = ['srt'];

function clientWith(routes: Parameters<typeof stubFetch>[0]) {
  const { fetch, calls } = stubFetch(routes);
  return { client: new SubtitleDbClient({ fetch, retries: 0 }), calls };
}

describe('similarity', () => {
  it('scores identical strings at 1 and unrelated ones near 0', () => {
    expect(similarity('The Matrix', 'The Matrix')).toBe(1);
    expect(similarity('The Matrix', 'Amelie')).toBeLessThan(0.2);
  });

  it('ignores case, punctuation and accents', () => {
    expect(similarity('Amelie', 'Amélie')).toBe(1);
    expect(similarity('Spider-Man: No Way Home', 'spider man no way home')).toBe(1);
  });
});

describe('findSubtitles ladder', () => {
  it('rung 1: resolves an explicit tmdb id in one request', async () => {
    // tmdb is the headline key, so it leads the ladder.
    const { client, calls } = clientWith([
      { match: /by-tmdb\/603/, body: movieBundle([bundleSubtitle()]) },
    ]);

    const r = await findSubtitles({ client, hint: { tmdbId: 603 }, formats: SRT_ONLY });

    expect(r.tier).toBe('explicit-tmdb');
    expect(r.candidates).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('rung 2: resolves an explicit imdb id, which is how media servers arrive', async () => {
    const { client, calls } = clientWith([
      { match: /by-imdb\/tt0133093/, body: movieBundle([bundleSubtitle()]) },
    ]);

    const r = await findSubtitles({ client, hint: { imdbId: 'tt0133093' }, formats: SRT_ONLY });

    expect(r.tier).toBe('explicit-imdb');
    expect(r.candidates).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('explicit imdb also resolves a TV episode, because episodes carry their own imdb id', async () => {
    const got = movieBundle(
      [bundleSubtitle({ id: 7162825, language: 'en' })],
      lookupTitle({ imdb: 'tt1480055', name: '"Game of Thrones" Winter Is Coming', year: 2011 }),
    );
    const { client } = clientWith([{ match: /by-imdb\/tt1480055/, body: got }]);

    const r = await findSubtitles({ client, hint: { imdbId: 'tt1480055' }, formats: SRT_ONLY });
    expect(r.tier).toBe('explicit-imdb');
    expect(r.title?.name).toContain('Game of Thrones');
  });

  it('a tmdb 404 falls through to imdb rather than failing', async () => {
    // The imdb->tmdb map is only partial in production, so by-tmdb 404s for many ids.
    // A plugin must treat that as "next rung", never as an error.
    const { client } = clientWith([
      { match: /by-tmdb/, status: 404, body: { error: 'not_found', message: 'no mapping' } },
      { match: /by-imdb/, body: movieBundle([bundleSubtitle()]) },
    ]);

    const r = await findSubtitles({
      client,
      hint: { tmdbId: 603, imdbId: 'tt0133093' },
      formats: SRT_ONLY,
    });

    expect(r.tier).toBe('explicit-imdb');
    expect(r.candidates).toHaveLength(1);
  });

  it('falls all the way through to the title when both ids miss', async () => {
    const { client } = clientWith([
      { match: /by-tmdb/, status: 404, body: {} },
      { match: /by-imdb/, status: 404, body: {} },
      { match: /by-title/, body: movieBundle([bundleSubtitle()]) },
    ]);

    const r = await findSubtitles({
      client,
      hint: { tmdbId: 603, imdbId: 'tt0133093', title: 'The Matrix', year: 1999 },
      formats: SRT_ONLY,
    });

    expect(r.tier).toBe('title');
    expect(r.candidates).toHaveLength(1);
  });

  it('rung 3: an episode with no id of its own goes by the series id before the name', async () => {
    // By name, the API answers "Friends" with Matlock (2024). The series' id, drilled
    // to the season and episode, is the episode's own page.
    const { client, calls } = clientWith([
      {
        match: /by-imdb\/tt0108778\/season\/1\/episode\/1/,
        body: episodeBundle([bundleSubtitle({ id: 7 })], {
          season: 1,
          episode: 1,
          title: lookupTitle({ imdb: 'tt0108778', name: 'Friends', year: 1994 }),
        }),
      },
      { match: /by-title/, body: movieBundle([bundleSubtitle({ id: 9 })]) },
    ]);

    const r = await findSubtitles({
      client,
      hint: { seriesImdbId: 'tt0108778', title: 'Friends', season: 1, episode: 1 },
      formats: SRT_ONLY,
    });

    expect(r.tier).toBe('series-imdb');
    expect(r.candidates.map((c) => c.subtitle.id)).toEqual([7]);
    expect(calls).toHaveLength(1);
  });

  it("an episode's own id comes before its series id", async () => {
    const { client, calls } = clientWith([
      { match: /by-imdb\/tt0583459/, body: movieBundle([bundleSubtitle()]) },
    ]);

    const r = await findSubtitles({
      client,
      hint: { imdbId: 'tt0583459', seriesImdbId: 'tt0108778', season: 1, episode: 1 },
      formats: SRT_ONLY,
    });

    expect(r.tier).toBe('explicit-imdb');
    expect(calls).toHaveLength(1);
  });

  it('an episode the series id cannot drill to falls through to the name', async () => {
    const { client, calls } = clientWith([
      { match: /by-imdb/, status: 404, body: {} },
      { match: /by-title/, body: movieBundle([bundleSubtitle()]) },
    ]);

    const r = await findSubtitles({
      client,
      hint: { seriesImdbId: 'tt0108778', title: 'Friends', season: 1, episode: 99 },
      formats: SRT_ONLY,
    });

    expect(r.tier).toBe('title');
    expect(calls).toHaveLength(2);
  });

  it('rung 4: drills a series title straight to the episode by its numbers', async () => {
    // The server matches the title and narrows by season/episode, so the client sends
    // the numbers in the slug and never ranks a list of titles itself.
    const { client, calls } = clientWith([
      {
        match: /by-title/,
        body: episodeBundle([bundleSubtitle({ id: 7 })], {
          season: 1,
          episode: 1,
          title: lookupTitle({ imdb: 'tt1480055', name: '"Game of Thrones" Winter Is Coming' }),
        }),
      },
    ]);

    const r = await findSubtitles({
      client,
      hint: { title: 'Game of Thrones', season: 1, episode: 1 },
      formats: SRT_ONLY,
    });

    expect(r.tier).toBe('title');
    expect(r.candidates.map((c) => c.subtitle.id)).toEqual([7]);
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/v1/by-title/season/1/episode/1');
    expect(url.searchParams.get('q')).toBe('Game of Thrones');
  });

  it('drops rows filed under another episode, and counts them', async () => {
    // The wrong episode is not a worse match, it is the wrong file: this is how a
    // viewer ends up watching episode 14 with episode 15's lines. A row sub_meta has
    // no entry for is kept, because unknown is not wrong.
    const subs = [
      bundleSubtitle({ id: 1, season: 1, episode: 1 }),
      bundleSubtitle({ id: 2, season: 1, episode: 2 }),
      bundleSubtitle({ id: 3 }),
    ];
    const { client } = clientWith([
      { match: /by-imdb/, body: episodeBundle(subs, { season: 1, episode: 1 }) },
    ]);

    const r = await findSubtitles({
      client,
      hint: { imdbId: 'tt1480055', season: 1, episode: 1 },
      formats: SRT_ONLY,
    });

    expect(r.candidates.map((c) => c.subtitle.id)).toEqual([1, 3]);
    expect(r.wrongEpisode).toBe(1);
  });

  it('reports manual when the title does not resolve', async () => {
    const { client } = clientWith([{ match: /by-title/, status: 404, body: {} }]);

    const r = await findSubtitles({
      client,
      hint: { title: 'Zzzz Nonexistent Qqqq' },
      formats: SRT_ONLY,
    });

    expect(r.tier).toBe('manual');
    expect(r.candidates).toHaveLength(0);
  });

  it('returns manual immediately when the hint is unusable, spending no requests', async () => {
    const { client, calls } = clientWith([]);
    const r = await findSubtitles({ client, hint: {}, formats: SRT_ONLY });
    expect(r.tier).toBe('manual');
    expect(calls).toHaveLength(0);
  });
});

describe('format filtering', () => {
  it('drops formats the player cannot render and counts them', async () => {
    // Hard filter, not a preference. Nothing here converts, so handing a player an
    // ass file it cannot parse produces a silently empty caption track.
    const subs = [
      bundleSubtitle({ id: 1, format: 'srt' }),
      bundleSubtitle({ id: 2, format: 'ass' }),
      bundleSubtitle({ id: 3, format: 'sub' }),
      bundleSubtitle({ id: 4, format: 'vtt' }),
    ];
    const { client } = clientWith([{ match: /by-imdb/, body: movieBundle(subs) }]);

    const r = await findSubtitles({
      client,
      hint: { imdbId: 'tt0133093' },
      formats: ['srt', 'vtt'],
    });

    expect(r.candidates.map((c) => c.subtitle.id).sort()).toEqual([1, 4]);
    expect(r.unrenderable).toBe(2);
  });

  it('can end up with zero candidates when no format is renderable', async () => {
    const { client } = clientWith([
      { match: /by-imdb/, body: movieBundle([bundleSubtitle({ format: 'ass' })]) },
    ]);

    const r = await findSubtitles({
      client,
      hint: { imdbId: 'tt0133093' },
      formats: ['vtt'],
    });

    expect(r.candidates).toHaveLength(0);
    expect(r.unrenderable).toBe(1);
    // Still reports the tier that resolved, so the caller can say "found the title,
    // but your player cannot render any of its subtitles".
    expect(r.tier).toBe('explicit-imdb');
    expect(r.title).not.toBeNull();
  });
});

describe('ranking', () => {
  it('orders by language preference', async () => {
    const subs = [
      bundleSubtitle({ id: 1, language: 'de' }),
      bundleSubtitle({ id: 2, language: 'fr' }),
      bundleSubtitle({ id: 3, language: 'en' }),
    ];
    const { client } = clientWith([{ match: /by-imdb/, body: movieBundle(subs) }]);

    const r = await findSubtitles({
      client,
      hint: { imdbId: 'tt0133093' },
      formats: SRT_ONLY,
      languages: ['en', 'fr'],
    });

    expect(r.candidates.map((c) => c.subtitle.language)).toEqual(['en', 'fr', 'de']);
  });

  it('puts the subtitle recorded against this exact file first', async () => {
    // Two release names, compared against each other. Comparing a release name
    // against the film's title, which is what this did before sub_meta published
    // release_name, cannot agree with anything.
    const subs = [
      bundleSubtitle({ id: 1, release_name: 'Anatomy.of.a.Fall.2023.720p.WEBRip.x264-GALAXY' }),
      bundleSubtitle({ id: 2, release_name: 'Anatomy.of.a.Fall.2023.1080p.BluRay.x264-KOVAL' }),
    ];
    const { client } = clientWith([{ match: /by-imdb/, body: movieBundle(subs) }]);

    const r = await findSubtitles({
      client,
      hint: {
        imdbId: 'tt0133093',
        title: 'Anatomy of a Fall',
        release: 'Anatomy.of.a.Fall.2023.1080p.BluRay.x264-KOVAL',
      },
      formats: SRT_ONLY,
    });

    expect(r.candidates.map((c) => c.subtitle.id)).toEqual([2, 1]);
    expect(r.candidates[0]?.reason).toContain('same release');
  });

  it('sinks zero-cue subtitles, which cannot render at all', async () => {
    const subs = [bundleSubtitle({ id: 1, cues: 0 }), bundleSubtitle({ id: 2, cues: 900 })];
    const { client } = clientWith([{ match: /by-imdb/, body: movieBundle(subs) }]);

    const r = await findSubtitles({ client, hint: { imdbId: 'tt0133093' }, formats: SRT_ONLY });
    expect(r.candidates[0]?.subtitle.id).toBe(2);
    expect(r.candidates[1]?.reason).toContain('no cues');
  });

  it('respects a hearing-impaired preference', async () => {
    const subs = [
      bundleSubtitle({ id: 1, hearing_impaired: false }),
      bundleSubtitle({ id: 2, hearing_impaired: true }),
    ];
    const { client } = clientWith([{ match: /by-imdb/, body: movieBundle(subs) }]);

    const r = await findSubtitles({
      client,
      hint: { imdbId: 'tt0133093' },
      formats: SRT_ONLY,
      hearingImpaired: true,
    });

    expect(r.candidates[0]?.subtitle.id).toBe(2);
  });

  it('is deterministic when scores tie', async () => {
    const subs = [bundleSubtitle({ id: 9 }), bundleSubtitle({ id: 3 }), bundleSubtitle({ id: 5 })];
    const { client } = clientWith([{ match: /by-imdb/, body: movieBundle(subs) }]);

    const r = await findSubtitles({ client, hint: { imdbId: 'tt0133093' }, formats: SRT_ONLY });
    expect(r.candidates.map((c) => c.subtitle.id)).toEqual([3, 5, 9]);
  });
});

describe('language fan-out', () => {
  // Regression, found against the live API. `lang` takes a single ISO code; a comma
  // separated list is accepted, ignored, and the default sort=lang then returns the
  // alphabetically earliest languages. The Matrix has 715 subtitles, so limit=100
  // came back ar through de with no English at all, while the client believed it had
  // asked for English. One request per language is the fix.
  function fanFetch(byLang: Record<string, BundleSubtitle[]>) {
    const asked: (string | undefined)[] = [];
    const client = {
      byImdb: async (_id: string, q: { lang?: string }) => {
        asked.push(q.lang);
        return movieBundle(q.lang ? (byLang[q.lang] ?? []) : Object.values(byLang).flat());
      },
    } as unknown as SubtitleDbClient;
    return { client, asked };
  }

  it('issues one request per configured language', async () => {
    const { client, asked } = fanFetch({
      en: [bundleSubtitle({ id: 1, language: 'en' })],
      fr: [bundleSubtitle({ id: 2, language: 'fr' })],
      es: [bundleSubtitle({ id: 3, language: 'es' })],
    });

    const r = await findSubtitles({
      client,
      hint: { imdbId: 'tt0133093' },
      languages: ['en', 'fr', 'es'],
      formats: ['srt'],
    });

    expect(asked).toEqual(['en', 'fr', 'es']);
    expect(r.candidates.map((c) => c.subtitle.language)).toEqual(['en', 'fr', 'es']);
  });

  it('merges in caller priority order and drops duplicate ids', async () => {
    // A subtitle can legitimately come back under more than one language query if the
    // API ever widens its filter; the merge must not double-count it.
    const shared = bundleSubtitle({ id: 9, language: 'en' });
    const { client } = fanFetch({
      en: [shared],
      de: [shared, bundleSubtitle({ id: 10, language: 'de' })],
    });

    const r = await findSubtitles({
      client,
      hint: { imdbId: 'tt0133093' },
      languages: ['en', 'de'],
      formats: ['srt'],
    });

    expect(r.candidates.map((c) => c.subtitle.id)).toEqual([9, 10]);
  });

  it('asks once, unfiltered, when no language preference is configured', async () => {
    const { client, asked } = fanFetch({ en: [bundleSubtitle({ id: 1 })] });
    await findSubtitles({ client, hint: { imdbId: 'tt0133093' }, formats: ['srt'] });
    expect(asked).toEqual([undefined]);
  });
});

describe('reading past the first page', () => {
  // The API sends at most 100 rows a request. The Matrix holds 147 in English, so a
  // client that reads one page never offers the other 47.
  function rows(total: number, language = 'en', first = 1): BundleSubtitle[] {
    return Array.from({ length: total }, (_, i) => bundleSubtitle({ id: first + i, language }));
  }

  // Pages the way the API does: `limit` rows from `offset`, and the full count in `total`.
  function pagedFetch(byLang: Record<string, BundleSubtitle[]>, honourOffset = true) {
    const asked: { lang?: string; offset?: number; limit?: number }[] = [];
    const client = {
      byImdb: async (_id: string, q: { lang?: string; offset?: number; limit?: number }) => {
        asked.push({ lang: q.lang, offset: q.offset, limit: q.limit });
        const all = byLang[q.lang ?? 'en'] ?? [];
        const from = honourOffset ? (q.offset ?? 0) : 0;
        const page = movieBundle(all.slice(from, from + (q.limit ?? 20)));
        return { ...page, subtitles: { ...page.subtitles, total: all.length } };
      },
    } as unknown as SubtitleDbClient;
    return { client, asked };
  }

  const matrix = { imdbId: 'tt0133093' };

  it('reads a long list a page at a time', async () => {
    const { client, asked } = pagedFetch({ en: rows(250) });
    const r = await findSubtitles({ client, hint: matrix, limit: 500, formats: SRT_ONLY });
    expect(asked.map((a) => [a.offset, a.limit])).toEqual([
      [undefined, 100],
      [100, 100],
      [200, 100],
    ]);
    expect(r.candidates).toHaveLength(250);
  });

  it('stops at the limit', async () => {
    const { client, asked } = pagedFetch({ en: rows(250) });
    const r = await findSubtitles({ client, hint: matrix, limit: 150, formats: SRT_ONLY });
    expect(asked.map((a) => [a.offset, a.limit])).toEqual([
      [undefined, 100],
      [100, 50],
    ]);
    expect(r.candidates).toHaveLength(150);
  });

  it('reads one page by default', async () => {
    const { client, asked } = pagedFetch({ en: rows(250) });
    const r = await findSubtitles({ client, hint: matrix, formats: SRT_ONLY });
    expect(asked).toEqual([{ lang: undefined, offset: undefined, limit: 100 }]);
    expect(r.candidates).toHaveLength(100);
  });

  it('stops when a page brings nothing new', async () => {
    // An API that ignored the offset would send the first page forever.
    const { client, asked } = pagedFetch({ en: rows(250) }, false);
    const r = await findSubtitles({ client, hint: matrix, limit: 500, formats: SRT_ONLY });
    expect(asked).toHaveLength(2);
    expect(r.candidates).toHaveLength(100);
  });

  it('holds the limit for each language', async () => {
    const { client } = pagedFetch({ en: rows(150), fr: rows(150, 'fr', 1001) });
    const r = await findSubtitles({
      client,
      hint: matrix,
      languages: ['en', 'fr'],
      limit: 150,
      formats: SRT_ONLY,
    });
    const langs = r.candidates.map((c) => c.subtitle.language);
    expect(langs.filter((l) => l === 'en')).toHaveLength(150);
    expect(langs.filter((l) => l === 'fr')).toHaveLength(150);
  });

  it('sends an offset only past the first page', async () => {
    const all = rows(150);
    const page = (items: BundleSubtitle[], offset: number) => ({
      title: lookupTitle(),
      subtitles: { total: all.length, limit: 100, offset, items },
    });
    const { client, calls } = clientWith([
      { match: /offset=100/, body: page(all.slice(100), 100) },
      { match: /by-imdb/, body: page(all.slice(0, 100), 0) },
    ]);
    const r = await findSubtitles({ client, hint: matrix, limit: 500, formats: SRT_ONLY });
    expect(calls.map((c) => new URL(c.url).searchParams.get('offset'))).toEqual([null, '100']);
    expect(new URL(calls[1]?.url ?? '').searchParams.get('limit')).toBe('100');
    expect(r.candidates).toHaveLength(150);
  });
});
