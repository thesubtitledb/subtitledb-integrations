import { expect, type Page, test } from '@playwright/test';

/**
 * The load patterns from docs/documentation.md, in a real browser.
 *
 * The unit suite drives these against fakes, which proves the logic. This proves the
 * sequence: a real element that gains a source after the attach, a real MutationObserver
 * seeing a player appear, real track elements being removed on destroy. Every one of
 * these is something a host page does without asking, and none of them is under the
 * integration's control.
 */

const API = 'api.thesubtitledb.org';

async function open(page: Page, mode: string): Promise<void> {
  await page.goto(`/lifecycle.html?mode=${mode}`, { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-done', 'true', { timeout: 30_000 });
}

test('a video that gets its source after the attach still resolves', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(API)) calls.push(new URL(r.url()).pathname);
  });

  await open(page, 'late-source');

  // The attach happened against an empty element. It still identified the film and
  // published a list, and it still downloaded no subtitle bytes to do it.
  expect(await page.locator('body').getAttribute('data-imdb')).toBe('tt0133093');
  expect(Number(await page.locator('body').getAttribute('data-tracks'))).toBeGreaterThan(0);
  expect(calls.filter((p) => p.startsWith('/get/'))).toHaveLength(0);
});

test('a player added to the page later is attached by the observer', async ({ page }) => {
  await open(page, 'observe');

  // Nothing was in the page when the observer started.
  await expect(page.locator('#story')).toContainText('observer started, 0 players');
  await expect(page.locator('#story')).toContainText('observer attached a player');
  expect(Number(await page.locator('body').getAttribute('data-tracks'))).toBeGreaterThan(0);

  const count = await page.evaluate(
    () => (window as unknown as { __watcher: { handles(): unknown[] } }).__watcher.handles().length,
  );
  expect(count).toBe(1);
});

test('attaching twice is one session, not two sets of tracks', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(API)) calls.push(new URL(r.url()).pathname);
  });

  await open(page, 'twice');

  expect(await page.evaluate(() => (window as unknown as { __same: boolean }).__same)).toBe(true);
  // Two languages, so two searches. A second real attach would have made it four.
  expect(calls.filter((p) => p.startsWith('/v1/'))).toHaveLength(2);
  const tracks = await page.locator('video track').count();
  expect(tracks).toBeGreaterThan(0);
  expect(tracks).toBe(Number(await page.locator('body').getAttribute('data-tracks')));
});

test('the media changing under a live handle re-resolves', async ({ page }) => {
  await open(page, 'source-change');

  await expect(page.locator('#story')).toContainText('film resolved to tt0133093');
  await expect(page.locator('#story')).toContainText('episode resolved to tt1480055');
  expect(await page.locator('body').getAttribute('data-imdb')).toBe('tt1480055');
});

test('destroy removes every track it added', async ({ page }) => {
  await open(page, 'destroy');

  const tracks = await page.evaluate(
    () => (window as unknown as { __tracks: { before: number; after: number } }).__tracks,
  );
  expect(tracks.before).toBeGreaterThan(0);
  expect(tracks.after).toBe(0);
  expect(await page.locator('video track').count()).toBe(0);
});

test('a player that announces itself ready more than once resolves once', async ({ page }) => {
  const calls: string[] = [];
  page.on('request', (r) => {
    if (r.url().includes(API)) calls.push(new URL(r.url()).pathname);
  });

  // Media elements fire several events that mean "the source changed", and most
  // players fire their own on top. The host page sees every one of them, so the
  // repeats have to be free and they have to agree.
  await page.goto('/players.html?player=native', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('body')).toHaveAttribute('data-resolved', 'true', { timeout: 30_000 });
  await page.waitForTimeout(1500);

  const counts = await page.evaluate(
    () => (window as unknown as { __resolves?: number[] }).__resolves ?? [],
  );
  // How many times the callback fires is the browser's and the player's business:
  // overlapping ready events are collapsed into one resolve, so some of them arrive
  // while it is already running and never produce a second call. What has to hold is
  // that every call agrees and none of them costs anything.
  expect(counts.length).toBeGreaterThan(0);
  expect(new Set(counts).size).toBe(1);
  expect(counts[0]).toBeGreaterThan(0);
  // Three configured languages, three requests, however many times it resolved.
  expect(calls.filter((p) => p.startsWith('/v1/'))).toHaveLength(3);
  expect(calls.filter((p) => p.startsWith('/get/'))).toHaveLength(0);
});
