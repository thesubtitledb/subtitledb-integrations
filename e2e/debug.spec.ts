import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';

/**
 * The playback debugger from the script tag, in a real browser playing a real file.
 *
 * The receiving end is stood in for here: what is under test is what the browser
 * sends, when, and what it keeps. The media events are the browser's own, which no
 * fake element reproduces: the order of play, playing, seeking and seeked, and the
 * positions timeupdate reports along the way.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CDN = `http://localhost:${process.env.CDN_PORT ?? 4174}`;
const RECEIVER = 'https://api.thesubtitledb.org/dbg';
const KEY = 'sdbg_e2etestkey00000000000000';
const MARK = 'subtitledb.debug';

interface Report {
  [field: string]: unknown;
  p: number;
  s: number;
  fl?: number;
  ev?: { k: string; t: number; d: string }[];
}

let chunks: Record<string, string>;

test.beforeAll(async () => {
  const { version } = JSON.parse(
    await readFile(join(root, 'packages/loader/package.json'), 'utf8'),
  );
  ({ chunks } = JSON.parse(await readFile(join(root, 'cdn/v', version, 'manifest.json'), 'utf8')));
});

/** Answers every report as the receiving side does, and keeps what arrived. */
async function receive(context: BrowserContext, rule: string) {
  const reports: Report[] = [];
  const heard: Promise<Record<string, string>>[] = [];
  await context.route(RECEIVER, async (route) => {
    const req = route.request();
    reports.push(JSON.parse(req.postData() ?? '{}'));
    // Read after the answer: the headers as sent are only final once it is in.
    heard.push(req.allHeaders());
    await route.fulfill({
      status: 204,
      headers: {
        'access-control-allow-origin': '*',
        'access-control-expose-headers': 'x-sdb-trace',
        'x-sdb-trace': rule,
      },
    });
  });
  const cookies = async () => (await Promise.all(heard)).map((h) => h.cookie);
  return { reports, cookies };
}

/** The example page, with the loader in and its own attach started. */
async function open(page: Page): Promise<void> {
  await page.goto(`/cdn.html?cdn=${encodeURIComponent(CDN)}`);
  await page.waitForFunction(() => 'SubtitleDB' in window);
}

/** A second, muted video on the page, attached with a debugger key. */
async function attachDebugged(page: Page): Promise<void> {
  await page.evaluate((key) => {
    const v = document.createElement('video');
    v.id = 'debugged';
    v.muted = true;
    v.playsInline = true;
    v.src = 'media/sample.webm';
    document.querySelector('main')?.append(v);
    const sdb = (window as never as { SubtitleDB: { attach(t: unknown, o: unknown): unknown } })
      .SubtitleDB;
    sdb.attach(v, { hint: { imdbId: 'tt0133093' }, languages: ['en'], debug: key });
  }, KEY);
  // Watched once the debugger's chunk is in: before that, a play is caught mid-way
  // and its startup is unknown, which is a different test.
  await page.waitForFunction(
    (mark) => Symbol.for(mark) in (document.getElementById('debugged') as HTMLVideoElement),
    MARK,
  );
}

const video = (page: Page, run: string) =>
  page.evaluate(`(async (v) => { ${run} })(document.getElementById('debugged'))`);

test('without a key there is no debugger at all: no chunk, no report, no storage', async ({
  page,
  context,
}) => {
  const { reports } = await receive(context, 'all');
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  await open(page);
  await page.evaluate(() =>
    (window as never as { __handle: { ready: Promise<unknown> } }).__handle.ready.catch(() => {}),
  );
  await page.evaluate(() =>
    (document.getElementById('player') as HTMLVideoElement).play().catch(() => {}),
  );
  await page.waitForTimeout(1500);
  expect(chunks.debug).toBeTruthy();
  expect(requests.filter((u) => u.endsWith(chunks.debug as string))).toEqual([]);
  expect(reports).toEqual([]);
  expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
});

test('the debug option reports a play as it goes: first frame, seek, pause, hidden tab', async ({
  page,
  context,
}) => {
  // One a credentialed request from this page would carry, so its absence means
  // something.
  await context.addCookies([
    {
      name: 'probe',
      value: '1',
      domain: 'api.thesubtitledb.org',
      path: '/',
      secure: true,
      sameSite: 'None',
    },
  ]);
  const { reports, cookies } = await receive(context, 'all');
  await open(page);
  await attachDebugged(page);

  await video(page, 'await v.play();');
  await expect.poll(() => reports.length, { timeout: 20_000 }).toBeGreaterThan(0);
  const first = reports[0] as Report;
  expect(first).toMatchObject({ v: 1, k: KEY, p: 1, s: 0 });
  expect(first.l).toMatch(/^[0-9A-F]{16}$/);
  expect((first.fl ?? 0) & 1).toBe(1);
  expect(Number(first.st)).toBeGreaterThan(0);
  // The sample is recorded in a browser, which writes no length into the file, so the
  // browser playing it may call its length unknown, as it does a live stream's.
  expect(first.du === 15 || first.li === 1, `du ${first.du}, li ${first.li}`).toBe(true);

  // Past the two seconds a pause must clear after the last report.
  await page.waitForTimeout(2500);
  await video(page, 'v.currentTime = Math.min(v.duration - 3, v.currentTime + 4);');
  await page.waitForTimeout(1200);
  await video(page, 'v.pause();');
  await expect.poll(() => reports.some((r) => Number(r.pu) >= 1)).toBe(true);
  const paused = reports.find((r) => Number(r.pu) >= 1) as Report;
  expect(paused.sk).toBe(1);
  expect(Number(paused.wa)).toBeGreaterThan(2000);
  // Watch time is time playing, so it is short of the wall clock since the first frame.
  expect(Number(paused.wa)).toBeLessThan(6000);
  // A pause is not a play's last word, so it carries no trace.
  expect(paused.ev).toBeUndefined();

  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => reports.some((r) => Array.isArray(r.ev))).toBe(true);
  const hidden = reports.find((r) => Array.isArray(r.ev)) as Report;
  const steps = hidden.ev ?? [];
  expect(steps[0]?.k).toBe('attach');
  expect(steps.map((e) => e.k)).toEqual(
    expect.arrayContaining(['source', 'manifest', 'first_frame', 'seek', 'pause']),
  );
  expect(steps.find((e) => e.k === 'source')?.d).toMatch(/^localhost:\d+\/media\/sample\.webm$/);
  // What SubtitleDB matched rides along, from the attach's own resolve.
  expect(hidden.im).toBe(133093);

  // One play, numbered in order, and nothing went down along the way.
  expect(reports.map((r) => r.p)).toEqual(reports.map(() => 1));
  expect(reports.map((r) => r.s)).toEqual(reports.map((_, i) => i));
  for (const f of ['wa', 'un', 'mp', 'sk', 'pu']) {
    const seen = reports.map((r) => Number(r[f] ?? 0));
    expect(seen, f).toEqual([...seen].sort((a, b) => a - b));
  }

  // Sent without the viewer's cookies, and the only storage is the debugger's own.
  const sent = await cookies();
  expect(sent).toHaveLength(reports.length);
  expect(sent.filter(Boolean)).toEqual([]);
  expect((await page.evaluate(() => Object.keys(localStorage))).sort()).toEqual(['sdb_uid']);
});

test('SubtitleDB.debug watches every video, including one added later', async ({
  page,
  context,
}) => {
  const { reports } = await receive(context, 'problems');
  await open(page);
  const ready = await page.evaluate(async (key) => {
    const w = window as never as {
      SubtitleDB: { debug(k: string): { ready: Promise<void> } };
      __dbg: unknown;
    };
    const h = w.SubtitleDB.debug(key);
    w.__dbg = h;
    await h.ready;
    return true;
  }, KEY);
  expect(ready).toBe(true);
  await page.waitForFunction(
    (mark) => Symbol.for(mark) in (document.getElementById('player') as HTMLVideoElement),
    MARK,
  );

  await page.evaluate(() => {
    const v = document.createElement('video');
    v.id = 'later';
    v.muted = true;
    v.src = 'media/sample.webm';
    document.querySelector('main')?.append(v);
  });
  await page.waitForFunction(
    (mark) => Symbol.for(mark) in (document.getElementById('later') as HTMLVideoElement),
    MARK,
  );
  await page.evaluate(() => (document.getElementById('later') as HTMLVideoElement).play());
  await expect.poll(() => reports.length, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(reports[0]).toMatchObject({ k: KEY, s: 0 });
  // Not attached through SubtitleDB, so nothing about what is playing.
  expect(reports[0]?.im).toBeUndefined();

  // A clean play under the default rule sends no trace, even when it ends.
  await page.evaluate(() => {
    (window as never as { __dbg: { stop(): void } }).__dbg.stop();
  });
  await expect.poll(() => reports.length).toBeGreaterThan(1);
  expect(reports.every((r) => r.ev === undefined)).toBe(true);
});

test('an autoplay the browser refuses is reported as a play that never started', async ({
  playwright,
  baseURL,
}) => {
  // Chrome's own default for a page nobody has clicked: autoplay only when muted. Set
  // here rather than left to however this browser was launched.
  const browser = await playwright.chromium.launch({
    args: ['--autoplay-policy=document-user-activation-required'],
  });
  try {
    const context = await browser.newContext({ baseURL });
    const { reports } = await receive(context, 'problems');
    // Set up from the page's own script: anything Playwright evaluates in the page
    // counts as a click, and a page that has been clicked may autoplay.
    await context.addInitScript((key) => {
      const start = setInterval(() => {
        const sdb = (
          window as never as { SubtitleDB?: { attach(t: unknown, o: unknown): unknown } }
        ).SubtitleDB;
        const main = document.querySelector('main');
        if (!sdb || !main) return;
        clearInterval(start);
        const v = document.createElement('video');
        v.id = 'debugged';
        v.autoplay = true;
        v.src = 'media/sample.webm';
        main.append(v);
        sdb.attach(v, { hint: { imdbId: 'tt0133093' }, languages: ['en'], debug: key });
      }, 50);
    }, KEY);
    const page = await context.newPage();
    await page.goto(`/cdn.html?cdn=${encodeURIComponent(CDN)}`);
    await expect
      .poll(() => reports.some((r) => ((r.fl ?? 0) & 128) === 128), { timeout: 20_000 })
      .toBe(true);
    const refused = reports.find((r) => ((r.fl ?? 0) & 128) === 128) as Report;
    expect(refused.p).toBe(1);
    expect((refused.fl ?? 0) & 1).toBe(0);
    // A play that never started is a problem play, so its trace goes with it.
    expect(refused.ev?.map((e) => e.k)).toContain('blocked');
  } finally {
    await browser.close();
  }
});
