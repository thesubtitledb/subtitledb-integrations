# Testing

Run from the repo root unless a `cd` is given. CI is `.github/workflows/ci.yml`, on every
pull request and on push to main. Every job blocks, and on main the `release` job runs
only after all of them pass.

| Suite | Command | Proves | CI job |
|---|---|---|---|
| `packages/*/test/*.test.ts`, vitest | `npm test` | core (client, identify, match, convert, cache, session), the players, html5 and artplayer bindings, the loader and transcribe packages. Fetch is stubbed. `packages/core/test/shared-cases.test.ts` reads `plugins/shared/match-cases.json`, the ranking cases every plugin shares | `check`, after `npm run lint` and `npm run typecheck` |
| `packages/core/test/api.live.test.ts` | `npm run test:live` | the wire types in `packages/core/src/types.ts` against the live api.thesubtitledb.org | `live` |
| `e2e/*.spec.ts`, Playwright Chromium | `npx playwright install chromium` once, then `npm run e2e` | the example pages in a real browser against the live API, served on port 4173 with the CDN tree on 4174. Builds, vendors and builds the CDN tree first | `check`, after `npm run build` |
| `packages/loader/test/build.test.ts` | `npm run build && npm run build:cdn`, then `npx vitest run packages/loader/test/build.test.ts` | the CDN tree as a browser gets it: no bare specifier, no `import.meta` in the classic script, no empty file, the headers | `check` and `build` |
| `plugins/python/tests` | `cd plugins/python && python3 -m pytest` | the shared Python client that the Kodi and Bazarr plugins vendor | `python` |
| `plugins/bazarr/tests` | `cd plugins/bazarr && python3 -m pytest` | the Bazarr provider, `install.py`, and the release zip installing from where it unpacks | `python` |
| `plugins/kodi/tests` | `cd plugins/kodi && python3 -m pytest` | the Kodi add-on logic and the addon.xml it ships | `python` |
| `plugins/dotnet/tests/packaging` | `cd plugins/dotnet && python3 -m pytest` | the zip layout and the Jellyfin repository manifest in `tools/build-plugins.py`, no compiler needed | `python` |
| `plugins/dotnet/tests/*`, xunit | `cd plugins/dotnet && dotnet test SubtitleDb.sln` | the C# client and finder, and the Jellyfin and Emby providers. Warnings are errors | `dotnet` |
| `plugins/vlc/tests/run.lua` | `cd plugins/vlc && bash tests/get-lua.sh && tests/.lua/bin/lua tests/run.lua` | the VLC extension loaded with no `vlc` table, its own JSON decoder on the shared cases, and a scan for Lua 5.4-only syntax | `lua` |
| `plugins/hosts/`, the live hosts harness | Actions > Live hosts > Run workflow (`.github/workflows/hosts.yml`) | each plugin installed into real Jellyfin, Emby, Kodi, VLC and Bazarr on GitHub runners, searching and downloading through the host against the live API. [plugins/hosts](../plugins/hosts/README.md) explains it | none: run by hand |

The `python` job also runs `ruff check .` over every Python tree, `python3
tools/gen-languages.py --check` in `plugins/dotnet` (the C# language tables are generated
from the Python ones and checked in) and `python3 build.py` in `plugins/kodi`.

The `build` job runs `scripts/release-files.sh`, which builds every file a release
publishes into `release/<tag>/` with its `SHA256SUMS`, and keeps them as the run's
`release` artifact. On main the `release` job publishes each tag that does not exist
yet: see [Releases](../README.md#releases).

Runtimes: Node 24; Python 3.9 or newer with `pytest` and `ruff`; the .NET 8 SDK;
`curl`, `make` and a C compiler for `get-lua.sh`, which builds Lua 5.4 into
`plugins/vlc/tests/.lua`. The hosts harness needs containers and runs only on GitHub.
Its `api` job, `python3 plugins/hosts/baseline.py`, needs only network: it asks the live
API for every sample by every route and exits 1 when one resolves to the wrong title or
is answered by another rung than the route should reach.
