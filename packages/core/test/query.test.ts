import { describe, expect, it } from 'vitest';
import { SubtitleDbError } from '../src/errors.js';
import { query } from '../src/query.js';
import { bundleSubtitle, movieBundle, stubFetch } from './fixtures.js';

const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello\n';
const DOWNLOAD = /\/get\/5(\?|$)/;

function routes() {
  return [
    {
      match: /by-imdb/,
      body: movieBundle([bundleSubtitle({ id: 5, format: 'srt', language: 'en' })]),
    },
    { match: DOWNLOAD, text: SRT },
  ];
}

describe('query', () => {
  it('maps candidates to results with a URL and downloads nothing until load()', async () => {
    const { fetch, calls } = stubFetch(routes());
    const res = await query({ hint: { imdbId: 'tt0133093' }, languages: ['en'], fetch });

    expect(res.tier).toBe('explicit-imdb');
    expect(res.title?.name).toBe('The Matrix');
    expect(res.results).toHaveLength(1);
    const first = res.results[0];
    if (!first) throw new Error('expected a result');
    expect(first.url).toBe('https://api.thesubtitledb.org/get/5');
    expect(first.id).toBe(5);
    expect(first.language).toBe('en');
    expect(first.format).toBe('srt');
    expect(first.label).toBe('English - 1386 lines');
    expect(first.subtitle.download_url).toBe(first.url);
    // The search ran; the download has not.
    expect(calls.some((c) => DOWNLOAD.test(c.url))).toBe(false);

    const loaded = await first.load();
    expect(calls.some((c) => DOWNLOAD.test(c.url))).toBe(true);
    expect(loaded.text).toContain('Hello');
    // No convertTo and no transform, so the stored format comes back untouched.
    expect(loaded.format).toBe('srt');
    expect(loaded.language).toBe('en');
    expect(loaded.label).toBe(first.label);
  });

  it('converts and shifts on load when asked, returning WebVTT and cues', async () => {
    const { fetch } = stubFetch(routes());
    const res = await query({
      hint: { imdbId: 'tt0133093' },
      convertTo: 'vtt',
      offsetMs: 500,
      cues: true,
      fetch,
    });
    const first = res.results[0];
    if (!first) throw new Error('expected a result');
    const loaded = await first.load();

    expect(loaded.format).toBe('vtt');
    expect(loaded.text.startsWith('WEBVTT')).toBe(true);
    expect(loaded.cues?.[0]).toEqual({ start: 1500, end: 2500, text: 'Hello' });
  });

  it('converts without cues when only convertTo is set', async () => {
    const { fetch } = stubFetch(routes());
    const res = await query({ hint: { imdbId: 'tt0133093' }, convertTo: 'vtt', fetch });
    const loaded = await res.results[0]?.load();

    expect(loaded?.format).toBe('vtt');
    expect(loaded?.text).toContain('00:00:01.000 --> 00:00:02.000');
    expect(loaded?.cues).toBeUndefined();
  });

  it('threads the antispam id through the search, the download and the URL', async () => {
    const { fetch, calls } = stubFetch(routes());
    const res = await query({ hint: { imdbId: 'tt0133093' }, antispamId: 'aid-9', fetch });
    const first = res.results[0];
    if (!first) throw new Error('expected a result');
    await first.load();

    const search = calls.find((c) => c.url.includes('/by-imdb/'));
    const dl = calls.find((c) => DOWNLOAD.test(c.url));
    if (!search || !dl) throw new Error('expected both a search and a download call');
    expect(new URL(search.url).searchParams.get('antispam_id')).toBe('aid-9');
    expect(new URL(dl.url).searchParams.get('antispam_id')).toBe('aid-9');
    // A caller who fetches the URL themselves sends the same id as load() would.
    expect(first.url).toBe(dl.url);
  });

  it('names the download for its integration, apart from the name on the lookups', async () => {
    const { fetch, calls } = stubFetch(routes());
    const res = await query({
      hint: { imdbId: 'tt0133093' },
      clientName: 'mine',
      downloadClient: 'loader',
      fetch,
    });
    const first = res.results[0];
    if (!first) throw new Error('expected a result');
    await first.load();

    const search = calls.find((c) => c.url.includes('/by-imdb/'));
    const dl = calls.find((c) => DOWNLOAD.test(c.url));
    if (!search || !dl) throw new Error('expected both a search and a download call');
    expect(new URL(search.url).searchParams.get('client')).toBe('mine');
    expect(new URL(dl.url).searchParams.get('client')).toBe('loader');
    expect(first.url).toBe(dl.url);
  });

  it('sends no antispam id when none was given', async () => {
    const { fetch, calls } = stubFetch(routes());
    const res = await query({ hint: { imdbId: 'tt0133093' }, fetch });
    await res.results[0]?.load();

    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(new URL(c.url).searchParams.has('antispam_id')).toBe(false);
  });

  it('memoises load so two reads fetch once', async () => {
    const { fetch, calls } = stubFetch(routes());
    const res = await query({ hint: { imdbId: 'tt0133093' }, fetch });
    const first = res.results[0];
    if (!first) throw new Error('expected a result');
    await Promise.all([first.load(), first.load()]);
    expect(calls.filter((c) => DOWNLOAD.test(c.url))).toHaveLength(1);
  });

  it('finds an episode by the series id alone, with the season and episode', async () => {
    const { fetch, calls } = stubFetch([
      {
        match: /by-imdb\/tt0903747\/season\/2\/episode\/3/,
        body: movieBundle([bundleSubtitle({ id: 5 })]),
      },
    ]);
    const res = await query({
      hint: { seriesImdbId: 'tt0903747', season: 2, episode: 3 },
      fetch,
    });
    expect(res.tier).toBe('series-imdb');
    expect(res.results).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('throws not_found when no rung finds the title', async () => {
    const { fetch } = stubFetch([
      { match: /by-imdb/, status: 404, body: { error: 'not_found', message: 'no title' } },
    ]);
    const err = await query({ hint: { imdbId: 'tt9999998' }, fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(SubtitleDbError);
    expect(err).toMatchObject({ status: 404, code: 'not_found' });
    expect(err.message).toContain('tt9999998');
  });

  it('asks once per language however many languages there are', async () => {
    const { fetch, calls } = stubFetch(routes());
    const languages = 'en,fr,de,es,it,pt,nl,sv,no,da,fi,pl,cs,hu,ro,el,tr'.split(',');
    const res = await query({ hint: { imdbId: 'tt0133093' }, languages, fetch });
    expect(res.tier).toBe('explicit-imdb');
    expect(calls).toHaveLength(17);
  });

  it('refuses an http apiBase when a key is set', async () => {
    const { fetch, calls } = stubFetch(routes());
    const err = await query({
      hint: { imdbId: 'tt0133093' },
      key: 'k',
      apiBase: 'http://api.thesubtitledb.org',
      fetch,
    }).catch((e) => e);
    expect(err).toMatchObject({ code: 'bad_request' });
    expect(calls).toHaveLength(0);
  });

  it('returns no results, not an error, when nothing matched', async () => {
    const { fetch } = stubFetch([{ match: /by-imdb/, body: movieBundle([]) }]);
    const res = await query({ hint: { imdbId: 'tt0133093' }, fetch });
    expect(res.results).toEqual([]);
  });

  it('throws the API refusal rather than returning an empty result', async () => {
    const { fetch } = stubFetch([
      { match: /by-imdb/, status: 400, body: { error: 'bad_request', message: 'lang: bad code' } },
    ]);
    const err = await query({ hint: { imdbId: 'tt0133093' }, fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(SubtitleDbError);
    expect(err).toMatchObject({ status: 400, code: 'bad_request', message: 'lang: bad code' });
  });

  it('throws a transport failure too', async () => {
    const { fetch } = stubFetch([{ match: /by-imdb/, throws: true }]);
    const err = await query({ hint: { imdbId: 'tt0133093' }, fetch }).catch((e) => e);
    expect(err).toMatchObject({ code: 'transport_error' });
  });

  it('refuses a hint with nothing to look up by, before any request', async () => {
    const { fetch, calls } = stubFetch([]);
    for (const hint of [undefined, {}, { season: 1, episode: 1 }, { title: 'x' }]) {
      const err = await query({ hint, fetch }).catch((e) => e);
      expect(err, JSON.stringify(hint)).toBeInstanceOf(SubtitleDbError);
      expect(err.code).toBe('bad_request');
    }
    expect(calls).toHaveLength(0);
  });

  it('maps language tags to corpus codes, one request per language', async () => {
    const { fetch, calls } = stubFetch(routes());
    await query({
      hint: { imdbId: 'tt0133093' },
      lang: 'en-US',
      languages: ['pt-BR', 'en'],
      fetch,
    });
    const langs = calls.map((c) => new URL(c.url).searchParams.get('lang'));
    expect(langs).toEqual(['en', 'pb']);
  });

  it('sends the key on the lookup and the download', async () => {
    const { fetch, calls } = stubFetch(routes());
    const { results } = await query({ hint: { imdbId: 'tt0133093' }, key: 'sdb_k', fetch });
    await results[0]?.load();
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(new Headers(c.init?.headers).get('authorization')).toBe('Bearer sdb_k');
    }
  });
});
