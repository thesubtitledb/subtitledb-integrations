#!/usr/bin/env node
/**
 * Renders static/icons/<size>.png from the site's logo glyph: the frame with the
 * subtitle bar in its lower third, filled so it still reads at 16 px. Run once when
 * the mark changes; the PNGs are committed, so a build needs no browser.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const out = join(dirname(dirname(fileURLToPath(import.meta.url))), 'static', 'icons');

const svg = (
  size,
) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28" width="${size}" height="${size}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#35B7AB"/>
<stop offset=".65" stop-color="#1B7FA5"/><stop offset="1" stop-color="#12688C"/></linearGradient></defs>
<rect width="28" height="28" rx="6.5" fill="url(#g)"/>
<rect x="6" y="17" width="16" height="${size < 24 ? 4 : 3.4}" rx="1.7" fill="#fff"/></svg>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const size of [16, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}</style>${svg(size)}`);
    const png = await page.locator('svg').screenshot({ omitBackground: true });
    await writeFile(join(out, `${size}.png`), png);
  }
} finally {
  await browser.close();
}
console.log('icons written');
