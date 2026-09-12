# subtitledb-integrations

Subtitles in the player's own captions menu. [thesubtitledb.org](https://thesubtitledb.org)

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

No key, no signup, about 2 KB.

## Bundled

```bash
git clone https://github.com/thesubtitledb/subtitledb-integrations
cd subtitledb-integrations
npm install && npm run build && npm run vendor
```

```js
import { attachSubtitleDb } from '@subtitledb/players';

const handle = attachSubtitleDb(player, {
  hint: { imdbId: 'tt0133093' },
  languages: ['en', 'fr'],
  autoSelect: true,
});
```

`vendor` writes ES modules to `examples/vendor`. Not on npm yet.

## Targets

```js
attachSubtitleDb(videoEl);                    // bare <video>
attachSubtitleDb(player);                     // player instance
attachSubtitleDb(container);                  // its container
attachSubtitleDb({ plyr });                   // plyr-react
attachSubtitleDb({ player });                 // @videojs-player/vue
attachSubtitleDb({ player, videoElement });   // shaka-player-react
attachSubtitleDb(ref);                        // React useRef, Vue ref
attachSubtitleDb(player, { player: 'plyr' }); // skip detection
```

Sixteen bindings over fifteen libraries. hls.js and dash.js through `<video>`.

## CDN helper

```js
import {
  attach,
  preload,
  setBasePath,
  version,
} from 'https://cdn.thesubtitledb.org/latest/subtitle-finder.esm.js';
```

| Member | Type | Does |
|---|---|---|
| `attach(target, options?)` | `DeferredHandle` | Mounts. Loads bindings only if the target needs them. |
| `preload()` | `Promise<unknown>` | Warms the chunks early. |
| `setBasePath(path)` | `void` | Fetch chunks from your own copy. |
| `version` | `string` | Stamped at publish. |

## Handle

```js
const h = SubtitleDB.attach(video, { hint: { imdbId: 'tt0133093' } });

await h.ready;
h.player.name;                  // 'videojs'
h.player.via;                   // 'instance'
h.tracks();                     // Candidate[], menu order
await h.select(h.tracks()[0]);
h.current();                    // ResolveResult
h.media();                      // the <video> playing now
await h.refresh();
h.destroy();
```

| Member | Type | Null until |
|---|---|---|
| `ready` | `Promise<AttachHandle>` | - |
| `player` | `PlayerInfo` | ready |
| `degraded` | `DegradedInfo` | ready, and after it unless degraded |
| `session` | `SubtitleSession` | ready |
| `media()` | `HTMLVideoElement` | - |
| `refresh()` | `Promise<ResolveResult>` | - |
| `select(candidate)` | `Promise<void>` | - |
| `tracks()` | `Candidate[]` | empty until first resolve |
| `current()` | `ResolveResult` | first resolve |
| `destroy()` | `void` | - |

`player.via`: `named`, `instance`, `element`, `ref`, `descend`, `ascend`, `native`.

## Options

```js
attachSubtitleDb(player, {
  hint: { imdbId: 'tt0133093' }, // exact identity; otherwise inferred
  languages: ['en', 'fr'],       // best first; otherwise alphabetical
  autoSelect: true,              // show one; otherwise offer only
  player: 'plyr',                // force a binding
  formats: ['vtt'],              // what the player renders natively
  convert: true,                 // srt, ass, ssa to WebVTT in the browser
  maxTracks: 30,
  strict: false,                 // throw rather than degrade
});
```

Dropping one of the first three is the usual reason nothing appears.

Also accepted: `hearingImpaired`, `limit`, `apiBase`, `clientName`, `fetch`,
`cacheTtlMs`, `maxRequests`, `onResolved`, `onSelected`, `onDegraded`, `onError`.
Defaults in [docs/documentation.md](docs/documentation.md).

## Packages

| Package | For |
|---|---|
| `@subtitledb/players` | Sixteen bindings, one call |
| `@subtitledb/html5` | Bare `<video>` and its track list |
| `@subtitledb/artplayer` | ArtPlayer's own plugin shape |
| `@subtitledb/core` | Client, identify, filename, match, convert, cache |

```js
import {
  attachSubtitleDb, attachedTo, observeSubtitleDb, resolvePlayer, findPlayer,
  playerFor, findVideo, isVideoElement, detectBinding, bindingByName, BINDINGS,
  ownerOf, looksOwned, OWNER_CLASSES,
} from '@subtitledb/players';

import {
  createClient, SubtitleDbClient, createSession, SubtitleSession, findSubtitles,
  similarity, candidateLabel, identify, elementIdentity, isResolvable,
  parseFilename, basename, toVtt, srtToVtt, assToVtt, subtitleMime, CONVERTIBLE,
  SingleFlightCache, handleFor, handleForAny, registerHandle, languageName,
  hasLanguageName, normaliseImdb, backoffMs, EMPTY_RESULT, DEFAULT_API_BASE,
} from '@subtitledb/core';
```

## Scripts

```bash
npm test              # unit, hermetic, no network
npm run test:live     # contract tests against the real API
npm run typecheck     # types, plus the stray-build check
npm run build         # all four packages
npm run vendor        # built packages -> examples/vendor
npm run serve         # localhost:4173
npm run e2e           # Playwright over the examples
npm run lint          # Biome
npm run lint:fix      # Biome, writing fixes
```

## More

- [docs/documentation.md](docs/documentation.md) - options, handle, load patterns, limits
- [docs/players.md](docs/players.md) - every player, which binding, what was run
- [examples/minimal.html](examples/minimal.html) - smallest working page
- [subtitledb-stremio](https://github.com/thesubtitledb/subtitledb-stremio) - hosted addon, not a plugin
