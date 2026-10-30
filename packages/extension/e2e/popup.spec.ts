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
  await expect(page.locator('tsdb-subtitles')).toHaveCount(0);
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
  await popup.locator('input[name=color][value="#ffe14d"]').check();
  await expect(popup.locator('#lkSizeOut')).toHaveText('9.0%');
  await expect.poll(size).toBeCloseTo(32.4, 0);
  const saved = await popup.evaluate(() => chrome.storage.sync.get('style'));
  expect(saved.style).toMatchObject({ size: 9, color: '#ffe14d' });

  // A popup opened later starts from what was saved.
  const again = await openPopup(popup.context(), page.url());
  await again.locator('#lookBtn').click();
  await expect(again.locator('#lkSize')).toHaveValue('9');
  await again.locator('#lkReset').click();
  await expect.poll(size).toBeCloseTo(16.6, 0);
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
  await popup.locator('#q').fill('zzqx no such film qqzx');
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
