# @subtitledb/core

A client for [The Subtitle Database](https://thesubtitledb.org), a free subtitle API for films and series in over 100 languages. Install it and call it. No account and no key.

No dependencies. Runs in browsers and Node 20 or newer. TypeScript types included.

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

`hint` takes an IMDb or TMDB id, or a title and year, plus a season and episode for a series. Add the video's release name as `release` and the results that match its timing come first.

## What it does

| Call | |
|---|---|
| `query()` | Finds the subtitles for what is playing and ranks them. Nothing downloads until you call `load()`. |
| `load()` | Downloads one result. With `convertTo: 'vtt'` it converts SRT and ASS to WebVTT. `offsetMs` shifts the timings and `fps` changes the frame rate. |
| `createClient()` | The API itself. `byImdb`, `byTmdb`, `byTitle`, `byReleasename`, `byInfohash` and `bySubid` each return a title with its subtitles. |
| `parseFilename()` | Reads the title, year, season, episode and release from a video file name. |
| `toVtt()`, `shift()`, `rescale()` | The conversion and timing helpers on their own. |

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
| Downloads | 200 an hour per IP address | 10,000 a day |
| Text search | Not included | `client.search()` |

```js
const client = createClient({ key: process.env.SUBTITLEDB_KEY });
const { results } = await client.search('breaking bad', { lang: 'en' });
```

The key goes in a request header. Use it on a server, not in page code, where anyone can read it.

The playback debugger for your own site takes its own debug key, from the Debugger tab at [thesubtitledb.org/developer](https://thesubtitledb.org/developer). It reports startup time, stalls and errors from your viewers.

## More

- API reference: [thesubtitledb.org/developer](https://thesubtitledb.org/developer)
- Plugins for Kodi, Stremio, Bazarr, VLC, Jellyfin and Emby: [thesubtitledb.org/developer/integrations](https://thesubtitledb.org/developer/integrations)
- Discord: [discord.gg/KyaGQ4jNx7](https://discord.gg/KyaGQ4jNx7)

MIT licence.
