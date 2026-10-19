# subtitledb-integrations

Subtitles from [TheSubtitleDB](https://thesubtitledb.org) in web video players and media
servers. This repo holds the script tag, the JavaScript packages behind it, and plugins
for Jellyfin, Emby, Kodi, VLC and Bazarr. None of them needs a key or an account.

## Script tag

No install and no key. Add the script, point it at the player, and the subtitles appear in
the player's captions menu.

```html
<video id="v" controls src="film.mp4"></video>
<script src="https://cdn.thesubtitledb.org/latest/subtitle-helper.js"></script>
<script>
  SubtitleDB.attach(document.getElementById('v'), {
    hint: { imdbId: 'tt0133093' },
    languages: ['en'],
    autoSelect: true,
  });
</script>
```

The script is about 3 KB gzipped and loads player code only when the page needs it. Use
`/v/<version>/` in place of `/latest/` to pin a version; `latest/subtitle-helper.esm.js`
is the same build as an ES module. [docs/cdn.md](docs/cdn.md) covers pinning, CSP,
self-hosting and the debugger.

### Every option

```js
SubtitleDB.attach(player, {
  hint: { imdbId: 'tt0133093' },
  languages: ['en', 'fr'],
  autoSelect: 'locale',
  hearingImpaired: false,
  maxTracks: 30,
  limit: 100,
  convert: true,
  formats: ['vtt'],
  player: 'videojs',
  strict: false,
  transcribe: false,
  cacheTtlMs: 300000,
  maxRequests: 12,
  apiBase: 'https://api.thesubtitledb.org',
  clientName: 'my-site',
  fetch: window.fetch,
  debug_key: 'sdbg_...',
  onResolved(result) {},
  onSelected(loaded) {},
  onDegraded(info) {},
  onError(err) {},
});
```

| Option | Default | What it does |
|---|---|---|
| `hint` | read from the page | What is playing: `{ imdbId }`, `{ tmdbId }`, or `{ title, year, season, episode }`. Left out, it is read from the video's source and the page |
| `languages` | every language | Languages to fetch, best first |
| `autoSelect` | off | Show a subtitle without the viewer picking one: `true` for the best match, `'locale'` for the viewer's own languages, or a code such as `'en'` |
| `hearingImpaired` | `false` | Rank hearing impaired subtitles first |
| `maxTracks` | `30` | Most subtitles offered in the menu |
| `limit` | `100` | Subtitles asked for per language |
| `convert` | `true` | Convert srt, ass and ssa to WebVTT in the browser |
| `formats` | `['vtt']` | Formats the player renders itself. ArtPlayer adds srt, ass and ssa |
| `player` | detected | Name the player binding instead of detecting it |
| `strict` | `false` | Throw when a player is found but its captions menu cannot be reached |
| `transcribe` | `false` | Speech to text on the device when nothing matches. See [transcription](docs/documentation.md#transcription) |
| `cacheTtlMs` | `300000` | How long a lookup is reused, in milliseconds |
| `maxRequests` | `12` | Most network calls for the life of the attach |
| `apiBase` | `https://api.thesubtitledb.org` | The API to call |
| `clientName` | none | Sent as `client` on lookups, so we can tell your site apart |
| `fetch` | `window.fetch` | Your own fetch |
| `debug_key` | none | Script tag only. Reports this video to the [playback debugger](docs/cdn.md#playback-debugger) |
| `onResolved` | none | Called after every lookup, including one that found nothing |
| `onSelected` | none | Called when a subtitle is fetched and handed to the player |
| `onDegraded` | none | Called when a player is found but its captions menu is not |
| `onError` | none | Called on every failure. Errors never escape `attach` |

A lookup offers subtitles and shows none until `autoSelect` picks one, `select()` is
called, or the viewer turns one on.

### Methods

| `SubtitleDB.` | What it does |
|---|---|
| `attach(target, options)` | Adds subtitles to the player and returns a [handle](#handle) |
| `query(options)` | The ranked subtitles as data, each with `url`, `label`, `language`, `load()`, `blobUrl()` and `track()` |
| `get(options)` | The best match, already loaded, or `null` |
| `toBlobUrl(loaded)`, `toTrack(loaded)` | A loaded subtitle as an object URL or a `<track>` |
| `debug(key, options)` | Reports every video on the page to the playback debugger |
| `preload()` | Fetches the player code ahead of time |
| `setBasePath(path)` | Loads the code from your own copy of the files |
| `version` | The version that loaded |

```js
const sub = await SubtitleDB.get({ hint: { imdbId: 'tt0133093' }, convertTo: 'vtt' });
if (sub) video.append(sub.track);
```

`query` and `get` take `hint`, `languages`, `hearingImpaired` and `limit`, and convert on
load with `convertTo: 'vtt'`, `encoding`, `offsetMs`, `fps: { from, to }` and `cues: true`.

## Handle

```js
const handle = SubtitleDB.attach(player, options);

await handle.ready;          // script tag only: the player code has loaded
handle.player;               // { name, label, untested, via }
handle.degraded;             // null, or the player that was seen but not reached
handle.session;              // the lookup state underneath
handle.media();              // the <video> playing now
handle.tracks();             // the subtitles on offer, in menu order
handle.current();            // the last lookup's result
await handle.select(track);  // fetch, convert and show one
await handle.refresh();      // look up again
handle.destroy();            // remove the tracks and stop
```

## Players

The binding is picked from the object you pass. One call covers Video.js, Shaka, Plyr,
Vidstack, DPlayer, Clappr, xgplayer, MediaElement.js, OpenPlayerJS, Media Chrome,
ArtPlayer, Bitmovin, Flowplayer, THEOplayer, JW Player and a bare `<video>`, which is
also how hls.js and dash.js are served.

```js
attach(video);                    // a <video>
attach(player);                   // a player instance
attach(container);                // the element around it
attach(ref);                      // a React or Vue ref
attach({ plyr });                 // plyr-react
attach({ player });               // @videojs-player/vue
attach({ player, videoElement }); // shaka-player-react
```

[docs/players.md](docs/players.md) lists every player and what was tested on each.

## Packages

The script tag is built from these packages. `@subtitledb/core` is on npm; build the
rest from this repo.

### @subtitledb/core

```bash
npm i @subtitledb/core
```

```js
import { createClient } from '@subtitledb/core';

const sdb = createClient({ client: 'my-app/1.0' });

await sdb.byImdb('tt0133093', { lang: 'en' }); // 133093 works too
await sdb.byTmdb(603, { type: 'movie' }); // /v1/by-tmdb/movie/603, or type: 'tv'
await sdb.byTitle('the matrix');
await sdb.byReleasename('The.Matrix.1999.1080p.BluRay.x264-AMIABLE');
await sdb.byInfohash('0123456789abcdef0123456789abcdef01234567');
await sdb.bySubid(1775434752);                 // the title a subtitle belongs to
await sdb.fetchSubtitleText(subtitle);         // { text, format }, as stored
sdb.downloadUrl(subtitle);                     // the address fetchSubtitleText reads
await sdb.health();
sdb.posterUrl('/abc.jpg', 'w780');

// Needs a key from thesubtitledb.org/account/keys
const keyed = createClient({ key: process.env.SUBTITLEDB_KEY });
await keyed.search('the matrix', { lang: 'en' });
```

Every call works without a key except `search`, which needs one, sent as a Bearer
header; keep it on a server. Lookups have no rate limits; downloads allow 1,000 an
hour without a key and 100,000 a day with one.

A lookup returns `{ title, subtitles: { total, limit, offset, items } }`. `byTitle`,
`byReleasename`, `bySubid` and `byInfohash` also say what they matched, in `match`,
`subtitle` or `torrent`. Every lookup takes `lang` (up to 16, comma separated),
`format`, `sort` (`lang`, `cues` or `newest`), `limit` (up to 100),
`offset`, `response_class` (`minimal`, `standard`, `detailed` or `full`) and `signal`,
and all but `bySubid` take `season` and `episode`. Client options are `apiBase`,
`client`, `downloadClient`, `antispamId`, `key`, `timeoutMs` (10000), `retries` (2) and
`fetch`.

A failed request throws `SubtitleDbError` with `status` and `code`, and an aborted
`signal` throws `SubtitleDbAbort`. Only a 5xx or a network failure is retried; an overloaded API answers 503 and its Retry-After sets the wait. An
IMDb id the index does not know answers 404 `not_found`, so it throws. An id with
subtitles filed under it but no title behind them answers with an empty `title.name`.

Core also exports what `attach` is built from: the ranking (`findSubtitles`, `query`,
`createSession`), page and file name identification (`identify`, `parseFilename`),
language codes, format conversion (`toVtt`, `decodeBytes`, cue `shift` and `rescale`),
the request cache and the error classes; `packages/core/src/index.ts` lists each one.

### @subtitledb/players

```js
import { attachSubtitleDb, attachedTo, observeSubtitleDb } from '@subtitledb/players';

attachSubtitleDb(player, options);         // what SubtitleDB.attach runs
attachedTo(target);                        // the live handle for a player or element
// every video under root, now and as they are added
const watcher = observeSubtitleDb({ root, onAttach, ...options });
watcher.handles(); watcher.stop(); watcher.destroy();
```

Also exported: each binding by name (`videojs`, `shaka`, `plyr` and the rest), the list
of them as `bindings` or `BINDINGS`, and `bindingByName`, `detectBinding`, `findPlayer`,
`playerFor`, `resolvePlayer`, `findVideo`, `isVideoElement`, `ownerOf`, `looksOwned` and
`OWNER_CLASSES`.

### @subtitledb/html5 and @subtitledb/artplayer

```js
import { attachSubtitleDb } from '@subtitledb/html5';
attachSubtitleDb(video, {
  disabled: true,                  // add tracks off and let the viewer turn one on
  onTracks(tracks, candidates) {}, // the <track> elements changed
  onShow(track, index, loaded) {}, // a track has its text and is showing
});

import { subtitleDbPlugin } from '@subtitledb/artplayer';
new Artplayer({ container, url, plugins: [subtitleDbPlugin({ languages: ['en'] })] });
```

`@subtitledb/html5` is the smallest build, for a bare `<video>` only. The ArtPlayer
package adds its own settings menu and also exports `attachSubtitleDb(art, options)`.

### @subtitledb/transcribe

The engines behind `transcribe`: `runTranscription`, `runInWorker`, `spawnWorker`,
`engineProgram`, `transformersProgram` and `whisperCppProgram` (with `TRANSFORMERS_CDN`,
`WHISPER_CPP_CDN` and `WHISPER_CPP_MODELS`), the audio steps `extractAudio`, `downmix`,
`resampleLinear` and `TARGET_RATE`, the output steps `cuesToVtt` and `formatTimestamp`,
and `TranscribeError`.

### @subtitledb/debug

The playback debugger behind `debug`: `watch(video, options)` for one video,
`watchPage(options)` for every video on a page, `looksLikeKey` and `KEY_PATTERN` for a
debugger key, `toLoadId`, the report bits in `FLAGS`, the two storage keys it writes
(`OUTBOX` and `VISITOR`), and `resetDebug` for tests.

### @subtitledb/loader

The script tag itself, built into the files cdn.thesubtitledb.org serves.

## Plugins

| Host | Install and settings |
|---|---|
| Jellyfin 10.10+ and Emby 4.8+ | [plugins/dotnet](plugins/dotnet/README.md) |
| Kodi 19+ | [plugins/kodi](plugins/kodi/README.md) |
| VLC 3 | [plugins/vlc](plugins/vlc/README.md) |
| Bazarr | [plugins/bazarr](plugins/bazarr/README.md) |

They all rank by the same rules, tested against one shared file,
`plugins/shared/match-cases.json`. [plugins/hosts](plugins/hosts/README.md) runs each
plugin inside its real application. The Stremio addon lives in
[subtitledb-stremio](https://github.com/thesubtitledb/subtitledb-stremio).

## Releases

CI builds each release from the commit it names, after every test passes, and publishes
it with a `SHA256SUMS` and a build attestation. A release is made when a version
changes, and a published one never changes.

| Tag | Files | Version from |
|---|---|---|
| `loader-v*` | everything cdn.thesubtitledb.org serves for that version, zipped | `packages/loader/package.json` |
| `jellyfin-v*` | the plugin zip and the repository `manifest.json` | `plugins/dotnet/Directory.Build.props` |
| `emby-v*` | the plugin zip | the same |
| `kodi-v*` | the add-on zip | the add-on's `addon.xml` |
| `vlc-v*` | `subtitledb.lua` | `S.VERSION` in that file |
| `bazarr-v*` | the provider, the shared client and `install.py` | `VERSION` in `plugins/bazarr/provider.py` |

The CDN serves the release files unchanged, so either copy verifies:

```bash
curl -sO https://cdn.thesubtitledb.org/v/<version>/subtitle-helper.js
gh attestation verify subtitle-helper.js --repo thesubtitledb/subtitledb-integrations
```

## Build and test

```bash
npm install
npm run build        # every package
npm test             # unit tests, no network
npm run test:live    # contract tests against the real API
npm run typecheck
npm run lint         # Biome; lint:fix writes the fixes
npm run vendor       # built packages into examples/vendor
npm run serve        # the examples on localhost:4173
npm run e2e          # Playwright over the examples
npm run build:cdn    # the CDN files, into cdn/
npm run serve:cdn    # cdn/ on localhost:4174
```

```bash
ruff check .
(cd plugins/python && python -m pytest)
(cd plugins/bazarr && python -m pytest)
(cd plugins/kodi && python -m pytest && python build.py)
(cd plugins/dotnet && dotnet test SubtitleDb.sln && python -m pytest)
(cd plugins/vlc && tests/get-lua.sh && tests/.lua/bin/lua tests/run.lua)
```

[docs/testing.md](docs/testing.md) lists every suite and the CI job that runs it.

## More

- [docs/documentation.md](docs/documentation.md): every option and load pattern in detail
- [docs/players.md](docs/players.md): each player and its binding
- [docs/cdn.md](docs/cdn.md): the script tag, the debugger, pinning, CSP and self-hosting
- [examples/minimal.html](examples/minimal.html) and
  [examples/cdn.html](examples/cdn.html): the smallest working pages
