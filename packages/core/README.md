# @subtitledb/core

A client for [The Subtitle Database](https://thesubtitledb.org), a free subtitle API for films and series in over 100 languages. Install it and call it. No account and no key.

No dependencies. Runs in browsers and Node 20.3 or newer. TypeScript types included. It is an ES module: `import` it, or `require()` it on Node 22.12 or 20.19 and newer, which load ES modules with `require()`. On older Node use `await import('@subtitledb/core')`.

## Install

```bash
npm i @subtitledb/core
```

## Get a subtitle

```js
import { query } from '@subtitledb/core';

const { results } = await query({
  hint: { imdbId: 'tt0944947', season: 1, episode: 1 },
  languages: ['en'],
  convertTo: 'vtt',
});

const sub = await results[0].load();
// { text, format: 'vtt', language: 'en', label }
```

`hint` takes an IMDb or TMDB id, or a title and year, plus a season and episode for a series. A series' own IMDb id works too, as `seriesImdbId` with a season and episode. TMDB numbers films and shows separately, so give a TMDB id its type: `{ tmdbId: 1396, tmdbType: 'tv' }`. A hint with a season or episode is taken as `tv`. Add the video's release name as `release` and the results that match its timing come first. `languages` takes language tags: `en-US` asks for `en`, `pt-BR` for `pb`, `zh-TW` for `zt`, `es-419` or `es-MX` for `ea`.

`query()` throws a `SubtitleDbError` when the API refuses the request, the hint has nothing to look up by, or no title matches the hint (`not_found`). `code` is the API's own code (`bad_request`, `not_found`, `rate_limited`) and `message` its message. A title with no subtitles in the languages asked for returns no results.

## What it does

| Call | |
|---|---|
| `query()` | Finds the subtitles for what is playing and ranks them. Nothing downloads until you call `load()`. |
| `load()` | Downloads one result. With `convertTo: 'vtt'` it converts SRT and ASS to WebVTT. `offsetMs` shifts the timings and `fps` changes the frame rate; the offset is applied first, then the rescale, so it is given in the subtitle's own time. |
| `createClient()` | The API itself. `byImdb`, `byTmdb`, `byTitle`, `byReleasename`, `byInfohash` and `bySubid` each return a title with its subtitles. `byTmdb` takes `type: 'movie'` or `'tv'` and asks `/v1/by-tmdb/movie/:id` or `/v1/by-tmdb/tv/:id`; a season or episode implies `tv`. The untyped `/v1/by-tmdb/:id` is kept for existing callers. `sort` is `lang` (the default), `cues` or `newest`. |
| `parseFilename()` | Reads the title, year, season, episode and release from a video file name. |
| `localeLanguages()` | The browser's languages as the codes the corpus uses, best first: `pt-BR` gives `pb`, then `pt`. |
| `toVtt()` | Converts SRT or ASS text to WebVTT. |
| `parseVtt()`, `shift()`, `rescale()`, `serialize()` | Timing helpers. `shift()` and `rescale()` take the cues from `parseVtt()`, not text. |

```js
import { createClient } from '@subtitledb/core';

const client = createClient();
const { title, subtitles } = await client.byImdb('tt0133093', { lang: 'en' });
const { text } = await client.fetchSubtitleText(subtitles.items[0]);
```

## Free, and more with a key

Everything above is free and needs no key. A free key from [your account](https://thesubtitledb.org/account/keys) adds:

| | No key | With a key |
|---|---|---|
| Lookups | 300 a minute per IP address | 1,800 a minute |
| Downloads | 200 an hour per IP address | 100,000 a day |
| Text search | Not included | `client.search()` |

```js
const client = createClient({ key: process.env.SUBTITLEDB_KEY });
const { results } = await client.search('breaking bad', { lang: 'en' });
```

The key goes in a request header, and only over https: with a key, an `http://` `apiBase` or `download_url` is refused with `bad_request`. Use it on a server, not in page code, where anyone can read it. A key that is wrong or revoked is refused with `bad_key`, never ignored. Every refusal is a `SubtitleDbError` whose `code` is the API's: `bad_key` on a lookup or download, `key_required` where a key is needed (`search()` throws it before sending anything), `rate_limited` past the allowance. A download that answers with something other than a subtitle is `download_failed`.

The playback debugger for your own site takes its own debug key, from the Debugger tab at [thesubtitledb.org/developer](https://thesubtitledb.org/developer). It reports startup time, stalls and errors from your viewers.

## More

- API reference: [thesubtitledb.org/developer](https://thesubtitledb.org/developer)
- Plugins for Kodi, Stremio, Bazarr, VLC, Jellyfin and Emby: [thesubtitledb.org/developer/integrations](https://thesubtitledb.org/developer/integrations)
- Discord: [discord.gg/KyaGQ4jNx7](https://discord.gg/KyaGQ4jNx7)

MIT licence.
