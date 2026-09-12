import { expect, test } from '@playwright/test';

/**
 * Drives examples/minimal.html, which is the page printed in docs/documentation.md.
 *
 * Documentation that does not run is documentation that has drifted. The claim being
 * tested is the one a new reader makes: paste this, get a subtitle on screen, with no
 * clicking and nothing else added.
 */

test('the page in the guide puts a subtitle on screen by itself', async ({ page }) => {
  await page.goto('/minimal.html');

  // Nothing on this page reports its state, on purpose: the guide's copy has no
  // status panel in it. So wait on the media element, the way a viewer would.
  const cue = await page.evaluate(async () => {
    const video = document.getElementById('player') as HTMLVideoElement;
    video.muted = true;
    try {
      await video.play();
    } catch {
      // Autoplay refused. The element still loads, which is all this needs.
    }
    for (let i = 0; i < 150; i++) {
      const track = [...video.textTracks].find((t) => t.mode === 'showing');
      const first = track?.cues?.[0] as VTTCue | undefined;
      if (first && video.readyState >= 1) {
        return { start: first.startTime, duration: video.duration, label: track?.label ?? '' };
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    return { start: -1, duration: video.duration, label: '' };
  });

  expect(cue.start).toBeGreaterThanOrEqual(0);
  expect(cue.start + 0.5).toBeLessThan(cue.duration);
  // languages: ['en'] is one of the three keys the guide says matters. Without it the
  // API answers alphabetically and this is Arabic.
  expect(cue.label).toContain('English');

  await page.evaluate((start: number) => {
    const video = document.getElementById('player') as HTMLVideoElement;
    video.currentTime = start + 0.25;
  }, cue.start);
  await page.waitForTimeout(1500);

  const live = await page.evaluate(() => {
    const video = document.getElementById('player') as HTMLVideoElement;
    const showing = [...video.textTracks].filter((t) => t.mode === 'showing');
    return {
      showing: showing.length,
      active: showing[0]?.activeCues?.length ?? 0,
      time: video.currentTime,
    };
  });
  expect(live.time).toBeGreaterThan(cue.start);
  expect(live.showing).toBe(1);
  expect(live.active).toBeGreaterThan(0);
});
