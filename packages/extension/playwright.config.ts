import { defineConfig } from '@playwright/test';

/**
 * The built Chrome extension (dist/chrome, so `node build.mjs chrome` first) loaded
 * into full Chromium, driven through its popup against the live API. The pages it
 * opens are served by e2e/server.mjs.
 */
const PORT = Number(process.env.PORT ?? 4180);

export default defineConfig({
  testDir: './e2e',
  testMatch: '*.spec.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  use: { trace: 'retain-on-failure' },
  webServer: {
    command: `node e2e/server.mjs ${PORT}`,
    url: `http://localhost:${PORT}/plain.html`,
    reuseExistingServer: !process.env.CI,
  },
});
