# subtitledb-integrations

The public JS SDK: `@subtitledb/core`, `@subtitledb/players`, `@subtitledb/html5` and
`@subtitledb/artplayer`. The CDN loader and the plugins for Bazarr, Kodi, VLC, Jellyfin
and Emby live in the private thesubtitledb/subtitledb-cdn, which carries the same
packages and the same tests.

## Tests

Run from the repo root after `npm ci`. CI is `.github/workflows/ci.yml`: two jobs, both
blocking, written to run on every pull request and on push to main. As of 2026-09-25
GitHub Actions is disabled on this repository (Settings > Actions), so nothing runs on
GitHub and the suites have to be run here before a merge.

| Suite | Command | Proves | CI job |
|---|---|---|---|
| `packages/*/test/*.test.ts`, vitest | `npm test` | core (client, identify, match, convert, cache, session) and the three bindings, with fetch stubbed. `packages/core/test/shared-cases.test.ts` reads `plugins/shared/match-cases.json`, the ranking cases every SubtitleDB plugin shares | `check`, after `npm run lint` and `npm run typecheck` |
| `packages/core/test/api.live.test.ts` | `npm run test:live` | the wire types in `packages/core/src/types.ts` against the live api.thesubtitledb.org | `live` |
| `e2e/*.spec.ts`, Playwright Chromium | `npx playwright install chromium` once, then `npm run e2e` | the example pages in a real browser against the live API. Runs `npm run build` and `npm run vendor` itself and serves `examples/` on port 4173 | `check`, after `npm run build` |

Needs Node 24. The unit tests resolve `@subtitledb/*` to the TypeScript source, not to
`dist/`, and `npm run typecheck` fails if a compiled `.js` lands beside a `.ts` in
`packages/*/src`.

Known state on 2026-09-25: `npm run test:live` fails two assertions. The API stopped
sending `seasons: null` on a movie or an episode drill on 2026-09-09 and now leaves the
key out; subtitledb-cdn's copy of `api.live.test.ts` was changed to match and this one
was not. The other 15 assertions pass.
