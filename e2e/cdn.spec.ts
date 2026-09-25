import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import { ELEMENT_TRACK_PLAYERS, EXPECT_COMMERCIAL, EXPECTED_BINDING, PLAYERS } from './players.js';

/**
 * The CDN distribution, from a page on a different origin.
 *
 * Two claims are under test and only one of them is about subtitles. The first is the
 * ordinary one: paste a script tag, get a caption on screen. The second is the reason
 * the package is built the way it is, and it can only be checked by looking at what
 * the browser did *not* ask for. A bare <video> must never pull the sixteen
 * bindings; a page that hands over a player must. Nothing on screen differs between a
 * working split and a broken one, so an assertion about a request that did not happen
 * is the only thing standing between this and quietly shipping both chunks to
 * everybody.
 */

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const CDN = `http://localhost:${process.env.CDN_PORT ?? 4174}`;

/**
 * The hashed chunk names, read from the tree the webServer just built. Hard-coding
 * them would make this suite pass against a stale build and fail against a good one.
 */
let manifest: { version: string; chunks: { engine: string; players: string } };

test.beforeAll(async () => {
  const { version } = JSON.parse(
    await readFile(join(root, 'packages/loader/package.json'), 'utf8'),
  );
  manifest = JSON.parse(await readFile(join(root, 'cdn/v', version, 'manifest.json'), 'utf8'));
});

/** What the example pages report about the track they ended up with. */
interface Cues {
  showing: number;
  label: string;
  /** Start time of the first cue, or -1 when there is no showing track yet. */
  first: number;
  active: number;
}

/** Every URL the page fetched, in order, so a test can assert on an absence. */
function recordRequests(page: import('@playwright/test').Page): string[] {
  const seen: string[] = [];
  page.on('request', (req) => seen.push(req.url()));
  return seen;
}

/**
 * Waits for the attach to publish a cue, then proves one is on screen at play time.
 *
 * The reading is done by the page, not from here. Video.js emulates text tracks in
 * JavaScript unless told to use the native ones, so its cues never reach
 * `video.textTracks` and a spec that queried the element directly would report a
 * working attach as a silent failure. Each page knows which list its player writes
 * to; this only knows what the answer has to look like.
 */
async function expectCaptionOnScreen(page: import('@playwright/test').Page): Promise<void> {
  const cue = await page.evaluate(async () => {
    const w = window as never as { __video: () => HTMLVideoElement; __cues: () => Cues };
    const video = w.__video();
    video.muted = true;
    try {
      await video.play();
    } catch {
      // Autoplay refused. The element still loads, which is all this needs.
    }
    for (let i = 0; i < 200; i++) {
      const state = w.__cues();
      if (state.first >= 0 && video.readyState >= 1) return state;
      await new Promise((r) => setTimeout(r, 200));
    }
    return w.__cues();
  });

  expect(cue.first, 'no showing track ever appeared').toBeGreaterThanOrEqual(0);
  // languages: ['en'] is what asked for this. Without it the API answers
  // alphabetically and the track on screen is Arabic.
  expect(cue.label).toContain('English');

  await page.evaluate((start: number) => {
    (window as never as { __seek: (t: number) => void }).__seek(start + 0.25);
  }, cue.first);
  await page.waitForTimeout(1500);

  const live = await page.evaluate(() => (window as never as { __cues: () => Cues }).__cues());

  // "A track was published" and "a subtitle is on screen" are different claims and
  // only the second one is the product.
  expect(live.showing).toBe(1);
  expect(live.active).toBeGreaterThan(0);
}

test('a classic script tag on a bare video, and no bindings anywhere', async ({ page }) => {
  const requests = recordRequests(page);
  await page.goto(`/cdn.html?cdn=${encodeURIComponent(CDN)}`);

  await expectCaptionOnScreen(page);

  expect(requests.some((u) => u === `${CDN}/latest/subtitle-finder.js`)).toBe(true);
  expect(requests.some((u) => u.endsWith(manifest.chunks.engine))).toBe(true);
  // The saving. If this ever goes true the split has stopped working and every page
  // using a plain <video> is paying for a resolver it will never call.
  expect(
    requests.filter((u) => u.endsWith(manifest.chunks.players)),
    'the bindings chunk was fetched for a bare video element',
  ).toEqual([]);
});

test('a module handed a player fetches the bindings it actually needs', async ({ page }) => {
  const requests = recordRequests(page);
  await page.goto(`/cdn-esm.html?cdn=${encodeURIComponent(CDN)}`);

  await expect
    .poll(() => page.evaluate(() => Boolean((window as never as { __handle?: unknown }).__handle)))
    .toBe(true);
  await page.evaluate(() =>
    (window as never as { __handle: { ready: Promise<unknown> } }).__handle.ready.catch(() => {}),
  );

  expect(requests.some((u) => u === `${CDN}/latest/subtitle-finder.esm.js`)).toBe(true);
  expect(requests.some((u) => u.endsWith(manifest.chunks.players))).toBe(true);

  await expectCaptionOnScreen(page);
});

test('the same file included twice leaves one copy running the page', async ({ page }) => {
  await page.goto(`/cdn.html?cdn=${encodeURIComponent(CDN)}`);
  await page.evaluate(
    () => (window as never as { __handle: { ready: Promise<unknown> } }).__handle.ready,
  );
  // `ready` means the chunk landed and attach returned, not that the search came
  // back. The whole list is published as tracks, so counting before the resolve
  // completes counts zero and then blames the second copy for all of them.
  await expect
    .poll(
      () =>
        page.evaluate(
          () => (document.getElementById('player') as HTMLVideoElement).textTracks.length,
        ),
      { timeout: 30_000 },
    )
    .toBeGreaterThan(0);

  const result = await page.evaluate(
    async ([cdn, version]) => {
      const video = document.getElementById('player') as HTMLVideoElement;
      const before = video.textTracks.length;

      // The CMS case: a theme and a plugin both paste the snippet, at different
      // pinned versions. Two copies of the code do not share the WeakMaps that make
      // one player mean one handle, so the second must defer rather than build a
      // second session on the same element.
      let reported = '';
      await new Promise<void>((done, fail) => {
        const el = document.createElement('script');
        el.src = `${cdn}/v/${version}/subtitle-finder.js`;
        el.onload = () => done();
        el.onerror = () => fail(new Error(`could not load ${el.src}`));
        document.head.appendChild(el);
      });

      const second = (
        window as never as {
          SubtitleDB: {
            attach: (t: unknown, o: unknown) => { ready: Promise<unknown> };
          };
        }
      ).SubtitleDB.attach(video, {
        hint: { imdbId: 'tt0133093' },
        languages: ['en'],
        autoSelect: true,
        onError: (err: Error) => {
          reported = err.message;
        },
      });
      await second.ready;
      await new Promise((r) => setTimeout(r, 1000));

      return { before, after: video.textTracks.length, reported };
    },
    [CDN, manifest.version] as const,
  );

  // No second track, no doubled captions menu, no second session polling the API.
  expect(result.after).toBe(result.before);
  // And the page is told, once, through the call that found out.
  expect(result.reported).toMatch(/already running/i);
});

test('the headers a third-party page depends on are actually served', async ({ request }) => {
  // Checking the built _headers file is checking a file. This checks what a browser
  // gets, which is the only thing the CORS and resource-policy checks read.
  const chunk = await request.get(`${CDN}/v/${manifest.version}/${manifest.chunks.engine}`);
  expect(chunk.status()).toBe(200);
  expect(chunk.headers()['access-control-allow-origin']).toBe('*');
  expect(chunk.headers()['cross-origin-resource-policy']).toBe('cross-origin');
  expect(chunk.headers()['cache-control']).toContain('immutable');

  const entry = await request.get(`${CDN}/latest/subtitle-finder.js`);
  expect(entry.status()).toBe(200);
  expect(entry.headers()['access-control-allow-origin']).toBe('*');
  // Not immutable, and not four hours either: this is the file a bad release sits in.
  expect(entry.headers()['cache-control']).toContain('max-age=300');
});

/**
 * Every player this repo supports, through the loader instead of through the packages.
 *
 * players.spec.ts decides whether the bindings work when a page bundles them. This
 * decides whether they work when a page pastes a script tag, which is a different
 * program with the same source: the code arrives from another origin, in two halves,
 * and which half is fetched is decided by a DOM check that runs before either half
 * exists. Get that check wrong for one player and that player alone publishes a
 * native track to something that renders nothing from one, reports success, and looks
 * identical from every other angle. Vidstack did exactly that, and neither the unit
 * suite nor players.spec.ts could have seen it.
 *
 * The page is examples/players.html with `?via=cdn`, so the mounts, the readers and
 * the assertions are the ones players.spec.ts already uses. One line differs, and it
 * is the line under test.
 */

/** Players that render captions through the media element's own text tracks. */
const ON_ELEMENT = new Set<string>(ELEMENT_TRACK_PLAYERS);

/** The players page, attaching through the loader served from the other origin. */
async function openThroughCdn(page: Page, player: string, extra = ''): Promise<void> {
  await page.goto(`/players.html?player=${player}&via=cdn&cdn=${encodeURIComponent(CDN)}${extra}`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.locator('body')).toHaveAttribute('data-mounted', 'true', { timeout: 30_000 });
  // Positive proof of which code attached. A page that quietly fell back to the
  // import-mapped package would otherwise pass every assertion below without the
  // loader having run at all, and this whole block would be theatre.
  await expect(page.locator('body')).toHaveAttribute('data-attached', 'cdn', { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-resolved', 'true', { timeout: 30_000 });
}

/** How many times the browser asked for each half. */
function chunkCounts(requests: string[]): { engine: number; players: number } {
  return {
    engine: requests.filter((u) => u.endsWith(manifest.chunks.engine)).length,
    players: requests.filter((u) => u.endsWith(manifest.chunks.players)).length,
  };
}

/**
 * Select the first candidate, then prove a cue is live at the time being watched.
 *
 * The rule players.spec.ts sets, read through the page's own state reader rather than
 * off the element, so the four players that keep their cues somewhere else are held
 * to it too. Video.js emulates text tracks in JavaScript, Shaka and ArtPlayer leave
 * their track hidden and paint it themselves, and Vidstack keeps its own list; a
 * check that queried video.textTracks would report all four as silent failures and
 * would be wrong about all four.
 */
async function expectCueOnScreen(page: Page, player: string): Promise<void> {
  await page.evaluate(() => window.__pickFirst());
  await expect(page.locator('body')).toHaveAttribute('data-selected', /\d+/, { timeout: 30_000 });

  const cue = await page.evaluate(async () => {
    const video = window.__video();
    if (!video) throw new Error('no media element');
    video.muted = true;
    try {
      await video.play();
    } catch {
      // A browser that refuses autoplay still loads, and a seek still moves the cues.
    }
    for (let i = 0; i < 100; i++) {
      const state = window.__state();
      if ((state.first ?? -1) >= 0) return { ...state, duration: video.duration };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { ...window.__state(), duration: video.duration };
  });

  expect(cue.error).toBeUndefined();
  expect(cue.count).toBeGreaterThan(0);
  // A parser that is not ours accepted the bytes and built cues out of them.
  expect(cue.cues).toBeGreaterThan(0);
  // The clip is generated long enough for a real subtitle's first cue to land inside
  // it. If the corpus ever moves that cue past the end, this fails here rather than
  // passing on an empty screen.
  const first = cue.first ?? -1;
  expect(first).toBeGreaterThanOrEqual(0);
  expect(first + 0.5).toBeLessThan(cue.duration);

  await page.evaluate((start: number) => {
    const video = window.__video();
    if (video) video.currentTime = start + 0.25;
  }, first);
  await page.waitForTimeout(1500);

  const live = await page.evaluate(() => window.__state());
  // "A track was published" and "a subtitle is on screen" are different claims and
  // only the second one is the product.
  expect(live.active ?? 0).toBeGreaterThan(0);
  // And for a player that renders through the element, exactly one track is on. Two
  // is doubled captions; none is a cue list nobody can see.
  if (ON_ELEMENT.has(player)) expect(live.showing).toBe(1);
}

test.describe('every player, through the CDN loader', () => {
  for (const player of PLAYERS) {
    test(player, async ({ page }) => {
      const requests = recordRequests(page);
      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text());
      });
      page.on('pageerror', (e) => errors.push(e.message));

      await openThroughCdn(page, player);

      // Detected from the object's shape, across a chunk boundary. The page never
      // passes player: '...' in either distribution.
      await expect(page.locator('#status')).toContainText(`(${EXPECTED_BINDING[player]})`);
      expect(await page.locator('#candidates li').count()).toBeGreaterThan(0);

      await expectCueOnScreen(page, player);

      const chunks = chunkCounts(requests);
      if (player === 'native') {
        // The one entry on this list that is not a player. It mounts a bare
        // <video class="player"> with nothing on top of it, which is the case the
        // whole split exists for, so demanding the bindings here would be demanding
        // the saving away.
        expect(chunks.engine).toBe(1);
        expect(chunks.players, 'the bindings chunk was fetched for a bare video').toBe(0);
      } else {
        expect(chunks.players, 'the bindings chunk was never fetched').toBe(1);
      }

      // Media decode noise from the generated placeholder clip is not a finding.
      const real = errors.filter(
        (e) => !/sample\.webm|media error|MEDIA_ELEMENT|Failed to load resource/i.test(e),
      );
      expect(real).toEqual([]);
    });
  }
});

/**
 * The commercial four, through the loader, split by what a licence actually gates.
 *
 * Same split as players.spec.ts, and for the same reason. Three of the four load and
 * construct without a key, which is enough for the two claims this file is about: the
 * loader fetched the bindings, and the bindings recognised the real object rather than
 * a fake shaped from the documentation. Publishing a track needs a source and a source
 * is what a key unlocks, so that half stays in players.spec.ts, where it does not
 * change with the distribution.
 *
 * These never fail for the absence of a key.
 */
test.describe('commercial players, through the CDN loader', () => {
  for (const player of Object.keys(EXPECT_COMMERCIAL)) {
    test(player, async ({ page }) => {
      const requests = recordRequests(page);
      await page.goto(`/players.html?player=${player}&via=cdn&cdn=${encodeURIComponent(CDN)}`, {
        waitUntil: 'domcontentloaded',
      });
      const mine = (await page.evaluate(() => window.__commercial)).find((c) => c.name === player);
      test.skip(!mine?.loadable, `${player} has no library without a licence`);

      await expect(page.locator('body')).toHaveAttribute('data-attached', 'cdn', {
        timeout: 30_000,
      });
      await expect(page.locator('body')).toHaveAttribute('data-resolved', 'true', {
        timeout: 30_000,
      });

      await expect(page.locator('#status')).toContainText(`(${EXPECT_COMMERCIAL[player]})`);
      expect(await page.locator('#candidates li').count()).toBeGreaterThan(0);
      expect(chunkCounts(requests).players, 'the bindings chunk was never fetched').toBe(1);
    });
  }
});

/**
 * The element a player mounted, handed over instead of the player.
 *
 * This is where the split is most easily got wrong, because a `<video>` that Video.js
 * has taken over is still a `<video>`. The loader has to tell the two apart before it
 * owns anything that could answer properly, so it asks `looksOwned`, which reads class
 * names off the DOM and nothing else. Under-answer once and the element engine
 * publishes a native text track to a player that renders nothing from one and reports
 * success, and the code that would have caught that is in the chunk that was not
 * fetched.
 *
 * These are the free players owners.ts can recognise from the page, and therefore the
 * ones `looksOwned` must never miss. Shaka is absent and cannot be here: the compiled
 * build marks nothing at all, which owners.ts documents as a limit rather than a gap.
 */
const OWNED_ELEMENT: Record<string, string> = {
  // Reachable from the element they mounted, so the binding is the player's own.
  videojs: 'videojs',
  plyr: 'plyr',
  // Seen and not reachable. Their subtitles are real DOM children, so the element
  // path renders them and only the player's own captions menu goes missing, which the
  // adapter reports as a degraded attach rather than refusing. `native` is the honest
  // answer; taking the engine chunk to get there would not be, because nothing would
  // have been in a position to check.
  dplayer: 'native',
  xgplayer: 'native',
  openplayerjs: 'native',
};

test.describe('handed the element rather than the player', () => {
  for (const [player, binding] of Object.entries(OWNED_ELEMENT)) {
    test(player, async ({ page }) => {
      const requests = recordRequests(page);
      await openThroughCdn(page, player, '&target=element');

      await expect(page.locator('#status')).toContainText(`(${binding})`);
      expect(chunkCounts(requests).players, 'looksOwned missed a mounted player').toBe(1);

      await expectCueOnScreen(page, player);
    });
  }
});
