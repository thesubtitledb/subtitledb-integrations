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
      { find: '@subtitledb/transcribe', replacement: src('transcribe/src/index.ts') },
    ],
  },
  // What build.mjs stamps in. The loader reads all four, and a test that had to
  // supply them by hand would be testing a different program than the one shipped.
  // The chunk names point at real fixture modules so the dynamic import under test is
  // a real dynamic import.
  define: {
    __SDB_VERSION__: JSON.stringify('0.0.0-test'),
    __SDB_CHUNKS__: JSON.stringify({
      engine: 'engine.mjs',
      players: 'players.mjs',
      transcribe: 'transcribe.mjs',
    }),
    __SDB_BASE__: JSON.stringify('https://cdn.example.test/v/0.0.0-test/'),
    __SDB_PIN__: 'false',
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
