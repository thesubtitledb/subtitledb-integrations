import { expect, test } from '@playwright/test';

/**
 * Drives examples/artplayer.html in a real browser against the real API.
 *
 * The assertions that matter are the ones the unit tests structurally cannot make:
 * that subtitles are requested without any user interaction, that the cross-origin
 * fetch and the /get/ redirect actually work from a page, and that real subtitle text
 * reaches the player.
 */

const API = 'api.thesubtitledb.org';

test.describe('ArtPlayer example', () => {
  test('resolves subtitles on load with no interaction', async ({ page }) => {
    const apiCalls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes(API)) apiCalls.push(r.url());
    });

    await page.goto('/artplayer.html');
    await expect(page.locator('body')).toHaveAttribute('data-resolved', 'true', {
      timeout: 30_000,
    });

    // Nobody clicked anything. This is the eager-loading contract.
    expect(apiCalls.length).toBeGreaterThan(0);
    await expect(page.locator('#state')).toHaveText('resolved');
  });

  test('identifies The Matrix and lists real candidates', async ({ page }) => {
    await page.goto('/artplayer.html');
    await expect(page.locator('body')).toHaveAttribute('data-resolved', 'true', {
      timeout: 30_000,
    });

    const status = page.locator('#status');
    await expect(status).toContainText('tt0133093');
    await expect(status).toContainText('The Matrix');
    await expect(status).toContainText('explicit-imdb');

    const items = page.locator('#candidates li');
    expect(await items.count()).toBeGreaterThan(0);
    await expect(items.first()).toContainText('English');
  });

  test('an eager attach costs one search request per configured language', async ({ page }) => {
    // The budget that makes eager loading affordable: search only, no subtitle bytes.
    // The API filters on a single language code per request and silently ignores a
    // comma separated list, so three configured languages is three small cacheable
    // requests. The number that must stay at zero is the download count.
    const calls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes(API)) calls.push(new URL(r.url()).pathname);
    });

    await page.goto('/artplayer.html');
    await expect(page.locator('body')).toHaveAttribute('data-resolved', 'true', {
      timeout: 30_000,
    });
    await page.waitForTimeout(1500);

    const json = calls.filter((p) => p.startsWith('/v1/'));
    const downloads = calls.filter((p) => p.startsWith('/get/'));
    expect(json).toHaveLength(3);
    expect(downloads).toHaveLength(0);
  });

  test('resolves a TV episode by its episode-level imdb id', async ({ page }) => {
    await page.goto('/artplayer.html');
    await expect(page.locator('body')).toHaveAttribute('data-resolved', 'true', {
      timeout: 30_000,
    });

    await page.locator('[data-pick="episode"]').click();
    await expect(page.locator('#status')).toContainText('tt1480055', { timeout: 30_000 });
    await expect(page.locator('#status')).toContainText('Game of Thrones');
    expect(await page.locator('#candidates li').count()).toBeGreaterThan(0);
  });

  test('identifies a film from a release filename alone', async ({ page }) => {
    await page.goto('/artplayer.html');
    await expect(page.locator('body')).toHaveAttribute('data-resolved', 'true', {
      timeout: 30_000,
    });

    await page.locator('[data-pick="filename"]').click();
    // No id anywhere: title and year are parsed out of the filename, searched, and
    // resolved back to an imdb id. The tier is `title`. This asked for `title-year`,
    // a tier MatchTier has never had, and the year is carried in the hint instead.
    // The first cell is the tier, so match it whole: `title` is also a row label.
    await expect(page.locator('#status dd').first()).toHaveText('title', { timeout: 30_000 });
    await expect(page.locator('#status')).toContainText('"source":"filename"');
    await expect(page.locator('#status')).toContainText('"year":1999');
    await expect(page.locator('#status')).toContainText('tt0133093');
  });

  test('selecting a language downloads real subtitle text through the redirect', async ({
    page,
  }) => {
    await page.goto('/artplayer.html');
    await expect(page.locator('body')).toHaveAttribute('data-resolved', 'true', {
      timeout: 30_000,
    });

    // Drive the adapter the way the player menu does, through its own settings entry.
    await page.evaluate(async () => {
      const w = window as unknown as { __pickFirst?: () => Promise<void> };
      if (w.__pickFirst) await w.__pickFirst();
    });

    await expect(page.locator('body')).toHaveAttribute('data-selected', /\d+/, {
      timeout: 30_000,
    });

    const preview = await page.locator('#preview').textContent();
    expect(preview).toBeTruthy();
    // Served exactly as stored. SRT cue timings use a comma, WebVTT uses a dot.
    expect(preview).toMatch(/\d{2}:\d{2}:\d{2},\d{3}/);
    expect(preview?.startsWith('WEBVTT')).toBe(false);
  });

  test('reports no console errors while doing all of that', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/artplayer.html');
    await expect(page.locator('body')).toHaveAttribute('data-resolved', 'true', {
      timeout: 30_000,
    });

    // The placeholder video is expected to 404; anything else is a real problem.
    const real = errors.filter(
      (e) => !/sample\.mp4|media error|MEDIA_ELEMENT|Failed to load resource/i.test(e),
    );
    expect(real).toEqual([]);
  });
});
