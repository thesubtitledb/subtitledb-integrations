import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (p: string) => fileURLToPath(new URL(`./packages/${p}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      // Adapters import @subtitledb/core by name, which npm links to its built dist.
      // Unit tests must run against source, or a stale build silently decides what
      // passes: an adapter test once "proved" a feature the built core did not have.
      // The end-to-end run vendors the real build, so build breakage is still caught.
      //
      // Longest first. These are prefix matches, so '@subtitledb/players' placed
      // above '@subtitledb/players/marks' would swallow it and resolve the subpath to
      // a file that does not exist.
      { find: '@subtitledb/players/marks', replacement: src('players/src/marks.ts') },
      { find: '@subtitledb/players', replacement: src('players/src/index.ts') },
      { find: '@subtitledb/core', replacement: src('core/src/index.ts') },
      { find: '@subtitledb/html5', replacement: src('html5/src/index.ts') },
    ],
  },
  test: {
    // Hermetic tests only. Anything that touches the real API lives in *.live.test.ts
    // and runs under vitest.live.config.ts, so a network blip can never look like a
    // logic regression.
    include: ['packages/*/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.live.test.ts'],
    environment: 'node',
  },
});
