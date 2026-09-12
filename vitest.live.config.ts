import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // These hit https://api.thesubtitledb.org for real. They are the only proof that
    // the wire types in packages/core/src/types.ts still match what ships.
    include: ['packages/*/test/**/*.live.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    retry: 1,
  },
});
