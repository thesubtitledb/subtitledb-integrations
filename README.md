# subtitledb-integrations

Subtitles from [TheSubtitleDB](https://thesubtitledb.org) in web video players and media
servers. This repo holds the script tag, the JavaScript packages behind it, and plugins
for Jellyfin, Emby, Kodi, VLC and Bazarr. None of them needs a key or an account.

## Script tag

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

The script is about 3 KB gzipped and loads player code only when the page needs it. The
same build is an ES module at `latest/subtitle-helper.esm.js`. Use `/v/<version>/` in
place of `/latest/` to pin a version.

| `SubtitleDB.` | What it does |
|---|---|
| `attach(target, options)` | Adds subtitles to the player's captions menu and returns a [handle](#handle) |
| `query(options)` | The ranked subtitles as data, each with `url`, `label`, `language`, `load()`, `blobUrl()` and `track()` |
| `get(options)` | The best match, already loaded, or `null` |
| `toBlobUrl(loaded)`, `toTrack(loaded)` | A loaded subtitle as an object URL or a `<track>` |
| `debug(key, options)` | Reports playback of every video on the page to the [playback debugger](docs/cdn.md#playback-debugger) |
| `preload()` | Fetches the player code ahead of time |
| `setBasePath(path)` | Loads the code from your own copy of the files |
| `version` | The version that loaded |

```js
const sub = await SubtitleDB.get({ hint: { imdbId: 'tt0133093' }, convertTo: 'vtt' });
if (sub) video.append(sub.track);
```

`query` and `get` take `hint`, `languages`, `hearingImpaired` and `limit`. They convert
on load with `convertTo: 'vtt'`, `encoding`, `offsetMs`, `fps: { from, to }` and
`cues: true`. [docs/cdn.md](docs/cdn.md) covers pinning, CSP, self-hosting and the
debugger.

## Options

`attach` takes the same options for every player:

```js
SubtitleDB.attach(player, {
  // or { tmdbId }, or { title, year, season, episode }; read from the page if left out
  hint: { imdbId: 'tt0133093' },
  languages: ['en', 'fr'],       // best first
  autoSelect: true,              // or 'locale', or a code such as 'en-US'
  hearingImpaired: false,        // rank hearing impaired subtitles first
  maxTracks: 30,                 // most subtitles offered
  limit: 100,                    // subtitles asked for per language, 100 per request
  convert: true,                 // srt, ass and ssa to WebVTT in the browser
  formats: ['vtt'],              // what the player renders itself; ArtPlayer adds srt, ass, ssa
  player: 'videojs',             // skip detection
  strict: false,                 // throw when a player is found but its menu cannot be reached
  transcribe: false,             // speech to text on the device when nothing matches
  cacheTtlMs: 300000,            // how long a lookup is reused
  maxRequests: 12,               // network calls for the life of the attach
  apiBase: 'https://api.thesubtitledb.org',
  clientName: 'my-site',         // sent as `client` on lookups
  fetch: window.fetch,
  debug: 'sdbg_...',             // script tag only: the debugger for this video
  onResolved(result) {},         // after every lookup, also one that found nothing
  onSelected(loaded) {},         // a subtitle was fetched and handed to the player
  onDegraded(info) {},           // a player was found but its captions menu was not
  onError(err) {},
});
```

`transcribe: true` runs Whisper in the browser through transformers.js. It also takes
`{ when, engine, model, task, device, language, source, onProgress }`. Nothing downloads
until a viewer picks the transcription. See
[docs/documentation.md](docs/documentation.md#transcription).

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

A lookup offers subtitles and shows none. One shows when `autoSelect` picks it, when
`select()` is called, or when the viewer turns it on in the player's menu.

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

The script tag is built from these packages. They are not on npm, so build them from
this repo.

### @subtitledb/core

```js
import { createClient } from '@subtitledb/core';

const sdb = createClient({ client: 'my-app/1.0' });

await sdb.byImdb('tt0133093', { lang: 'en' }); // 133093 works too
await sdb.byTmdb(603);
await sdb.byTitle('the matrix');
await sdb.byReleasename('The.Matrix.1999.1080p.BluRay.x264-AMIABLE');
await sdb.byInfohash('0123456789abcdef0123456789abcdef01234567');
await sdb.bySubid(1775434752);                 // the title a subtitle belongs to
await sdb.fetchSubtitleText(subtitle);         // { text, format }, as stored
sdb.downloadUrl(subtitle);                     // the address fetchSubtitleText reads
await sdb.health();
sdb.posterUrl('/abc.jpg', 'w780');
```

A lookup returns `{ title, subtitles: { total, limit, offset, items } }`. `byTitle`,
`byReleasename`, `bySubid` and `byInfohash` also say what they matched, in `match`,
`subtitle` or `torrent`. Every lookup takes `lang` (up to 16, comma separated),
`format`, `sort` (`lang`, `downloads`, `cues` or `bytes`), `limit` (up to 100),
`offset`, `response_class` (`minimal`, `standard`, `detailed` or `full`) and `signal`,
and all but `bySubid` take `season` and `episode`. Client options are `apiBase`,
`client`, `downloadClient`, `antispamId`, `timeoutMs` (10000), `retries` (2) and
`fetch`.

A failed request throws `SubtitleDbError` with `status` and `code`, and an aborted
`signal` throws `SubtitleDbAbort`. Only a 429, a 5xx or a network failure is retried. An
IMDb id the index does not know returns an empty `title.name` rather than a 404.

```js
// the ranked list attach uses
findSubtitles({ client, hint, languages, formats, hearingImpaired, limit });
candidateLabel(candidate);      // 'English - HI - The.Matrix.1999.1080p.BluRay'
query(options);                 // what SubtitleDB.query wraps
createSession(options);         // the lookup state behind a handle
identify({ config, element, src, doc }); // what is playing, from ids, the element or the file name
elementIdentity(video);         // the options identify reads off a <video>
isResolvable(hint);             // is there enough to look anything up
parseFilename(name);            // title, year, season, episode, group, tags, container
basename(pathOrUrl);
similarity(a, b);               // 0 to 1, how alike two release names are
languageName('en');             // 'English'
hasLanguageName('pb');          // true
normaliseImdb(133093);          // 'tt0133093'
backoffMs(attempt, retryAfter); // the retry wait, honouring Retry-After
toVtt(text, 'srt');             // also srtToVtt and assToVtt; CONVERTIBLE lists the formats
subtitleMime('ass');            // 'text/x-ssa'
decodeBytes(bytes, 'auto');     // bytes to text in their own charset
serialize(rescale(shift(parseVtt(vtt), -500), 23.976, 25)); // cue edits
new SingleFlightCache({ ttlMs, maxEntries }); // get, set, pending, resolve(key, fn), delete, clear
```

Core also exports `SubtitleDbClient`, `SubtitleSession`, `ConvertError`,
`UnknownPlayerError`, `PlayerNotReachableError` and `DEFAULT_API_BASE`; the handle
registry the adapters share
(`registerHandle`, `handleFor`, `handleForAny`, `EMPTY_RESULT`); and the transcription
contract (`resolveTranscribe`, `syntheticCandidate`, `DEFAULT_MODELS`, `SYNTHETIC_ID`).

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
| `bazarr-v*` | the provider, the shared client and `install.py` | `plugins/python/pyproject.toml` |

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
