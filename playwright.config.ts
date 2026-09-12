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
      // Build and vendor first so the served examples are never stale.
      command: 'npm run build && npm run vendor && npm run serve',
      url: `http://localhost:${process.env.PORT ?? 4173}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
