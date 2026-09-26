import { describe, expect, it } from 'vitest';
import {
  decodeBytes,
  query as exported,
  parseVtt,
  rescale,
  serialize,
  shift,
} from '../src/index.js';
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
  it('is exported from the package, with the cue tools it converts with', () => {
    // The loader's SubtitleDB.query and get are this function. It once sat on an
    // unmerged branch for a month while the site documented it as shipped.
    expect(exported).toBe(query);
    for (const fn of [decodeBytes, parseVtt, rescale, serialize, shift]) {
      expect(typeof fn).toBe('function');
    }
  });

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

  it('returns no results, not an error, when nothing matched', async () => {
    const { fetch } = stubFetch([{ match: /by-imdb/, body: movieBundle([]) }]);
    const res = await query({ hint: { imdbId: 'tt0133093' }, fetch });
    expect(res.results).toEqual([]);
  });
});
