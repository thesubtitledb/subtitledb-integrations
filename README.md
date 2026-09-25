# subtitledb-integrations

Subtitles in the player's own captions menu, and a client for the API behind it.
[thesubtitledb.org](https://thesubtitledb.org)

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

No key, no signup, about 2 KB. The same for media servers and desktop players:
[plugins](#plugins) for Jellyfin, Emby, Kodi, VLC and Bazarr.

## Query the API

```js
import { createClient } from '@subtitledb/core';

const sdb = createClient({ client: 'my-app/1.0' });

const bundle = await sdb.byImdb('tt0133093', { lang: 'en', limit: 1 });
```

Real response, `subtitle_languages` cut after its first rows:

```json
{
  "title": {
    "imdb": "tt0133093",
    "tmdb_id": 603,
    "media_type": "movie",
    "name": "The Matrix",
    "year": 1999,
    "subtitle_count": 1092,
    "subtitle_languages": { "en": 139, "es": 66, "tr": 58, "ar": 55, "pl": 52 }
  },
  "subtitles": {
    "total": 139,
    "limit": 1,
    "offset": 0,
    "items": [
      {
        "id": 1775434752,
        "language": "en",
        "format": "srt",
        "cues": 1834,
        "duration_s": 8094,
        "bytes": 110564,
        "encoding": "utf-8",
        "release_name": "The.Matrix.1999.WEB-DL.TUBI",
        "hearing_impaired": false,
        "fps": null,
        "added_at": "2023-03-02T03:07:00Z",
        "download_url": "https://api.thesubtitledb.org/get/1775434752"
      }
    ]
  }
}
```

### Six ways in, one bundle out

```js
await sdb.byImdb('tt0133093');       // 133093, "133093" or "tt0133093"
await sdb.byTmdb(603);
await sdb.byTitle('the matrix');     // free text, server picks the top title
await sdb.byReleasename('The.Matrix.1999.1080p.BluRay.x264-AMIABLE');
await sdb.byInfohash('0123456789abcdef0123456789abcdef01234567');
await sdb.bySubid(1775434752);       // which title does this file belong to
```

Every one resolves to `{ title, subtitles }`. Four of them add a block saying how
they got there:

```js
(await sdb.byTitle('the matrix')).match;
// { name: 'The Matrix', imdb: 'tt0133093', score: 1 }

(await sdb.byReleasename('The.Matrix.1999.1080p.BluRay.x264-AMIABLE')).match;
// { sub_id: 7497274,
//   release_name: 'The.Matrix.1999.REMASTERED.1080p.BluRay.X264-AMIABLE',
//   score: 0.61, shared_tokens: 7 }

(await sdb.bySubid(1775434752)).subtitle;
// the subtitle row itself, alongside title: { imdb, name }

(await sdb.byInfohash(hash)).torrent;
// the torrent the hash belongs to
```

### One episode

```js
await sdb.byImdb('tt0903747', { season: 1, episode: 1, lang: 'en', limit: 1 });
```

```json
{
  "title": {
    "imdb": "tt0903747",
    "tmdb_id": 1396,
    "media_type": "tv",
    "name": "Breaking Bad",
    "year": 2008,
    "subtitle_count": 362,
    "subtitle_languages": { "id": 125, "ar": 43, "fa": 41, "en": 36, "pt": 25 }
  },
  "subtitles": {
    "total": 36,
    "limit": 1,
    "offset": 0,
    "items": [
      {
        "id": 8900892,
        "language": "en",
        "format": "srt",
        "cues": 813,
        "duration_s": 3533,
        "bytes": 52009,
        "encoding": "utf-8-sig",
        "release_name": "Breaking Bad S01E01 Pilot.DVDRip.HI.cc.en.SNY",
        "hearing_impaired": false,
        "fps": 29.97,
        "added_at": "2021-12-06T17:43:31Z",
        "download_url": "https://api.thesubtitledb.org/get/8900892"
      }
    ]
  }
}
```

Two things to read carefully here. A drilled episode does not echo `season` or
`episode` back: you asked, so you know. And `title` describes the **series**
(`media_type: 'tv'`, 362 files across 13 languages) while `subtitles` describes the
**episode** you drilled to (36 English).

### Parameters

```js
await sdb.byImdb('tt0133093', {
  lang: 'en',                  // one code, or up to 16 comma separated
  format: 'srt',
  sort: 'cues',                // 'lang' | 'downloads' | 'cues' | 'bytes'
  limit: 50,                   // API defaults to 20, caps at 100
  offset: 0,
  response_class: 'standard',  // 'minimal' | 'standard' | 'detailed' | 'full'
  season: 1,                   // every by* lookup except bySubid
  episode: 1,
  signal: controller.signal,
});
```

`lang` and `format` bite on a movie and on an episode drill. They are **ignored** on
a series or season bundle, which comes back whole by design.

`response_class` decides how much TMDB metadata rides on `title`:

```js
(await sdb.byImdb('tt0133093', { response_class: 'minimal' })).title;
// imdb, tmdb_id, media_type, name, year, subtitle_count, subtitle_languages

(await sdb.byImdb('tt0133093', { response_class: 'standard' })).title;
// the same, plus poster_path, backdrop_path, overview, original_title,
// release_date, genres, vote, runtime_min, tagline, original_language
```

### Errors

```js
import { SubtitleDbError, SubtitleDbAbort } from '@subtitledb/core';

try {
  await sdb.byInfohash('0123456789abcdef0123456789abcdef01234567');
} catch (e) {
  e instanceof SubtitleDbError; // true
  console.log(e.message, e.status, e.code);
}
```

```text
no title mapped to that infohash   404   not_found
```

A bad id never leaves the process:

```js
await sdb.byImdb('nope');
// SubtitleDbError: not an imdb id: nope   (status 0, code bad_request)
```

An IMDb id nobody has mapped does **not** 404. It answers with `name: ''`,
`tmdb_id: null` and whatever rows are filed under it, so check `title.name` before
you trust the list.

Only 429, 5xx and transport failures retry. An aborted `signal` throws
`SubtitleDbAbort`.

### The bytes

```js
const sub = bundle.subtitles.items[0];
const { text, format } = await sdb.fetchSubtitleText(sub);

format;        // 'srt'
text.length;   // 110190
text.slice(0, 40);
// '1\n00:00:03,036 --> 00:00:06,239\nCAPTIONI'
```

Returns the stored format untouched. It follows `download_url` exactly as the API
gave it, because the files host is allowed to move.

### Health and posters

```js
await sdb.health();
// { ok: true, clickhouse: 'up',
//   titles: 519754, indexed_subtitles: 10702424, tmdb_mappings: 160973 }

sdb.posterUrl('/abc.jpg');          // https://api.thesubtitledb.org/p/w342/abc.jpg
sdb.posterUrl('/abc.jpg', 'w780');  // https://api.thesubtitledb.org/p/w780/abc.jpg
sdb.posterUrl(null);                // null
```

### Client options

```js
createClient({
  apiBase: 'https://api.thesubtitledb.org',
  client: 'my-app/1.0',  // a query param, not a header: no CORS preflight
  timeoutMs: 10000,      // per attempt
  retries: 2,
  fetch: myFetch,
});
```

## Rank them for a player

```js
import { createClient, findSubtitles, candidateLabel } from '@subtitledb/core';

const result = await findSubtitles({
  client: createClient(),
  hint: { imdbId: 'tt0133093' },
  languages: ['en'],
  formats: ['vtt', 'srt'], // hard filter: what the player can actually render
  limit: 3,
});
```

`title` is the same block as above and `candidates` runs to three, both cut here:

```json
{
  "tier": "explicit-imdb",
  "unrenderable": 1,
  "wrongEpisode": 0,
  "title": { "imdb": "tt0133093", "name": "The Matrix", "year": 1999 },
  "candidates": [
    {
      "subtitle": {
        "id": 1693438976,
        "language": "en",
        "format": "srt",
        "cues": 1477,
        "hearing_impaired": true,
        "release_name": "The Matrix (1999) (1080p BluRay X265 HEVC 10bit AAC 7.1 Joy) [UTR]"
      },
      "score": 100,
      "reason": "preferred language en"
    }
  ]
}
```

```js
result.candidates.map(candidateLabel);
// [ 'English - HI - The Matrix (1999) (1080p BluRay X265 HEV',
//   'English - The.Matrix.1999.WEB-DL.TUBI' ]
```

`tier` names the rung that won: `explicit-imdb`, `explicit-tmdb`, `series-imdb` (the
series' id with a season and episode), `title`, or `manual` when nothing automatic
worked. `unrenderable` counts rows dropped for
format alone, `wrongEpisode` rows filed under a different episode.

## Helpers

```js
import {
  parseFilename,
  identify,
  similarity,
  languageName,
  subtitleMime,
  normaliseImdb,
  backoffMs,
} from '@subtitledb/core';

parseFilename('The.Matrix.1999.1080p.BluRay.x264-AMIABLE.mkv');
// { title: 'The Matrix', year: 1999, season: null, episode: null,
//   group: 'AMIABLE', tags: ['1080p', 'bluray', 'x264'],
//   container: 'mkv', release: 'The.Matrix.1999.1080p.BluRay.x264-AMIABLE' }

parseFilename('Breaking.Bad.S01E01.720p.WEB-DL.mkv');
// { title: 'Breaking Bad', year: null, season: 1, episode: 1,
//   group: null, tags: ['720p', 'web'], container: 'mkv', ... }

identify({ src: '/media/The.Matrix.1999.1080p.BluRay.x264.mkv' });
// { release: 'The.Matrix.1999.1080p.BluRay.x264', title: 'The Matrix',
//   year: 1999, source: 'filename' }

identify({ config: { imdbId: 'tt0133093' } });
// { imdbId: 'tt0133093', source: 'config' }

similarity(
  'The.Matrix.1999.1080p.BluRay.x264-AMIABLE',
  'The Matrix 1999 1080p BluRay x264 AMIABLE',
); // 1
similarity('The Matrix', 'Breaking Bad'); // 0

languageName('en');    // 'English'
languageName('fre');   // 'FRE'  table is 2-letter, unknown falls back to the code
subtitleMime('vtt');   // 'text/vtt'
subtitleMime('ass');   // 'text/x-ssa'
normaliseImdb(133093); // 'tt0133093'
backoffMs(0, null);    // ~150, then ~300, ~600
backoffMs(0, '5');     // 5000   Retry-After wins
```

```js
import { toVtt } from '@subtitledb/core';

toVtt('1\n00:00:01,000 --> 00:00:03,500\nHello there.\n', 'srt');
```

```text
WEBVTT

00:00:01.000 --> 00:00:03.500
Hello there.
```

```js
toVtt(text, 'sub'); // ConvertError: cannot convert sub to vtt
```

`CONVERTIBLE` is `srt`, `vtt`, `ass`, `ssa`. Everything else throws.

## Attach to a player instead

```js
import { attachSubtitleDb } from '@subtitledb/players';

const handle = attachSubtitleDb(player, {
  hint: { imdbId: 'tt0133093' },
  languages: ['en', 'fr'],
  autoSelect: true,
});

await handle.ready;
handle.player.name; // 'videojs'
handle.player.via;  // 'instance'
handle.tracks();    // Candidate[], menu order
await handle.select(handle.tracks()[0]);
handle.current();   // ResolveResult
handle.media();     // the <video> playing now
await handle.refresh();
handle.destroy();
```

It works out what you handed it:

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
`player.via` reports which route matched: `named`, `instance`, `element`, `ref`,
`descend`, `ascend`, `native`.

On top of the client options above it takes `convert` (srt, ass and ssa to WebVTT
in the browser, on by default), `maxTracks` (30), `strict` (throw rather than
degrade), `hearingImpaired`, and `onResolved`, `onSelected`, `onDegraded`,
`onError`.

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

## Plugins

| Host | Install |
|---|---|
| Jellyfin 10.10+ | Dashboard > Plugins > Repositories, add `https://cdn.thesubtitledb.org/plugins/jellyfin/manifest.json`, install SubtitleDB from the catalog, restart |
| Emby 4.8+ | Unzip [subtitledb-emby.zip](https://cdn.thesubtitledb.org/plugins/emby/subtitledb-emby.zip) into Emby's `plugins` directory, restart |
| Kodi 19+ | Settings > Add-ons > Install from zip file, with the zip from the newest `kodi-v` [release](https://github.com/thesubtitledb/subtitledb-integrations/releases) |
| VLC 3 | Copy `subtitledb.lua` from the newest `vlc-v` [release](https://github.com/thesubtitledb/subtitledb-integrations/releases) into VLC's `lua/extensions` directory |
| Bazarr | Unzip the newest `bazarr-v` [release](https://github.com/thesubtitledb/subtitledb-integrations/releases), run `python3 bazarr/install.py /path/to/bazarr` |

Each plugin's README covers its settings and what it does with what the host knows:
[dotnet](plugins/dotnet/README.md) (Jellyfin and Emby), [kodi](plugins/kodi/README.md),
[vlc](plugins/vlc/README.md), [bazarr](plugins/bazarr/README.md). They rank subtitles by
the same rules, and `plugins/shared/match-cases.json` is the one file every suite reads,
so the rules cannot drift apart language by language.

## Releases

Everything above that gets installed is built by this repository's CI, from the commit
the release names, after every test has passed. Each release carries a `SHA256SUMS`
and a build attestation signed by GitHub.

| Tag | Files |
|---|---|
| `loader-v*` | every file cdn.thesubtitledb.org serves for that version, zipped, and `SHA256SUMS` by path |
| `jellyfin-v*` | the plugin zip and the repository `manifest.json` |
| `emby-v*` | the plugin zip |
| `kodi-v*` | the add-on zip |
| `vlc-v*` | `subtitledb.lua` |
| `bazarr-v*` | the provider, the shared client and `install.py` |

The CDN serves the release files unchanged, so a file can be checked from either place:

```bash
curl -sO https://cdn.thesubtitledb.org/v/0.4.3/subtitle-finder.js
gh attestation verify subtitle-finder.js --repo thesubtitledb/subtitledb-integrations
```

A release is made when a version changes: `packages/loader/package.json`,
`plugins/dotnet/Directory.Build.props` (Jellyfin and Emby), the Kodi `addon.xml`,
`S.VERSION` in `subtitledb.lua`, and `plugins/python/pyproject.toml` (the shared client,
which is most of the Bazarr files). A published release cannot be changed.

## Build from source

```bash
git clone https://github.com/thesubtitledb/subtitledb-integrations
cd subtitledb-integrations
npm install && npm run build && npm run vendor
```

`vendor` writes ES modules to `examples/vendor`. Not on npm yet.

| Package | For |
|---|---|
| `@subtitledb/core` | The client above, plus identify, match, convert, cache |
| `@subtitledb/players` | Sixteen bindings, one call |
| `@subtitledb/html5` | Bare `<video>` and its track list |
| `@subtitledb/artplayer` | ArtPlayer's own plugin shape |
| `@subtitledb/transcribe` | On-device speech to text, offered when the index has nothing |
| `@subtitledb/loader` | The cdn.thesubtitledb.org script |

## Scripts

```bash
npm test              # unit, hermetic, no network
npm run test:live     # contract tests against the real API
npm run typecheck     # types, plus the stray-build check
npm run build         # every package
npm run vendor        # built packages -> examples/vendor
npm run serve         # localhost:4173
npm run e2e           # Playwright over the examples
npm run lint          # Biome
npm run lint:fix      # Biome, writing fixes
npm run build:cdn     # the cdn.thesubtitledb.org tree, into cdn/
npm run serve:cdn     # cdn/ on localhost:4174, a second origin on purpose
```

The plugins have their own toolchains:

```bash
ruff check .                                          # every Python tree at once
(cd plugins/python && python -m pytest)               # the shared client
(cd plugins/bazarr && python -m pytest)
(cd plugins/kodi   && python -m pytest && python build.py)
(cd plugins/dotnet && dotnet test SubtitleDb.sln && python -m pytest)
(cd plugins/vlc    && tests/get-lua.sh && tests/.lua/bin/lua tests/run.lua)
```

Those test each plugin against stubs. The Live hosts workflow installs each one into
Jellyfin, Emby, Kodi, VLC or Bazarr and downloads a subtitle through it: Actions >
Live hosts > Run workflow. [docs/testing.md](docs/testing.md) lists every suite, what it
proves and which CI job runs it.

## More

- [docs/documentation.md](docs/documentation.md) - every export, every option
- [docs/players.md](docs/players.md) - every player, which binding, what was run
- [docs/cdn.md](docs/cdn.md) - the script tag, what it downloads, pinning, CSP, self-hosting
- [examples/minimal.html](examples/minimal.html) - smallest working page
- [examples/cdn.html](examples/cdn.html) - the same with no build step
- [plugins/hosts](plugins/hosts/README.md) - each plugin run inside the real application
- [subtitledb-stremio](https://github.com/thesubtitledb/subtitledb-stremio) - hosted addon, not a plugin
