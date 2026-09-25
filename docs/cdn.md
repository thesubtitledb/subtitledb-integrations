# The script tag

One file from `cdn.thesubtitledb.org`, one call, and subtitles are on the video. No
build step, no install, no import map, no account and no key.

- [The page](#the-page)
- [As a module](#as-a-module)
- [What gets downloaded](#what-gets-downloaded)
- [The handle](#the-handle)
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

<script src="https://cdn.thesubtitledb.org/latest/subtitle-finder.js"></script>
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
  import { attach } from 'https://cdn.thesubtitledb.org/latest/subtitle-finder.esm.js';

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
| `subtitle-finder.js` / `subtitle-finder.esm.js` | always | ~1.8 KB |
| the shared core | on the first `attach()` | ~10 KB |
| the element engine | the target is a plain `<video>` | ~0.1 KB |
| the player bindings | the target is a player, or a player owns the element | ~6 KB |

So a page with a bare `<video>` costs about 12 KB and never downloads the sixteen
bindings or the resolver that picks between them. A page with a player costs about
18 KB. The split is decided by looking at the target, and it errs towards fetching the
bindings: a `<video>` that Video.js has taken over is still a `<video>`, and putting a
plain text track on one publishes something the player renders nothing from.

Nothing subtitle-related is downloaded until a selection is made, and no request is
made at all until you call `attach`.

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

## Pinning a version

`latest/` is what the examples use and what most pages should. It is cached for five
minutes, so a fix reaches your page the same day.

Every release is also published at an immutable path, which never changes and is
cached for a year:

```html
<script src="https://cdn.thesubtitledb.org/v/0.2.0/subtitle-finder.js"></script>
```

Published versions are listed at
[`/versions.json`](https://cdn.thesubtitledb.org/versions.json), and each one carries
a `/v/<version>/manifest.json` giving the exact byte size and a `sha384` hash of both
entry files, so you can add Subresource Integrity:

```html
<script
  src="https://cdn.thesubtitledb.org/v/0.2.0/subtitle-finder.js"
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
<script src="/assets/subtitle-finder.js"></script>
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
