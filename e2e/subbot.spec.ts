import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium, expect, test } from '@playwright/test';

/**
 * Drives examples/subbot.html: the transcription row selected on a real element in a
 * real browser, with the real worker, the real whisper.cpp build and a real model.
 *
 * Serial on one page on purpose. The model is 43 MB from HuggingFace and the Cache
 * API that keeps it is per context, so one context carries it across the four
 * players rather than fetching it four times.
 *
 * Two things are proved per player: a cue is on the element's own track within the
 * budget, and the run ends with a complete WebVTT handed to the adapter. The budget
 * is the product's: three seconds from the click to the first line, model already
 * cached. A GitHub runner is slower than any viewer's machine, so CI is given more
 * and the measured number is printed either way.
 */

const PAGE = `http://localhost:${process.env.PORT ?? 4173}`;
const CDN = `http://localhost:${process.env.CDN_PORT ?? 4174}`;
const FIRST_CUE_MS = process.env.CI ? 12_000 : 3_000;

interface Report {
  player: string | null;
  state: string;
  firstCueMs: number | null;
  /** Milliseconds between the first cue's start and the playhead when it appeared. */
  firstCueLead: number | null;
  /** When each state first arrived, milliseconds after the select. */
  marks: Record<string, number>;
  lines: string[];
  complete: boolean;
  error: string | null;
  vtt: string | null;
}

// A minute of Sintel through both tiers on one WASM thread is a few minutes of work.
test.describe.configure({ mode: 'serial', timeout: 300_000 });

let context: BrowserContext;
let page: import('@playwright/test').Page;

test.beforeAll(async () => {
  // A profile on disk rather than the fixture's in-memory context: Chromium keeps
  // the engine's optimised code in that profile's code cache once a run has
  // compiled it, and the next run starts on it, as a viewer's browser does.
  context = await chromium.launchPersistentContext(await mkdtemp(join(tmpdir(), 'subbot-')), {
    headless: true,
  });
  page = await context.newPage();
  await page.goto(`${PAGE}/subbot.html?cdn=${encodeURIComponent(CDN)}`);
  await page.waitForFunction(
    () => typeof (window as { SubtitleDB?: unknown }).SubtitleDB === 'object',
  );
});

test.afterAll(async () => {
  await context.close();
});

async function report(): Promise<Report> {
  return page.evaluate(() =>
    (window as unknown as { __subbot: { report: () => Report } }).__subbot.report(),
  );
}

/**
 * `at` is where playback starts. The budget is measured from a point with speech
 * under the playhead (17 s is mid-sentence in Sintel); from 0 the first seconds are
 * music, and the first line is on the track before it is due rather than within a
 * fixed time.
 */
async function run(player: string, warm: boolean, at?: number) {
  await page.evaluate(
    async ([p, a]) => {
      const w = window as unknown as {
        __subbot: { mount: (p: string) => Promise<void>; select: (at?: number) => Promise<void> };
      };
      await w.__subbot.mount(p);
      await w.__subbot.select(a);
    },
    [player, at] as const,
  );

  await expect
    .poll(async () => (await report()).firstCueMs, { timeout: 120_000, message: 'no cue appeared' })
    .not.toBeNull();
  const r = await report();
  expect(r.error, r.error ?? '').toBeNull();
  console.log(
    `${player}: first cue ${r.firstCueMs} ms after select${warm ? '' : ' (cold: model download included)'}`,
  );
  console.log(`${player}: first cue ${r.firstCueLead} ms ahead of the playhead`);
  console.log(`${player}: states ${JSON.stringify(r.marks)}`);
  // Cold runs only print: the download sits between the click and the first cue.
  if (warm && at !== undefined) {
    expect(r.firstCueMs ?? Number.POSITIVE_INFINITY).toBeLessThan(FIRST_CUE_MS);
  } else if (warm) {
    expect(r.firstCueLead ?? -1).toBeGreaterThan(0);
  }

  // The cue is on the element's own track, where the browser renders it.
  const onTrack = await page.evaluate(() => {
    const v = document.getElementById('player') as HTMLVideoElement;
    return [...v.textTracks].some((t) => t.mode === 'showing' && (t.cues?.length ?? 0) > 0);
  });
  expect(onTrack).toBe(true);

  // The whole minute, handed over as a file.
  await expect.poll(async () => (await report()).complete, { timeout: 180_000 }).toBe(true);
  await expect.poll(async () => (await report()).vtt, { timeout: 30_000 }).not.toBeNull();
  const done = await report();
  expect(done.vtt).toMatch(/^WEBVTT/);
  expect(done.lines.length).toBeGreaterThan(3);
  // Sintel's first minute: a line the model cannot miss.
  expect(done.vtt?.toLowerCase()).toMatch(/dragon|scales|sintel|gatekeeper|strange/);
}

test('plain video: the first cue within budget, then the whole file', async () => {
  // Cold: the model is downloaded on this run and cached for the ones after.
  await run('native', false);
});

test('plain video again, model cached: the budget holds', async () => {
  await run('native', true, 17);
});

test('dash.js, reading the MPD the element does not know', async () => {
  await run('dashjs', true, 17);
});

test('Shaka, reading the asset it loaded', async () => {
  await run('shaka', true, 17);
});

test('hls.js, reading the playlist', async () => {
  // Opus in fMP4: Playwright's Chromium carries no AAC decoder.
  await run('hlsjs', true, 17);
});
