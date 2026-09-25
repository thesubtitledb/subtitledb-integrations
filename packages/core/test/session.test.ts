import { describe, expect, it, vi } from 'vitest';
import { SubtitleDbClient } from '../src/client.js';
import { createSession } from '../src/session.js';
import { SYNTHETIC_ID } from '../src/transcribe.js';
import { bundleSubtitle, movieBundle, stubFetch } from './fixtures.js';

function session(routes: Parameters<typeof stubFetch>[0], opts: Record<string, unknown> = {}) {
  const { fetch, calls } = stubFetch(routes);
  const client = new SubtitleDbClient({ fetch, retries: 0 });
  return {
    calls,
    s: createSession({ client, formats: ['srt'], ...opts }),
  };
}

const BY_IMDB = { match: /by-imdb/, body: movieBundle([bundleSubtitle()]) };
const DOWNLOAD = { match: /\/get\/114415$/, text: '1\n00:00:01,000 --> 00:00:02,000\nhi\n' };

describe('eager resolve, lazy load', () => {
  it('resolving spends exactly one request and fetches no subtitle bytes', async () => {
    // This is the traffic contract for eager loading: attaching a configured player
    // must cost one cacheable JSON request, not a subtitle download per language.
    const { s, calls } = session([BY_IMDB, DOWNLOAD]);
    const r = await s.resolve({ imdbId: 'tt0133093' });

    expect(r.candidates).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => !c.url.includes('/get/'))).toBe(true);
  });

  it('load() is what transfers bytes, and only for the chosen track', async () => {
    const { s, calls } = session([BY_IMDB, DOWNLOAD]);
    const r = await s.resolve({ imdbId: 'tt0133093' });
    const pick = r.candidates[0];
    if (!pick) throw new Error('expected a candidate');

    const loaded = await s.load(pick);
    expect(loaded?.text).toContain('00:00:01,000');
    expect(loaded?.format).toBe('srt');
    expect(calls).toHaveLength(2);
  });

  it('autoSelect fetches one track during resolve', async () => {
    const { s, calls } = session([BY_IMDB, DOWNLOAD], { autoSelect: true });
    const r = await s.resolve({ imdbId: 'tt0133093' });

    expect(r.selected?.text).toContain('hi');
    expect(calls).toHaveLength(2);
  });

  it('autoSelect can pin a language and picks nothing when it is absent', async () => {
    const subs = [
      bundleSubtitle({ id: 1, language: 'de' }),
      bundleSubtitle({ id: 2, language: 'en' }),
    ];
    const { s } = session(
      [
        { match: /by-imdb/, body: movieBundle(subs) },
        { match: /\/get\/2$/, text: 'english' },
      ],
      { autoSelect: 'en' },
    );
    const r = await s.resolve({ imdbId: 'tt0133093' });
    expect(r.selected?.candidate.subtitle.id).toBe(2);

    const { s: s2, calls } = session([{ match: /by-imdb/, body: movieBundle(subs) }], {
      autoSelect: 'ja',
    });
    const r2 = await s2.resolve({ imdbId: 'tt0133093' });
    expect(r2.selected).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});

describe('caching and repeated attaches', () => {
  it('resolving the same media twice issues one request', async () => {
    const { s, calls } = session([BY_IMDB]);
    await s.resolve({ imdbId: 'tt0133093' });
    await s.resolve({ imdbId: 'tt0133093' });
    expect(calls).toHaveLength(1);
  });

  it('loading the same subtitle twice downloads once', async () => {
    const { s, calls } = session([BY_IMDB, DOWNLOAD]);
    const r = await s.resolve({ imdbId: 'tt0133093' });
    const pick = r.candidates[0];
    if (!pick) throw new Error('expected a candidate');

    await s.load(pick);
    await s.load(pick);
    expect(calls.filter((c) => c.url.includes('/get/'))).toHaveLength(1);
  });

  it('a duplicate resolve for the same media does not abort the first', async () => {
    // Regression. Players emit ready/restart/loadedmetadata in combinations that vary
    // by version, and an adapter may also have a fallback timer. resolve() used to
    // abort unconditionally, so a second trigger for the SAME media killed the
    // in-flight request and reported "not found" for a title that was about to
    // resolve. Caught by the browser end-to-end run against a slow response.
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const impl = (async (input: RequestInfo | URL) => {
      await gate;
      if (String(input).includes('by-imdb')) {
        return new Response(JSON.stringify(movieBundle([bundleSubtitle()])), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as unknown as typeof fetch;

    const s = createSession({
      client: new SubtitleDbClient({ fetch: impl, retries: 0 }),
      formats: ['srt'],
    });

    const first = s.resolve({ imdbId: 'tt0133093' });
    const second = s.resolve({ imdbId: 'tt0133093' });
    release?.();

    const [a, b] = await Promise.all([first, second]);
    expect(a.tier).toBe('explicit-imdb');
    expect(b.tier).toBe('explicit-imdb');
    expect(a.candidates).toHaveLength(1);
    expect(b.candidates).toHaveLength(1);
  });

  it('still cancels the previous resolve when the media really changes', async () => {
    const seen: string[] = [];
    const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url.includes('tt0133093')) {
        // Never settles until aborted, standing in for a slow first title.
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return new Response(JSON.stringify(movieBundle([bundleSubtitle()])), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const s = createSession({
      client: new SubtitleDbClient({ fetch: impl, retries: 0 }),
      formats: ['srt'],
    });

    const stale = s.resolve({ imdbId: 'tt0133093' });
    const fresh = await s.resolve({ imdbId: 'tt1480055' });

    expect(fresh.tier).toBe('explicit-imdb');
    // The superseded resolve degrades to an empty result rather than hanging.
    expect((await stale).candidates).toHaveLength(0);
  });

  it('a different source resolves again', async () => {
    const { s, calls } = session([
      { match: /by-imdb\/tt0133093/, body: movieBundle([bundleSubtitle()]) },
      {
        match: /by-imdb\/tt1480055/,
        body: movieBundle([bundleSubtitle({ id: 7162825 })]),
      },
    ]);
    await s.resolve({ imdbId: 'tt0133093' });
    await s.resolve({ imdbId: 'tt1480055' });
    expect(calls).toHaveLength(2);
  });
});

describe('failure handling', () => {
  it('never throws out of resolve, and reports through onError', async () => {
    const onError = vi.fn();
    const { s } = session([{ match: /by-imdb/, throws: true }], { onError });

    const r = await s.resolve({ imdbId: 'tt0133093' });
    expect(r.candidates).toHaveLength(0);
    expect(r.tier).toBe('manual');
    expect(onError).toHaveBeenCalledOnce();
  });

  it('returns null from load on a failed download rather than breaking the player', async () => {
    const onError = vi.fn();
    const { s } = session([BY_IMDB, { match: /\/get\//, status: 500, body: {} }], { onError });
    const r = await s.resolve({ imdbId: 'tt0133093' });
    const pick = r.candidates[0];
    if (!pick) throw new Error('expected a candidate');

    expect(await s.load(pick)).toBeNull();
    expect(onError).toHaveBeenCalled();
  });

  it('spends nothing on an unusable hint', async () => {
    const { s, calls } = session([BY_IMDB]);
    const r = await s.resolve({});
    expect(r.tier).toBe('manual');
    expect(calls).toHaveLength(0);
  });
});

describe('request budget', () => {
  it('stops making requests once the ceiling is reached', async () => {
    // The budget exists because eager loading multiplies traffic across every player
    // on every page, against an API that has no rate limiting of its own yet.
    const onError = vi.fn();
    const { s, calls } = session([{ match: /by-imdb/, body: movieBundle([bundleSubtitle()]) }], {
      maxRequests: 2,
      onError,
    });

    await s.resolve({ imdbId: 'tt0133093' });
    const before = calls.length;
    await s.resolve({ imdbId: 'tt0111161' });

    expect(calls.length).toBe(before);
    expect(onError).toHaveBeenCalled();
    expect(s.requestCount).toBeLessThanOrEqual(2);
  });

  it('charges a duplicate resolve nothing while the first is still in flight', async () => {
    // Players fire ready, loadstart and loadedmetadata within a few milliseconds of
    // each other, and an adapter resolves on all of them. Single-flight collapses
    // those into one call, so charging each one exhausted the budget before the
    // viewer could pick a subtitle, on a page that had made exactly one search.
    const onError = vi.fn();
    const { s, calls } = session([BY_IMDB, DOWNLOAD], { languages: ['en'], onError });

    const [a, b, c] = await Promise.all([
      s.resolve({ imdbId: 'tt0133093' }),
      s.resolve({ imdbId: 'tt0133093' }),
      s.resolve({ imdbId: 'tt0133093' }),
    ]);

    expect(calls).toHaveLength(1);
    expect(s.requestCount).toBe(2);
    expect(onError).not.toHaveBeenCalled();
    for (const r of [a, b, c]) expect(r.candidates).toHaveLength(1);

    // And the budget it did not spend is still there for the download.
    const pick = a.candidates[0];
    if (!pick) throw new Error('expected a candidate');
    expect(await s.load(pick)).not.toBeNull();
  });

  it('charges every page a limit past 100 can take', async () => {
    // 250 a language is up to three pages, and the ceiling has to hold for all three.
    const tight = session([BY_IMDB], { languages: ['en'], limit: 250, maxRequests: 3 });
    expect((await tight.s.resolve({ imdbId: 'tt0133093' })).candidates).toHaveLength(0);
    expect(tight.calls).toHaveLength(0);

    const room = session([BY_IMDB], { languages: ['en'], limit: 250, maxRequests: 4 });
    expect((await room.s.resolve({ imdbId: 'tt0133093' })).candidates).toHaveLength(1);
    expect(room.s.requestCount).toBe(4);
  });
});

describe('lifecycle', () => {
  it('dispose cancels work and refuses further resolves', async () => {
    const { s } = session([BY_IMDB]);
    await s.resolve({ imdbId: 'tt0133093' });
    s.dispose();
    await expect(s.resolve({ imdbId: 'tt0133093' })).rejects.toThrow(/disposed/);
  });

  it('load after dispose returns null instead of throwing', async () => {
    const { s } = session([BY_IMDB, DOWNLOAD]);
    const r = await s.resolve({ imdbId: 'tt0133093' });
    const pick = r.candidates[0];
    if (!pick) throw new Error('expected a candidate');
    s.dispose();
    expect(await s.load(pick)).toBeNull();
  });
});

describe('client side conversion', () => {
  const SRT_TEXT = '1\n00:00:01,000 --> 00:00:02,000\nhi\n';

  it('converts on load, not on resolve', async () => {
    const { s, calls } = session([BY_IMDB, { match: /\/get\/114415$/, text: SRT_TEXT }], {
      formats: ['vtt'],
      convertTo: 'vtt',
    });

    const r = await s.resolve({ imdbId: 'tt0133093' });
    // The srt candidate survives the format filter because the converter can reach it,
    // and resolving still costs exactly one request with no bytes transferred.
    expect(r.candidates).toHaveLength(1);
    expect(calls).toHaveLength(1);

    const pick = r.candidates[0];
    if (!pick) throw new Error('expected a candidate');
    const loaded = await s.load(pick);
    expect(loaded?.format).toBe('vtt');
    expect(loaded?.convertedFrom).toBe('srt');
    expect(loaded?.text.startsWith('WEBVTT')).toBe(true);
  });

  it('hands over a format the player declared, rather than converting it', async () => {
    // The whole point of `convert`: it converts what this player cannot render, not
    // everything that is not already WebVTT. ArtPlayer parses srt and ass itself, and
    // converting them anyway rewrote its subtitles through a second parser and threw
    // the ass styling away. That is why that adapter shipped `convert` inverted, and
    // why fixing it here is what lets every adapter default it the same way.
    const { s } = session([BY_IMDB, { match: /\/get\/114415$/, text: SRT_TEXT }], {
      formats: ['srt', 'vtt'],
      convertTo: 'vtt',
    });

    const r = await s.resolve({ imdbId: 'tt0133093' });
    const pick = r.candidates[0];
    if (!pick) throw new Error('expected a candidate');

    const loaded = await s.load(pick);
    expect(loaded?.format).toBe('srt');
    expect(loaded?.convertedFrom).toBeUndefined();
    expect(loaded?.text).toBe(SRT_TEXT);
  });

  it('matches the declared format regardless of case on either side', async () => {
    // `formats` is hand written per adapter and the corpus stores whatever it stored,
    // so SRT and srt arrive here from opposite directions and have to agree.
    const { s } = session([BY_IMDB, { match: /\/get\/114415$/, text: SRT_TEXT }], {
      formats: ['SRT'],
      convertTo: 'vtt',
    });

    const r = await s.resolve({ imdbId: 'tt0133093' });
    const pick = r.candidates[0];
    if (!pick) throw new Error('expected a candidate');

    expect((await s.load(pick))?.format).toBe('srt');
  });

  it('leaves the format filter alone when conversion is off', async () => {
    // Without convertTo a vtt-only player must not be offered the srt it cannot parse.
    const { s } = session([BY_IMDB], { formats: ['vtt'] });
    const r = await s.resolve({ imdbId: 'tt0133093' });
    expect(r.candidates).toHaveLength(0);
    expect(r.unrenderable).toBe(1);
  });

  it('reports a conversion failure instead of handing over an empty track', async () => {
    const onError = vi.fn();
    const { s } = session([BY_IMDB, { match: /\/get\/114415$/, text: 'not a subtitle' }], {
      formats: ['vtt'],
      convertTo: 'vtt',
      onError,
    });
    const r = await s.resolve({ imdbId: 'tt0133093' });
    const pick = r.candidates[0];
    if (!pick) throw new Error('expected a candidate');

    expect(await s.load(pick)).toBeNull();
    expect(onError).toHaveBeenCalled();
  });
});

describe('autoSelect locale and region tolerance', () => {
  const subs = [
    bundleSubtitle({ id: 1, language: 'de' }),
    bundleSubtitle({ id: 2, language: 'en' }),
    bundleSubtitle({ id: 3, language: 'fr' }),
  ];
  const page = { match: /by-imdb/, body: movieBundle(subs) };

  it("'locale' picks the viewer's most preferred available language", async () => {
    vi.stubGlobal('navigator', { languages: ['de-DE', 'en-US'] });
    try {
      const { s } = session([page, { match: /\/get\/1$/, text: 'deutsch' }], {
        autoSelect: 'locale',
      });
      const r = await s.resolve({ imdbId: 'tt0133093' });
      expect(r.selected?.candidate.subtitle.id).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("'locale' tolerates a region: en-US selects the corpus en", async () => {
    vi.stubGlobal('navigator', { languages: ['en-US'] });
    try {
      const { s } = session([page, { match: /\/get\/2$/, text: 'english' }], {
        autoSelect: 'locale',
      });
      const r = await s.resolve({ imdbId: 'tt0133093' });
      expect(r.selected?.candidate.subtitle.id).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("'locale' fetches the viewer's languages when none are configured", async () => {
    vi.stubGlobal('navigator', { languages: ['de-DE', 'en-US'] });
    try {
      const { s, calls } = session([page, { match: /\/get\/1$/, text: 'deutsch' }], {
        autoSelect: 'locale',
      });
      await s.resolve({ imdbId: 'tt0133093' });
      // Fanned out one title request per viewer language, so the candidates actually
      // contain them rather than the alphabetically earliest codes an unfiltered
      // request returns.
      expect(calls.some((c) => c.url.includes('lang=de'))).toBe(true);
      expect(calls.some((c) => c.url.includes('lang=en'))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("'locale' falls back to the top candidate when the viewer's language is absent", async () => {
    vi.stubGlobal('navigator', { languages: ['ja'] });
    try {
      // Languages are configured, so those are fetched and ranked; the viewer's
      // Japanese is not among them, so 'locale' takes the top candidate rather than
      // nothing.
      const { s } = session([page, { match: /\/get\/2$/, text: 'x' }], {
        autoSelect: 'locale',
        languages: ['en', 'de'],
      });
      const r = await s.resolve({ imdbId: 'tt0133093' });
      expect(r.selected?.candidate.subtitle.id).toBe(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a navigator with no language info degrades to the top candidate', async () => {
    // Node ships a real global navigator, so the SSR/no-language case is a navigator
    // that reports no languages: localeLanguages is empty, the fetch is unfiltered,
    // and the top-ranked candidate is taken rather than nothing.
    vi.stubGlobal('navigator', {});
    try {
      const { s } = session([page, { match: /\/get\/1$/, text: 'x' }], { autoSelect: 'locale' });
      const r = await s.resolve({ imdbId: 'tt0133093' });
      expect(r.selected?.candidate.subtitle.id).toBe(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a pinned language tolerates a region too: en-US selects en', async () => {
    const { s } = session([page, { match: /\/get\/2$/, text: 'english' }], { autoSelect: 'en-US' });
    const r = await s.resolve({ imdbId: 'tt0133093' });
    expect(r.selected?.candidate.subtitle.id).toBe(2);
  });
});

describe('on-device transcription', () => {
  const EMPTY = { match: /by-imdb/, body: movieBundle([]) };
  const media = {} as HTMLMediaElement;
  const vtt = (): Promise<{ text: string; format: 'vtt' }> =>
    Promise.resolve({ text: 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nhi\n', format: 'vtt' });

  it('offers a synthetic candidate when the corpus has nothing and an engine is wired', async () => {
    const transcriber = vi.fn(vtt);
    const { s } = session([EMPTY], { transcribe: true, transcriber });
    const r = await s.resolve({ imdbId: 'tt0133093' });

    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.synthetic).toBe(true);
    expect(r.candidates[0]?.subtitle.id).toBe(SYNTHETIC_ID);
  });

  it('does not offer one without a transcriber, so a dead row is never shown', async () => {
    const { s } = session([EMPTY], { transcribe: true });
    const r = await s.resolve({ imdbId: 'tt0133093' });
    expect(r.candidates).toHaveLength(0);
  });

  it('does not offer one when transcription is off', async () => {
    const transcriber = vi.fn(vtt);
    const { s } = session([EMPTY], { transcribe: { when: 'off' }, transcriber });
    const r = await s.resolve({ imdbId: 'tt0133093' });
    expect(r.candidates).toHaveLength(0);
  });

  it("the default 'no-match' stays quiet while the corpus has something", async () => {
    const transcriber = vi.fn(vtt);
    const { s } = session([BY_IMDB], { transcribe: true, transcriber });
    const r = await s.resolve({ imdbId: 'tt0133093' });
    expect(r.candidates).toHaveLength(1);
    expect(r.candidates[0]?.synthetic).toBeUndefined();
  });

  it("'always' offers it last, after the real candidates", async () => {
    const transcriber = vi.fn(vtt);
    const { s } = session([BY_IMDB], { transcribe: { when: 'always' }, transcriber });
    const r = await s.resolve({ imdbId: 'tt0133093' });
    expect(r.candidates).toHaveLength(2);
    expect(r.candidates[0]?.synthetic).toBeUndefined();
    expect(r.candidates.at(-1)?.synthetic).toBe(true);
  });

  it('load() transcribes the synthetic candidate through the wired engine', async () => {
    const transcriber = vi.fn(vtt);
    const { s, calls } = session([EMPTY], { transcribe: true, transcriber });
    const r = await s.resolve({ imdbId: 'tt0133093' });
    const syn = r.candidates[0];
    if (!syn) throw new Error('expected a synthetic candidate');

    const loaded = await s.load(syn, { media });
    expect(loaded?.format).toBe('vtt');
    expect(loaded?.text).toContain('WEBVTT');
    expect(transcriber).toHaveBeenCalledOnce();
    // Transcription never touches the SubtitleDB API, so it costs no download.
    expect(calls.every((c) => !c.url.includes('/get/'))).toBe(true);
  });

  it('caches a transcription so re-selecting the row runs the engine once', async () => {
    const transcriber = vi.fn(vtt);
    const { s } = session([EMPTY], { transcribe: true, transcriber });
    const r = await s.resolve({ imdbId: 'tt0133093' });
    const syn = r.candidates[0];
    if (!syn) throw new Error('expected a synthetic candidate');

    await s.load(syn, { media });
    await s.load(syn, { media });
    expect(transcriber).toHaveBeenCalledOnce();
  });

  it('returns null and reports when there is no media element to read', async () => {
    const onError = vi.fn();
    const transcriber = vi.fn(vtt);
    const { s } = session([EMPTY], { transcribe: true, transcriber, onError });
    const r = await s.resolve({ imdbId: 'tt0133093' });
    const syn = r.candidates[0];
    if (!syn) throw new Error('expected a synthetic candidate');

    expect(await s.load(syn)).toBeNull();
    expect(transcriber).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalled();
  });

  it('autoSelect never chooses the synthetic row, only a real candidate', async () => {
    const transcriber = vi.fn(vtt);
    const { s } = session([BY_IMDB, DOWNLOAD], {
      transcribe: { when: 'always' },
      transcriber,
      autoSelect: true,
    });
    const r = await s.resolve({ imdbId: 'tt0133093' });
    expect(r.selected?.candidate.synthetic).toBeUndefined();
    expect(transcriber).not.toHaveBeenCalled();
  });
});
