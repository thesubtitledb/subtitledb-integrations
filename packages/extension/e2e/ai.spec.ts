import { expect, test } from './fixtures.js';

/**
 * AI subtitles end to end: the popup starts SubBot on the Sintel clip, the workers run
 * in the extension's frame, the 44 MB model comes from HuggingFace, and lines land on
 * the video's own track as SubBot's renderer puts them there on the site.
 */

test.describe.configure({ timeout: 300_000 });

test('SubBot writes subtitles for a video on the page', async ({ open, context }) => {
  // No corpus match, so the run transcribes rather than switching to a TSDB file.
  await context.route(/\/v1\/subbot\/identify\b/, (r) =>
    r.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: { match: null, files: [], probes: 0, runner_up: 0 },
    }),
  );
  const { page, popup } = await open('/plain.html');
  await expect(popup.locator('#ai')).toBeVisible({ timeout: 20_000 });
  await expect(popup.locator('#aiStart')).toBeEnabled();
  await popup.locator('input[name=q][value=fast]').check();
  await popup.locator('#spoken').selectOption('en');
  await popup.locator('#aiStart').click();
  await expect(popup.locator('#aiRun')).toBeVisible();
  await expect(popup.locator('#aiText')).not.toBeEmpty();

  await page.bringToFront();
  await page.evaluate(() => (document.getElementById('v') as HTMLVideoElement).play());

  // The status the popup polls moves through the model download to live lines.
  await expect(popup.locator('#aiText')).toHaveText(/^(Live|Done)/, { timeout: 240_000 });
  await expect(popup.locator('#aiText')).not.toHaveClass(/bad/);
  // Lines land on the track SubBot's renderer adds, named as on the site.
  const cues = () =>
    page.evaluate(() => {
      const v = document.getElementById('v') as HTMLVideoElement;
      const t = Array.from(v.textTracks).find((x) => x.label === 'AI subtitles (English)');
      return t?.mode === 'showing' ? (t.cues?.length ?? 0) : -1;
    });
  await expect.poll(cues, { timeout: 120_000 }).toBeGreaterThan(0);

  await popup.locator('#aiStop').click();
  await expect(popup.locator('#aiRun')).toBeHidden();
  await expect(popup.locator('#aiOpts')).toBeVisible();
});
