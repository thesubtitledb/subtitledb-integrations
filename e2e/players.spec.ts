import { expect, type Page, test } from '@playwright/test';
import {
  type Commercial,
  ELEMENT_TRACK_PLAYERS,
  EXPECT_COMMERCIAL,
  EXPECTED_BINDING,
  PLAYERS,
} from './players.js';

/**
 * Drives examples/players.html against a real build of every player library, one
 * page load per player, and asserts the same contract for all of them.
 *
 * This is the file that decides whether the bindings work. The unit suite drives
 * hand-written fakes, which prove the binding calls what it says it calls and
 * nothing more; only a real build can tell you the method still exists under that
 * name, that the player accepts a blob URL, and that a subtitle converted in the
 * browser produces cues rather than an empty track. Shaka 5 dropping
 * setTextTrackVisibility, Clappr giving a plain object a tagName of "video", and
 * Plyr throwing when handed a track it has not seen an addtrack event for were all
 * found here and none of them were visible to a fake.
 */

const API = 'api.thesubtitledb.org';

/**
 * Players whose binding declares it renders SubRip, so the file is handed over
 * exactly as the API served it.
 *
 * This is the one place `convert` is visible from outside the package, and it is a
 * property of the player rather than of the option: ArtPlayer parses srt and ass
 * itself, so rewriting either would be work that can only lose information.
 * Everything else here declares WebVTT and nothing else, and gets the conversion.
 */
const RENDERS_SRT = new Set<string>(['artplayer']);

async function open(page: Page, player: string): Promise<void> {
  // domcontentloaded, not load: a player that keeps a connection open for its media
  // would otherwise hold the load event and time out the navigation.
  await page.goto(`/players.html?player=${player}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-mounted', 'true', { timeout: 30_000 });
  await expect(page.locator('body')).toHaveAttribute('data-resolved', 'true', { timeout: 30_000 });
}

test.describe('every player, one attach call', () => {
  test('the page offers exactly the players this spec covers', async ({ page }) => {
    await open(page, 'native');
    // The free list is the contract this block asserts; the commercial four are
    // covered separately because a licence changes what can be checked.
    expect(await page.evaluate(() => window.__free)).toEqual([...PLAYERS]);
  });

  for (const player of PLAYERS) {
    test.describe(player, () => {
      test('is detected, resolves eagerly, and downloads nothing until asked', async ({ page }) => {
        const calls: string[] = [];
        page.on('request', (r) => {
          if (r.url().includes(API)) calls.push(new URL(r.url()).pathname);
        });

        await open(page, player);

        // Detected from the object's shape. The page never passes player: '...'.
        await expect(page.locator('#status')).toContainText(`(${EXPECTED_BINDING[player]})`);
        await expect(page.locator('#status')).toContainText('tt0133093');
        expect(await page.locator('#candidates li').count()).toBeGreaterThan(0);

        // Eager: this happened with no click. Lazy: one search fan-out, one request
        // per configured language, and not a single subtitle byte.
        await page.waitForTimeout(1000);
        expect(calls.filter((p) => p.startsWith('/v1/'))).toHaveLength(3);
        expect(calls.filter((p) => p.startsWith('/get/'))).toHaveLength(0);
      });

      test('selecting one publishes a track the browser parses into cues', async ({ page }) => {
        await open(page, player);
        await page.evaluate(() => window.__pickFirst());
        await expect(page.locator('body')).toHaveAttribute('data-selected', /\d+/, {
          timeout: 30_000,
        });

        const preview = await page.locator('#preview').textContent();
        if (RENDERS_SRT.has(player)) {
          // Untouched: still SubRip, comma decimal separator and all.
          await expect(page.locator('body')).toHaveAttribute('data-converted-from', '');
          expect(preview).toMatch(/\d{2}:\d{2}:\d{2},\d{3}/);
        } else {
          // The API served SubRip and the player is holding WebVTT, converted here.
          await expect(page.locator('body')).toHaveAttribute('data-converted-from', 'srt');
          expect(preview).toContain('WEBVTT');
          expect(preview).not.toMatch(/\d{2}:\d{2}:\d{2},\d{3}/);
        }

        const state = await page.evaluate(async () => {
          for (let i = 0; i < 60; i++) {
            const s = window.__state();
            if (s.count > 0 && (s.cues ?? 0) > 0) return s;
            await new Promise((r) => setTimeout(r, 200));
          }
          return window.__state();
        });
        expect(state.error).toBeUndefined();
        expect(state.count).toBeGreaterThan(0);
        // The real assertion, and the reason this file exists: a parser that is not
        // ours accepted the bytes and built cues out of them.
        expect(state.cues).toBeGreaterThan(0);
      });

      test('reports no console errors', async ({ page }) => {
        const errors: string[] = [];
        page.on('console', (m) => {
          if (m.type() === 'error') errors.push(m.text());
        });
        page.on('pageerror', (e) => errors.push(e.message));

        await open(page, player);
        await page.evaluate(() => window.__pickFirst());
        await expect(page.locator('body')).toHaveAttribute('data-selected', /\d+/, {
          timeout: 30_000,
        });

        // Media decode noise from the generated placeholder clip is not a finding.
        const real = errors.filter(
          (e) => !/sample\.webm|media error|MEDIA_ELEMENT|Failed to load resource/i.test(e),
        );
        expect(real).toEqual([]);
      });
    });
  }
});

/**
 * The commercial players, split by what a licence actually gates.
 *
 * Three of the four load and construct without a key, and that is enough to check the
 * half of the contract that broke on Shaka and Clappr: the binding is detected from
 * the shape of the real object rather than a fake shaped from the documentation, and
 * resolve still costs one request per language and no subtitle bytes. Publishing a
 * track needs a source, and a source is exactly what a key unlocks, so that half is
 * asserted only when this machine has one.
 *
 * These tests never fail for the absence of a key. They report what mode they ran in.
 */
test.describe('commercial players', () => {
  for (const player of Object.keys(EXPECT_COMMERCIAL)) {
    test(`${player}: detected from the real library, and eager either way`, async ({ page }) => {
      const calls: string[] = [];
      page.on('request', (r) => {
        if (r.url().includes(API)) calls.push(new URL(r.url()).pathname);
      });

      await page.goto(`/players.html?player=${player}`, { waitUntil: 'domcontentloaded' });
      const state = await page.evaluate(
        () => (window as unknown as { __commercial: Commercial[] }).__commercial,
      );
      const mine = state.find((c) => c.name === player);
      test.skip(!mine?.loadable, `${player} has no library without a licence`);

      await expect(page.locator('body')).toHaveAttribute('data-mounted', 'true', {
        timeout: 30_000,
      });
      await expect(page.locator('body')).toHaveAttribute('data-resolved', 'true', {
        timeout: 30_000,
      });

      await expect(page.locator('#status')).toContainText(`(${EXPECT_COMMERCIAL[player]})`);
      expect(await page.locator('#candidates li').count()).toBeGreaterThan(0);
      await page.waitForTimeout(1000);
      expect(calls.filter((x) => x.startsWith('/v1/'))).toHaveLength(3);
      expect(calls.filter((x) => x.startsWith('/get/'))).toHaveLength(0);
    });

    test(`${player}: publishes a track when a licence lets a source load`, async ({ page }) => {
      await page.goto(`/players.html?player=${player}`, { waitUntil: 'domcontentloaded' });
      const state = await page.evaluate(
        () => (window as unknown as { __commercial: Commercial[] }).__commercial,
      );
      const mine = state.find((c) => c.name === player);
      test.skip(!mine?.loadable, `${player} has no library without a licence`);

      await expect(page.locator('body')).toHaveAttribute('data-mounted', 'true', {
        timeout: 30_000,
      });
      await expect(page.locator('body')).toHaveAttribute('data-resolved', 'true', {
        timeout: 30_000,
      });
      await page.evaluate(() => window.__pickFirst());
      await expect(page.locator('body')).toHaveAttribute('data-selected', /\d+/, {
        timeout: 30_000,
      });
      await expect(page.locator('body')).toHaveAttribute('data-converted-from', 'srt');

      const result = await page.evaluate(async () => {
        for (let i = 0; i < 40; i++) {
          const s = window.__state();
          if (s.count > 0) return s;
          await new Promise((r) => setTimeout(r, 200));
        }
        return window.__state();
      });
      expect(result.error).toBeUndefined();

      // Bitmovin and Flowplayer take the track with no licence at all: Bitmovin's
      // subtitles API is not gated, and Flowplayer renders through native tracks.
      // THEOplayer refuses every source, so it can only get this far with a key.
      if (mine?.licensed || player === 'bitmovin' || player === 'flowplayer') {
        expect(result.count).toBeGreaterThan(0);
      } else {
        // A green test that asserted nothing reads as coverage. THEOplayer took the
        // call and then refuses the source, so the publish is genuinely unverifiable
        // here: report it as a skip, the way JW Player already is.
        test.skip(true, `${player} needs a licence before a source will load`);
      }
    });
  }
});

/**
 * The rest of this file stops at "the browser parsed cues out of it", which is true
 * of a track the player has already hidden. ELEMENT_TRACK_PLAYERS is the list that
 * has to answer for the picture as well as the parse; see e2e/players.ts for why each
 * player is or is not on it.
 */
test.describe('the caption is still on once playback starts', () => {
  for (const player of ELEMENT_TRACK_PLAYERS) {
    test(player, async ({ page }) => {
      await open(page, player);
      await page.evaluate(() => window.__pickFirst());
      await expect(page.locator('body')).toHaveAttribute('data-selected', /\d+/, {
        timeout: 30_000,
      });

      // Start it. MediaElement.js leaves the element on preload none, so until
      // something asks for the media there is no duration to seek within.
      await page.evaluate(async () => {
        const video = window.__video();
        if (!video) throw new Error('no media element');
        video.muted = true;
        try {
          await video.play();
        } catch {
          // A browser that refuses autoplay still loads and fires the events a
          // player hangs its caption handling on, which is what this watches for.
        }
        for (let i = 0; i < 100 && video.readyState < 1; i++) {
          await new Promise((r) => setTimeout(r, 100));
        }
      });

      // Seek to the first cue and play through it. The clip is generated long enough
      // for a real subtitle's first cue to land inside it; if the corpus moves that
      // cue past the end this fails here rather than passing on an empty screen.
      const cue = await page.evaluate(async () => {
        const video = window.__video();
        if (!video) throw new Error('no media element');
        for (let i = 0; i < 60; i++) {
          const track = [...video.textTracks].find((t) => t.mode === 'showing');
          const first = track?.cues?.[0] as VTTCue | undefined;
          if (first) return { start: first.startTime, duration: video.duration };
          await new Promise((r) => setTimeout(r, 200));
        }
        return { start: -1, duration: video.duration };
      });
      expect(cue.start).toBeGreaterThanOrEqual(0);
      expect(cue.start + 0.5).toBeLessThan(cue.duration);

      await page.evaluate((start: number) => {
        const video = window.__video();
        if (video) video.currentTime = start + 0.25;
      }, cue.start);
      await page.waitForTimeout(1500);

      const live = await page.evaluate(() => {
        const video = window.__video();
        const showing = video ? [...video.textTracks].filter((t) => t.mode === 'showing') : [];
        return {
          showing: showing.length,
          active: showing[0]?.activeCues?.length ?? 0,
          time: video?.currentTime ?? 0,
        };
      });
      // One track on, and a cue on screen at the time the viewer is watching. Cues
      // parsed off a track the player has since hidden satisfy neither.
      expect(live.time).toBeGreaterThan(cue.start);
      expect(live.showing).toBe(1);
      expect(live.active).toBeGreaterThan(0);
    });
  }
});

test('ArtPlayer paints the cue itself, off a track it keeps hidden', async ({ page }) => {
  // Every assertion above stops one step short of the screen for this one player.
  // ArtPlayer leaves its own <track> at mode "hidden" and draws the text into a div,
  // so "the browser parsed cues" proves the parse and not the picture, and the
  // showing-track block cannot cover it: there is no showing track to look at.
  //
  // It is also the only player here handed SubRip rather than WebVTT, so this is
  // where that decision is checked against a real parser instead of a declaration.
  await open(page, 'artplayer');
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
    for (let i = 0; i < 60; i++) {
      const track = [...video.textTracks].find((t) => (t.cues?.length ?? 0) > 0);
      const first = track?.cues?.[0] as VTTCue | undefined;
      if (first) return { start: first.startTime, duration: video.duration };
      await new Promise((r) => setTimeout(r, 200));
    }
    return { start: -1, duration: video.duration };
  });
  expect(cue.start).toBeGreaterThanOrEqual(0);
  expect(cue.start + 0.5).toBeLessThan(cue.duration);

  await page.evaluate((start: number) => {
    const video = window.__video();
    if (video) video.currentTime = start + 0.25;
  }, cue.start);

  // .art-subtitle-line is ArtPlayer's own class, written by its own renderer from
  // its own cuechange handler. Nothing in this repo can produce it.
  const line = page.locator('.art-subtitle-line').first();
  await expect(line).toBeVisible({ timeout: 10_000 });
  expect((await line.textContent())?.trim()).not.toBe('');
});

test('openplayerjs suppresses native cue rendering, and says so in its own stylesheet', async ({
  page,
}) => {
  // The one player where a showing track with active cues is still an empty screen.
  // OpenPlayerJS hides the browser's cue container and draws captions itself from a
  // list it snapshots when it is constructed, so a track added afterwards is never
  // in it. No adapter can undo that from the outside; docs/players.md gives the host
  // page the one line that does. Pinned here so the day OpenPlayerJS drops the rule,
  // this fails and the documented limitation goes with it.
  await open(page, 'openplayerjs');

  const hiding = await page.evaluate(() =>
    [...document.styleSheets]
      .flatMap((sheet) => {
        try {
          return [...sheet.cssRules];
        } catch {
          return [];
        }
      })
      .map((rule) => rule.cssText)
      .filter(
        (text) => text.includes('media-text-track-container') && /display:\s*none/.test(text),
      ),
  );
  expect(hiding.length).toBeGreaterThan(0);
});

/**
 * Refusing, in a real browser, where the DOM the markers read is a real DOM.
 *
 * The unit suite drives hand-built nodes with a `classList` shim. Only this can say
 * that `closest`, a shadow boundary and a real Video.js registry behave the way the
 * marker table assumes, and only this can prove the negative that matters most: a
 * page that works today must keep working.
 */
test.describe('players we can see and cannot reach', () => {
  test('videojs: a container with no reachable instance is refused by name', async ({ page }) => {
    await open(page, 'videojs');

    const result = await page.evaluate(async () => {
      const mod = await import('/vendor/players-adapter/index.js');
      // A second, detached Video.js shell rather than the live one: the real player
      // writes itself onto its own container, so mutating that would be testing our
      // own sabotage. This is the page a component that keeps its player private
      // leaves behind, built out of the same two class names Video.js writes.
      const box = document.createElement('div');
      box.className = 'video-js';
      const video = document.createElement('video');
      video.className = 'vjs-tech';
      box.append(video);
      document.body.append(box);
      try {
        mod.attachSubtitleDb(box, {});
        return { threw: false };
      } catch (err) {
        const e = err as { name?: string; player?: string; message?: string };
        return { threw: true, name: e.name, player: e.player, message: e.message };
      } finally {
        box.remove();
      }
    });

    expect(result.threw).toBe(true);
    expect(result.name).toBe('PlayerNotReachableError');
    expect(result.player).toBe('videojs');
    expect(result.message).toContain('videojs.getPlayer');
  });

  test('hlsjs: a bare element is not refused, which is the whole point', async ({ page }) => {
    await open(page, 'hlsjs');

    const result = await page.evaluate(async () => {
      const mod = await import('/vendor/players-adapter/index.js');
      const video = document.createElement('video');
      document.body.append(video);
      try {
        const handle = mod.attachSubtitleDb(video, {});
        const name = handle.player.name;
        handle.destroy();
        return { threw: false, name };
      } catch (err) {
        return { threw: true, name: (err as { name?: string }).name };
      } finally {
        video.remove();
      }
    });

    // hls.js, dash.js, jPlayer, Griffith, Kaltura, Jellyfin and Video-React all land
    // here. A blanket refusal would have broken every one of them.
    expect(result.threw).toBe(false);
    expect(result.name).toBe('native');
  });

  test('plyr: a container with no instance is reported, not refused', async ({ page }) => {
    await open(page, 'plyr');

    const result = await page.evaluate(async () => {
      const mod = await import('/vendor/players-adapter/index.js');
      const box = document.createElement('div');
      box.className = 'plyr';
      const video = document.createElement('video');
      box.append(video);
      document.body.append(box);
      const seen: unknown[] = [];
      try {
        const handle = mod.attachSubtitleDb(box, { onDegraded: (d: unknown) => seen.push(d) });
        const out = { threw: false, degraded: handle.degraded, seen: seen.length };
        handle.destroy();
        return out;
      } catch (err) {
        return { threw: true, name: (err as { name?: string }).name };
      } finally {
        box.remove();
      }
    });

    // Plyr's subtitles are real DOM children, so the track renders and only Plyr's
    // own captions menu goes missing. Throwing would break a page that works.
    expect(result.threw).toBe(false);
    expect(result.degraded).toEqual({ player: 'plyr', reason: 'menu' });
    expect(result.seen).toBe(1);
  });
});
