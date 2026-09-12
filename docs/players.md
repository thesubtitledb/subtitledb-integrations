# Web video players, and how a subtitle plugin reaches each one

The inventory this repo works from. Every player below renders into an
`HTMLVideoElement` sooner or later, so the question is never "can it show a
subtitle" but "who owns the text track": the browser, the player, or a server you
do not control. That answer decides which of three groups a player falls in, and
groups one and two are the ones we can serve.

Counts are the subtitle corpus as measured on the live system: 6,864,222 rows,
of which WebVTT is 2,487 (0.036%) and srt, ass and ssa together are about 94%.
Client side conversion is what makes group one reachable at all.

## Group 1: the player is a `<video>` element plus a user interface

Adding a `<track>` to the element is enough to render a subtitle. The
player-specific binding exists only so the player's own captions menu lists what
we added, rather than the subtitle appearing with no way to switch it.

```js
import { attachSubtitleDb } from '@subtitledb/players';

const handle = attachSubtitleDb(plyrInstance, { hint: { imdbId: 'tt0133093' } });

await handle.ready;
handle.player; // { name: 'plyr', label: 'Plyr', untested: false, via: 'instance' }
```

Hand any of these the `<video>` instead and the subtitle still renders, just
without the player's own menu entry.

| Player | Licence | Binding | Notes |
|---|---|---|---|
| Native `<video>` | - | `native` | The floor. Everything else degrades to this |
| [Plyr](https://plyr.io) | MIT | `plyr` | `player.currentTrack` and `toggleCaptions` are public API |
| [MediaElement.js](https://www.mediaelementjs.com) | MIT | `mediaelement` | Wraps the element, keeps native tracks |
| [Fluid Player](https://fluidplayer.com) | MIT | `native` | Its instance holds no element reference; pass it the `<video>` |
| [OpenPlayerJS](https://www.openplayerjs.com) | MIT | `openplayerjs` | MediaElement successor. Needs one line of CSS, below |
| [DPlayer](https://dplayer.diygod.dev) | MIT | `dplayer` | One subtitle at a time by design |
| [Clappr](https://github.com/clappr/clappr) | BSD-3 | `clappr` | Element lives under `player.core`. Told which track is on |
| [xgplayer](https://h5player.bytedance.com) | MIT | `xgplayer` | ByteDance |
| [Oplayer](https://github.com/shiyiya/oplayer) | MIT | `native` | Exposes `player.$video` |
| [Media Chrome](https://media-chrome.mux.dev) | MIT | `mediachrome` | Controls only; slots a real `<video>` |
| [Mux Player](https://docs.mux.com/guides/player) | MIT | `mediachrome` | Media Chrome plus hls.js |
| [hls.js](https://github.com/video-dev/hls.js) | Apache-2.0 | `native` | A playback engine, not a UI. `findVideo` reaches `hls.media` |
| [dash.js](https://github.com/Dash-Industry-Forum/dash.js) | BSD-3 | `native` | Also an engine. `findVideo` calls `getVideoElement()` |
| [Video-React](https://video-react.js.org) | MIT | `native` | Pass `player.video.video` |
| [jPlayer](https://jplayer.org) | MIT | `native` | Legacy jQuery, still deployed |
| [Griffith](https://zhihu.github.io/griffith) | MIT | `native` | Zhihu |
| [Chimee](https://github.com/Chimeejs/chimee) | MIT | `native` | Legacy |
| [Afterglow](https://github.com/moritzraguschat/afterglow) | MIT | `videojs` | A Video.js skin |
| Jellyfin, Emby, Plex web | mixed | `native` | Web clients are a `<video>` and a custom UI |

## Group 2: the player owns its own text-track engine

These hide or ignore native `<track>` elements and render captions themselves,
so the binding has to speak the player's API. This is also where the better
integration lives, because the player's own menu, styling and offset controls
come for free.

The call does not change. Hand one of these a bare `<video>` and you get nothing
on screen and no error, which is why the group matters:

```js
attachSubtitleDb(videojsPlayer, { hint: { imdbId: 'tt0133093' } }); // menu, styling
attachSubtitleDb(videojsPlayer.el().querySelector('video'));        // silence
```

| Player | Licence | Binding | API used |
|---|---|---|---|
| [Video.js](https://videojs.com) | Apache-2.0 | `videojs` | `addRemoteTextTrack`, `remoteTextTracks` |
| [Shaka Player](https://github.com/shaka-project/shaka-player) | Apache-2.0 | `shaka` | `addTextTrackAsync`, `selectTextTrack` |
| [Vidstack](https://vidstack.io) | MIT | `vidstack` | `player.textTracks.add` |
| [ArtPlayer](https://artplayer.org) | MIT | `artplayer`, or `@subtitledb/artplayer` | `subtitle.switch`. The standalone package adds its settings menu |
| [JW Player](https://jwplayer.com) | commercial | `jwplayer` | Native tracks, then `setCurrentCaptions` to pick ours |
| [THEOplayer](https://theoplayer.com) | commercial | `theoplayer` | `player.source.textTracks`, rewritten on select |
| [Bitmovin](https://bitmovin.com) | commercial | `bitmovin` | `player.subtitles.add` |
| [Flowplayer](https://flowplayer.com) | commercial | `flowplayer` | Native tracks. Its own menu lists them |
| [Brightcove](https://www.brightcove.com) | commercial | `videojs` | Video.js underneath |
| [Cloudinary Video Player](https://cloudinary.com/documentation/video_player_how_to_embed) | commercial | `videojs` | Video.js underneath |
| [PeerTube](https://joinpeertube.org) | AGPL-3.0 | `videojs` | Video.js underneath |
| [Kaltura Playkit](https://github.com/kaltura/kaltura-player-js) | AGPL-3.0 | `native` | Playkit renders into a `<video>` |
| [Radiant Media Player](https://www.radiantmediaplayer.com) | commercial | `native` | |
| [Playerjs](https://playerjs.com) | commercial | `native` | `api('subtitle')` is undocumented |
| [Vime](https://vimejs.com) | MIT | `vidstack` | Deprecated in favour of Vidstack |

Two of the rows above are in this group because of the player, not because of
the binding: JW Player and Flowplayer both render through the element's own text
tracks, so their bindings take the element path and only reach for the player's
API to say which track is on. Video.js, Shaka, Vidstack, Bitmovin, THEOplayer and
ArtPlayer are the six that publish through a player API and never touch the
element.

ArtPlayer has two entry points and they are not the same thing.

```js
// fuller: adds an entry to ArtPlayer's own settings menu
import { subtitleDbPlugin } from '@subtitledb/artplayer';

new Artplayer({
  container: '#player',
  url: 'film.mp4',
  plugins: [subtitleDbPlugin({ hint: { imdbId: 'tt0133093' } })],
});

// enough to stop it resolving to `native`
attachSubtitleDb(artplayerInstance, { hint: { imdbId: 'tt0133093' } });
```

`@subtitledb/artplayer` is the fuller one: it adds an entry to ArtPlayer's own
settings menu and it is what `plugins: [subtitleDbPlugin()]` takes. The
`artplayer` binding in this package exists so that an ArtPlayer handed to the
general `attachSubtitleDb` stops resolving to `native`, which is what it did
before: a native `<track>` on ArtPlayer's video renders through the browser's own
caption layer, on top of and unstyled by the player. Both hand the file over in
the same formats, because both read the same declaration.

The four commercial players (JW, THEO, Bitmovin, Flowplayer) have bindings
written to their published API with a native-track fallback. Bitmovin and
Flowplayer have since been run against real builds; JW and THEOplayer are
**marked untested** in the code and here. Fluid Player has no binding at all:
the object `fluidPlayer()` returns holds no reference to its media element, so
there is nothing to reach from it. It renders native tracks, so hand it the
`<video>` the page already has and the native binding does the rest.

## What has actually been run

`examples/players.html` mounts a real build of every player that publishes one,
sixteen of the seventeen setups it lists, and `e2e/players.spec.ts` drives each of
them, asserting the same three things:

1. The binding is detected from the object shape alone. The page never names one.
2. Resolve happens on load, with no click, costing one request per configured
   language and not a single subtitle byte.
3. After one selection, a parser that is not ours has built 790 cues from a file
   that arrived as SubRip.
4. The caption is still on two seconds into playback, with a cue on screen at the
   time the viewer is watching. This is the one that catches a player taking the
   subtitle back: Clappr wipes its caption selection on the first play and hides
   every track that does not match an id only its own setter writes, so the
   subtitle appeared and then vanished while the cues stayed parsed and every
   other assertion above stayed green.

Covered: native, hls.js, plyr, videojs, shaka, vidstack, dplayer, clappr,
xgplayer, mediaelement, openplayerjs, mediachrome, and three of the
commercial four: bitmovin, flowplayer and theoplayer, the last through detection
and resolve only. JW Player is the one player nothing here has ever run against.

A licence turns out to gate less than expected. All three commercial players
with a public build load and construct without a key, so detection is checked
against the real object rather than a fake shaped from the documentation, and
that is where every binding bug so far has been. What a key gates is playback:

| Player | Without a licence | Needs a key for |
|---|---|---|
| Bitmovin | Everything. `subtitles.add`, `enable` and `list` are not gated | Nothing this adapter does |
| Flowplayer | Everything. It renders through native tracks, 790 cues | Nothing this adapter does |
| THEOplayer | Loads, detects, and resolves from the page hint. Refuses every source | Publishing a track at all |
| JW Player | Nothing. No library is fetchable without an account | Loading the library |

So bitmovin and flowplayer have lost the untested marker. THEOplayer and JW keep
it. Nothing in the suite passes while asserting nothing: JW skips both of its
tests because no library loads, and THEOplayer's publish test skips on the same
reasoning once the source is refused, so an unlicensed run reports three skips
rather than a full green. That is the state of every CI runner. Keys are read
from a gitignored `licences.env` and never committed.

Five bindings were wrong until a real build said so, and none was visible to a
unit test against a fake:

- Shaka 5 removed `setTextTrackVisibility`. Detecting on it meant every Shaka 5
  player fell through to the native binding.
- Clappr gives plain objects a `tagName` of `video`. The probe returned one as if
  it were an element, so Clappr was never detected as Clappr.
- Plyr throws from `currentTrack` when it has not yet seen the `addtrack` event for
  the track being selected, which took the whole selection down with it.
- THEOplayer replaces its video element when the source changes, so the `<track>`
  elements appended to it were thrown away. It has no call that adds a track to a
  loaded stream either: side-loaded text is part of the source description. The
  binding now rewrites `player.source` and restores `currentTime`.
- Clappr holds its own idea of which caption is on, and on the first play it hides
  every track that does not match it. Nothing but its own setter writes that
  record, so a track shown by anyone else lasted until playback started. The
  binding now hands the track to Clappr's setter, which also ticks the right entry
  in its menu. Its setter refuses a track that is already showing, so the track has
  to be handed over not showing and put back if Clappr will not take it.

### OpenPlayerJS renders no caption it did not know about at construction

The one player where everything this adapter does is correct and the screen is
still empty. OpenPlayerJS hides the browser's own cue container:

```css
.op-player video::-webkit-media-text-track-container {
  display: none !important;
}
```

and draws captions itself from a track list it snapshots when it is constructed,
so a track added afterwards is in neither. Nothing an adapter can do from outside
the player changes that. A host page that wants subtitles rendered gives the
browser its cue container back, which is one line and puts the cues on screen:

```css
.op-player video::-webkit-media-text-track-container {
  display: block !important;
}
```

The cues then render in the browser's own caption style rather than the player's,
and OpenPlayerJS's captions button still lists only what it saw at construction.
`e2e/players.spec.ts` pins the rule in OpenPlayerJS's stylesheet, so the day it
stops hiding the container, this note fails with it.

Three defects in the shared code came out of these runs, and none of them was
visible to a unit test. A duplicate resolve that single-flight had already
collapsed was still charged to the request budget. A re-resolve after a selection
rebuilt the track list and dropped the subtitle the viewer was watching. And the
client stored the browser's own `fetch` and then called it as a method of itself,
which is an "Illegal invocation" in every browser: any host page that did not
pass a `fetch` of its own failed every request before it left the tab. Every unit
test injects a transport, and `examples/players.html` passes a counting wrapper,
so nothing caught it until a page attached with nothing but a hint.

## One configuration surface

The host page calls `attachSubtitleDb(player, options)` and never learns which
player it got, so the options have to mean the same thing on all sixteen bindings.
There are no per-player option bags, and a binding cannot read an option of its own:
whatever it needs is either structural, worked out from the player object, or it
belongs in `AttachOptions` and applies everywhere. The full list is the
configuration table in the README.

Uniformity is asserted, not assumed. `packages/players/test/uniform.test.ts` drives
every binding through one frozen options object and checks the same behaviour each
time: one search per configured language, no subtitle byte before a selection,
`maxTracks` capping the offer, one fetch on select, and WebVTT in the player's hands
whatever the API served. It found the gap that made this worth doing: the two
attach paths are separate implementations, and the one used by Video.js, Shaka,
Vidstack, Bitmovin and THEOplayer resolved against an empty hint, so those five
identified nothing at all unless the host page named the title, while every other
player read it off the media element. Both paths now derive identity through
`elementIdentity` in the core package, and every binding, including the five that
publish through a player API, declares how to reach its media element.

Measured against the live API from a desktop browser, each player in a cold
browser context: resolve, meaning navigation to a rendered track list, is 410ms
to 554ms across seven players, of which three parallel language requests are 79ms
to 137ms each and the rest is page load and the player's own readiness.
Selection, meaning click to 790 rendered cues, is 166ms to 237ms cold, covering
the `/get/` redirect at about 30ms, a 52.8KB download at 103ms to 142ms, the
conversion and the browser's parse; 28ms to 63ms once the browser holds the file.
Every response came back `cf-cache-status: DYNAMIC`, so none of that is edge
cached yet.

Resolving is idempotent and the repeats are free. A media element fires several
events that mean the source changed and most players fire their own on top, so
`onResolved` runs three times on the element path against one on the api path.
The candidate list is identical every time and the request count does not move,
which `e2e/lifecycle.spec.ts` asserts rather than assumes.

## What a page actually hands over

Every binding above detects a **player instance**, structurally, from its own
properties. A page that builds its player itself has one. A page using a framework
wrapper never does:

| What the page holds | Library |
|---|---|
| `{ plyr }` | plyr-react |
| `{ player }` | @videojs-player/vue |
| `{ player, videoElement }` | shaka-player-react |
| `{ current }` | any React `useRef` |
| `{ value }` | any Vue `ref`, holding any of the above |
| a container element | a component that keeps its player private |

```js
attachSubtitleDb({ plyr });                  // plyr-react
attachSubtitleDb({ player });                // @videojs-player/vue
attachSubtitleDb({ player, videoElement });  // shaka-player-react
attachSubtitleDb(useRef());                  // { current }
attachSubtitleDb(vueRef);                    // { value }, holding any of the above
attachSubtitleDb(containerEl);               // player kept private
```

None of those is a player instance, so every one of them missed all fifteen bindings
and reached `native`, which is last and whose detect is satisfied by any object with
a video element somewhere inside it. Measured across the fakes: 15 of 15 wrapper
shapes resolved to the wrong binding. The failure then split by group. For group 1
the track is a real DOM child, so subtitles rendered and only the player's own
captions menu was missing. For group 2 the player ignores a native track entirely:
no subtitles, no error, and a page that looks correctly wired up.

The gap was structural rather than a missing case. `probe.ts` descends for an
element, `playerFor` ascends for a player, and nothing descended for a player.
`packages/players/src/resolve.ts` is that missing direction, and every entry point
now goes through it so the element path, the api path, `observeSubtitleDb` and any
framework wrapper cannot disagree about what a target is:

1. `player: '...'`, if the page named one. Nothing else gets a vote.
2. The object itself.
3. One reference layer at a time: `current`, `value`, and `__v_raw`, which is Vue's
   own marker for the target behind a reactive proxy, read as a plain property so
   this needs no dependency on Vue.
4. Down, into the object, for a player. Same rules as the element walk: own
   enumerable keys, a 40-key budget, a depth cap, and a try/catch around every read.
5. Up, from the media element, to whatever owns it. This crosses a shadow boundary
   now, which is what reaches Vidstack and Media Chrome: `parentElement` is null at
   the top of a shadow root, so the climb used to stop one node short of the two
   players whose element *is* the API.
6. `native`.

`handle.player.via` reports which step answered. It is on the handle because after
the fact "the resolver found nothing" and "the resolver was never reached" produce
the identical symptom, and that ambiguity is what let this stay invisible.

```js
await handle.ready;

handle.player.via;
// 'named'    the page passed player: '...'
// 'instance' the object itself was the player
// 'element'  it was a media element
// 'ref'      unwrapped from current, value or __v_raw
// 'descend'  found inside the object
// 'ascend'   climbed from the media element, shadow boundaries included
// 'native'   no player, driving the element directly
```

`native` is still a correct answer and not a failure. hls.js, dash.js, jPlayer,
Griffith, Kaltura, Jellyfin and Video-React are all served properly by driving the
element directly, and all of them arrive at step 6.

Resolution also decides identity. The handle registry is keyed on the **resolved**
player as well as on the argument and the media element, so a wrapper, the player
inside it and the element underneath all answer with one handle. That matters most
under Vue: structural detection survives a reactive proxy untouched, but two proxies
of one target are not the same object, so keying on anything else made a
double-attach a matter of which reference the second caller happened to hold.

`packages/players/test/wrappers.test.ts` is the gate: every binding, every shape.

## When the resolver reaches `native` and should not have

Resolution can still end at `native` with no player in hand, and that is the right
answer far more often than it is the wrong one. hls.js, dash.js, jPlayer, Griffith,
Kaltura, Jellyfin and Video-React are all driven correctly through the element. So
refusing whenever we land on `native` would break every one of those working pages.

Refusal is therefore evidence-positive: it happens only where a player that renders
nothing from a native track can be shown to be present. The evidence is a DOM marker
on or above the media element, which is new; every other kind of detection in this
package is structural, on the object.

Every marker below was grepped out of the builds in `examples/vendor`. Three of five
first guesses were wrong.

| Player | Marker, verified | Recovered by | Refuses |
|---|---|---|---|
| Video.js | `vjs-tech` on the element **and** a `.video-js` ancestor | `videojs.getPlayer(el)`, then the id, then a scan of `videojs.getPlayers()` | yes |
| Bitmovin | `.bitmovinplayer-container` ancestor | nothing published | yes |
| Shaka | `shaka-video`, or a `.shaka-video-container` ancestor | `video.ui.getControls().getPlayer()` | yes |
| THEOplayer | none exists | a scan of `THEOplayer.players` | no |
| JW Player | `.jwplayer` ancestor | `jwplayer(id)` | no |
| Plyr, DPlayer, xgplayer, OpenPlayerJS, Flowplayer | their own container class | already reached by the climb when the page exposes a back reference | no, reported |

Three of those rows are corrections worth stating, because each one is a false
refusal avoided:

- **`.video-js` alone is not evidence.** `examples/players.html:392` gives
  THEOplayer's container `class="player video-js"`, so requiring only that class
  would refuse this repo's own example page for a player that is not Video.js.
  `vjs-tech` is written by Video.js on the element it took over and by nothing else.
- **THEOplayer publishes no container class at all.** The marker assumed for it does
  not exist in the shipped build, so its only evidence is finding the instance in its
  own registry, which makes "present" and "recovered" the same event and leaves
  nothing to refuse over.
- **A headless Shaka leaves no DOM mark whatsoever.** `shaka-video` appears only in
  `shaka-player.ui.js`; the compiled build this repo vendors contains neither string.
  So `new shaka.Player()` with no UI is unrefusable by any amount of looking.

Three outcomes, and the asymmetry is the design:

- **Marker found, instance recovered.** Not a failure at all. Resolution runs again
  on the recovered instance and the page gets the real binding, reported as `ascend`.
- **Group 2 marker, no instance.** `PlayerNotReachableError`, naming the player and
  what to pass instead. It is a subclass of `UnknownPlayerError`, so a page already
  catching that keeps catching this. The native path was going to render nothing, so
  a thrown error is strictly better than the silence.
- **Group 1 marker, no instance.** Never throws. The track is a real DOM child, so
  the subtitle appears and only the player's own captions menu will not list it.
  `handle.degraded` is set, `onDegraded` fires once, and that is all. `strict: true`
  promotes it to a throw for a page that would rather fail its own tests.

Both halves in code:

```js
import { PlayerNotReachableError, UnknownPlayerError } from '@subtitledb/core';

try {
  const handle = attachSubtitleDb(target, {
    hint: { imdbId: 'tt0133093' },
    onDegraded: (info) => {
      info; // { player: 'plyr', reason: 'menu' }
    },
  });

  await handle.ready;
  handle.degraded; // the same object, or null
} catch (e) {
  if (e instanceof PlayerNotReachableError) {
    e.player; // 'videojs' -- the binding name that was seen
  }
  e instanceof UnknownPlayerError; // true either way
}
```

`PlayerNotReachableError` extends `UnknownPlayerError`, so a page already catching
the older type keeps catching this one.

### The half that needs no fingerprint

A marker table only catches players somebody already wrote down. Headless Shaka is
invisible to it, and so is every player released after this was written. So the
second half of reachability is behavioural, in `@subtitledb/html5`: one look, 1.5
seconds after a subtitle was shown, at whether the track survived.

| Observed | Reported |
|---|---|
| the element is no longer connected | the player removed the track it was given |
| the track's mode is no longer `showing` | the player turned it off after it was shown |
| the track loaded and holds no cues | the bytes were not readable as WebVTT, which is a conversion problem and is worded as one |

It reports through `options.onError` and never throws, and it adds no option. A page
with no `onError` sees nothing new, so this costs every existing consumer nothing.
One timer, restarted per selection, so a viewer clicking through four languages
produces one look. The fingerprint table is the loud, precise half; this is the
general, quiet one. Neither is sufficient alone.

## Group 3: hosted embeds, where a page-side plugin cannot help

The video is an iframe on someone else's origin. Cross-origin isolation means
there is no element to attach to and no caption API reachable from the embedding
page. This is not a gap to close later, it is the security boundary working.

| Player | Why not | What would work instead |
|---|---|---|
| YouTube | IFrame API exposes no caption injection | Upload captions to the video |
| Vimeo | Player API can list text tracks, not add them | Vimeo API upload |
| Dailymotion | Same | Their API |
| Twitch | Live, no caption API | - |
| Wistia | Captions are account-side | Wistia API upload |
| Cloudflare Stream | Captions attach to the video object | Stream API upload |
| Bunny Stream | Same | Bunny API upload |
| Loom, Streamable, social embeds | No caption surface at all | - |

A browser extension can reach inside some of these, which is why extensions are
a different product with a different threat model. They were explicitly out of
scope for this repo.

## What this means for coverage

Group 1 plus group 2 is every player anyone self-hosts or embeds directly, which
is the whole addressable set. The split that actually decides reach is not the
player, it is the format:

```js
attachSubtitleDb(player, { convert: false }); // 2,487 subtitles of 6.86 million
attachSubtitleDb(player);                     // convert: true, about 94%
```

- With conversion off, only a player with its own srt or ass parser can be
  served, and a bare `<track>` player gets 2,487 subtitles out of 6.86 million.
- With conversion on, which is the default, every player in groups one and two
  reaches about 94% of the corpus.

The remaining 6% is `sub`, `tmp`, `mpl`, `smi` and `txt`. Those are filtered out
and reported as unrenderable rather than handed to a player to fail silently.
