import type { Page } from '@playwright/test';
import {
  alignTo,
  EXTENSION_ID,
  expect,
  ORIGIN,
  openPopup,
  SRT,
  showing,
  tabIds,
  test,
} from './fixtures.js';

/**
 * The built Chrome extension against the live API: what a viewer does in the popup,
 * and what lands on the page.
 */

test('finds the title, searches the API, and draws the picked file over the video', async ({
  open,
}) => {
  const searches: string[] = [];
  const { page, popup } = await open('/plain.html');
  popup.on('request', (r) => {
    if (r.url().startsWith('https://api.thesubtitledb.org/')) searches.push(r.url());
  });

  await expect(popup.locator('#q')).toHaveValue('Sintel');
  await expect(popup.locator('#year')).toHaveValue('2010');
  await expect(popup.locator('#from')).toHaveText('From the page');

  // The search runs on its own: the page named the film.
  const rows = popup.locator('#list .res');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  await expect(popup.locator('#match b')).toContainText('Sintel');
  await rows.first().click();
  await expect(popup.locator('#now')).toBeVisible();
  await expect(rows.first().locator('.ra')).toHaveText('On screen');

  const last = await popup.evaluate(
    () => (window as { __tsdbLast?: { first: { start: number; text: string } } }).__tsdbLast,
  );
  expect(last?.first.text).toBeTruthy();
  await alignTo(popup, last?.first.start ?? 0);
  await page.bringToFront();
  const words = (s: string) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, '');
  await expect.poll(async () => words(await showing(popup))).toBe(words(last?.first.text ?? ''));
  await expect(page.locator('tsdb-subtitles')).toHaveCount(1);

  // The downloads are recorded against the extension, not the browser.
  expect(searches.some((u) => u.includes('client=chrome-extension'))).toBe(true);
  // And asked for without the site and credit lines stamped on either end.
  expect(searches.some((u) => u.includes('/get/') && u.includes('remove_watermark=true'))).toBe(
    true,
  );
  const rules = await popup.evaluate(() =>
    (
      chrome as unknown as {
        declarativeNetRequest: {
          getSessionRules(): Promise<{ action: { requestHeaders: { value: string }[] } }[]>;
        };
      }
    ).declarativeNetRequest.getSessionRules(),
  );
  expect(rules[0]?.action.requestHeaders[0]?.value).toMatch(
    /TheSubtitleDB-Extension\/\d+\.\d+\.\d+ \(chrome\)$/,
  );
});

test('sync, hide and remove act on what is on screen', async ({ open }) => {
  const { page, popup } = await open('/plain.html');
  await popup.locator('#file').setInputFiles(SRT);
  await expect(popup.locator('#nowMeta')).toContainText('from your computer');
  await page.bringToFront();
  await expect.poll(() => showing(popup)).toBe('Hello from a file');

  await popup.getByRole('button', { name: '+1', exact: true }).click();
  await popup.getByRole('button', { name: '+0.1', exact: true }).click();
  await expect(popup.locator('#nowOffset')).toHaveText('+1.1 s');
  // A line that starts at 0:00 shown 1.1 s later is not on screen at 0:00 yet.
  await expect.poll(() => showing(popup)).toBe('');
  await popup.locator('#nowReset').click();
  await expect(popup.locator('#nowOffset')).toHaveText('0 s');
  await expect.poll(() => showing(popup)).toBe('Hello from a file');

  await popup.locator('#nowHide').click();
  await expect(popup.locator('#nowHide')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => showing(popup)).toBe('');
  await popup.locator('#nowHide').click();
  await expect.poll(() => showing(popup)).toBe('Hello from a file');

  await popup.locator('#nowRemove').click();
  await expect(popup.locator('#now')).toBeHidden();
  await expect(page.locator('tsdb-subtitles')).toHaveCount(0);
});

test('appearance is saved and redrawn in the page', async ({ open }) => {
  const { page, popup } = await open('/plain.html');
  await popup.locator('#file').setInputFiles(SRT);
  await page.bringToFront();
  await expect.poll(() => showing(popup)).toBe('Hello from a file');
  const size = () =>
    page
      .locator('tsdb-subtitles')
      .evaluate((h) => Number.parseFloat((h as HTMLElement).style.fontSize));
  // 360 px tall at the default 4.6 %.
  await expect.poll(size).toBeCloseTo(16.6, 0);

  await popup.locator('#lookBtn').click();
  await expect(popup.locator('#look')).toBeVisible();
  await popup.locator('#lkSize').fill('9');
  await popup.locator('input[name=color][value="#ffd60a"]').check();
  await expect(popup.locator('#lkSizeOut')).toHaveText('9.0%');
  await expect.poll(size).toBeCloseTo(32.4, 0);
  const saved = await popup.evaluate(() => chrome.storage.sync.get('style'));
  expect(saved.style).toMatchObject({ size: 9, color: '#ffd60a' });

  // A popup opened later starts from what was saved.
  const again = await openPopup(popup.context(), page.url());
  await again.locator('#lookBtn').click();
  await expect(again.locator('#lkSize')).toHaveValue('9');
  await again.locator('#lkReset').click();
  await expect.poll(size).toBeCloseTo(16.6, 0);

  // A preset sets several things at once and is marked as the one in use.
  await again.locator('[data-preset=yellow]').click();
  await expect(again.locator('[data-preset=yellow]')).toHaveAttribute('aria-pressed', 'true');
  const yellow = await again.evaluate(() => chrome.storage.sync.get('style'));
  expect(yellow.style).toMatchObject({ color: '#ffd60a', box: 0, edge: 'outline', weight: 700 });
});

/** Types a search once the popup is done with the one it ran for the page. */
async function typeSearch(popup: Page, text: string): Promise<void> {
  await expect
    .poll(() =>
      popup.evaluate(() => {
        const on = (id: string) => !(document.getElementById(id) as HTMLElement).hidden;
        const go = document.getElementById('go') as HTMLButtonElement;
        return on('hero') ? 'hero' : on('search') && !go.disabled ? 'search' : 'busy';
      }),
    )
    .not.toBe('busy');
  if (await popup.locator('#hero').isVisible()) await popup.locator('#heroBack').click();
  await popup.locator('#q').fill(text);
}

/**
 * A button in the bar over the video. The bar lives in a closed shadow root, which
 * no selector reaches, so it is found in the accessibility tree and clicked where
 * it is drawn.
 */
async function barButton(page: Page, name: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('Accessibility.enable');
  const { nodes } = await cdp.send('Accessibility.getFullAXTree');
  const node = nodes.find((n) => n.role?.value === 'button' && n.name?.value === name);
  expect(node, `a bar button named ${name}`).toBeTruthy();
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node?.backendDOMNodeId });
  const [x1 = 0, y1 = 0, , , x3 = 0, y3 = 0] = model.content;
  await page.mouse.click((x1 + x3) / 2, (y1 + y3) / 2);
  await cdp.detach();
}

test('the bar on the video syncs and resizes without the popup', async ({ open }) => {
  const { page, popup } = await open('/plain.html');
  await popup.locator('#file').setInputFiles(SRT);
  await page.bringToFront();
  await expect.poll(() => showing(popup)).toBe('Hello from a file');
  const box = await page.locator('#v').boundingBox();
  await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 200);
  await page.mouse.move((box?.x ?? 0) + 210, (box?.y ?? 0) + 210);

  const barShown = () =>
    popup.evaluate(async (tabId) => {
      const [got] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => globalThis.__tsdb?.barShown() ?? false,
      });
      return got?.result;
    }, popup.tabId);
  await expect.poll(barShown).toBe(true);
  await page.mouse.move(900, 650);
  await page.mouse.move(905, 655);
  await expect.poll(barShown, { timeout: 3000 }).toBe(false);
  await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 200);
  await page.mouse.move((box?.x ?? 0) + 210, (box?.y ?? 0) + 210);
  await expect.poll(barShown).toBe(true);

  await barButton(page, 'Later');
  // The first line starts at 0:00; half a second later it is not on screen yet.
  await expect.poll(() => showing(popup)).toBe('');
  await barButton(page, 'Bigger text');
  const sizeNow = async () => {
    const got = await popup.evaluate(() => chrome.storage.sync.get('style'));
    return (got.style as { size?: number } | undefined)?.size;
  };
  await expect.poll(sizeNow).toBe(5);
  const again = await openPopup(popup.context(), page.url());
  await expect(again.locator('#nowOffset')).toHaveText('+0.5 s');

  await barButton(page, 'Remove subtitles');
  await expect(page.locator('tsdb-subtitles')).toHaveCount(0);
});

test('suggestions lead to a show, its seasons and an episode', async ({ open }) => {
  const { popup } = await open('/two.html');
  await typeSearch(popup, 'Breaking Bad');
  const show = popup
    .locator('#suggest li')
    .filter({ has: popup.locator('b', { hasText: /^Breaking Bad$/ }) })
    .filter({ hasText: 'Series' })
    .first();
  await expect(show).toBeVisible({ timeout: 20_000 });
  await show.click();

  await expect(popup.locator('#hero')).toBeVisible({ timeout: 20_000 });
  await expect(popup.locator('#match b')).toContainText('Breaking Bad');
  await expect(popup.locator('#rstate')).toHaveText('Pick an episode.');
  // Nothing left from the search before: no count, no list.
  await expect(popup.locator('#rcount')).toHaveText('');
  await expect(popup.locator('#heroPoster')).toHaveCSS('background-image', /\/p\/w185\//);
  await popup.locator('#seasonChips button', { hasText: /^S1$/ }).click();
  await popup.locator('#episodeChips button').first().click();
  await expect(popup.locator('#match small')).toContainText('S1 E1', { timeout: 20_000 });
  const rows = popup.locator('#list .res');
  await expect(rows.first()).toBeVisible({ timeout: 20_000 });
  // No video length on this page: the score comes from nothing, so none is drawn.
  await expect(popup.locator('#list .ring')).toHaveCount(0);

  // Another season drops the episode from the header and asks again.
  await popup.locator('#seasonChips button', { hasText: /^S2$/ }).click();
  await expect(popup.locator('#match small')).not.toContainText('S1 E1');
  await expect(popup.locator('#rstate')).toHaveText('Pick an episode.');

  await popup.locator('#heroBack').click();
  await expect(popup.locator('#search')).toBeVisible();
});

test('dark by default; theme and interface language are saved', async ({ open }) => {
  const { page, popup } = await open('/two.html');
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(popup.locator('html')).toHaveAttribute('lang', 'en');
  await popup.locator('#setBtn').click();
  await expect(popup.locator('#settings')).toBeVisible();
  await popup.locator('input[name=theme][value=light]').check({ force: true });
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'light');

  await popup.locator('#uiLang').selectOption('ar');
  await expect(popup.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(popup.locator('html')).toHaveAttribute('lang', 'ar');
  await expect(popup.locator('html')).toHaveAttribute('data-theme', 'light');

  const again = await openPopup(popup.context(), page.url());
  await expect(again.locator('html')).toHaveAttribute('dir', 'rtl');
  await again.locator('#setBtn').click();
  await again.locator('#uiLang').selectOption('');
  await expect(again.locator('html')).toHaveAttribute('dir', 'ltr');
  await expect(again.locator('#search .go')).toHaveText('Search');
});

test('a video in another origin’s iframe', async ({ open }) => {
  const { page, popup } = await open('/iframe.html');
  // The top page names the film; the player frame only says "Video player".
  await expect(popup.locator('#q')).toHaveValue('Sintel');
  await expect(popup.locator('#videos')).toBeHidden();
  await popup.locator('#file').setInputFiles(SRT);
  await page.bringToFront();
  await expect.poll(() => showing(popup)).toBe('Hello from a file');
  const frame = page.frames().find((f) => f.url().includes('127.0.0.1'));
  await expect(frame?.locator('tsdb-subtitles') ?? page.locator('none')).toHaveCount(1);
  await expect(page.locator('tsdb-subtitles')).toHaveCount(0);
});

test('a video inside an open shadow root', async ({ open }) => {
  const { page, popup } = await open('/shadow.html');
  await popup.locator('#file').setInputFiles(SRT);
  await page.bringToFront();
  await expect.poll(() => showing(popup)).toBe('Hello from a file');
  const box = await page.locator('tsdb-subtitles').boundingBox();
  expect(box).toMatchObject({ x: 0, y: 0, width: 640, height: 360 });
});

test('fullscreen: inside the fullscreen element, and on a track when the video is', async ({
  open,
}) => {
  const { page, popup } = await open('/plain.html');
  await popup.locator('#file').setInputFiles(SRT);
  await page.bringToFront();
  await expect.poll(() => showing(popup)).toBe('Hello from a file');

  await page.locator('#fsWrap').click();
  await expect(page.locator('#wrap > tsdb-subtitles')).toHaveCount(1);
  await expect.poll(() => showing(popup)).toBe('Hello from a file');
  await page.evaluate(() => document.exitFullscreen());

  await page.locator('#fsVideo').click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const t = Array.from((document.getElementById('v') as HTMLVideoElement).textTracks);
        const tsdb = t.find((x) => x.label === 'TSDB');
        return tsdb ? `${tsdb.mode} ${tsdb.cues?.length}` : 'none';
      }),
    )
    .toBe('showing 2');
  await page.evaluate(() => document.exitFullscreen());
  await expect(page.locator('body > tsdb-subtitles')).toHaveCount(1);
});

test('lists every video big enough to subtitle, the biggest first', async ({ open }) => {
  const { popup } = await open('/two.html');
  await expect(popup.locator('#videos')).toBeVisible();
  await expect(popup.locator('.vrow')).toHaveCount(2);
  await expect(popup.locator('.vrow').first()).toContainText('640 × 360');
  await expect(popup.locator('.vrow').first()).toHaveAttribute('aria-checked', 'true');
  await popup.locator('.vrow').nth(1).click();
  await expect(popup.locator('.vrow').nth(1)).toHaveAttribute('aria-checked', 'true');
});

test('says why on a page extensions cannot touch', async ({ context }) => {
  // A browser page's address is hidden from the extension: its tab is the new one.
  const before = await tabIds(context);
  const page = await context.newPage();
  await page.goto('chrome://version');
  const id = (await tabIds(context)).find((t) => !before.includes(t));
  const popup = await openPopup(context, id ?? 0);
  await expect(popup.locator('#noticeTitle')).toHaveText('Not on this page');
  await expect(popup.locator('#search')).toBeHidden();
});

test('a typed search with no match says so and offers AI subtitles first', async ({ open }) => {
  const { popup } = await open('/two.html');
  await typeSearch(popup, 'zzqx no such film qqzx');
  await popup.locator('#go').click();
  await expect(popup.locator('#rstate')).toContainText('No title matched', { timeout: 20_000 });
  await expect(popup.locator('#ai')).toHaveClass(/lead/);
  // No src yet on these videos: SubBot cannot start, and the popup says why.
  await expect(popup.locator('#aiStart')).toBeDisabled();
  await expect(popup.locator('#aiWhy')).toBeVisible();
});

test('the worker frame refuses to start a worker without the extension’s token', async ({
  context,
}) => {
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/two.html`);
  const answered = await page.evaluate(async (id) => {
    const f = document.createElement('iframe');
    f.src = `chrome-extension://${id}/worker.html`;
    document.body.append(f);
    await new Promise((r) => f.addEventListener('load', r));
    const ch = new MessageChannel();
    let got = false;
    ch.port1.onmessage = () => {
      got = true;
    };
    f.contentWindow?.postMessage({ tsdb: 'spawn', token: crypto.randomUUID() }, '*', [ch.port2]);
    await new Promise((r) => setTimeout(r, 1500));
    return got;
  }, EXTENSION_ID);
  expect(answered).toBe(false);
});
