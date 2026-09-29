# The script tag

One file from `cdn.thesubtitledb.org`, one call, and subtitles are on the video. No
build step, no install, no import map, no account and no key.

- [The page](#the-page)
- [As a module](#as-a-module)
- [What gets downloaded](#what-gets-downloaded)
- [The handle](#the-handle)
- [Query API](#query-api)
- [Playback debugger](#playback-debugger)
- [Pinning a version](#pinning-a-version)
- [Content Security Policy](#content-security-policy)
- [Self-hosting](#self-hosting)
- [Including it twice](#including-it-twice)
- [What this is not](#what-this-is-not)

Everything about options, the candidate list, identification and cost is the same as
every other way of using these packages and lives in
[documentation.md](documentation.md). This page only covers what is different about
loading it from a URL.

## The page

```html
<video id="player" controls src="film.mp4"></video>

<script src="https://cdn.thesubtitledb.org/latest/subtitle-helper.js"></script>
<script>
  SubtitleDB.attach(document.getElementById('player'), {
    hint: { imdbId: 'tt0133093' },
    languages: ['en'],
    autoSelect: true,
  });
</script>
```

That is the whole integration. The three options are the ones worth setting:

- `hint` says what is playing. Without it, identity is worked out from the page and
  the filename, which works but is a guess.
- `languages` says which languages you want, best first. Without it you get the API's
  own order, which is alphabetical: ask for The Matrix and you get Arabic.
- `autoSelect` puts the top one on screen. Without it subtitles are offered and none
  is shown, because choosing is the viewer's job.

`attach` takes a player as happily as an element. Video.js, Plyr, Shaka, JW, Vidstack,
DPlayer, ArtPlayer and ten others are recognised from the shape of the object, so
there is nothing to configure and no plugin to register:

```html
<script>
  const player = videojs('my-video');
  SubtitleDB.attach(player, { hint: { imdbId: 'tt0133093' }, languages: ['en'], autoSelect: true });
</script>
```

The full list is in [players.md](players.md).

## As a module

```html
<script type="module">
  import { attach } from 'https://cdn.thesubtitledb.org/latest/subtitle-helper.esm.js';

  attach(document.getElementById('player'), {
    hint: { imdbId: 'tt0133093' },
    languages: ['en'],
    autoSelect: true,
  });
</script>
```

Same code, same options. The module build works out where it is from
`import.meta.url`, so it can be re-hosted, proxied or renamed and still find the rest
of itself.

## What gets downloaded

The script tag is about 2 KB over the wire. Everything else is fetched only if your
page turns out to need it.

| File | Fetched when | Gzipped |
|---|---|---|
| `subtitle-helper.js` / `subtitle-helper.esm.js` | always | ~1.8 KB |
| the shared core | on the first `attach()`, `query()` or `get()` | ~10 KB |
| the element engine | the target is a plain `<video>`, or a query | ~0.1 KB |
| the player bindings | the target is a player, or a player owns the element | ~6 KB |
| the debugger | a page passes a [debugger key](#playback-debugger) | ~5.6 KB |

So a page with a bare `<video>` costs about 12 KB and never downloads the sixteen
bindings or the resolver that picks between them. A page with a player costs about
18 KB. The split is decided by looking at the target, and it errs towards fetching the
bindings: a `<video>` that Video.js has taken over is still a `<video>`, and putting a
plain text track on one publishes something the player renders nothing from.

Nothing subtitle-related is downloaded until a selection is made, and no request is
made at all until you call `attach`, `query`, `get` or `debug`.

To spend the requests earlier, on a page that knows a player is coming:

```js
SubtitleDB.preload();
```

## The handle

`attach` returns the same handle as everywhere else, with one addition: it comes back
before the code behind it has loaded, so it also has `ready`.

```js
const handle = SubtitleDB.attach(player, options);

await handle.ready;          // the chunk has landed and the attach has run
handle.player.label;         // "Video.js"
```

Before `ready` settles, `tracks()` is empty and `current()` is null, which is what a
live handle answers before its first resolve anyway. `player`, `session` and
`degraded` are null until it settles, because there is no honest answer for them yet.
Calls made in the meantime are queued, not dropped, and that includes `destroy()`: a
component that unmounts while its chunk is still downloading tears down correctly.

## Query API

`attach` wires subtitles into a player for you. `query` does the opposite: it hands you
the subtitles as data so you can wire them into a player of your own. Same matching, same
corpus, no key. It needs 0.6.0 or later.

```js
const { results } = await SubtitleDB.query({
  hint: { imdbId: 'tt0133093' },
  languages: ['en', 'fr'],
});

for (const r of results) {
  r.url;       // absolute, downloadable, CORS-clean
  r.label;     // "English - 1386 lines"
  r.language;  // "en"
}
```

A result carries its URL and metadata and downloads nothing until you ask. When you want
the bytes, call one of its handles:

```js
const best = results[0];
const track = await best.track();  // a <track> element, ready to append
video.append(track);
```

`load()` returns `{ text, format }`, `blobUrl()` returns a same-origin object URL (yours
to revoke), and `track()` returns a `<track>` element. All three fetch and convert on
first use and cache the result, so calling two of them downloads once.

### Converting on the way out

Fold conversion into the query and every handle applies it:

```js
const { results } = await SubtitleDB.query({
  hint: { imdbId: 'tt0133093' },
  languages: ['en'],
  convertTo: 'vtt',               // srt, ass and ssa become WebVTT
  encoding: 'auto',               // decode non-UTF-8 bytes; auto sniffs a BOM
  offsetMs: -500,                 // shift every cue earlier by half a second
  fps: { from: 23.976, to: 25 },  // rescale for a frame-rate mismatch
  cues: true,                     // also return the parsed cues on load()
});
```

Any of `offsetMs`, `fps` or `cues` produces WebVTT, since they are applied to parsed
cues. With none of the convert options set, a result keeps its stored format.

### One line

`get` is `query` plus "load the best one":

```js
const sub = await SubtitleDB.get({ hint: { imdbId: 'tt0133093' }, convertTo: 'vtt' });
if (sub) video.append(sub.track);   // or sub.text, sub.blobUrl, sub.url
```

It returns the top result already loaded, or `null` when nothing matched.
`SubtitleDB.toBlobUrl(loaded)` and `SubtitleDB.toTrack(loaded)` turn a `load()` result
into a blob URL or a `<track>` directly, for when you kept the loaded bytes yourself.

Every query and download carries a per-page-load `antispam_id`, so abusive traffic can
be told from ordinary use. It is regenerated on each page load and identifies the page,
not the visitor.

## Playback debugger

The debugger reports how video plays on your own site: how long each play takes to
start, where it stalls, which errors it hits and how much was watched. You read it in
the [Debugger tab](https://thesubtitledb.org/developer/debugger) of the developer
portal, which is also where you enroll your domains and get a key. It needs 0.7.0 or
later.

A key is `sdbg_` and 24 letters or digits. It sits in your page, so it is not a
secret: it is only accepted from the domains you enrolled, and it is not an API key.

For one video, pass it to `attach`:

```js
SubtitleDB.attach(video, {
  hint: { imdbId: 'tt0133093' },
  languages: ['en'],
  debug: 'sdbg_...',
});
```

For every video on the page, including ones added later:

```js
const dbg = SubtitleDB.debug('sdbg_...');
await dbg.ready;  // rejects if the debugger's code could not load
dbg.stop();       // a last report for each video, then nothing
```

The `debug` option also reports what SubtitleDB matched and which subtitle was on, and
`destroy()` on the handle sends the last report before it lets go of the video.
`SubtitleDB.debug()` works on a page with no subtitles from us at all, but cannot see
a video inside a shadow root; pass that one to `attach` instead. A video is watched
once, however it was passed and however many copies of the script are on the page.

A key of the wrong shape makes `SubtitleDB.debug()` throw a `TypeError`. The `debug`
option reports it through `onError` and attaches the subtitles anyway. The name is
`debug` because `debugger` is a reserved word in JavaScript.

### What it sends

Without a key, nothing: no file, no storage and no request. With one, the debugger's
code is fetched alongside the rest, and each play sends a short report at the first
frame, every ten minutes of playback, on pause, and when the play ends, fails or
changes source, the tab is hidden or the page is closed. That is about four a play.

Each report is a `text/plain` POST to `api.thesubtitledb.org`, sent without cookies,
so the [CSP above](#content-security-policy) already covers it. It carries running
totals for the play, which only ever grow, so a report that arrives twice or late
changes nothing. Fields that are zero or empty are left out.

| Field | Meaning |
|---|---|
| `v` | Format version, 1. |
| `k` | Your key. |
| `l` | Page-load id, 16 hex characters, new on every page load. |
| `p` | The play within the page load, from 1. A replay after the end is a new play. |
| `s` | The report within the play, from 0. |
| `ps` | When the play started, in epoch seconds. |
| `u` | Visitor id, see [What it stores](#what-it-stores). |
| `pa` | The page's path and query string, up to 512 characters. |
| `im`, `tm`, `se`, `ep` | IMDb number, TMDB id, season and episode. Only with the `debug` option. |
| `du`, `li` | Length in seconds. `li` is 1 for a live stream, which has none. |
| `st` | Milliseconds from pressing play to the first frame. |
| `wa` | Milliseconds spent playing: not paused, stalled or seeking. |
| `un` | Distinct seconds played. A scene watched twice counts once, and a seek counts nothing. |
| `mp` | Furthest position reached while playing, in seconds. |
| `sk`, `pu` | Seeks and pauses. |
| `sn`, `sm` | Stalls after the first frame, and milliseconds stalled. |
| `er` | Highest media error: 1 aborted, 2 network, 3 decode, 4 source not supported. |
| `mh` | Tallest frame, in pixels. |
| `dr`, `fr` | Frames dropped and frames shown during the play. |
| `fl` | Flags, each set the first time it happens: 1 started, 2 ended, 4 fullscreen, 8 picture-in-picture, 16 cast, 32 muted, 64 autoplay. |
| `pl` | The player SubtitleDB recognised. |
| `ss`, `sl` | Where the subtitle on screen came from (`sdb`, `ai` for on-device transcription, `page` for a track of your own) and its language. |
| `sb`, `sw`, `si` | Milliseconds with a subtitle on screen, subtitle changes, and the SubtitleDB subtitle id. |
| `al` | Audio language, where the browser reports one. |
| `ev` | The play's trace, when your key keeps one. |

The trace is the play step by step, timed from when the video was first watched: its
source, length and size, what SubtitleDB offered, the first frame, pauses, seeks,
stalls, quality changes, subtitle changes, errors and the end. A source is its host and
path only, never its query string or fragment, where signed media URLs keep their
tokens. A trace keeps up to 150 steps and drops from the middle when it has more. It
goes only with a report that could be the play's last, and only for the plays your
key asks for: those that stalled or failed (the default), a percentage of plays, all
of them, or none. You choose in the portal.

### What it stores

Two localStorage entries, written only on a page that passes a key:

- `sdb_uid`: a random 16-character id and the time it was made, replaced after a
  year. It is combined with your site's name before it is kept, so one browser on two
  sites is two unrelated visitors.
- `sdb_dbg_ob`: reports not yet answered, the newest for each of up to five plays.
  The next page load on your site sends them again, and any older than a day are
  dropped unsent.

Where storage is blocked, no visitor id is sent and nothing is retried. The reports
still go.

## Pinning a version

`latest/` is what the examples use and what most pages should. It is cached for five
minutes, so a fix reaches your page the same day.

Every release is also published at an immutable path, which never changes and is
cached for a year:

```html
<script src="https://cdn.thesubtitledb.org/v/0.7.0/subtitle-helper.js"></script>
```

Versions before 0.5.0 keep the name they shipped with: `subtitle-finder.js`, or
`sdb.js` for 0.1.0. The old `latest/` names redirect to the new one.

Published versions are listed at
[`/versions.json`](https://cdn.thesubtitledb.org/versions.json), and each one carries
a `/v/<version>/manifest.json` giving the exact byte size and a `sha384` hash of both
entry files, so you can add Subresource Integrity:

```html
<script
  src="https://cdn.thesubtitledb.org/v/0.7.0/subtitle-helper.js"
  integrity="sha384-..."
  crossorigin="anonymous"
></script>
```

Take the hash from that release's manifest. Only the versioned files have one: the
`latest/` files are overwritten on every release, and a hash for a file that changes
is a hash that breaks the page holding it.

## Content Security Policy

If your page sets a CSP, it needs three things. This is the most common reason a
correct integration shows nothing:

```
script-src  https://cdn.thesubtitledb.org
connect-src https://api.thesubtitledb.org https://files.thesubtitledb.org
media-src   blob:
```

`media-src blob:` is not optional. Subtitles are handed to the player as a blob URL
rather than as a link to our origin, because a cross-origin `<track>` without
permissive CORS fails by rendering nothing at all rather than by reporting an error.

### On-device transcription

If you turn on `transcribe`, the engine and its model load from a CDN when a viewer
selects the transcription row, and the engine runs in a worker created from a blob.
That needs four more directives, and none of them apply until someone actually clicks
the row:

```
worker-src  blob:
script-src  https://cdn.jsdelivr.net
connect-src https://cdn.jsdelivr.net https://huggingface.co https://*.hf.co
```

`worker-src blob:` lets the engine run off the main thread. `script-src` covers the
engine module (transformers.js from jsDelivr). `connect-src` covers the model download
(the HuggingFace hub, and jsDelivr for the whisper.cpp engine). This is a deliberate
third-party exposure: a visitor who runs transcription fetches these bytes from
jsDelivr and HuggingFace. Nothing loads from them unless transcription is both enabled
and selected.

## Self-hosting

Copy the contents of a `/v/<version>/` directory onto your own server and point the
script tag at your copy. The loader works out where it is from the script element, so
if the entry and its chunks sit in the same directory nothing else is needed.

If they do not, say so before the first attach:

```html
<script src="/assets/subtitle-helper.js"></script>
<script>
  SubtitleDB.setBasePath('https://static.example.com/subtitledb/');
  SubtitleDB.attach(video, options);
</script>
```

Your copy still talks to `api.thesubtitledb.org`. There is nothing to run and nothing
to key.

## Including it twice

A page that loads this file twice, which is the ordinary case where a CMS theme and a
plugin both paste the snippet, runs one copy. The first one on the page keeps it; the
second reports a message through `onError` and forwards its calls to the first.

This matters because two copies do not share the bookkeeping that makes one player
mean one handle: you would get two subtitle sessions on one video, a captions menu
listing everything twice, and double the API traffic. If both copies pin different
versions, the older one wins, because it is the one already holding live handles.

## What this is not

It is not on npm, and this file is not a package. If your page has a build step,
[install from source](documentation.md#install) instead: your bundler will tree-shake
what you do not use, which this cannot do for you.

There is no auto-attach. Nothing happens until you call `attach`, so adding the script
tag to a page changes nothing on its own.
