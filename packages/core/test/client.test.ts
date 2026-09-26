import { describe, expect, it } from 'vitest';
import { backoffMs, createClient, normaliseImdb, SubtitleDbClient } from '../src/client.js';
import { SubtitleDbError } from '../src/errors.js';
import { movieBundle, stubFetch } from './fixtures.js';

describe('normaliseImdb', () => {
  it('accepts every form a player might hand us', () => {
    expect(normaliseImdb(133093)).toBe('tt0133093');
    expect(normaliseImdb('133093')).toBe('tt0133093');
    expect(normaliseImdb('tt0133093')).toBe('tt0133093');
    expect(normaliseImdb('TT0133093')).toBe('tt0133093');
    expect(normaliseImdb(' tt1480055 ')).toBe('tt1480055');
  });

  it('rejects junk rather than sending it to the API', () => {
    expect(() => normaliseImdb('not-an-id')).toThrow(SubtitleDbError);
    expect(() => normaliseImdb('tt')).toThrow(SubtitleDbError);
  });
});

describe('backoffMs', () => {
  it('honours a numeric Retry-After in seconds', () => {
    expect(backoffMs(0, '3')).toBe(3000);
  });

  it('honours an HTTP-date Retry-After', () => {
    const when = new Date(Date.now() + 2000).toUTCString();
    const got = backoffMs(0, when);
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThanOrEqual(8000);
  });

  it('caps at the ceiling so a hostile header cannot stall a player', () => {
    expect(backoffMs(0, '99999')).toBe(8000);
  });

  it('grows exponentially and stays jittered', () => {
    // rand is injected so the jitter is assertable rather than flaky.
    expect(backoffMs(0, null, () => 1)).toBe(300);
    expect(backoffMs(1, null, () => 1)).toBe(600);
    expect(backoffMs(4, null, () => 1)).toBe(4800);
    expect(backoffMs(0, null, () => 0)).toBe(0);
  });
});

describe('SubtitleDbClient', () => {
  it('uses the global fetch without invoking it as a method of the client', async () => {
    // Browsers reject a native fetch called as somebody else's method: "Illegal
    // invocation". Every unit test here injects a plain function, so the default path
    // was never exercised and every page that brought no fetch of its own failed each
    // request before it left the tab. This is that rule, in a test.
    const real = globalThis.fetch;
    const seen: unknown[] = [];
    const native = function (this: unknown) {
      seen.push(this);
      if (this !== undefined && this !== globalThis) {
        throw new TypeError('Illegal invocation');
      }
      return Promise.resolve(new Response(JSON.stringify(movieBundle([])), { status: 200 }));
    } as unknown as typeof fetch;

    globalThis.fetch = native;
    try {
      const c = new SubtitleDbClient();
      await c.byImdb(133093, { lang: 'en' });
      expect(seen).toHaveLength(1);
      expect(seen[0] === globalThis || seen[0] === undefined).toBe(true);
    } finally {
      globalThis.fetch = real;
    }
  });

  it('builds a by-imdb URL with the padded id and the client marker', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-imdb/, body: movieBundle([]) }]);
    const c = new SubtitleDbClient({ fetch, client: 'test/1.0' });
    await c.byImdb(133093, { lang: 'en', limit: 5 });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/v1/by-imdb/tt0133093');
    // One code. The API drops a comma list and answers with every language, so callers
    // fan out one request per language rather than believing a list filtered.
    expect(url.searchParams.get('lang')).toBe('en');
    expect(url.searchParams.get('limit')).toBe('5');
    // A query parameter, not a header: a custom header would force a CORS preflight
    // before every new path for no diagnostic benefit.
    expect(url.searchParams.get('client')).toBe('test/1.0');
  });

  it('reaches the same API through the site origin, which proxies /api', async () => {
    // The prefix belongs on the base, not in the paths. Both deployments are real and
    // both have to work off one set of paths, which is what stops the next person
    // "fixing" it by putting /api back where it was.
    const { fetch, calls } = stubFetch([{ match: /by-title/, body: movieBundle([]) }]);
    await new SubtitleDbClient({ fetch, apiBase: 'https://thesubtitledb.org/api' }).byTitle(
      'matrix',
    );

    const url = new URL(calls[0]?.url ?? '');
    expect(url.origin + url.pathname).toBe('https://thesubtitledb.org/api/v1/by-title');
    expect(url.searchParams.get('q')).toBe('matrix');
  });

  it('omits parameters that were not supplied', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-title/, body: movieBundle([]) }]);
    const c = new SubtitleDbClient({ fetch });
    await c.byTitle('matrix');

    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('q')).toBe('matrix');
    expect(url.searchParams.has('limit')).toBe(false);
    expect(url.searchParams.has('client')).toBe(false);
  });

  it('maps an API error body onto a typed error', async () => {
    const { fetch } = stubFetch([
      {
        match: /by-imdb/,
        status: 404,
        body: { error: 'not_found', message: 'no such title', hint: 'try by-title' },
      },
    ]);
    const c = new SubtitleDbClient({ fetch, retries: 0 });

    await expect(c.byImdb(1)).rejects.toMatchObject({
      status: 404,
      code: 'not_found',
      hint: 'try by-title',
    });
  });

  it('does not retry a 404', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-imdb/, status: 404, body: {} }]);
    const c = new SubtitleDbClient({ fetch, retries: 3 });
    await expect(c.byImdb(1)).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('retries a 500 and succeeds', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      if (n === 1) return new Response('{}', { status: 500 });
      return new Response(JSON.stringify(movieBundle([])), { status: 200 });
    }) as unknown as typeof fetch;

    const c = new SubtitleDbClient({ fetch: impl, retries: 2 });
    const got = await c.byImdb(133093);
    expect(got.title.imdb).toBe('tt0133093');
    expect(n).toBe(2);
  });

  it('survives a transport failure with no readable body', async () => {
    // The API rejects wrong-host requests before its CORS hook runs, so browsers see
    // an opaque network error. Nothing may depend on reading a body here.
    const { fetch } = stubFetch([{ match: /by-imdb/, throws: true }]);
    const c = new SubtitleDbClient({ fetch, retries: 0 });

    const err = await c.byImdb(1).catch((e) => e);
    expect(err).toBeInstanceOf(SubtitleDbError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('transport_error');
    expect(err.retryable).toBe(true);
  });

  it('follows download_url exactly as returned and never builds a files-host URL', async () => {
    const { fetch, calls } = stubFetch([{ match: /files\.example\.test/, text: '1\nhello\n' }]);
    const c = new SubtitleDbClient({ fetch });
    const got = await c.fetchSubtitleText({
      download_url: 'https://files.example.test/dl/99.srt',
      format: 'srt',
    });

    expect(got.text).toBe('1\nhello\n');
    // Returned untouched. This library never converts.
    expect(got.format).toBe('srt');
    expect(calls[0]?.url).toBe('https://files.example.test/dl/99.srt');
  });

  it('sends the antispam id on every request, alongside the client marker', async () => {
    const { fetch, calls } = stubFetch([{ match: /\/v1\/|healthz/, body: movieBundle([]) }]);
    const c = new SubtitleDbClient({ fetch, client: 'cdn/1.0', antispamId: 'aid-123' });
    await c.byImdb('tt0133093');
    await c.byTmdb(603);
    await c.byTitle('the matrix');
    await c.byReleasename('The.Matrix.1999.1080p');
    await c.byInfohash('0123456789abcdef0123456789abcdef01234567');
    await c.bySubid(1);
    await c.health();

    expect(calls).toHaveLength(7);
    for (const call of calls) {
      const url = new URL(call.url);
      // A query parameter, not a header, for the same reason as `client`: no preflight.
      expect(url.searchParams.get('antispam_id'), url.pathname).toBe('aid-123');
      expect(url.searchParams.get('client'), url.pathname).toBe('cdn/1.0');
    }
  });

  it('appends the antispam id to the download too, so a search ties to its download', async () => {
    const { fetch, calls } = stubFetch([{ match: /files\.example\.test/, text: '1\nhi\n' }]);
    const c = new SubtitleDbClient({ fetch, antispamId: 'aid-123' });
    const sub = { download_url: 'https://files.example.test/dl/99.srt', format: 'srt' };
    await c.fetchSubtitleText(sub);

    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/dl/99.srt');
    expect(url.searchParams.get('antispam_id')).toBe('aid-123');
    // The address handed to a caller who downloads it themselves is the same one.
    expect(c.downloadUrl(sub)).toBe(calls[0]?.url);
  });

  it('leaves a download_url that is not a URL alone rather than dropping it', () => {
    const c = new SubtitleDbClient({ antispamId: 'aid-123' });
    expect(c.downloadUrl({ download_url: 'not a url' })).toBe('not a url');
    expect(new SubtitleDbClient().downloadUrl({ download_url: 'https://x.test/get/1' })).toBe(
      'https://x.test/get/1',
    );
  });

  it('decodes the download with the requested charset, sniffing a BOM for auto', async () => {
    // "hi" as UTF-16LE with a byte-order mark. res.text() would read this as UTF-8 and
    // produce mojibake; the encoding option is what a corpus full of non-UTF-8 needs.
    const bytes = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    const impl = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;
    const c = new SubtitleDbClient({ fetch: impl });
    const got = await c.fetchSubtitleText(
      { download_url: 'https://files.example.test/dl/1.srt', format: 'srt' },
      { encoding: 'auto' },
    );
    expect(got.text).toBe('hi');
    expect(got.format).toBe('srt');
  });

  it('builds proxied poster URLs and passes null through', () => {
    const c = createClient({ apiBase: 'https://api.example.test' });
    expect(c.posterUrl('/abc.jpg')).toBe('https://api.example.test/p/w342/abc.jpg');
    expect(c.posterUrl('abc.jpg', 'w780')).toBe('https://api.example.test/p/w780/abc.jpg');
    expect(c.posterUrl(null)).toBeNull();
  });

  it('strips a trailing slash from apiBase so URLs never double up', () => {
    const c = createClient({ apiBase: 'https://api.example.test/' });
    expect(c.apiBase).toBe('https://api.example.test');
  });
});

describe('SubtitleDbClient lookup verbs', () => {
  it('builds every lookup URL against the /v1 surface the deployed API serves', async () => {
    // Full URLs, not pathnames: the same base-vs-path trap that once put /api back in
    // front of /v1 would put it in front of these too, and only a whole-URL assertion
    // sees the base and the path disagreeing with the deployment.
    const { fetch, calls } = stubFetch([
      { match: /by-tmdb/, body: movieBundle([]) },
      { match: /by-imdb/, body: movieBundle([]) },
      { match: /by-infohash/, body: movieBundle([]) },
      { match: /by-releasename/, body: movieBundle([]) },
      { match: /by-title/, body: movieBundle([]) },
      { match: /by-subid/, body: movieBundle([]) },
    ]);
    const c = new SubtitleDbClient({ fetch });

    await c.byTmdb(603);
    await c.byImdb('tt0133093');
    await c.byInfohash('C9E15563EF4B8F2A');
    await c.byReleasename('The.Matrix.1999.1080p.BluRay.x264-GROUP');
    await c.byTitle('matrix');
    await c.bySubid(481207);

    expect(calls.map((x) => new URL(x.url).origin + new URL(x.url).pathname)).toEqual([
      'https://api.thesubtitledb.org/v1/by-tmdb/603',
      // Padded and prefixed the way the API stores an imdb id.
      'https://api.thesubtitledb.org/v1/by-imdb/tt0133093',
      // The infohash is lowercased the way the API stores it.
      'https://api.thesubtitledb.org/v1/by-infohash/c9e15563ef4b8f2a',
      // Free text never touches the path: release names carry dots and slashes.
      'https://api.thesubtitledb.org/v1/by-releasename',
      'https://api.thesubtitledb.org/v1/by-title',
      'https://api.thesubtitledb.org/v1/by-subid/481207',
    ]);
  });

  it('passes free text as a query parameter, not a path segment', async () => {
    const { fetch, calls } = stubFetch([
      { match: /by-releasename/, body: movieBundle([]) },
      { match: /by-title/, body: movieBundle([]) },
    ]);
    const c = new SubtitleDbClient({ fetch });

    await c.byReleasename('The.Matrix.1999.1080p.BluRay.x264-GROUP');
    await c.byTitle('breaking bad');

    const rel = new URL(calls[0]?.url ?? '');
    expect(rel.searchParams.get('release')).toBe('The.Matrix.1999.1080p.BluRay.x264-GROUP');
    const tit = new URL(calls[1]?.url ?? '');
    expect(tit.searchParams.get('q')).toBe('breaking bad');
  });

  it('narrows a series with the season and episode slug', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-tmdb/, body: movieBundle([]) }]);
    const c = new SubtitleDbClient({ fetch });

    await c.byTmdb(1396, { season: 2 });
    await c.byTmdb(1396, { season: 1, episode: 3 });
    // An episode with no season is not a valid slug, so it is dropped, not smuggled in.
    await c.byTmdb(1396, { episode: 3 });

    expect(calls.map((x) => new URL(x.url).pathname)).toEqual([
      '/v1/by-tmdb/1396/season/2',
      '/v1/by-tmdb/1396/season/1/episode/3',
      '/v1/by-tmdb/1396',
    ]);
  });

  it('the slug narrows a series found by any resolving verb, including by-imdb', async () => {
    const { fetch, calls } = stubFetch([
      { match: /by-imdb/, body: movieBundle([]) },
      { match: /by-infohash/, body: movieBundle([]) },
      { match: /by-releasename/, body: movieBundle([]) },
      { match: /by-title/, body: movieBundle([]) },
    ]);
    const c = new SubtitleDbClient({ fetch });

    await c.byImdb('tt0944947', { season: 1, episode: 1 });
    await c.byInfohash('DEADBEEF', { season: 1 });
    await c.byReleasename('some.show.s02', { season: 2 });
    await c.byTitle('breaking bad', { season: 3, episode: 4 });

    expect(calls.map((x) => new URL(x.url).pathname)).toEqual([
      '/v1/by-imdb/tt0944947/season/1/episode/1',
      '/v1/by-infohash/deadbeef/season/1',
      '/v1/by-releasename/season/2',
      '/v1/by-title/season/3/episode/4',
    ]);
  });

  it('threads lang, format and sort onto the subtitle bucket', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-imdb/, body: movieBundle([]) }]);
    const c = new SubtitleDbClient({ fetch });

    await c.byImdb('tt0133093', { lang: 'en', format: 'srt', sort: 'downloads' });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('lang')).toBe('en');
    expect(url.searchParams.get('format')).toBe('srt');
    expect(url.searchParams.get('sort')).toBe('downloads');
  });

  it('carries limit, offset and the client marker on a lookup', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-tmdb/, body: movieBundle([]) }]);
    const c = new SubtitleDbClient({ fetch, client: 'test/1.0' });

    await c.byTmdb(603, { limit: 5, offset: 40 });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('offset')).toBe('40');
    expect(url.searchParams.get('client')).toBe('test/1.0');
  });

  it('returns the bundle the API sent, untouched', async () => {
    const { fetch } = stubFetch([{ match: /by-tmdb/, body: movieBundle([]) }]);
    const c = new SubtitleDbClient({ fetch });

    const bundle = await c.byTmdb(603);
    // A movie has no `seasons` key; only a series root or a season drill carries one.
    // The live suite pins the same keys against production at every scope.
    expect(Object.keys(bundle).sort()).toEqual(['subtitles', 'title']);
    expect(bundle.title.imdb).toBe('tt0133093');
  });
});
