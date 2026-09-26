/**
 * SubtitleDB.query, get, toBlobUrl and toTrack, and the antispam id every call carries.
 *
 * These were written, documented on the site, and then left on a branch that never
 * merged, so the CDN shipped three releases without them. What is pinned here is the
 * surface and the id, so neither can go missing again without a test saying so.
 *
 * The engine chunk is the fixture in ./fixtures, imported through the real dynamic
 * import, for the reason attach.test.ts gives.
 */
import { resolveObjectURL } from 'node:buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';

const FIXTURES = new URL('./fixtures/', import.meta.url).href;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** A fresh copy of the loader, as a new page load would have. */
async function fresh() {
  vi.resetModules();
  Reflect.deleteProperty(globalThis, '__subtitledb__');
  const base = await import('../src/base.js');
  base.setBasePath(FIXTURES);
  const q = await import('../src/query.js');
  const ids = await import('../src/ids.js');
  const { attach } = await import('../src/attach.js');
  const engine = await import('./fixtures/engine.mjs');
  engine.calls.length = 0;
  engine.queries.length = 0;
  engine.answer.results = [engine.result()];
  return { ...q, ids, attach, engine };
}

/** A video element the way the probe duck-types one. */
function video(): unknown {
  return { tagName: 'VIDEO', className: '', addEventListener() {}, parentElement: null };
}

/** Enough of a document for toTrack: createElement hands back a plain object. */
function stubDocument(): void {
  vi.stubGlobal('document', { createElement: (tag: string) => ({ tagName: tag.toUpperCase() }) });
}

/** The type and text behind a blob URL made in this process. */
async function blob(url: string): Promise<{ type: string; text: string }> {
  const b = resolveObjectURL(url);
  if (!b) throw new Error(`no blob behind ${url}`);
  return { type: b.type, text: await b.text() };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('query', () => {
  it('loads the engine chunk and answers with results that fetch nothing yet', async () => {
    const { query, engine } = await fresh();
    const res = await query({ hint: { imdbId: 'tt0133093' }, languages: ['en'] });

    expect(engine.queries).toHaveLength(1);
    expect(engine.queries[0].hint).toEqual({ imdbId: 'tt0133093' });
    expect(engine.queries[0].languages).toEqual(['en']);
    expect(res.tier).toBe('explicit-imdb');
    expect(res.results).toHaveLength(1);
    expect(res.results[0]?.url).toBe('https://api.example.test/get/5');
    expect(typeof res.results[0]?.load).toBe('function');
    expect(typeof res.results[0]?.blobUrl).toBe('function');
    expect(typeof res.results[0]?.track).toBe('function');
  });

  it('names the release and the page load on the way in', async () => {
    const { query, engine } = await fresh();
    await query({ hint: { imdbId: 'tt0133093' } });
    expect(engine.queries[0].clientName).toBe('cdn/0.0.0-test');
    expect(engine.queries[0].antispamId).toMatch(UUID);
  });

  it('lets the page name itself', async () => {
    const { query, engine } = await fresh();
    await query({ hint: { imdbId: 'tt0133093' }, clientName: 'mine/1', antispamId: 'page-1' });
    expect(engine.queries[0].clientName).toBe('mine/1');
    expect(engine.queries[0].antispamId).toBe('page-1');
  });

  it('gives each result a blob URL and a track on demand', async () => {
    stubDocument();
    const { query } = await fresh();
    const [first] = (await query({ hint: { imdbId: 'tt0133093' } })).results;
    if (!first) throw new Error('expected a result');

    const url = await first.blobUrl();
    expect(await blob(url)).toEqual({
      type: 'text/vtt;charset=utf-8',
      text: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n',
    });
    const track = await first.track();
    expect(track).toMatchObject({ tagName: 'TRACK', kind: 'subtitles', srclang: 'en' });
    expect(track.label).toBe('English - 1 lines');
    expect(track.src).toMatch(/^blob:/);
  });
});

describe('get', () => {
  it('loads the top result and hands it back ready to append', async () => {
    stubDocument();
    const { get, engine } = await fresh();
    const got = await get({ hint: { imdbId: 'tt0133093' }, convertTo: 'vtt' });
    if (!got) throw new Error('expected a subtitle');

    expect(engine.queries[0].convertTo).toBe('vtt');
    expect(got.format).toBe('vtt');
    expect(got.text.startsWith('WEBVTT')).toBe(true);
    expect(got.url).toBe('https://api.example.test/get/5');
    expect(got.subtitle).toEqual({ id: 5 });
    expect((await blob(got.blobUrl)).text).toBe(got.text);
    expect(got.track).toMatchObject({ tagName: 'TRACK', kind: 'subtitles', srclang: 'en' });
  });

  it('is null, not an error, when nothing matched', async () => {
    const { get, engine } = await fresh();
    engine.answer.results = [];
    expect(await get({ hint: { imdbId: 'tt0000001' } })).toBeNull();
  });

  it('carries the same ids as query', async () => {
    const { get, engine } = await fresh();
    engine.answer.results = [];
    await get({ hint: { imdbId: 'tt0133093' } });
    expect(engine.queries[0].clientName).toBe('cdn/0.0.0-test');
    expect(engine.queries[0].antispamId).toMatch(UUID);
  });
});

describe('toBlobUrl', () => {
  it('types the blob by format, so a passthrough result is not called WebVTT', async () => {
    const { toBlobUrl } = await fresh();
    const loaded = (format: string) => ({ text: 'x', format, language: 'en', label: 'English' });
    expect((await blob(toBlobUrl(loaded('vtt')))).type).toBe('text/vtt;charset=utf-8');
    expect((await blob(toBlobUrl(loaded('ASS')))).type).toBe('text/x-ssa;charset=utf-8');
    expect((await blob(toBlobUrl(loaded('ssa')))).type).toBe('text/x-ssa;charset=utf-8');
    expect((await blob(toBlobUrl(loaded('srt')))).type).toBe('text/plain;charset=utf-8');
  });
});

describe('the antispam id', () => {
  it('is one id for the whole page load: every query, every get, every attach', async () => {
    const { query, get, attach, ids, engine } = await fresh();
    await query({ hint: { imdbId: 'tt0133093' } });
    await query({ hint: { tmdbId: 603 } });
    engine.answer.results = [];
    await get({ hint: { imdbId: 'tt0133093' } });
    await attach(video(), {}).ready;

    expect(ids.ANTISPAM_ID).toMatch(UUID);
    const seen = [...engine.queries, ...engine.calls.map((c: { options: unknown }) => c.options)];
    expect(seen).toHaveLength(4);
    for (const options of seen) {
      expect((options as { antispamId?: string }).antispamId).toBe(ids.ANTISPAM_ID);
    }
  });

  it('is minted again on the next page load', async () => {
    const first = (await fresh()).ids.ANTISPAM_ID;
    const second = (await fresh()).ids.ANTISPAM_ID;
    expect(first).toMatch(UUID);
    expect(second).toMatch(UUID);
    expect(second).not.toBe(first);
  });

  it('still has the same shape where crypto.randomUUID is missing', async () => {
    // A page served over plain http has no randomUUID. The id only has to be unique
    // within one page load, so the fallback is allowed to be non-cryptographic.
    vi.stubGlobal('crypto', {});
    const { ids } = await fresh();
    expect(ids.ANTISPAM_ID).toMatch(UUID);
  });

  it('is never stored, so it cannot outlive the page and follow a visitor', async () => {
    const touched: string[] = [];
    const trap = (name: string) => ({
      getItem: () => touched.push(`${name}.getItem`),
      setItem: () => touched.push(`${name}.setItem`),
    });
    vi.stubGlobal('localStorage', trap('localStorage'));
    vi.stubGlobal('sessionStorage', trap('sessionStorage'));
    vi.stubGlobal('indexedDB', { open: () => touched.push('indexedDB.open') });
    const doc = {
      createElement: (tag: string) => ({ tagName: tag.toUpperCase() }),
      get cookie() {
        touched.push('cookie read');
        return '';
      },
      set cookie(_v: string) {
        touched.push('cookie write');
      },
    };
    vi.stubGlobal('document', doc);

    const { query, get, attach } = await fresh();
    await query({ hint: { imdbId: 'tt0133093' } });
    await get({ hint: { imdbId: 'tt0133093' } });
    await attach(video(), {}).ready;

    expect(touched).toEqual([]);
  });
});
