# subtitledb-integrations

Subtitle plugins for web video players.

One call finds what is playing, asks the [SubtitleDB](https://thesubtitledb.org) open
API what exists for it, and fills the player's own captions menu.

No key. No signup. No account.

Sixteen bindings over fifteen player libraries, plus a bare `<video>` (also how hls.js
and dash.js are reached). Nothing is imported from the player, so there is no player
dependency and no version to pin.

## Install

One script tag, no build step:

```html
<video id="v" controls src="film.mp4"></video>
<script src="https://cdn.thesubtitledb.org/latest/subtitle-finder.js"></script>
<script>
  SubtitleDB.attach(document.getElementById('v'), {
    hint: { imdbId: 'tt0133093' },
    languages: ['en'],
    autoSelect: true,
  });
</script>
```

About 2 KB. It fetches only the half of the code your page needs.

ES module build at the same path: `subtitle-finder.esm.js`.

From source, if the page has a build step:

```bash
git clone https://github.com/thesubtitledb/subtitledb-integrations
cd subtitledb-integrations
npm install
npm run build
npm run vendor
```

`vendor` writes plain ES modules into `examples/vendor`. Point an import map at them.

Not on npm yet.

## CDN helper

The `SubtitleDB` global, and the ES module's named exports. Same four either way.

| Method | Returns | Does |
|---|---|---|
| `attach(target, options?)` | `DeferredHandle` | Mounts on a player, element or framework ref. Loads bindings only if the target needs them. |
| `preload()` | `Promise<unknown>` | Warms the chunks before the first attach. |
| `setBasePath(path)` | `void` | Overrides where chunks are fetched from. For self-hosting. |
| `version` | `string` | Build version, stamped at publish. |

`target` can be a player instance, its container, a bare `<video>`, or a framework
ref: `{plyr}`, `{player}`, `{player, videoElement}`, a React `useRef`, a Vue `ref`.

## The handle

`attach()` returns at once. The loaded handle settles on `ready`.

| Member | Type | Notes |
|---|---|---|
| `ready` | `Promise<AttachHandle>` | The real handle, once its module has loaded. |
| `player` | `PlayerInfo \| null` | `name`, `label`, `untested`, `via`. Null until ready. |
| `degraded` | `DegradedInfo \| null` | Set only when a player was seen but not reachable. |
| `session` | `SubtitleSession \| null` | The underlying session. Null until ready. |
| `media()` | `HTMLVideoElement \| null` | The element playing now, read live, never cached. |
| `refresh()` | `Promise<ResolveResult>` | Force a fresh resolve. |
| `select(candidate)` | `Promise<void>` | Fetch, convert if the player cannot render it, show it. |
| `tracks()` | `Candidate[]` | Candidates offered, in menu order. Empty before the first resolve. |
| `current()` | `ResolveResult \| null` | Last resolve. Null before the first. |
| `destroy()` | `void` | Detach and clean up. |

`player.via` says how the target was reached: `named`, `instance`, `element`, `ref`,
`descend`, `ascend`, `native`.

## Options

Three matter most. Dropping one is the usual reason nothing appears.

| Option | Default | Notes |
|---|---|---|
| `hint` | inferred | `{ imdbId }` and friends. Exact beats inference. |
| `languages` | API order | Best first. Unset is alphabetical: ask for The Matrix, get Arabic. |
| `autoSelect` | `false` | Puts one on screen. Unset offers without showing. |

Also accepted: `player`, `formats`, `convert`, `maxTracks`, `hearingImpaired`,
`limit`, `strict`, `apiBase`, `clientName`, `fetch`, `cacheTtlMs`, `maxRequests`, and
the callbacks `onResolved`, `onSelected`, `onDegraded`, `onError`.

Full table in [docs/documentation.md](docs/documentation.md).

## Packages

| Package | For |
|---|---|
| `@subtitledb/players` | Any of the sixteen bindings. One attach call. |
| `@subtitledb/html5` | A bare `<video>` and its track list. |
| `@subtitledb/artplayer` | ArtPlayer's own plugin shape. |
| `@subtitledb/core` | Client, identify, filename, match, convert, cache. |

`@subtitledb/players` also exports `attachSubtitleDb`, `attachedTo`,
`observeSubtitleDb`, `resolvePlayer`, `findPlayer`, `playerFor`, `findVideo`,
`isVideoElement`, `detectBinding`, `bindingByName`, `BINDINGS`, `ownerOf`,
`looksOwned`, `OWNER_CLASSES`.

`@subtitledb/core` also exports `createClient`, `SubtitleDbClient`, `createSession`,
`SubtitleSession`, `findSubtitles`, `similarity`, `candidateLabel`, `identify`,
`elementIdentity`, `isResolvable`, `parseFilename`, `basename`, `toVtt`, `srtToVtt`,
`assToVtt`, `subtitleMime`, `CONVERTIBLE`, `SingleFlightCache`, `handleFor`,
`handleForAny`, `registerHandle`, `languageName`, `hasLanguageName`, `normaliseImdb`,
`backoffMs`, `EMPTY_RESULT`, `DEFAULT_API_BASE`.

## Scripts

| Command | Does |
|---|---|
| `npm test` | Unit. Hermetic, no network. |
| `npm run test:live` | Contract tests against the real API. |
| `npm run typecheck` | Types, and fails on stray build output in `src`. |
| `npm run build` | Compile all four packages. |
| `npm run vendor` | Built packages into `examples/vendor`. |
| `npm run serve` | <http://localhost:4173> |
| `npm run e2e` | Playwright over the example pages. |
| `npm run lint` | Biome. |
| `npm run lint:fix` | Biome, writing fixes. |

## Docs

- [docs/documentation.md](docs/documentation.md) - options, the handle, load patterns, limits.
- [docs/players.md](docs/players.md) - every player, which binding reaches it, what has been run.
- [examples/minimal.html](examples/minimal.html) - the smallest page that works.

## Stremio

Different shape, separate repo:
[thesubtitledb/subtitledb-stremio](https://github.com/thesubtitledb/subtitledb-stremio).

A hosted service, not a plugin the client loads. It vendors this repo's converter and
similarity function under a CI drift gate.
