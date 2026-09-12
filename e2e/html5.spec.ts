import { expect, test } from '@playwright/test';

/**
 * Drives examples/html5.html in a real browser against the real API.
 *
 * The point of this page is the conversion path, and the only honest place to test it
 * is a real browser: a converted subtitle is correct when the browser's own WebVTT
 * parser accepts it and produces cues. A unit test can compare strings; it cannot
 * tell you the browser agreed.
 */

const API = 'api.thesubtitledb.org';

async function resolved(page: import('@playwright/test').Page) {
  await expect(page.locator('body')).toHaveAttribute('data-resolved', 'true', {
    timeout: 30_000,
  });
}

test.describe('plain video element example', () => {
  test('resolves on load and offers srt tracks a track element could not take raw', async ({
    page,
  }) => {
    await page.goto('/html5.html');
    await resolved(page);

    await expect(page.locator('#status')).toContainText('tt0133093');
    const items = page.locator('#candidates li');
    expect(await items.count()).toBeGreaterThan(0);
    // WebVTT is 0.036% of the corpus, so if anything is offered here at all it is
    // because the converter widened what this player can reach.
    await expect(items.first()).toContainText('SRT');
  });

  test('adds track elements with no src, so nothing downloads before a choice', async ({
    page,
  }) => {
    const calls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes(API)) calls.push(new URL(r.url()).pathname);
    });

    await page.goto('/html5.html');
    await resolved(page);
    await page.waitForTimeout(1500);

    const tracks = await page.evaluate(() => {
      const v = document.getElementById('player') as HTMLVideoElement;
      return [...v.querySelectorAll('track')].map((t) => ({
        src: t.getAttribute('src'),
        label: t.label,
      }));
    });

    expect(tracks.length).toBeGreaterThan(0);
    expect(tracks.every((t) => !t.src)).toBe(true);
    expect(calls.filter((p) => p.startsWith('/get/'))).toHaveLength(0);
    expect(calls.filter((p) => p.startsWith('/v1/'))).toHaveLength(3);
  });

  test('selecting a track converts srt to WebVTT the browser actually parses', async ({ page }) => {
    await page.goto('/html5.html');
    await resolved(page);

    await page.evaluate(async () => {
      const w = window as unknown as { __pickFirst?: () => Promise<void> };
      if (w.__pickFirst) await w.__pickFirst();
    });
    await expect(page.locator('body')).toHaveAttribute('data-selected', /\d+/, { timeout: 30_000 });

    // The API served srt; the page is showing vtt.
    await expect(page.locator('body')).toHaveAttribute('data-converted-from', 'srt');
    const preview = await page.locator('#preview').textContent();
    expect(preview).toContain('WEBVTT');
    expect(preview).toMatch(/\d{2}:\d{2}:\d{2}\.\d{3} --> /);
    expect(preview).not.toMatch(/\d{2}:\d{2}:\d{2},\d{3}/);

    // The real assertion: the browser's WebVTT parser accepted it and built cues.
    const cues = await page.evaluate(async () => {
      const v = document.getElementById('player') as HTMLVideoElement;
      const showing = [...v.textTracks].find((t) => t.mode === 'showing');
      if (!showing) return -1;
      for (let i = 0; i < 60 && (showing.cues?.length ?? 0) === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return showing.cues?.length ?? 0;
    });
    expect(cues).toBeGreaterThan(0);
  });

  test('a TV episode resolves by its episode-level imdb id', async ({ page }) => {
    await page.goto('/html5.html');
    await resolved(page);

    await page.locator('[data-pick="episode"]').click();
    await expect(page.locator('#status')).toContainText('tt1480055', { timeout: 30_000 });
    expect(await page.locator('#candidates li').count()).toBeGreaterThan(0);
  });

  test('reports no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });

    await page.goto('/html5.html');
    await resolved(page);

    const real = errors.filter(
      (e) => !/sample\.mp4|media error|MEDIA_ELEMENT|Failed to load resource/i.test(e),
    );
    expect(real).toEqual([]);
  });
});
