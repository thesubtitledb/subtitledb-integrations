# Integration guide

Everything a host page needs: the call, the options, and what happens under every way
a page can load a player.

- [Words used here](#words-used-here)
- [Install](#install)
- [A page that works](#a-page-that-works)
- [The call](#the-call)
- [Configuration](#configuration)
- [The handle](#the-handle)
- [What a resolve gives you](#what-a-resolve-gives-you)
- [Load patterns](#load-patterns)
- [Identification](#identification)
- [What it costs](#what-it-costs)
- [Failure modes](#failure-modes)
- [Limits](#limits)

## Words used here

| Word | Means |
|---|---|
| binding | The small piece of code that talks to one player. Detected for you. |
| element path | Subtitles are added to the page's `<video>` as `<track>` elements. |
| api path | The player owns its text tracks, so subtitles go through the player's own API. Five players work this way: Video.js, Shaka, Vidstack, Bitmovin, THEOplayer. |
| resolve | Work out what is playing and ask the API which subtitles exist for it. No subtitle text is downloaded. |
| candidate | One subtitle that could be shown, with a score and a reason. A resolve returns a list of them. |
| select | Download one candidate, convert it if needed, and put it on screen. |
| tier | Which rung of the match ladder produced the answer, best first: an id you gave, then a series and episode number, then a title and year, then `manual` for nothing matched. |
| unrenderable | How many subtitles were dropped because the player cannot render that file format. |
| HI | Hearing impaired: a subtitle that also writes out sounds, not only speech. |
| the offer | The candidate list a player is currently showing. |

## Install

If the page has no build step, there is nothing to install: one script tag from
`https://cdn.thesubtitledb.org/latest/subtitle-finder.js` does the whole thing.
Everything below is for a page that does have one.

Nothing here is on npm yet. Until it is, use the built files.

```bash
git clone https://github.com/thesubtitledb/subtitledb-integrations
cd subtitledb-integrations
npm install
npm run build
npm run vendor      # copies the built packages into examples/vendor
```

`npm run vendor` writes plain ES modules with no bundler step. Copy the folder your
page needs out of `examples/vendor`, then point an import map at it:

```html
<script type="importmap">
  {
    "imports": {
      "@subtitledb/core": "./vendor/core/index.js",
      "@subtitledb/html5": "./vendor/html5-adapter/index.js",
      "@subtitledb/players": "./vendor/players-adapter/index.js",
      "@subtitledb/artplayer": "./vendor/artplayer-adapter/index.js"
    }
  }
</script>
```

Every adapter imports `@subtitledb/core`, so map that one as well as the adapter you
use. In a bundler project, `npm install` the folders directly with a `file:` path
until the packages are published.

## A page that works

The whole thing, copy and paste, nothing left out. It plays a file and shows an
English subtitle for The Matrix without anybody clicking anything.

It is also a file in this repo, `examples/minimal.html`, and `e2e/minimal.spec.ts`
runs it in a browser against the live API and fails if no subtitle reaches the screen.
Documentation that does not run is documentation that has drifted.

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <script type="importmap">
      {
        "imports": {
          "@subtitledb/core": "./vendor/core/index.js",
          "@subtitledb/html5": "./vendor/html5-adapter/index.js"
        }
      }
    </script>
  </head>
  <body>
    <video id="player" controls src="movie.mp4"></video>

    <script type="module">
      import { attachSubtitleDb } from '@subtitledb/html5';

      const handle = attachSubtitleDb(document.getElementById('player'), {
        hint: { imdbId: 'tt0133093' },
        languages: ['en'],
        autoSelect: true,
        onError: (err) => console.error(err),
      });
    </script>
  </body>
</html>
```

Three things in there are doing the work, and leaving any of them out is the usual
reason nothing appears:

- `hint` says what is playing. Without it the page is searched for clues, which works
  but can be wrong. See [Identification](#identification).
- `languages` says which languages you want, best first. **Without it you get whatever
  the API returns first, which is alphabetical by language: ask for The Matrix with no
  languages and you get Arabic.**
- `autoSelect` puts one on screen. Without it the subtitles are offered and none is
  shown, because choosing is the viewer's or your UI's job. See
  [The handle](#the-handle).

## The call

```js
import { attachSubtitleDb } from '@subtitledb/players';

const handle = attachSubtitleDb(player, { languages: ['en', 'fr'] });
```

`player` is whatever you already have: a player instance, its container, or a bare
`<video>`. The binding is detected from the object's shape, never from a version
number or a global, so the same call works for Video.js, Shaka, Plyr, Vidstack,
DPlayer, Clappr, xgplayer, MediaElement.js, OpenPlayerJS, Media Chrome,
ArtPlayer, Bitmovin, Flowplayer, THEOplayer, JW Player, hls.js, dash.js and a plain
`<video>`. Nothing is imported from the player, so there is no dependency and no
version pinning.

Three packages, same function name, same options, same handle:

| Package | Use when |
|---|---|
| `@subtitledb/players` | You have a player, or do not know which one. This is the default. |
| `@subtitledb/html5` | You know it is a bare `<video>` and want the smallest bundle. |
| `@subtitledb/artplayer` | ArtPlayer, when you want its own settings menu, or the `plugins: [...]` form. `@subtitledb/players` also handles ArtPlayer, without the menu. |

## Configuration

One object, the same on every player. There are no per-player option bags: a binding
either works it out from the player, or the setting lives here and applies to all of
them. `packages/players/test/uniform.test.ts` drives all sixteen bindings through
one frozen object and fails if any of them stops honouring it.

| Option | Default | Meaning |
|---|---|---|
| `languages` | none | Preference order, best first. One search request per language. |
| `hint` | inferred | What is playing: `{ imdbId }`, `{ tmdbId }`, or `{ title, year, season, episode }`. |
| `autoSelect` | off | `true` picks the top candidate, `'locale'` the viewer's own language, a code like `'en-US'` pins one (matched on the base subtag). |
| `hearingImpaired` | off | Prefer HI subtitles when ranking. |
| `transcribe` | off | On-device speech-to-text when the corpus has nothing. `true` for defaults, or `{ when, engine, model, task, device, language, onProgress }`. See below. |
| `maxTracks` | 30 | Cap on how many subtitles are offered. |
| `convert` | on | Convert srt, ass and ssa to WebVTT in the browser. |
| `formats` | the binding's own | What the player renders unaided. Anything else is converted. |
| `limit` | 100 | Candidates requested per language. |
| `cacheTtlMs` | 5 minutes | How long a resolve is reused. |
| `maxRequests` | 12 | Hard ceiling on network calls for the session's whole life. |
| `apiBase` | public API | Point at another SubtitleDB deployment. |
| `client`, `fetch`, `clientName` | none | Bring your own transport. `clientName` is sent as a `client` query parameter. |
| `player` | detected | Force a binding by name and skip detection. |
| `onResolved` | none | Fires after every resolve, including one that found nothing. |
| `onSelected` | none | Fires when a subtitle has been fetched, converted and handed over. |
| `onError` | none | Every non-abort failure. Errors never escape `resolve()`. |

`formats` is the one default that is not the same everywhere, and it is a fact about
the player rather than a preference. Fifteen of the sixteen bindings declare
`['vtt']`, because a bare `<track>` takes WebVTT and nothing else. ArtPlayer declares
`['srt', 'ass', 'ssa', 'vtt']`, because it parses those itself, so it is handed the
file exactly as the API served it. `convert` then means one thing on all of them:
convert what this player cannot render. Setting `formats` yourself overrides both.

### Transcription

The engine that satisfies `transcribe` is not in this repository. It is loaded by the
CDN script tag; a page building from source here supplies its own by passing
`transcriber`.

`transcribe` adds a fallback for a title the corpus has nothing for: the video's own
audio, transcribed on the device, offered as one more row in the picker. It is off by
default, and the invariant that makes it safe to leave on is that nothing heavy loads
until a viewer selects that row. Offering it costs a placeholder in a menu; the engine
and the model download only on the click.

```ts
attach(video, {
  transcribe: true,                // every default: no-match, transformers.js, whisper-tiny.en
});

attach(video, {
  transcribe: {
    when: 'no-match',              // 'no-match' (default), 'always', or 'off'
    engine: 'transformers',       // 'transformers' (default) or 'whisper-cpp' (experimental)
    model: 'onnx-community/whisper-tiny.en',
    task: 'transcribe',           // or 'translate', which targets English only
    device: 'auto',               // 'auto', 'webgpu', or 'wasm'
    language: 'en',               // the tag for the produced track
    source: undefined,            // read the audio from here instead of the element
    onProgress: (p) => {},        // { phase: 'engine'|'model'|'transcribe', loaded, total }
  },
});
```

The default engine is transformers.js, running Whisper as ONNX on WebGPU where the
browser has it and WASM otherwise. `whisper-cpp` is a second, experimental engine that
runs a whisper.cpp WASM build; it is opt-in and may need a self-hosted build. Three
things to know: the audio has to be readable, so the media must be same-origin or
served with CORS; the output language is the audio's own, and `translate` only ever
targets English, so `autoSelect: 'locale'` on a foreign film is not satisfied by it;
and on the CDN the engine and model load from jsDelivr and HuggingFace, which needs a
wider CSP.

`source` is the escape hatch for a media element whose own source a `fetch` cannot
read. A `<video>` plays a cross-origin file that carries no CORS header, but reading its
audio for transcription cannot: the browser blocks the read. archive.org is the textbook
case, its `/download/` URL redirects to a storage node that drops the header. Point
`source` at a CORS-readable copy of the same audio (archive.org serves one at `/cors/`)
and playback keeps its own URL while the transcription reads the copy.

## The handle

```ts
handle.player            // { name, label, untested, via } - which binding, and how it was reached
handle.degraded          // null, or a player seen but not reached
handle.session           // the session underneath, if you want the client or the counters
handle.media()           // the element playing right now, read live
await handle.refresh()   // resolve again, e.g. after you changed the source yourself
handle.tracks()          // candidates on offer, in menu order
handle.current()         // the last ResolveResult, or null
await handle.select(c)   // fetch, convert and show one candidate
handle.destroy()         // remove tracks, revoke blob URLs, cancel in-flight work
```

The same handle from all four packages. It is declared once, in `@subtitledb/core`,
because three copies of it had already drifted apart.

`media()` is a call and not a captured element on purpose: a player that swaps its
element on a source change reports the new one here, and a reference taken at attach
time goes stale with no symptom other than the wrong answer.

`player.via` says which step of resolution answered: `named` when you passed
`player: '...'`, `instance` for the player itself, `ref` for a React or Vue
reference, `descend` for a framework wrapper, `ascend` when the player was reached by
climbing from its element, `element` for `@subtitledb/html5`, and `native` for a page
driving a bare element through hls.js, dash.js or anything else with no binding. It
is reported rather than inferred because "no player was found" and "no player was
looked for" are otherwise the same symptom.

Build your own menu from `tracks()`, or let the player's own captions menu show what
was published. `select()` is the only call that downloads a subtitle.

**A resolve on its own puts nothing on screen.** It offers subtitles; something has to
choose one. Either set `autoSelect`, or call `select()` when the viewer picks, or let
the player's own captions menu do it. A page that attaches, sees a full track list and
sees no text is working correctly and has not chosen yet.

The player's own captions menu counts as choosing. On the element path the offered
tracks are empty until something asks for one, so turning one on in the browser's or
the player's menu is taken as a request for that subtitle: the bytes are fetched and
it starts rendering, exactly as `select()` would. The one case that is not treated as
a choice is a track the browser switched on by itself while another one is already
rendering; that one is turned back off, because two enabled languages showing one
subtitle is a bug on screen and in the menu.

`@subtitledb/html5` differs in two ways, because it is the one package that already
knows which player it is talking to:

- `handle.player` is always `native`, with `via: 'element'`, since nothing was
  detected and nothing needed to be;
- it takes three extra options a bare element has no other way to express:
  `disabled` (add tracks disabled and let the browser or the host UI enable one,
  default true), `onTracks(tracks, candidates)` (the `<track>` elements were added or
  cleared, for a player that builds its own menu once at startup) and
  `onShow(track, index, loaded)` (a track has its bytes and is showing).

Everything else, the options and the rest of the handle, is the same call on every
package.

## What a resolve gives you

`onResolved`, `handle.current()` and `await handle.refresh()` all hand back the same
object. This is the whole of it.

```ts
interface ResolveResult {
  title: Title | null;   // what we matched to, null if nothing matched
  candidates: Candidate[]; // ranked, best first, already filtered to renderable formats
  tier: MatchTier;       // which rung matched: see the table below
  unrenderable: number;  // subtitles dropped because the player cannot render the format
  blocked?: string;      // a rung applied but the data is not there yet, e.g. tmdb ids
  hint: MediaHint;       // the identity that was used, whether you passed it or not
  selected?: LoadedSubtitle; // only when autoSelect chose and fetched one
}

interface Candidate {
  subtitle: Subtitle;    // the API row: language, format, release_name, cues, bytes, hearing_impaired
  score: number;         // higher is better, comparable only inside one result
  reason: string;        // why it ranked there, safe to show in a picker
}

interface LoadedSubtitle {
  candidate: Candidate;
  text: string;          // the subtitle itself, converted already if it needed it
  format: string;        // the format of `text`, not what the API stored
  convertedFrom?: string; // set when it was converted, naming the stored format
}
```

`tier` says how confident the match is, best first:

| `tier` | Meaning |
|---|---|
| `explicit-imdb` | You gave an IMDb id. Exact. |
| `explicit-tmdb` | You gave a TMDB id. Exact, but see [Limits](#limits). |
| `title` | Matched by searching a title, and a year when there was one. |
| `manual` | Nothing matched. `candidates` is whatever a plain search returned, or empty. |

`unrenderable` is worth surfacing. If it is large and `candidates` is short, subtitles
exist and your player cannot render them: turn `convert` on, or widen `formats`.

A label for a candidate, the same one the adapters put on their tracks:

```js
import { candidateLabel } from '@subtitledb/core';
candidateLabel(candidate); // "English - HI - The.Matrix.1999.1080p.BluRay"
```

The converter is exported too, for a page that fetches subtitle text itself:

```js
import { toVtt } from '@subtitledb/core';
const vtt = toVtt(srtText, 'srt'); // also 'ass' and 'ssa'
```

## Load patterns

The order a page loads in is not something an integration gets to decide, so all of
these are tested in `packages/players/test/lifecycle.test.ts` rather than assumed.

### The player already exists

```js
const player = new Plyr('#video');
const handle = attachSubtitleDb(player, { languages: ['en'] });
```

Resolve starts immediately if the media is ready, otherwise on the player's first
`loadedmetadata` or `loadstart`. No click, no wait. The five players that own
their text tracks resolve on attach instead: three of them have no ready event to
subscribe to, so waiting for one means never resolving at all.

### The player is created later, in code you control

Call `attachSubtitleDb` after you construct it. That is all.

### The player is created later, in code you do not control

```js
import { observeSubtitleDb } from '@subtitledb/players';

const watcher = observeSubtitleDb({ languages: ['en'] });
```

Watches the document for videos, works out what owns each one, and attaches once per
player. Covers a tag-manager script that runs before the page's own, a single page
app that builds a player on a route change, a feed that mounts one per card on
scroll, and a CMS embed with no integration point at all. `watcher.handles()` lists
what it attached, `stop()` stops watching, `destroy()` stops and tears down.

It reaches the player object where the page makes that possible: a custom element
player is the element (Vidstack, Media Chrome), and Video.js, Plyr and
MediaElement.js leave a back reference on or near their element. Shaka, Bitmovin,
THEOplayer and JW keep their player entirely in JavaScript with nothing pointing
back, so a watcher only sees their `<video>`. Those four hide native tracks, so pass
the instance to `attachSubtitleDb` yourself.

### Attach fires before the player has mounted its video

Supported, and the common case: `new Plyr(el)` returns before its media is in place,
a framework effect runs before layout, a lazy player mounts on scroll. The handle is
returned immediately and starts working when the element appears; `refresh()` called
in the meantime resolves once it does. Nothing is requested until then, so an attach
that is destroyed first never opens a session at all.

If no element appears within 15 seconds the handle reports an `UnknownPlayerError`
through `onError` and stays inert. It does not throw: a page that never mounted a
player is not a crash.

### The same page attaches twice

The second call returns the first handle. A script tag included twice, a component
that mounts twice under StrictMode, a route that re-runs its setup on the way back:
all of them are one session, one set of tracks, one download on select. Call
`destroy()` to release the player, after which attaching gives a fresh handle.

"The same player" means the same player however you name it. A wrapper, the instance
inside it, and the media element underneath all answer with one handle, and so do
`@subtitledb/players` and `@subtitledb/html5` when they are pointed at the same
video. Under Vue this is the difference between one session and two: two proxies of
one player are not the same object, so identity is taken after the wrapper has been
unwrapped rather than before.

### The source changes

A new file, a next episode, a quality switch: re-resolution is automatic on
`loadedmetadata`, `loadstart` and `emptied` for element-based players, and on the
player's own source event for those that have one. The offer is only rebuilt when it
actually changed, so a subtitle the viewer is watching survives the events a player
fires after a selection.

`refresh()` is there for the case nothing observable happened, for example a source
swapped in place with no event.

### The player is destroyed, or the route changes

Call `handle.destroy()`. It removes the tracks it added, revokes its blob URLs,
cancels in-flight requests and disposes the session. An observer's `destroy()` does
that for everything it attached.

Nothing is destroyed for you: a handle whose player is gone will not throw, but it
does hold its session, so a single page app that never calls `destroy()` leaks one
session per route.

### Server-side rendering

`attachSubtitleDb` touches `document`, `Blob` and `URL.createObjectURL`, so call it
from a client-side effect, not during render. The package is browser-only by design.

### Multiple players on one page

Independent sessions, one per player, each with its own budget and cache. They do not
share a request budget, so ten players are ten budgets.

## Identification

With no `hint`, identity is assembled from these sources in order. It is a merge,
not a race: each field is taken from the first source that has one, so a page that
names the title in its metadata and the year in the filename ends up with both.

1. `hint`, when you pass one.
2. `<video data-imdb-id>`, `data-tmdb-id`, `data-title`, `data-year`, `data-season`, `data-episode`.
3. JSON-LD on the page, then `og:` metadata.
4. The release filename in `currentSrc`.

Every binding does this identically, including the ones with their own text-track
engine. If you know what is playing, pass `hint` and skip the guessing:

```js
attachSubtitleDb(player, { hint: { imdbId: 'tt0133093' }, languages: ['en'] });
```

Pass `languages` with it. `hint` says which film; `languages` says which subtitles of
it you want. With no `languages` the API returns its own default order, which is
alphabetical by language, so this same call without the second key offers Arabic.

TV resolves today by episode-level IMDb id. Naming an episode by series plus season
plus episode is implemented but blocked on corpus metadata, and reports itself as
blocked rather than guessing.

## What it costs

Two phases, deliberately split.

**Resolve** is eager: it runs on attach and on every source change, costs one search
request per configured language, and downloads no subtitle bytes. Duplicate resolves
for the same media are collapsed and are not charged to `maxRequests`.

One request per language used to be forced by the API: `lang` took a single ISO
code, a comma separated list was accepted and silently ignored, and the default
`sort=lang` then answered with the alphabetically earliest languages instead, so a
page that asked for English with a list got Arabic and believed it worked. `lang` now
takes up to 16 comma separated codes, so the fan-out is a cost this library chooses
rather than one it is forced into. It stays, because each per-language request is
small and separately cacheable, and because collapsing it changes behaviour in four
language ports at once.

Two more things `lang` and `format` will not tell you apart from a filter that matched
nothing. Both bite on a movie bundle and on an episode drill, and both are **ignored on
a series or a season bundle**: the tree is served unfiltered by design, so
`by-imdb/tt0944947?lang=en` returns exactly the bytes of the unfiltered call. Drill to
`/season/:s/episode/:e` when the filter has to hold.

**Select** is lazy: one request, one conversion, one blob URL. It happens when the
viewer picks a subtitle, or immediately when `autoSelect` is set.

Measured against the live API from a desktop browser, each player in a cold
browser context: resolve is 410 to 554ms from navigation to a rendered track
list, of which the parallel language requests are 79 to 137ms each and the rest
is page load and the player's own readiness. Selection is 166 to 237ms for a
52.8KB file, covering the redirect, the download, the conversion and the
browser's parse, and 28 to 63ms once the browser holds the file.

`onResolved` fires more than once on the element path. How many times depends on the
player and the browser: a media element fires several events that mean the source
changed, and most players fire their own on top. The repeats are collapsed by the
cache, cost no request, and carry the same candidates, so a menu built from
`onResolved` can be rebuilt each time without flicker or extra traffic. Do not count
them, and do not put anything in that callback that must run once.

## Failure modes

| What happens | What you see |
|---|---|
| No player can be identified | `UnknownPlayerError` thrown from `attachSubtitleDb` |
| A player that renders nothing from a native track is on the page and its instance cannot be reached | `PlayerNotReachableError` thrown, naming the player. A subclass of `UnknownPlayerError` |
| A player whose subtitles are DOM children is on the page and its instance cannot be reached | Nothing thrown. `handle.degraded` is set and `onDegraded` fires once. `strict: true` makes it throw |
| A player took the track away, or turned it off, after it was shown | `onError`, about 1.5 seconds after selection, once |
| Player identified, media never mounts | `UnknownPlayerError` passed to `onError` after 15s |
| Nothing identifies the media | A resolve with no candidates. `onResolved` still fires |
| The title has no subtitles in your languages | Same: an empty candidate list, not an error |
| API down, network error, timeout | `onError`, and an empty result. Nothing throws |
| Request budget exhausted | `onError`, and no further requests from that session |

Errors never escape `resolve()` or `select()`. A page that ignores `onError` degrades
to no subtitles rather than to a broken player.

## Limits

- **Hosted embeds cannot be reached.** A YouTube, Vimeo or Dailymotion iframe is
  cross-origin, so no page-side plugin can add a track to it. See docs/players.md.
- **Cross-origin video elements** still work: subtitles are fetched by this code and
  handed over as a same-origin blob, so no CORS configuration is needed on your CDN.
- **JW Player and THEOplayer are unverified against a real build.** Both bindings are
  written to the documented API but neither can be exercised without a licence, and
  `handle.player.untested` says so at runtime.
- **Fluid Player has no binding.** Its instance exposes no reference to its media
  element, so pass the `<video>` instead and the native binding takes it.
- **A player that renders captions from its own manifest** may show both its track
  and ours. Use its API to hide the original, or read the candidates from
  `onResolved` and drive `select()` yourself rather than publishing a list.
- **OpenPlayerJS renders nothing it did not know about at construction.** It hides
  the browser's cue container in its own stylesheet and draws captions from a list
  it snapshots at startup. The track is published, showing and parsed, and the
  screen stays empty. One line of CSS in the host page fixes it; docs/players.md
  has it.
- **Shaka keeps the track after destroy.** It has no public removal for a
  side-loaded track and drops them when the manifest unloads, so `destroy()` takes
  back what it can everywhere else and leaves Shaka's in place.
