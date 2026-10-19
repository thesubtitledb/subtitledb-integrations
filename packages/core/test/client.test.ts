import { describe, expect, it, vi } from 'vitest';
import {
  backoffMs,
  createClient,
  DEFAULT_API_BASE,
  normaliseImdb,
  SubtitleDbClient,
} from '../src/client.js';
import { SubtitleDbAbort, SubtitleDbError } from '../src/errors.js';
import { corpusLanguage } from '../src/languages.js';
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

  it('waits out a 503 Retry-After and retries', async () => {
    let n = 0;
    const impl = (async () => {
      n++;
      if (n === 1) return new Response('{}', { status: 503, headers: { 'retry-after': '0' } });
      return new Response(JSON.stringify(movieBundle([])), { status: 200 });
    }) as unknown as typeof fetch;

    const c = new SubtitleDbClient({ fetch: impl, retries: 1 });
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

  it('names a timeout as one', async () => {
    const impl = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as unknown as typeof fetch;
    const c = new SubtitleDbClient({ fetch: impl, retries: 0, timeoutMs: 5 });

    const err = await c.byImdb(1).catch((e) => e);
    expect(err.status).toBe(0);
    expect(err.code).toBe('timeout');
    expect(err.message).toBe('no answer within 5 ms');
    expect(err.retryable).toBe(true);
  });

  it('refuses a bad imdb id before sending, and does not call it retryable', async () => {
    const { fetch, calls } = stubFetch([]);
    const c = new SubtitleDbClient({ fetch });

    const err = await c.byImdb('hello').catch((e) => e);
    expect(err).toBeInstanceOf(SubtitleDbError);
    expect(err.code).toBe('bad_request');
    expect(err.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('follows download_url exactly as returned and never builds a files-host URL', async () => {
    const { fetch, calls } = stubFetch([{ match: /files\.example\.test/, text: '1\nhello\n' }]);
    const c = new SubtitleDbClient({ fetch, apiBase: 'https://api.example.test' });
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
    const c = new SubtitleDbClient({
      fetch,
      antispamId: 'aid-123',
      apiBase: 'https://api.example.test',
    });
    const sub = { download_url: 'https://files.example.test/dl/99.srt', format: 'srt' };
    await c.fetchSubtitleText(sub);

    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/dl/99.srt');
    expect(url.searchParams.get('antispam_id')).toBe('aid-123');
    // The address handed to a caller who downloads it themselves is the same one.
    expect(c.downloadUrl(sub)).toBe(calls[0]?.url);
  });

  it('names the download with downloadClient, else with client', async () => {
    const { fetch, calls } = stubFetch([{ match: /files\.example\.test/, text: '1\nhi\n' }]);
    const sub = { download_url: 'https://files.example.test/get/99?ext=srt', format: 'srt' };
    await new SubtitleDbClient({
      fetch,
      apiBase: 'https://api.example.test',
      client: 'mine',
      downloadClient: 'loader',
    }).fetchSubtitleText(sub);
    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('client')).toBe('loader');
    expect(url.searchParams.get('ext')).toBe('srt');
    expect(
      new URL(new SubtitleDbClient({ client: 'web' }).downloadUrl(sub)).searchParams.get('client'),
    ).toBe('web');
  });

  /** A fetch whose response says it ended at `url`, as a browser's does after a redirect. */
  function landing(url: string, body: string): typeof fetch {
    return (async () => {
      const res = new Response(body, { status: 200 });
      Object.defineProperty(res, 'url', { value: url });
      return res;
    }) as unknown as typeof fetch;
  }

  it('reads a download that ended on the files host the API redirects to', async () => {
    const c = new SubtitleDbClient({
      fetch: landing('https://files.thesubtitledb.org/a/5.srt', '1\nhi\n'),
    });
    const got = await c.fetchSubtitleText({
      download_url: 'https://api.thesubtitledb.org/get/5',
      format: 'srt',
    });
    expect(got.text).toBe('1\nhi\n');
  });

  it('refuses a download that ended anywhere else', async () => {
    for (const host of [
      'https://evil.example/5.srt',
      'https://thesubtitledb.org.evil.example/5.srt',
    ]) {
      const c = new SubtitleDbClient({ fetch: landing(host, '1\nhi\n') });
      const err = await c
        .fetchSubtitleText({ download_url: 'https://api.thesubtitledb.org/get/5', format: 'srt' })
        .catch((e) => e);
      expect(err, host).toBeInstanceOf(SubtitleDbError);
      expect(err.code).toBe('download_failed');
    }
  });

  it('refuses a download_url off the API hosts before fetching it', async () => {
    const cases: [string, RegExp][] = [
      ['https://evil.example/get/5', /on evil.example/],
      ['https://thesubtitledb.org.evil.example/get/5', /thesubtitledb.org.evil.example/],
      ['', /empty/],
      ['not a url', /not a URL/],
    ];
    for (const [download_url, message] of cases) {
      const { fetch, calls } = stubFetch([{ match: /./, text: '1\\nhi\\n' }]);
      const err = await new SubtitleDbClient({ fetch, key: 'k' })
        .fetchSubtitleText({ download_url, format: 'srt' })
        .catch((e) => e);
      expect(err, download_url).toBeInstanceOf(SubtitleDbError);
      expect(err.code, download_url).toBe('bad_request');
      expect(err.message, download_url).toMatch(message);
      expect(err.message.trimEnd(), download_url).toBe(err.message);
      expect(calls, download_url).toHaveLength(0);
    }
  });

  it('accepts a download_url on the configured apiBase host and its files host', async () => {
    const { fetch, calls } = stubFetch([{ match: /./, text: '1\\nhi\\n' }]);
    const c = new SubtitleDbClient({ fetch, apiBase: 'https://api.example.test/api' });
    await c.fetchSubtitleText({ download_url: 'https://api.example.test/get/5', format: 'srt' });
    await c.fetchSubtitleText({ download_url: 'https://files.example.test/x', format: 'srt' });
    // The public hosts stay allowed behind a custom apiBase, such as a local proxy.
    await c.fetchSubtitleText({
      download_url: 'https://files.thesubtitledb.org/get/5',
      format: 'srt',
    });
    expect(calls).toHaveLength(3);
  });

  it('surfaces the API code and message when a download is refused', async () => {
    const cases: [number, string, string][] = [
      [400, 'bad_request', 'subtitle id must be a positive integer'],
      [401, 'bad_key', 'key not recognised'],
      [403, 'key_required', 'this download needs a key'],
      [429, 'rate_limited', 'slow down'],
    ];
    for (const [status, error, message] of cases) {
      const { fetch } = stubFetch([{ match: /get/, status, body: { error, message } }]);
      const err = await new SubtitleDbClient({ fetch })
        .fetchSubtitleText({ download_url: 'https://api.thesubtitledb.org/get/5', format: 'srt' })
        .catch((e) => e);
      expect(err, error).toBeInstanceOf(SubtitleDbError);
      expect(err).toMatchObject({ status, code: error, message });
    }
  });

  it('reports download_failed for a refusal with no readable body, and for a 404', async () => {
    for (const route of [
      { match: /get/, status: 401, text: 'nope' },
      { match: /get/, status: 404, body: { error: 'not_found', message: 'gone' } },
    ]) {
      const { fetch } = stubFetch([route]);
      const err = await new SubtitleDbClient({ fetch })
        .fetchSubtitleText({ download_url: 'https://api.thesubtitledb.org/get/5', format: 'srt' })
        .catch((e) => e);
      expect(err).toMatchObject({ status: route.status, code: 'download_failed' });
    }
  });

  it('refuses a web page or an empty body sent as the subtitle', async () => {
    // A captive portal answers 200. Handed to a player, the page shows as an empty track.
    for (const body of [
      '<!DOCTYPE html><html><body>Sign in</body></html>',
      '\n <HTML>',
      '',
      ' \n',
    ]) {
      const { fetch } = stubFetch([{ match: /get/, text: body }]);
      const err = await new SubtitleDbClient({ fetch })
        .fetchSubtitleText({ download_url: 'https://api.thesubtitledb.org/get/5', format: 'srt' })
        .catch((e) => e);
      expect(err, JSON.stringify(body)).toBeInstanceOf(SubtitleDbError);
      expect(err.code).toBe('download_failed');
    }
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
    // produce mojibake; the encoding option is for a deployment that sends such bytes.
    const bytes = new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0x69, 0x00]);
    const impl = (async () => new Response(bytes, { status: 200 })) as unknown as typeof fetch;
    const c = new SubtitleDbClient({ fetch: impl, apiBase: 'https://api.example.test' });
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

describe('a key never goes over plain http', () => {
  it('refuses an http download_url when a key is set, before fetching it', async () => {
    const { fetch, calls } = stubFetch([{ match: /./, text: '1\nhi\n' }]);
    const err = await createClient({ key: 'k', fetch })
      .fetchSubtitleText({ download_url: 'http://api.thesubtitledb.org/get/1', format: 'srt' })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SubtitleDbError);
    expect(err).toMatchObject({ code: 'bad_request', status: 0 });
    expect(calls).toHaveLength(0);
  });

  it('refuses an http apiBase when a key is set, localhost included', () => {
    for (const apiBase of ['http://api.thesubtitledb.org', 'http://localhost:8787']) {
      let err: unknown;
      try {
        createClient({ key: 'k', apiBase });
      } catch (e) {
        err = e;
      }
      expect(err, apiBase).toBeInstanceOf(SubtitleDbError);
      expect(err, apiBase).toMatchObject({ code: 'bad_request' });
    }
  });

  it('still allows a keyless http apiBase, such as a local test server', async () => {
    const { fetch, calls } = stubFetch([
      { match: /by-imdb/, body: movieBundle([]) },
      { match: /get/, text: '1\n00:00:01,000 --> 00:00:02,000\nhi\n' },
    ]);
    const c = createClient({ apiBase: 'http://localhost:8787', fetch });
    await c.byImdb('tt0133093');
    await c.fetchSubtitleText({ download_url: 'http://localhost:8787/get/1', format: 'srt' });
    expect(calls).toHaveLength(2);
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

    // Any season or episode means a show, so the drill takes the tv path.
    expect(calls.map((x) => new URL(x.url).pathname)).toEqual([
      '/v1/by-tmdb/tv/1396/season/2',
      '/v1/by-tmdb/tv/1396/season/1/episode/3',
      '/v1/by-tmdb/tv/1396',
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

    await c.byImdb('tt0133093', { lang: 'en', format: 'srt', sort: 'newest' });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.searchParams.get('lang')).toBe('en');
    expect(url.searchParams.get('format')).toBe('srt');
    expect(url.searchParams.get('sort')).toBe('newest');
  });

  it('takes the typed TMDB path, tv for a season, and the untyped one with no type', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-tmdb/, body: movieBundle([]) }]);
    const c = new SubtitleDbClient({ fetch });
    await c.byTmdb(1396, { type: 'tv' });
    await c.byTmdb(603, { type: 'movie' });
    await c.byTmdb(1396, { season: 2, episode: 3 });
    await c.byTmdb(1396, { type: 'tv', season: 2 });
    await c.byTmdb(603, { type: 'movie', season: 1 });
    await c.byTmdb(603);

    expect(calls.map((x) => new URL(x.url).pathname)).toEqual([
      '/v1/by-tmdb/tv/1396',
      '/v1/by-tmdb/movie/603',
      '/v1/by-tmdb/tv/1396/season/2/episode/3',
      '/v1/by-tmdb/tv/1396/season/2',
      '/v1/by-tmdb/movie/603',
      '/v1/by-tmdb/603',
    ]);
    expect(calls.some((x) => new URL(x.url).searchParams.has('type'))).toBe(false);
  });

  it('falls back to the untyped path with ?type= while the API has no typed route', async () => {
    const noRoute = { error: 'not_found', message: 'no route for GET /v1/by-tmdb/tv/1396' };
    const { fetch, calls } = stubFetch([
      { match: /by-tmdb\/(tv|movie)\//, status: 404, body: noRoute },
      { match: /by-tmdb\/\d+/, body: movieBundle([]) },
    ]);
    const c = new SubtitleDbClient({ fetch });
    await c.byTmdb(1396, { season: 2, episode: 3 });
    await c.byTmdb(603, { type: 'movie' });

    expect(calls.map((x) => new URL(x.url).pathname + new URL(x.url).search)).toEqual([
      '/v1/by-tmdb/tv/1396/season/2/episode/3',
      '/v1/by-tmdb/1396/season/2/episode/3?type=tv',
      '/v1/by-tmdb/movie/603',
      '/v1/by-tmdb/603?type=movie',
    ]);
  });

  it('does not fall back when the typed path finds no title', async () => {
    const { fetch, calls } = stubFetch([
      {
        match: /by-tmdb/,
        status: 404,
        body: { error: 'not_found', message: 'no title mapped to tmdb id 9' },
      },
    ]);
    const err = await new SubtitleDbClient({ fetch }).byTmdb(9, { type: 'tv' }).catch((e) => e);
    expect(err).toMatchObject({ status: 404, code: 'not_found' });
    expect(calls).toHaveLength(1);
  });

  it('maps language tags to corpus codes on every lookup, deduplicated, as one comma list', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-/, body: movieBundle([]) }]);
    const c = new SubtitleDbClient({ fetch });
    const lang = (i: number) => new URL(calls[i]?.url ?? '').searchParams.get('lang');

    await c.byImdb('tt0944947', { lang: 'en-US' });
    expect(lang(0)).toBe('en');
    await c.byTmdb(1399, { languages: ['pt-BR', 'zh-Hant', 'en-US', 'en', 'zh-TW'] });
    expect(lang(1)).toBe('pb,zt,en');
    await c.byImdb('tt0944947', { season: 1, episode: 1, lang: 'fr, de', languages: ['FR'] });
    expect(lang(2)).toBe('fr,de');
    await c.byTitle('matrix', { languages: [] });
    expect(lang(3)).toBeNull();
  });

  it('maps Spanish regions the way the API does', () => {
    // Checked live with ?lang= on 2026-10-18: these answer the ea files, the rest es.
    for (const tag of [
      'es-419',
      'es-MX',
      'es-AR',
      'es-CO',
      'es-US',
      'es-PR',
      'es_MX',
      'es-Latn-MX',
    ])
      expect(corpusLanguage(tag), tag).toBe('ea');
    for (const tag of ['es', 'es-ES', 'es-GQ', 'es-013', 'es-Latn', 'ES-es'])
      expect(corpusLanguage(tag), tag).toBe('es');
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

describe('SubtitleDbClient with a key', () => {
  const header = (init?: RequestInit): string | undefined =>
    (init?.headers as Record<string, string> | undefined)?.authorization;

  it('sends no key header without a key, so a keyless call needs no preflight', async () => {
    const { fetch, calls } = stubFetch([
      { match: /\/v1\//, body: movieBundle([]) },
      { match: /files\.example\.test/, text: '1\nhi\n' },
    ]);
    const c = new SubtitleDbClient({ fetch, apiBase: 'https://api.example.test' });
    await c.byImdb('tt0133093');
    await c.fetchSubtitleText({ download_url: 'https://files.example.test/get/9', format: 'srt' });

    for (const call of calls) expect(header(call.init), call.url).toBeUndefined();
  });

  it('sends the key as a Bearer header on lookups and downloads, never in the URL', async () => {
    const { fetch, calls } = stubFetch([
      { match: /\/v1\//, body: movieBundle([]) },
      { match: /files\.example\.test/, text: '1\nhi\n' },
    ]);
    const c = new SubtitleDbClient({
      fetch,
      key: ' sdb_test ',
      apiBase: 'https://api.example.test',
    });
    await c.byTmdb(603);
    await c.fetchSubtitleText({ download_url: 'https://files.example.test/get/9', format: 'srt' });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(header(call.init), call.url).toBe('Bearer sdb_test');
      expect(call.url).not.toContain('sdb_test');
    }
  });

  it('refuses search without a key before any request, with no status since nothing was sent', async () => {
    const { fetch, calls } = stubFetch([]);
    const c = new SubtitleDbClient({ fetch });
    await expect(c.search('matrix')).rejects.toMatchObject({ code: 'key_required', status: 0 });
    expect(calls).toHaveLength(0);
  });

  it('maps the search language tag to the corpus code', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-search/, body: { results: [] } }]);
    const c = new SubtitleDbClient({ fetch, key: 'k' });
    await c.search('matrix', { lang: 'pt-BR', languages: ['en-US'] });
    expect(new URL(calls[0]?.url ?? '').searchParams.get('lang')).toBe('pb,en');
  });

  it('searches by-search with the query and filters', async () => {
    const body = { query: {}, total: 0, subtitle_total: 0, limit: 5, offset: 0, results: [] };
    const { fetch, calls } = stubFetch([{ match: /\/v1\/by-search/, body }]);
    const c = new SubtitleDbClient({ fetch, key: 'sdb_test' });
    const got = await c.search('the matrix', { lang: 'en', year: 1999, limit: 5 });

    expect(got).toEqual(body);
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/v1/by-search');
    expect(url.searchParams.get('q')).toBe('the matrix');
    expect(url.searchParams.get('lang')).toBe('en');
    expect(url.searchParams.get('year')).toBe('1999');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(header(calls[0]?.init)).toBe('Bearer sdb_test');
  });
});

describe('every lookup verb, id by id', () => {
  const path = (url: string | undefined) => new URL(url ?? '').pathname;

  it('pads every imdb spelling to the same path', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-imdb/, body: movieBundle([]) }]);
    const c = new SubtitleDbClient({ fetch });
    for (const id of [133093, '133093', 'tt0133093', ' TT133093 ']) await c.byImdb(id);
    expect(calls.map((x) => path(x.url))).toEqual(Array(4).fill('/v1/by-imdb/tt0133093'));
  });

  it('takes a tmdb or subtitle id as a string or a number', async () => {
    // Players and data attributes hand over strings; the path must not change.
    const { fetch, calls } = stubFetch([{ match: /by-/, body: movieBundle([]) }]);
    const c = new SubtitleDbClient({ fetch });
    await c.byTmdb('603', { type: 'movie' });
    await c.byTmdb('1396', { type: 'tv', season: 1, episode: 2 });
    await c.bySubid('481207');
    expect(calls.map((x) => path(x.url))).toEqual([
      '/v1/by-tmdb/movie/603',
      '/v1/by-tmdb/tv/1396/season/1/episode/2',
      '/v1/by-subid/481207',
    ]);
  });

  it('trims a pasted infohash as well as lowercasing it', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-infohash/, body: movieBundle([]) }]);
    await new SubtitleDbClient({ fetch }).byInfohash('  ABCDEF0123456789\n');
    expect(path(calls[0]?.url)).toBe('/v1/by-infohash/abcdef0123456789');
  });

  it('keeps the bucket query on a drilled episode', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-imdb/, body: movieBundle([]) }]);
    await new SubtitleDbClient({ fetch }).byImdb('tt0903747', {
      season: 1,
      episode: 1,
      lang: 'en',
      format: 'srt',
      limit: 1,
      response_class: 'standard',
    });
    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/v1/by-imdb/tt0903747/season/1/episode/1');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      lang: 'en',
      format: 'srt',
      limit: '1',
      response_class: 'standard',
    });
  });

  it('asks health at /healthz, outside /v1', async () => {
    const body = { ok: true, store: 'up' };
    const { fetch, calls } = stubFetch([{ match: /healthz/, body }]);
    expect(await new SubtitleDbClient({ fetch }).health()).toEqual(body);
    expect(calls[0]?.url).toBe('https://api.thesubtitledb.org/healthz');
  });

  it('sends search filters as query parameters, and never the signal or the list', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-search/, body: { results: [] } }]);
    const c = new SubtitleDbClient({ fetch, key: 'k' });
    await c.search('matrix', {
      type: 'movie',
      year_from: 1990,
      year_to: 2000,
      sort: 'year',
      dir: 'asc',
      offset: 20,
      languages: ['en'],
      signal: new AbortController().signal,
    });
    const url = new URL(calls[0]?.url ?? '');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      q: 'matrix',
      type: 'movie',
      year_from: '1990',
      year_to: '2000',
      sort: 'year',
      dir: 'asc',
      offset: '20',
      lang: 'en',
    });
  });
});

describe('construction', () => {
  it('defaults to the public API host', () => {
    const c = createClient({ fetch: stubFetch([]).fetch });
    expect(c).toBeInstanceOf(SubtitleDbClient);
    expect(c.apiBase).toBe(DEFAULT_API_BASE);
  });

  it('refuses to build without any fetch, rather than failing on the first lookup', () => {
    vi.stubGlobal('fetch', undefined);
    try {
      expect(() => createClient()).toThrow(SubtitleDbError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('treats a blank key as no key', async () => {
    // `key: process.env.KEY ?? ''` must not send "Bearer " or unlock search.
    const { fetch, calls } = stubFetch([{ match: /by-imdb/, body: movieBundle([]) }]);
    const c = createClient({ fetch, key: '   ', apiBase: 'http://localhost:8787' });
    await c.byImdb('tt0133093');
    expect(new Headers(calls[0]?.init?.headers).has('authorization')).toBe(false);
    await expect(c.search('x')).rejects.toMatchObject({ code: 'key_required' });
  });

  it('returns null for a missing poster path of any kind', () => {
    const c = createClient({ fetch: stubFetch([]).fetch });
    expect(c.posterUrl(undefined)).toBeNull();
    expect(c.posterUrl('')).toBeNull();
  });
});

describe('lookup errors and retries', () => {
  it('maps each refusal the docs list onto status, code and message', async () => {
    const cases: [number, string, string][] = [
      [400, 'bad_request', 'lang takes ISO 639 codes'],
      [401, 'bad_key', 'key not recognised'],
      [404, 'not_found', 'no title for imdb id 98765432'],
      [503, 'unavailable', 'try again shortly'],
    ];
    for (const [status, error, message] of cases) {
      const { fetch } = stubFetch([{ match: /by-imdb/, status, body: { error, message } }]);
      const err = await new SubtitleDbClient({ fetch, retries: 0 })
        .byImdb('tt0133093')
        .catch((e) => e);
      expect(err, error).toBeInstanceOf(SubtitleDbError);
      expect(err, error).toMatchObject({ status, code: error, message });
      expect(err.retryable, error).toBe(status === 503);
    }
  });

  it('names an error with no readable body by its status', async () => {
    // A proxy in front of the API answers with HTML, not the API's JSON.
    const { fetch } = stubFetch([{ match: /by-imdb/, status: 502, text: '<html>bad gateway' }]);
    const err = await new SubtitleDbClient({ fetch, retries: 0 }).byImdb(1).catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: 'http_error' });
    expect(err.message).toBe('request failed with 502');
  });

  it('does not retry a refusal: asking again sends the same request', async () => {
    for (const status of [400, 401]) {
      const { fetch, calls } = stubFetch([{ match: /by-imdb/, status, body: {} }]);
      await new SubtitleDbClient({ fetch, retries: 3 }).byImdb(1).catch(() => {});
      expect(calls, String(status)).toHaveLength(1);
    }
  });

  it('retries a 429 and a 5xx, and gives up after the configured retries', async () => {
    for (const status of [429, 500, 503]) {
      const { fetch, calls } = stubFetch([
        { match: /by-imdb/, status, body: {}, headers: { 'retry-after': '0' } },
      ]);
      const err = await new SubtitleDbClient({ fetch, retries: 2 }).byImdb(1).catch((e) => e);
      expect(err, String(status)).toMatchObject({ status });
      // The first attempt plus two retries.
      expect(calls, String(status)).toHaveLength(3);
    }
  });

  it('retries a transport failure the configured number of times', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-imdb/, throws: true }]);
    const err = await new SubtitleDbClient({ fetch, retries: 1 }).byImdb(1).catch((e) => e);
    expect(err).toMatchObject({ code: 'transport_error' });
    expect(calls).toHaveLength(2);
  });
});

describe('aborting', () => {
  it('throws SubtitleDbAbort for a signal already aborted, and sends nothing', async () => {
    const { fetch, calls } = stubFetch([{ match: /by-imdb/, body: movieBundle([]) }]);
    const ac = new AbortController();
    ac.abort();
    const err = await new SubtitleDbClient({ fetch })
      .byImdb(1, { signal: ac.signal })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SubtitleDbAbort);
    // Kept apart so an adapter can ignore an abort without swallowing real failures.
    expect(err).not.toBeInstanceOf(SubtitleDbError);
    expect(calls).toHaveLength(0);
  });

  it('throws SubtitleDbAbort, not transport_error, when aborted mid-request', async () => {
    const ac = new AbortController();
    const impl = ((_url: string, init?: RequestInit) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        ac.abort();
      })) as unknown as typeof fetch;
    const err = await new SubtitleDbClient({ fetch: impl })
      .byTitle('matrix', { signal: ac.signal })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SubtitleDbAbort);
  });

  it('stops waiting out a Retry-After when aborted', async () => {
    // Without this a player torn down during a 503 holds its retry for up to 8 s.
    const ac = new AbortController();
    let n = 0;
    const impl = (async () => {
      n++;
      setTimeout(() => ac.abort(), 0);
      return new Response('{}', { status: 503, headers: { 'retry-after': '8' } });
    }) as unknown as typeof fetch;
    const started = Date.now();
    const err = await new SubtitleDbClient({ fetch: impl, retries: 2 })
      .byImdb(1, { signal: ac.signal })
      .catch((e) => e);
    expect(err).toBeInstanceOf(SubtitleDbAbort);
    expect(n).toBe(1);
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('throws SubtitleDbAbort from an aborted download', async () => {
    const ac = new AbortController();
    ac.abort();
    const impl = (async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response('1\nhi\n');
    }) as unknown as typeof fetch;
    const err = await new SubtitleDbClient({ fetch: impl })
      .fetchSubtitleText(
        { download_url: 'https://api.thesubtitledb.org/get/5', format: 'srt' },
        { signal: ac.signal },
      )
      .catch((e) => e);
    expect(err).toBeInstanceOf(SubtitleDbAbort);
  });
});

describe('download failures', () => {
  const sub = { download_url: 'https://api.thesubtitledb.org/get/5', format: 'srt' };

  it('reports a failed download as transport_error and does not retry it', async () => {
    const { fetch, calls } = stubFetch([{ match: /get/, throws: true }]);
    const err = await new SubtitleDbClient({ fetch, retries: 3 })
      .fetchSubtitleText(sub)
      .catch((e) => e);
    expect(err).toMatchObject({ status: 0, code: 'transport_error' });
    expect(calls).toHaveLength(1);
  });

  it('reports a 5xx download as download_failed with its status', async () => {
    const { fetch } = stubFetch([
      { match: /get/, status: 500, body: { error: 'internal', message: 'x' } },
    ]);
    const err = await new SubtitleDbClient({ fetch }).fetchSubtitleText(sub).catch((e) => e);
    // Only a 400, 401, 403 or 429 body is the API's own refusal; a 500 body is not read.
    expect(err).toMatchObject({ status: 500, code: 'download_failed' });
    expect(err.message).toBe('subtitle download failed with 500');
  });

  it('replaces a client name already on download_url instead of adding a second', () => {
    const c = new SubtitleDbClient({ client: 'mine' });
    const url = new URL(c.downloadUrl({ download_url: `${sub.download_url}?client=old&x=1` }));
    expect(url.searchParams.getAll('client')).toEqual(['mine']);
    expect(url.searchParams.get('x')).toBe('1');
  });
});
