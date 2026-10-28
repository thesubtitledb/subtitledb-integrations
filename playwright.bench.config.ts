import { defineConfig } from '@playwright/test';
import base from './playwright.config';

/**
 * Benches, not tests: real media from the internet, minutes per case, numbers printed
 * rather than asserted. Same servers as the e2e run. `npm run bench:ia`.
 */
export default defineConfig({
  ...base,
  testDir: './e2e-bench',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
});
