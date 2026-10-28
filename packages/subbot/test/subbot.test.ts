import type { ResolvedTranscribe, TranscribeRequest } from '@subtitledb/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_VAD_URL } from '../src/asr/models.js';
import { LIVE } from '../src/schedule.js';
import { Subbot, type SubbotState } from '../src/subbot.js';
import { dropWarm, warmUp } from '../src/warm.js';
import { type FakeOptions, fakeMedia, fakeSpawn, type Truth } from './fake-workers.js';

const DEPS = {
  workerUrl: 'https://cdn.test/v/1/w.js',
  wasmUrl: 'https://cdn.test/v/1/subbot.wasm',
};

/** One line every two seconds for `duration` seconds. */
function lines(duration: number): Truth[] {
  const out: Truth[] = [];
  for (let t = 0.5; t + 1.5 < duration; t += 2)
    out.push({ t0: t, t1: t + 1.4, text: `line at ${t}` });
  return out;
}

function config(over: Partial<ResolvedTranscribe> = {}): ResolvedTranscribe {
  return {
    when: 'always',
    engine: 'subbot',
    model: 'auto',
    quality: 'fast',
    task: 'transcribe',
    device: 'auto',
    language: 'auto',
    ...over,
  };
}

function start(
  fake: FakeOptions,
  over: Partial<ResolvedTranscribe> = {},
  playhead = 0,
  controls = false,
) {
  const { spawn, log } = fakeSpawn(fake);
  const media = fakeMedia(playhead, fake.duration, { controls });
  const states: SubbotState[] = [];
  const req: TranscribeRequest = {
    media,
    config: config({ onState: (s) => states.push(s), ...over }),
  };
  const bot = new Subbot(req, { ...DEPS, spawn });
  return { bot, log, media, states, run: bot.run() };
}

beforeEach(() => {
  vi.stubGlobal('navigator', { hardwareConcurrency: 8, deviceMemory: 8 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  dropWarm();
});

describe('the first cue', () => {
  it('comes from a short window at the playhead, before anything else is transcribed', async () => {
    const { log, run, states } = start({ truth: lines(30), duration: 30 }, {}, 10);
    await run;
    const first = log.windows[0];
    expect(first?.t0).toBe(10);
    expect(first?.t1).toBeCloseTo(10 + LIVE.first, 1);
    // The next window is the longer step, straight after.
    expect(log.windows[1]?.t0).toBeCloseTo(first?.t1 ?? 0, 1);
    expect((log.windows[1]?.t1 ?? 0) - (log.windows[1]?.t0 ?? 0)).toBeCloseTo(LIVE.step, 1);
    expect(states.map((s) => s.state)).toContain('listening');
    expect(states[0]?.state).toBe('loading');
  });

  it('is on screen before the second window is asked for', async () => {
    const seen: Array<{ cue: number; windows: number }> = [];
    const { bot, log, run } = start({
      truth: lines(30),
      duration: 30,
      msPerSec: { 'tiny-q8_0': 20 },
    });
    const tick = setInterval(() => {
      if (bot.timeToFirstCue !== null && seen.length === 0)
        seen.push({ cue: bot.timeToFirstCue, windows: log.windows.length });
    }, 1);
    await run;
    clearInterval(tick);
    expect(seen[0]?.windows).toBe(1);
  });
});

describe('the live tier', () => {
  it('keeps to the playhead while the quality tier works on the same seconds', async () => {
    const { run, log } = start(
      { truth: lines(60), duration: 60, msPerSec: { 'tiny-q8_0': 5, 'base-q8_0': 50 } },
      { quality: 'balanced' },
    );
    await run;
    const live = log.windows.filter((w) => w.model === 'tiny-q8_0').map((w) => w.t0);
    // The first window, then straight on from its end: not past the pool's windows.
    expect(live[0]).toBe(0);
    expect(live[1]).toBeCloseTo(LIVE.first, 1);
    expect(live[2]).toBeCloseTo(LIVE.first + LIVE.step, 1);
  });
});

describe('the whole file', () => {
  it('takes over the worker warmed before the click, and only asks it for the model', async () => {
    const fake = { truth: lines(10), duration: 10 };
    const { spawn, log } = fakeSpawn(fake);
    const assets = {
      wasmUrl: DEPS.wasmUrl,
      modelUrl: 'https://m.test/ggml-tiny-q8_0.bin',
      vadUrl: DEFAULT_VAD_URL,
      cacheName: 'subtitledb-subbot',
    };
    // No Cache API here, so the warm worker is the engine alone, as on a first visit.
    expect(await warmUp(spawn, assets)).toBe(false);
    expect(log.spawned).toBe(1);
    expect(log.loads).toBe(0);
    const states: SubbotState[] = [];
    const bot = new Subbot(
      {
        media: fakeMedia(0, 10),
        config: config({
          quality: 'fast',
          models: 'https://m.test/',
          onState: (s) => states.push(s),
        }),
      },
      { ...DEPS, spawn },
    );
    await bot.run();
    // The audio worker is the only new one; the live worker was the warm one, loaded on take-over.
    expect(log.spawned).toBe(2);
    expect(log.loads).toBe(1);
    expect(states.at(-1)?.state).toBe('complete');
  });

  it('is covered and handed back as WebVTT with every line, in order', async () => {
    const truth = lines(40);
    const { run, states } = start({ truth, duration: 40 }, {}, 20);
    const { text, format } = await run;
    expect(format).toBe('vtt');
    expect(text.startsWith('WEBVTT')).toBe(true);
    for (const l of truth) expect(text).toContain(l.text);
    const times = [...text.matchAll(/^(\d\d:\d\d:\d\d\.\d{3}) --> /gm)].map((m) => m[1]);
    expect(times).toEqual([...times].sort());
    expect(states.at(-1)).toEqual({ state: 'complete', cues: truth.length });
  });

  it('is re-done by the quality tier, whose lines replace the live ones', async () => {
    const truth = lines(30);
    const { run, log } = start(
      { truth, duration: 30, suffix: { 'tiny-q8_0': ' [live]', 'base-q8_0': ' [quality]' } },
      { quality: 'balanced' },
    );
    const { text } = await run;
    expect(text).toContain('[quality]');
    expect(text).not.toContain('[live]');
    const models = new Set(log.windows.map((w) => w.model));
    expect(models).toEqual(new Set(['tiny-q8_0', 'base-q8_0']));
    // The pool starts after the first live window, never before.
    expect(log.windows[0]?.model).toBe('tiny-q8_0');
  });

  it('completes on the live tier alone when the machine is too small for a pool', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 2, deviceMemory: 4 });
    const truth = lines(20);
    const { run, log, states } = start({ truth, duration: 20 }, { quality: 'balanced' });
    const { text } = await run;
    for (const l of truth) expect(text).toContain(l.text);
    expect(new Set(log.windows.map((w) => w.model))).toEqual(new Set(['tiny-q8_0']));
    expect(states.at(-1)?.state).toBe('complete');
  });

  it('takes a language only once two windows with speech agree on it', async () => {
    const { run, states } = start({ truth: lines(30), duration: 30, langs: ['ja', 'en', 'en'] });
    await run;
    const live = states.filter((s) => s.state === 'live');
    expect(live[0]).toMatchObject({ language: null });
    expect(live.at(-1)).toMatchObject({ language: 'en' });
    expect(live.some((s) => s.language === 'ja')).toBe(false);
  });

  it('does not take a language from windows that gave no lines', async () => {
    // Music for the first 8 s: whisper hears "Japanese" in it and writes only notes.
    const music = [0.5, 2.5, 4.5, 6.5].map((t) => ({ t0: t, t1: t + 1.4, text: '♪' }));
    const speech = lines(30).filter((l) => l.t0 > 8);
    const { run, states } = start({
      truth: [...music, ...speech],
      duration: 30,
      langs: ['ja', 'ja'],
    });
    await run;
    expect(states.some((s) => s.language === 'ja')).toBe(false);
    expect(states.filter((s) => s.state === 'live').at(-1)).toMatchObject({ language: 'en' });
  });

  it('detects the language from the first windows and reports it', async () => {
    const { run, states } = start({ truth: lines(10), duration: 10, lang: 'fr' });
    await run;
    const live = states.filter((s) => s.state === 'live');
    expect(live.at(-1)).toMatchObject({ language: 'fr' });
  });
});

describe('captions off in the browser menu', () => {
  it('pauses the transcription, and resumes at the playhead when AI subtitles is picked', async () => {
    vi.stubGlobal(
      'VTTCue',
      class {
        constructor(
          readonly startTime: number,
          readonly endTime: number,
          readonly text: string,
        ) {}
      },
    );
    const { log, media, states, run } = start(
      { truth: lines(60), duration: 60, msPerSec: { 'tiny-q8_0': 20 } },
      {},
      0,
      true,
    );
    const until = async (ok: () => boolean) => {
      for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(ok()).toBe(true);
    };
    await until(() => log.windows.length >= 2);

    media.pick(null);
    await until(() => states.some((s) => s.state === 'paused'));
    // The window in flight finishes; nothing new is asked for.
    await new Promise((r) => setTimeout(r, 200));
    const asked = log.windows.length;
    await new Promise((r) => setTimeout(r, 600));
    expect(log.windows.length).toBe(asked);
    expect(states.at(-1)?.state).toBe('paused');

    (media as { currentTime: number }).currentTime = 40;
    media.pick('AI subtitles');
    await until(() => log.windows.length > asked);
    const next = log.windows[asked];
    expect(next?.t0).toBe(40);
    expect((next?.t1 ?? 0) - (next?.t0 ?? 0)).toBeCloseTo(LIVE.first, 1);
    await run;
  });
});

describe('a seek', () => {
  it('drops a far window with most of its cost ahead and restarts at the new playhead', async () => {
    const { run, log, media, bot } = start(
      { truth: lines(120), duration: 120, msPerSec: { 'tiny-q8_0': 400 } },
      {},
      0,
    );
    // Wait for the second window (6 s, 2.4 s of fake work) to be in flight, then jump.
    await vi.waitFor(() => expect(log.windows.length).toBe(2), { timeout: 5000 });
    await new Promise((r) => setTimeout(r, 100));
    media.seek(90);
    await vi.waitFor(() => expect(log.windows.length).toBe(3), { timeout: 5000 });
    expect(log.terminated).toBeGreaterThanOrEqual(1);
    expect(log.windows[2]?.t0).toBe(90);
    expect((log.windows[2]?.t1 ?? 0) - 90).toBeCloseTo(LIVE.first, 1);
    void bot;
    // Stop the run: the rest of a two minute file at this fake speed is not the test.
    media.seek(0);
    await Promise.race([run, new Promise((r) => setTimeout(r, 10))]).catch(() => {});
  });
});

describe('failure', () => {
  it('rejects with the audio error and stops every worker', async () => {
    const { run, log } = start({ truth: [], duration: 10, audioError: 'unsupported_codec' });
    await expect(run).rejects.toMatchObject({ code: 'unsupported_codec' });
    expect(log.terminated).toBe(log.spawned);
  });

  it('is cancelled by the signal', async () => {
    const ac = new AbortController();
    const { spawn, log } = fakeSpawn({
      truth: lines(60),
      duration: 60,
      msPerSec: { 'tiny-q8_0': 200 },
    });
    const bot = new Subbot(
      { media: fakeMedia(0, 60), config: config(), signal: ac.signal },
      { ...DEPS, spawn },
    );
    const run = bot.run();
    await vi.waitFor(() => expect(log.windows.length).toBe(1));
    ac.abort();
    await expect(run).rejects.toMatchObject({ code: 'aborted' });
    expect(log.terminated).toBe(log.spawned);
  });
});
