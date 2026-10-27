import { describe, expect, it, vi } from 'vitest';
import { SubtitleDbClient } from '../src/client.js';
import { createSession } from '../src/session.js';
import { identifySpeech } from '../src/speech.js';
import type { TranscribeRequest } from '../src/transcribe.js';
import { parseVtt } from '../src/transform.js';
import { bundleSubtitle, movieBundle, stubFetch } from './fixtures.js';

/** An SRT of `n` lines from `t0` ms, `gap` apart. */
function srt(n: number, t0: number, gap: number, word: string): string {
  const ts = (ms: number) => {
    const h = String(Math.floor(ms / 3_600_000)).padStart(2, '0');
    const m = String(Math.floor(ms / 60_000) % 60).padStart(2, '0');
    const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
    return `${h}:${m}:${s},${String(ms % 1000).padStart(3, '0')}`;
  };
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    // Uneven gaps, so one offset fits and no other does.
    const start = t0 + i * gap + ((i * 7919) % 1700);
    out.push(`${i + 1}\n${ts(start)} --> ${ts(start + 1500)}\n${word} ${i}\n`);
  }
  return out.join('\n');
}

const MATCH = {
  match: {
    sub_id: 501,
    imdb_id: 'tt1727587',
    season: 0,
    episode: 0,
    lang: 'en',
    shift_ms: 4000,
    hits: 9,
  },
  files: [],
  probes: 12,
  runner_up: 0,
};
const HEARD = [{ start_ms: 61_000, text: 'What brings you to the land of the gatekeepers' }];
const EN = bundleSubtitle({ id: 501, language: 'en' });
const DE = bundleSubtitle({ id: 777, language: 'de' });

function routes(identify: unknown = MATCH) {
  return [
    { match: /\/v1\/subbot\/identify/, body: identify },
    { match: /\/v1\/by-subid\/501/, body: { ...movieBundle([EN]), subtitle: EN } },
    { match: /\/v1\/by-imdb\/tt1727587/, body: movieBundle([DE]) },
    { match: /\/get\/501$/, text: srt(120, 10_000, 4000, 'line') },
    // The German file's lines start 2.5 s before the English file's, before the shift.
    { match: /\/get\/777$/, text: srt(120, 7_500, 4000, 'zeile') },
  ];
}

function deps(r = routes(), languages: string[] = []) {
  const { fetch, calls } = stubFetch(r);
  const client = new SubtitleDbClient({ fetch, retries: 0 });
  return {
    calls,
    d: { client, languages, budget: () => true, signal: new AbortController().signal },
  };
}

describe('identifySpeech', () => {
  it('posts the heard lines and the spoken language', async () => {
    const { d, calls } = deps();
    await identifySpeech(d, 'en', HEARD);
    const post = calls[0];
    expect(post?.url).toContain('/v1/subbot/identify');
    expect(post?.init?.method).toBe('POST');
    expect(JSON.parse(String(post?.init?.body))).toEqual({ lang: 'en', cues: HEARD });
  });

  it('shows the spoken-language file, shifted onto the video', async () => {
    const { d } = deps();
    const r = await identifySpeech(d, 'en', HEARD);
    expect(r?.identified).toMatchObject({ sub_id: 501, matched_sub_id: 501, shift_ms: 4000 });
    expect(parseVtt(r?.text ?? '')[0]?.start).toBe(14_000);
  });

  it("shows the viewer's language instead, lined up against the spoken file", async () => {
    const { d } = deps(routes(), ['de-DE']);
    const r = await identifySpeech(d, 'en', HEARD);
    expect(r?.identified).toMatchObject({ sub_id: 777, matched_sub_id: 501, lang: 'de' });
    // 2.5 s behind the English file, which itself moves 4 s: 6.5 s in all.
    expect(Math.abs((r?.identified.shift_ms ?? 0) - 6500)).toBeLessThan(150);
    expect(r?.text).toContain('zeile 0');
  });

  it('falls back to the spoken file when the viewer language has none', async () => {
    const r0 = routes().map((x) =>
      /by-imdb/.test(String(x.match)) ? { ...x, body: movieBundle([]) } : x,
    );
    const { d } = deps(r0, ['ja']);
    const r = await identifySpeech(d, 'en', HEARD);
    expect(r?.identified.sub_id).toBe(501);
  });

  it('answers null on no match, with no other request', async () => {
    const { d, calls } = deps(routes({ match: null, files: [], probes: 2, runner_up: 0 }));
    expect(await identifySpeech(d, 'en', HEARD)).toBeNull();
    expect(calls).toHaveLength(1);
  });
});

describe('the session hands the engine its lookup', () => {
  const EMPTY = { match: /by-imdb\/tt0133093/, body: movieBundle([]) };
  const media = {} as HTMLMediaElement;

  async function run(transcribe: unknown, r = [EMPTY, ...routes()]) {
    const { fetch } = stubFetch(r);
    const client = new SubtitleDbClient({ fetch, retries: 0 });
    let seen: TranscribeRequest | undefined;
    const transcriber = vi.fn(async (req: TranscribeRequest) => {
      seen = req;
      const hit = await req.identify?.('en', HEARD);
      return hit ?? { text: 'WEBVTT\n', format: 'vtt' as const };
    });
    const s = createSession({ client, formats: ['vtt'], transcribe, transcriber });
    const res = await s.resolve({ imdbId: 'tt0133093' });
    const syn = res.candidates.find((c) => c.synthetic);
    if (!syn) throw new Error('expected the transcription row');
    return { loaded: await s.load(syn, { media }), seen };
  }

  it('by default, and the corpus file it finds is what loads', async () => {
    const { loaded, seen } = await run(true);
    expect(typeof seen?.identify).toBe('function');
    expect(loaded?.identified?.sub_id).toBe(501);
  });

  it('not when identify is off, or when translating', async () => {
    expect((await run({ identify: false })).seen?.identify).toBeUndefined();
    expect((await run({ task: 'translate' })).seen?.identify).toBeUndefined();
  });

  it('a failed lookup is reported and answers null', async () => {
    const onError = vi.fn();
    const { fetch } = stubFetch([EMPTY, { match: /subbot\/identify/, status: 500, body: {} }]);
    const client = new SubtitleDbClient({ fetch, retries: 0 });
    let hit: unknown = 'unset';
    const transcriber = vi.fn(async (req: TranscribeRequest) => {
      hit = await req.identify?.('en', HEARD);
      return { text: 'WEBVTT\n', format: 'vtt' as const };
    });
    const s = createSession({ client, formats: ['vtt'], transcribe: true, transcriber, onError });
    const res = await s.resolve({ imdbId: 'tt0133093' });
    const syn = res.candidates.find((c) => c.synthetic);
    if (!syn) throw new Error('expected the transcription row');
    await s.load(syn, { media });
    expect(hit).toBeNull();
    expect(onError).toHaveBeenCalled();
  });
});
