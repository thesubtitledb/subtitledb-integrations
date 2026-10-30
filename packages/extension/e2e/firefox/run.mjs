#!/usr/bin/env node
/**
 * The Firefox build in real Firefox, through geckodriver. Playwright's Firefox cannot
 * load an extension, so this speaks WebDriver itself: a dozen HTTP calls, no client
 * library.
 *
 * Installs dist/subtitledb-firefox-<v>.xpi as a temporary add-on with a fixed internal
 * UUID, so the popup's address is known, opens the e2e page, points the popup at its
 * tab, and checks what a viewer would: the title found, a live search, a file drawn
 * over the video, sync and remove.
 *
 *   FIREFOX_BIN    Firefox to drive (default: firefox on PATH)
 *   GECKODRIVER    geckodriver (default: $GECKOWEBDRIVER/geckodriver, then PATH)
 *   HEADED=1       show the window
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '../..');
const { version } = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
const XPI = join(pkg, 'dist', `subtitledb-firefox-${version}.xpi`);
const ID = 'browser-extension@thesubtitledb.org';
const UUID = '6f1e2d3c-4b5a-4968-8776-655443322110';
const BASE = `moz-extension://${UUID}`;
const PAGE_PORT = Number(process.env.PORT ?? 4181);
const DRIVER_PORT = Number(process.env.DRIVER_PORT ?? 4444);
const ORIGIN = `http://localhost:${PAGE_PORT}`;

const driverBin =
  process.env.GECKODRIVER ??
  (process.env.GECKOWEBDRIVER ? join(process.env.GECKOWEBDRIVER, 'geckodriver') : 'geckodriver');

// ------------------------------------------------------------------ WebDriver

let session = '';
async function wd(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${DRIVER_PORT}${path.replace(':s', session)}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${json.value?.message ?? res.status}`);
  return json.value;
}
const go = (url) => wd('POST', '/session/:s/url', { url });
const run = (script, ...args) => wd('POST', '/session/:s/execute/sync', { script, args });

async function until(what, fn, ms = 20_000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${what} (last: ${JSON.stringify(last)})`);
}

// ------------------------------------------------------------------ the run

const steps = [];
async function step(name, fn) {
  const t = Date.now();
  await fn();
  steps.push(name);
  console.log(`  ok  ${name} (${Date.now() - t} ms)`);
}

const server = await serve(PAGE_PORT);
// --allow-system-access lets WebDriver into moz-extension: pages, which it otherwise refuses.
const driver = spawn(driverBin, ['--port', String(DRIVER_PORT), '--allow-system-access'], {
  stdio: 'ignore',
});
let failed = false;
try {
  await until('geckodriver', () =>
    fetch(`http://127.0.0.1:${DRIVER_PORT}/status`).then((r) => r.ok),
  );
  const opts = {
    args: process.env.HEADED ? [] : ['-headless'],
    prefs: { 'extensions.webextensions.uuids': JSON.stringify({ [ID]: UUID }) },
  };
  if (process.env.FIREFOX_BIN) opts.binary = process.env.FIREFOX_BIN;
  ({ sessionId: session } = await wd('POST', '/session', {
    capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': opts } },
  }));
  console.log(`firefox: ${XPI}`);

  await step('installs as a temporary add-on', async () => {
    const id = await wd('POST', '/session/:s/moz/addon/install', { path: XPI, temporary: true });
    if (id !== ID) throw new Error(`installed as ${id}`);
  });

  await go(`${ORIGIN}/plain.html`);
  const pageHandle = await wd('GET', '/session/:s/window');
  const { handle: popupHandle } = await wd('POST', '/session/:s/window/new', { type: 'tab' });
  await wd('POST', '/session/:s/window', { handle: popupHandle });
  // WebDriver will not navigate to a moz-extension: address. A page may, to worker.html,
  // which is web accessible; from there the extension's own pages are reachable.
  const to = async (url) => {
    await run(`location.href = arguments[0];`, url);
    await until(url, async () => (await wd('GET', '/session/:s/url')) === url);
  };
  await go(`${ORIGIN}/two.html`);
  await to(`${BASE}/worker.html`);
  const tabId = await run(
    `return browser.tabs.query({}).then((t) => t.find((x) => x.url === arguments[0])?.id ?? 0);`,
    `${ORIGIN}/plain.html`,
  );
  if (!tabId) throw new Error('no tab for the e2e page');
  await to(`${BASE}/popup.html?tab=${tabId}`);

  await step('finds the title on the page', async () => {
    await until('the title', () =>
      run(`return document.getElementById('q').value === 'Sintel'
        && document.getElementById('year').value === '2010';`),
    );
  });

  await step('searches the live API and loads a file over the video', async () => {
    await until(
      'results',
      () => run(`return document.querySelectorAll('#list .res').length;`),
      30_000,
    );
    await run(`document.querySelector('#list .res').click();`);
    await until('the now panel', () => run(`return !document.getElementById('now').hidden;`));
    await until('"On screen"', () =>
      run(`return document.querySelector('#list .res .ra').textContent === 'On screen';`),
    );
  });

  const showing = () =>
    run(
      `return browser.scripting.executeScript({ target: { tabId: arguments[0], allFrames: true },
        func: () => globalThis.__tsdb?.showing() ?? '' }).then((r) => r.map((x) => x.result ?? '').join(''));`,
      tabId,
    );

  await step('draws a local file, and sync moves it', async () => {
    const srt = join(tmpdir(), 'tsdb-local.srt');
    await writeFile(srt, '1\n00:00:00,000 --> 00:00:30,000\nHello from a file\n');
    const input = await wd('POST', '/session/:s/element', {
      using: 'css selector',
      value: '#file',
    });
    const ref = Object.values(input)[0];
    await wd('POST', `/session/:s/element/${ref}/value`, { text: srt });
    await until('the file loaded', () =>
      run(`return document.getElementById('nowMeta').textContent.includes('from your computer');`),
    );
    await wd('POST', '/session/:s/window', { handle: pageHandle });
    await until('the overlay in the page', () =>
      run(`const h = document.querySelector('tsdb-subtitles');
        const r = h && h.getBoundingClientRect();
        return Boolean(r && r.width === 640 && r.height === 360);`),
    );
    await wd('POST', '/session/:s/window', { handle: popupHandle });
    await until('the line on screen', async () => (await showing()) === 'Hello from a file');
    await run(`document.querySelector('[data-shift="1000"]').click();`);
    await until('+1 s', () =>
      run(`return document.getElementById('nowOffset').textContent === '+1 s';`),
    );
    await until('the line moved off 0:00', async () => (await showing()) === '');
  });

  await step('remove takes it off the page', async () => {
    await run(`document.getElementById('nowRemove').click();`);
    await until('the panel gone', () => run(`return document.getElementById('now').hidden;`));
    await wd('POST', '/session/:s/window', { handle: pageHandle });
    await until('the overlay gone', () => run(`return !document.querySelector('tsdb-subtitles');`));
  });
} catch (e) {
  failed = true;
  console.error(`FAIL after ${steps.length} steps: ${e.message}`);
} finally {
  if (session) await wd('DELETE', '/session/:s').catch(() => {});
  driver.kill();
  server.close();
}
process.exit(failed ? 1 : 0);
