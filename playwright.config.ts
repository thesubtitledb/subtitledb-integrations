import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end run over the example pages.
 *
 * These drive a real browser against the real API, which is the only place the whole
 * chain is exercised at once: import map, ES modules, CORS, the /get/ redirect, blob
 * URLs and ArtPlayer itself. The unit tests stub fetch and cannot see any of that.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 45_000,
  use: {
    baseURL: `http://localhost:${process.env.PORT ?? 4173}`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Build and vendor first so the served examples are never stale. The CDN tree is
      // built here too rather than by the server below, because both builds run tsc
      // over the same projects and two of those at once corrupt the build info.
      command: 'npm run build && npm run vendor && npm run build:cdn && npm run serve',
      url: `http://localhost:${process.env.PORT ?? 4173}/`,
      // The latest/ entries are pinned at build time to an absolute origin. Left at
      // the default they would point a locally served page at the production chunks,
      // which is a test of the internet rather than of this branch.
      env: { CDN_ORIGIN: `http://localhost:${process.env.CDN_PORT ?? 4174}` },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      // A second origin, which is the point: an ES module fetched across one is
      // CORS-checked, and a classic script resolves import() against the page rather
      // than against itself. Same-origin serving passes both by accident.
      command: 'npm run serve:cdn',
      // 404s until the build above writes it, and this poll is what serialises them.
      url: `http://localhost:${process.env.CDN_PORT ?? 4174}/latest/subtitle-finder.js`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
