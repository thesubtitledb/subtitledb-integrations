import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  /** The warm-up's report, before the select: true with the model already in memory. */
  warm: boolean | null;
  /** Every text the notice on the video showed, in order. */
  notice: string[];
  /** The corpus file shown in place of the transcription, when the lookup found one. */
  identified: { sub_id: number; shift_ms: number } | null;
}

const NOTICE = '[data-subtitledb-status]';
/** The real API answers any origin; a stubbed answer has to say so too. */
const CORS = { 'access-control-allow-origin': '*' };

// A minute of Sintel through both tiers on one WASM thread is a few minutes of work.
test.describe.configure({ mode: 'serial', timeout: 300_000 });

let context: BrowserContext;
/** The Chrome profile: ~400 MB once the models are cached in it, removed after. */
let profile = '';
let page: import('@playwright/test').Page;

test.beforeAll(async () => {
  // A profile on disk rather than the fixture's in-memory context: Chromium keeps
  // the engine's optimised code in that profile's code cache once a run has
  // compiled it, and the next run starts on it, as a viewer's browser does.
  context = await chromium.launchPersistentContext(
    (profile = await mkdtemp(join(tmpdir(), 'subbot-'))),
    {
      headless: true,
    },
  );
  // The corpus lookup answers no match unless a test says otherwise, so the runs
  // below transcribe the whole minute whatever the live index holds.
  await context.route(/\/v1\/subbot\/identify\b/, (r) =>
    r.fulfill({ headers: CORS, json: { match: null, files: [], probes: 0, runner_up: 0 } }),
  );
  page = await context.newPage();
  await page.goto(`${PAGE}/subbot.html?cdn=${encodeURIComponent(CDN)}`);
  await page.waitForFunction(
    () => typeof (window as { SubtitleDB?: unknown }).SubtitleDB === 'object',
  );
});

test.afterAll(async () => {
  await context.close();
  await rm(profile, { recursive: true, force: true });
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
  type Page = {
    __subbot: { mount: (p: string) => Promise<void>; select: (at?: number) => Promise<void> };
  };
  await page.evaluate(async (p) => (window as unknown as Page).__subbot.mount(p), player);
  // The row is in the menu and the engine warms behind it. A viewer takes a moment to
  // reach the row; this waits for the warm-up to report, which on a warm run means the
  // model is already in memory when the select comes.
  await expect.poll(async () => (await report()).warm, { timeout: 30_000 }).not.toBeNull();
  const warmed = (await report()).warm;
  await page.evaluate(async (a) => (window as unknown as Page).__subbot.select(a), at);

  await expect
    .poll(async () => (await report()).firstCueMs, { timeout: 120_000, message: 'no cue appeared' })
    .not.toBeNull();
  const r = await report();
  expect(r.error, r.error ?? '').toBeNull();
  console.log(
    `${player}: first cue ${r.firstCueMs} ms after select${warm ? '' : ' (cold: model download included)'}`,
  );
  console.log(`${player}: first cue ${r.firstCueLead} ms ahead of the playhead`);
  console.log(`${player}: states ${JSON.stringify(r.marks)} warm-up had the model: ${warmed}`);
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

  // The notice counted up with a percentage, ended on ready, and went away.
  console.log(`${player}: notice ${JSON.stringify(done.notice)}`);
  expect(done.notice.some((t) => /^Transcribing\d+%$/.test(t))).toBe(true);
  if (!warm) expect(done.notice.some((t) => /^Downloading\d+%$/.test(t))).toBe(true);
  expect(done.notice).toContain('Ready');
  await expect(page.locator(NOTICE)).toHaveCount(0, { timeout: 5_000 });
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

type Driver = {
  __subbot: {
    mount: (p: string) => Promise<void>;
    select: (at?: number) => Promise<void>;
    setNotice: (on: boolean) => void;
  };
};

test('the notice stays small under a host rule that stretches, and the x hides it', async () => {
  type Page = Driver;
  // The developer portal's `.stage > * { width: 100%; height: 100% }`, aimed at it.
  await page.addStyleTag({ content: '[data-subtitledb-status]{width:100%;height:100%;left:0}' });
  await page.evaluate(async () => (window as unknown as Page).__subbot.mount('native'));
  await page.evaluate(async () => (window as unknown as Page).__subbot.select(17));
  const notice = page.locator(NOTICE);
  await expect(notice).toBeVisible({ timeout: 30_000 });
  const box = await notice.boundingBox();
  console.log(`notice box ${JSON.stringify(box)}`);
  expect(box?.width ?? 999).toBeLessThan(160);
  expect(box?.height ?? 999).toBeLessThanOrEqual(22);
  const paused = await page.evaluate(
    () => (document.getElementById('player') as HTMLVideoElement).paused,
  );
  await notice.getByRole('button', { name: 'Hide' }).click();
  await expect(notice).toHaveCount(0, { timeout: 2_000 });
  // The click was the pill's, not the player's.
  expect(
    await page.evaluate(() => (document.getElementById('player') as HTMLVideoElement).paused),
  ).toBe(paused);
  // Progress carries on behind it without drawing it again.
  await page.waitForTimeout(3_000);
  await expect(notice).toHaveCount(0);
});

test('status: false, the lines come and no notice is drawn', async () => {
  type Page = Driver;
  await page.evaluate(() => (window as unknown as Page).__subbot.setNotice(false));
  await page.evaluate(async () => (window as unknown as Page).__subbot.mount('native'));
  await page.evaluate(async () => (window as unknown as Page).__subbot.select(17));
  await expect
    .poll(async () => (await report()).firstCueMs, { timeout: 60_000, message: 'no cue appeared' })
    .not.toBeNull();
  expect((await report()).notice).toEqual([]);
  await expect(page.locator(NOTICE)).toHaveCount(0);
});

test('identify: the first lines find a corpus file, which replaces the transcription', async () => {
  type Page = Driver;
  const asked: Array<{ lang: string; cues: Array<{ start_ms: number; text: string }> }> = [];
  const file = {
    id: 501,
    language: 'en',
    format: 'srt',
    download_url: 'https://api.thesubtitledb.org/get/501',
  };
  await page.route(/\/v1\/subbot\/identify\b/, (r) => {
    asked.push(r.request().postDataJSON());
    return r.fulfill({
      headers: CORS,
      json: {
        match: {
          sub_id: 501,
          imdb_id: 'tt1727587',
          season: 0,
          episode: 0,
          lang: 'en',
          shift_ms: 1500,
          hits: 12,
        },
        files: [],
        probes: 20,
        runner_up: 0,
      },
    });
  });
  await page.route(/\/v1\/by-subid\/501\b/, (r) =>
    r.fulfill({
      headers: CORS,
      json: {
        title: { imdb_id: 'tt1727587', name: 'Sintel', kind: 'movie' },
        subtitles: { total: 1, limit: 1, offset: 0, items: [file] },
        subtitle: file,
      },
    }),
  );
  // The excerpt's real subtitles, 1.5 s early, as a corpus file of another release
  // would be. SubBot checks the words it hears after the lookup against them.
  const srt = await readFile(
    join(process.cwd(), 'packages/subbot/test/media/sintel-excerpt.en.srt'),
    'utf8',
  );
  const early = srt.replace(/(\d\d):(\d\d):(\d\d),(\d\d\d)/g, (_, h, m, sec, ms) => {
    const t = ((+h * 60 + +m) * 60 + +sec) * 1000 + +ms - 1500;
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    return `${pad(Math.floor(t / 3_600_000))}:${pad(Math.floor(t / 60_000) % 60)}:${pad(Math.floor(t / 1000) % 60)},${pad(t % 1000, 3)}`;
  });
  await page.route(/\/get\/501\b/, (r) =>
    r.fulfill({ headers: CORS, contentType: 'text/plain', body: early }),
  );
  try {
    await page.evaluate(() => (window as unknown as Page).__subbot.setNotice(true));
    await page.evaluate(async () => (window as unknown as Page).__subbot.mount('native'));
    await page.evaluate(async () => (window as unknown as Page).__subbot.select(17));
    await expect
      .poll(async () => (await report()).identified, {
        timeout: 180_000,
        message: `no swap; ${asked.length} lookup(s)`,
      })
      .not.toBeNull()
      .catch(async (e) => {
        console.log(`report: ${JSON.stringify({ ...(await report()), vtt: null })}`);
        throw e;
      });
    const r = await report();
    expect(r.error, r.error ?? '').toBeNull();
    expect(r.identified).toMatchObject({ sub_id: 501, shift_ms: 1500 });
    // The file, shifted 1.5 s, is what the adapter was handed.
    expect(r.vtt).toContain('00:00:48.850 --> 00:00:51.750');
    expect(r.vtt).toContain('A dangerous quest for a lone hunter.');
    expect(r.complete).toBe(false);
    expect(r.notice).toContain('Matched');
    // The lookup carried what the model heard, in the language it detected.
    const first = asked[0];
    expect(first?.lang).toBe('en');
    const words = (first?.cues ?? []).map((c) => c.text).join(' ');
    console.log(
      `identify: asked ${asked.length} time(s); first with ${words.split(/\s+/).length} words`,
    );
    expect(words.split(/\s+/).length).toBeGreaterThanOrEqual(25);
    expect(words.toLowerCase()).toMatch(/dragon|gatekeeper|searching|someone|alone/);
    // The track shows the corpus line, not the model's.
    const onTrack = await page.evaluate(() => {
      const v = document.getElementById('player') as HTMLVideoElement;
      return [...v.textTracks].flatMap((t) => [...(t.cues ?? [])].map((c) => (c as VTTCue).text));
    });
    expect(onTrack).toContain('A dangerous quest for a lone hunter.');
  } finally {
    await page.unrouteAll();
  }
});
