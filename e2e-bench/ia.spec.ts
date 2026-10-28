import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium, type Page, test } from '@playwright/test';

/**
 * The SubBot bench on films and episodes from the Internet Archive, as a viewer gets
 * them: the file streamed from archive.org (through /archive/ on the examples server,
 * as thesubtitledb.org reads it through its own), played from just before the first
 * line, SubBot selected, and two minutes watched in real time.
 *
 * Per title: how long to "live" and to the first line, the word error rate of the
 * lines on the track against a corpus file for the same release, how many lines were
 * decoder loops, and how far ahead of the playhead the lines reached.
 *
 * Not in CI: it needs archive.org and minutes per title. `npm run bench:ia` runs this
 * branch's build; BENCH_CDN=https://cdn.thesubtitledb.org BENCH_LABEL=main runs the
 * released loader for comparison. Results go to test-results/bench-ia/<label>.json.
 */

const PAGE = `http://localhost:${process.env.PORT ?? 4173}`;
const CDN = process.env.BENCH_CDN ?? `http://localhost:${process.env.CDN_PORT ?? 4174}`;
const LABEL = process.env.BENCH_LABEL ?? 'branch';
const SECONDS = Number(process.env.BENCH_SECONDS ?? 120);
const ONLY = process.env.BENCH_ONLY?.split(',');

interface Title {
  name: string;
  /** archive.org item/file. */
  path: string;
  /** Just before the first spoken line. */
  start: number;
  /** A corpus file for the same release, from api.thesubtitledb.org/get/<id>. */
  ref: number;
}

const TITLES: Title[] = [
  {
    name: 'The Powerpuff Girls Movie (2002)',
    path: 'img-7123/IMG_7123.mp4',
    start: 29,
    ref: 111963,
  },
  {
    name: 'Kingsman: The Secret Service (2014)',
    path: 'kingsman.-the.-secret.-service.-2014.720p.-blu-ray.x-264.-yify/Kingsman.The.Secret.Service.2014.720p.BluRay.x264.YIFY.mp4',
    start: 95,
    ref: 6173114,
  },
  {
    name: 'Sherlock S01E01 (2010)',
    path: 'BBC_Sherlock2010/1x01 A Study in Pink.mp4',
    start: 85,
    ref: 3835508,
  },
  {
    name: 'Malcolm in the Middle S01E01 (2000)',
    path: 'malcolm-in-the-middle-complete-series-2000-2006/Malcolm in the Middle (The Complete Series) [2000 - 2006]/Season 1/S01E01 - Pilot.mp4',
    start: 11,
    ref: 8194449,
  },
  {
    name: 'My Little Pony: Friendship Is Magic S01E01 (2010)',
    path: 'MyLittlePonyFull/Season 1/My Little Pony Friendship is Magic - Season 1 Episode 01 - Friendship Is Magic, Part 01.mp4',
    start: 13,
    ref: 4384899,
  },
  {
    name: "The Internet's Own Boy (2014)",
    path: 'TheInternetsOwnBoyTheStoryOfAaronSwartz/TheInternetsOwnBoy_TheStoryofAaronSwartz-HD.mp4',
    start: 22,
    ref: 5759069,
  },
  { name: 'Home (2009)', path: 'tareque2742_gmail_HOME/HOME.mp4', start: 86, ref: 3516560 },
];

interface Cue {
  start: number;
  end: number;
  text: string;
}

interface Row {
  title: string;
  liveMs: number | null;
  firstCueMs: number | null;
  wer: number | null;
  cues: number;
  loops: number;
  aheadS: number | null;
  error: string | null;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/\[[^\]]*\]|\([^)]*\)|<[^>]+>/g, ' ')
    .replace(/[^\p{L}\p{N}' ]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);

function wer(ref: string[], hyp: string[]): number {
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (ref[i - 1] === hyp[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return ref.length ? (prev[hyp.length] as number) / ref.length : 0;
}

/** A line the decoder looped on: no letter at all, or a word three times running. */
const loop = (text: string) => {
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  // One word stuck: "s-s-s-s-s-s-s-s-...".
  if (/([^\s\d]{1,6}?)\1{7,}/.test(text)) return true;
  if (/(?<![^\s,.!?])(\S+)(?:[,.\s]+\1(?![^\s,.!?])){2,}/i.test(text)) return true;
  // Or a few word triples over and over: "**** of **** of ...".
  const w = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (w.length < 12) return false;
  const tri = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) tri.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return tri.size / (w.length - 2) < 0.4;
};

function parseSrt(text: string): Cue[] {
  const ts = (s: string) => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : 0;
  };
  const out: Cue[] = [];
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.trim().split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a = '', b = ''] = (lines[i] as string).split('-->');
    out.push({ start: ts(a), end: ts(b), text: lines.slice(i + 1).join(' ') });
  }
  return out;
}

test.describe.configure({ mode: 'serial', timeout: (SECONDS + 240) * 1000 });

let context: BrowserContext;
/** The Chrome profile: ~400 MB once the models are cached in it, removed after. */
let profile = '';
let page: Page;
const rows: Row[] = [];

test.beforeAll(async () => {
  profile = await mkdtemp(join(tmpdir(), 'subbot-ia-'));
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
  });
  // No corpus lookup: a match would swap the corpus file in and score it, not SubBot.
  await context.route(/\/v1\/subbot\/identify\b/, (r) =>
    r.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: { match: null, files: [], probes: 0, runner_up: 0 },
    }),
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
  const dir = join('test-results', 'bench-ia');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${LABEL}.json`),
    JSON.stringify({ cdn: CDN, seconds: SECONDS, rows }, null, 2),
  );
  const pct = (x: number | null) => (x === null ? '-' : `${(100 * x).toFixed(1)}%`);
  console.log(`\nSubBot on the Internet Archive, ${LABEL} (${CDN}), ${SECONDS} s each`);
  for (const r of rows) {
    console.log(
      `  ${r.title.padEnd(50)} live ${r.liveMs ?? '-'} ms  first line ${r.firstCueMs ?? '-'} ms  wer ${pct(r.wer)}  lines ${r.cues}  loops ${r.loops}  ahead ${r.aheadS ?? '-'} s${r.error ? `  error ${r.error}` : ''}`,
    );
  }
});

/** examples/subbot.html's handle for the end to end runs. */
interface Driver {
  __subbot: {
    mount: (player: string, src: string) => Promise<unknown>;
    select: (at: number) => Promise<unknown>;
    video: () => HTMLVideoElement;
    report: () => {
      state: string;
      marks: Record<string, number>;
      firstCueMs: number | null;
      error: string | null;
    };
  };
}

async function play(t: Title): Promise<void> {
  await page.evaluate(
    (src) => (window as never as Driver).__subbot.mount('native', src),
    `/archive/${t.path}`,
  );
  await page.evaluate((at) => (window as never as Driver).__subbot.select(at), t.start);
}

// The models into this profile's cache before anything is timed, as for a returning viewer.
test('warm up', async () => {
  await play(TITLES[0] as Title);
  await page.waitForFunction(
    () => /live|complete|error/.test((window as never as Driver).__subbot.report().state),
    undefined,
    { timeout: 180_000 },
  );
});

for (const t of TITLES) {
  if (ONLY && !ONLY.some((o) => t.name.toLowerCase().includes(o.toLowerCase()))) continue;
  test(t.name, async () => {
    const refText = await fetch(`https://api.thesubtitledb.org/get/${t.ref}`).then((r) => r.text());
    await play(t);
    const end = t.start + SECONDS;
    // Watched in real time; a stall or an error ends the title early.
    await page
      .waitForFunction(
        (e) => {
          const s = (window as never as Driver).__subbot;
          return s.video().currentTime >= e || Boolean(s.report().error);
        },
        end,
        { timeout: (SECONDS + 120) * 1000, polling: 500 },
      )
      .catch(() => {});
    const got = await page.evaluate(() => {
      const s = (window as never as Driver).__subbot;
      const v = s.video();
      v.pause();
      // The transcription is the track showing; the corpus files the hint offered are disabled.
      const cues: Cue[] = [];
      for (const tr of v.textTracks) {
        if (tr.mode !== 'showing') continue;
        for (const c of tr.cues ?? []) {
          cues.push({ start: c.startTime, end: c.endTime, text: (c as VTTCue).text });
        }
      }
      const r = s.report();
      return {
        cues,
        playhead: v.currentTime,
        live: r.marks.live ?? null,
        firstCueMs: r.firstCueMs,
        error: r.error,
      };
    });
    const inWindow = (c: Cue) => c.start >= t.start && c.start < Math.min(end, got.playhead);
    const ref = parseSrt(refText).filter(inWindow);
    const hyp = got.cues.filter(inWindow).sort((a, b) => a.start - b.start);
    const last = got.cues.reduce((m, c) => Math.max(m, c.end), 0);
    rows.push({
      title: t.name,
      liveMs: got.live,
      firstCueMs: got.firstCueMs,
      wer: ref.length
        ? wer(words(ref.map((c) => c.text).join(' ')), words(hyp.map((c) => c.text).join(' ')))
        : null,
      cues: hyp.length,
      loops: hyp.filter((c) => loop(c.text)).length,
      aheadS: last ? Math.round(last - got.playhead) : null,
      error: got.error,
    });
    if (process.env.BENCH_DEBUG)
      for (const c of hyp) console.log(`  ${c.start.toFixed(1)} ${c.text}`);
  });
}
