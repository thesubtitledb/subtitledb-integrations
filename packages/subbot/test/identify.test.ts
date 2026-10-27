import type { IdentifiedText, ResolvedTranscribe, TranscribeRequest } from '@subtitledb/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IDENTIFY_WORDS,
  Subbot,
  type SubbotState,
  VERIFY_AFTER_MS,
  wordCount,
} from '../src/subbot.js';
import { dropWarm } from '../src/warm.js';
import { fakeMedia, fakeSpawn, type Truth } from './fake-workers.js';

const DEPS = {
  workerUrl: 'https://cdn.test/v/1/w.js',
  wasmUrl: 'https://cdn.test/v/1/subbot.wasm',
};

/** Five words every two seconds. */
function lines(duration: number): Truth[] {
  const out: Truth[] = [];
  for (let t = 0.5; t + 1.5 < duration; t += 2)
    out.push({ t0: t, t1: t + 1.4, text: `we said this at ${Math.round(t)}` });
  return out;
}

const FOUND: IdentifiedText = {
  text: 'WEBVTT\n\n00:00:04.000 --> 00:00:06.000\nA line a person wrote\n',
  format: 'vtt',
  identified: {
    sub_id: 501,
    imdb_id: 'tt1727587',
    season: 0,
    episode: 0,
    lang: 'en',
    shift_ms: 4000,
    matched_sub_id: 501,
  },
};

function start(identify: TranscribeRequest['identify'], over: Partial<ResolvedTranscribe> = {}) {
  const duration = 120;
  const { spawn, log } = fakeSpawn({ truth: lines(duration), duration });
  const states: SubbotState[] = [];
  const req: TranscribeRequest = {
    media: fakeMedia(0, duration),
    config: {
      when: 'always',
      engine: 'subbot',
      model: 'auto',
      quality: 'fast',
      task: 'transcribe',
      device: 'auto',
      language: 'auto',
      onState: (s) => states.push(s),
      ...over,
    },
    ...(identify ? { identify } : {}),
  };
  return { log, states, run: new Subbot(req, { ...DEPS, spawn }).run() };
}

beforeEach(() => {
  vi.stubGlobal('navigator', { hardwareConcurrency: 8, deviceMemory: 8 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  dropWarm();
});

describe('identify', () => {
  it('counts words the way the corpus index does', () => {
    expect(wordCount([{ text: "I don't know." }, { text: '你好吗' }])).toBe(7);
  });

  it('swaps the corpus file in on a match and stops transcribing', async () => {
    const identify = vi.fn(async () => FOUND);
    const { run, states, log } = start(identify);
    const r = await run;
    expect(r.text).toBe(FOUND.text);
    expect(r.identified?.sub_id).toBe(501);
    expect(identify).toHaveBeenCalledOnce();
    const [lang, cues] = identify.mock.calls[0] as unknown as [string, { start_ms: number }[]];
    expect(lang).toBe('en');
    expect(wordCount(cues as unknown as { text: string }[])).toBeGreaterThanOrEqual(
      IDENTIFY_WORDS[0] as number,
    );
    expect(cues[0]?.start_ms).toBe(500);
    expect(states.at(-1)).toEqual({ state: 'identified', identified: FOUND.identified });
    expect(states.some((s) => s.state === 'complete')).toBe(false);
    // Stopped well short of the two minutes.
    const covered = log.windows.reduce((n, w) => Math.max(n, w.t1), 0);
    expect(covered).toBeLessThan(60);
  });

  it('asks three times at most, then finishes the transcription', async () => {
    const identify = vi.fn(async () => null);
    const { run, states } = start(identify);
    const r = await run;
    expect(identify).toHaveBeenCalledTimes(IDENTIFY_WORDS.length);
    expect(r.identified).toBeUndefined();
    expect(states.at(-1)?.state).toBe('complete');
  });

  it('shows a match once the words after the lookup agree with it', async () => {
    // The file says what the video says, at the same times.
    const reference = lines(120).map((l) => ({ start_ms: l.t0 * 1000, text: l.text }));
    const identify = vi.fn(async () => ({ ...FOUND, reference }));
    const { run, states, log } = start(identify);
    const r = await run;
    expect(r.identified?.sub_id).toBe(501);
    expect(identify).toHaveBeenCalledOnce();
    expect(states.at(-1)?.state).toBe('identified');
    // It waited for words from 30 s past the first line, and no longer than it needed.
    const covered = log.windows.reduce((n, w) => Math.max(n, w.t1), 0);
    expect(covered).toBeGreaterThan(0.5 + VERIFY_AFTER_MS / 1000);
    expect(covered).toBeLessThan(90);
  });

  it('drops a match the words after do not bear out, and never takes it again', async () => {
    // Another episode: the same opening, then other words.
    const reference = [
      ...lines(20).map((l) => ({ start_ms: l.t0 * 1000, text: l.text })),
      ...lines(120)
        .filter((l) => l.t0 >= 20)
        .map((l) => ({ start_ms: l.t0 * 1000, text: 'somebody else talks here instead' })),
    ];
    const identify = vi.fn(async () => ({ ...FOUND, reference }));
    const { run, states } = start(identify);
    const r = await run;
    expect(r.identified).toBeUndefined();
    expect(identify).toHaveBeenCalledTimes(IDENTIFY_WORDS.length);
    expect(states.at(-1)?.state).toBe('complete');
  });

  it('never asks when translating, or when the session gave no lookup', async () => {
    const identify = vi.fn(async () => FOUND);
    expect((await start(identify, { task: 'translate' }).run).identified).toBeUndefined();
    expect(identify).not.toHaveBeenCalled();
    expect((await start(undefined).run).identified).toBeUndefined();
  });
});
