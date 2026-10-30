import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url));

// The extension's own suite, run by .github/workflows/extension.yml only; the root
// config leaves packages/extension out so the main CI does not pay for it.
export default defineConfig({
  resolve: {
    alias: [
      { find: '@subtitledb/subbot', replacement: src('subbot/src/index.ts') },
      { find: '@subtitledb/core', replacement: src('core/src/index.ts') },
    ],
  },
  define: { __TARGET__: JSON.stringify('chrome'), __VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
