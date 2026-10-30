import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, test as base, chromium, expect, type Page } from '@playwright/test';

export const ORIGIN = `http://localhost:${process.env.PORT ?? 4180}`;
const DIST = realpathSync(join(import.meta.dirname, '../dist/chrome'));

/**
 * The id Chrome gives an unpacked extension: the first 32 hex digits of the SHA-256
 * of its absolute path, written with the letters a to p.
 */
export const EXTENSION_ID = createHash('sha256')
  .update(DIST)
  .digest('hex')
  .slice(0, 32)
  .replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + Number.parseInt(c, 16)));

interface Fixtures {
  context: BrowserContext;
  /** Opens a page, then the popup pointed at it, as a click on the toolbar button would. */
  open: (url: string) => Promise<{ page: Page; popup: Popup }>;
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright reads the fixture names.
  context: async ({}, use) => {
    const dir = await mkdtemp(join(tmpdir(), 'tsdb-ext-'));
    // The full Chromium build: the headless shell cannot load extensions.
    const context = await chromium.launchPersistentContext(dir, {
      channel: 'chromium',
      headless: !process.env.HEADED,
      viewport: { width: 1000, height: 700 },
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    });
    await use(context);
    await context.close();
    await rm(dir, { recursive: true, force: true });
  },
  open: async ({ context }, use) => {
    await use(async (url) => {
      const page = await context.newPage();
      await page.goto(url.startsWith('http') || url.startsWith('chrome') ? url : ORIGIN + url);
      const popup = await openPopup(context, page.url());
      return { page, popup };
    });
  },
});

export { expect };

export type Popup = Page & { tabId: number };

/** The tab ids open now, read from an extension page. */
export async function tabIds(context: BrowserContext): Promise<number[]> {
  const p = await context.newPage();
  await p.goto(`chrome-extension://${EXTENSION_ID}/worker.html`);
  const ids = await p.evaluate(async () =>
    (await chrome.tabs.query({})).map((t) => t.id ?? 0).filter(Boolean),
  );
  await p.close();
  return ids;
}

/** The popup for the tab showing `url`, or for a tab id when its address is hidden. */
export async function openPopup(context: BrowserContext, url: string | number): Promise<Popup> {
  const popup = (await context.newPage()) as Popup;
  // Any extension page can list the tabs; the popup itself then takes ?tab=.
  await popup.goto(`chrome-extension://${EXTENSION_ID}/worker.html`);
  popup.tabId =
    typeof url === 'number'
      ? url
      : await popup.evaluate(async (u) => {
          const tabs = await chrome.tabs.query({});
          return tabs.find((t) => t.url === u)?.id ?? 0;
        }, url);
  expect(popup.tabId, `a tab for ${url}`).toBeGreaterThan(0);
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html?tab=${popup.tabId}`);
  return popup;
}

/** The subtitle text drawn in every frame of the tab, read from the content script. */
export async function showing(popup: Popup): Promise<string> {
  return popup.evaluate(async (tabId) => {
    const got = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => globalThis.__tsdb?.showing() ?? '',
    });
    return got.map((g) => g.result ?? '').join('');
  }, popup.tabId);
}

/** Moves the loaded subtitle so the line starting at `startMs` is on screen at 0:00. */
export async function alignTo(popup: Popup, startMs: number): Promise<void> {
  await popup.evaluate(
    async ([tabId, ms]) => {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: (m: number) => {
          globalThis.__tsdb?.offset(m);
        },
        args: [ms],
      });
    },
    [popup.tabId, -(startMs + 50)] as const,
  );
}

/** A subtitle file the suite writes rather than downloads. */
export const SRT = {
  name: 'local.srt',
  mimeType: 'text/plain',
  buffer: Buffer.from(
    '1\n00:00:00,000 --> 00:00:30,000\n<i>Hello</i> from a file\n\n2\n00:00:31,000 --> 00:00:32,000\nSecond\n',
  ),
};
