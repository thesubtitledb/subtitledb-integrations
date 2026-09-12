# subtitledb-integrations

Subtitle plugins for web video players. One call works out what is playing, asks the
SubtitleDB open API at `api.thesubtitledb.org` which subtitles exist for it, and puts
them in the player's own captions menu. No key, no signup, no account.

Website: <https://thesubtitledb.org>

Sixteen bindings cover fifteen player libraries and a plain `<video>`, which is also
how hls.js and dash.js are reached. Nothing is imported from the player, so there is
no player dependency and no version to pin.

Stremio is a different shape and lives in
[thesubtitledb/subtitledb-stremio](https://github.com/thesubtitledb/subtitledb-stremio):
its addon protocol is a hosted HTTP service rather than a plugin the client loads, so
it is deployed, not installed. It reads `plugins/shared/match-cases.json` as another
suite and vendors this repo's converter and similarity function under a CI drift gate,
which is what keeps a release match meaning the same thing there as it does here.

## Install

Not on npm yet. Build it and use the built files:

```bash
git clone https://github.com/thesubtitledb/subtitledb-integrations
cd subtitledb-integrations
npm install
npm run build
npm run vendor      # copies the built packages into examples/vendor
```

`npm run vendor` writes plain ES modules, no bundler needed. Copy what your page uses
out of `examples/vendor` and point an import map at it. Full recipe, and the bundler
version, in [docs/documentation.md](docs/documentation.md#install).

If the page has no build step at all, one script tag from
`https://cdn.thesubtitledb.org/latest/subtitle-finder.js` does the same thing in about
2 KB, fetching only the half of the code the page turns out to need. There is an ES
module build beside it at `subtitle-finder.esm.js`.

## Quick start

```js
import { attachSubtitleDb } from '@subtitledb/players';

const handle = attachSubtitleDb(player, {
  hint: { imdbId: 'tt0133093' },   // what is playing
  languages: ['en', 'fr'],         // which languages, best first
  autoSelect: true,                // put the top one on screen
});
```

`player` is a player instance, its container, a bare `<video>`, or whatever your
framework wrapper handed you: `{plyr}` from plyr-react, `{player}` from
@videojs-player/vue, `{player, videoElement}` from shaka-player-react, a React
`useRef` or a Vue `ref` holding any of those. The right binding is worked out from
the object's shape, and `handle.player.via` says how it was reached. Dropping one of
the three keys above is the usual reason nothing appears:

- `hint` says what is playing. Without it, identity is inferred from the page and the
  release filename. That works, but a hint is exact.
- `languages` says which languages you want. Without it you get the API's own order,
  which is alphabetical by language: ask for The Matrix and you get Arabic.
- `autoSelect` puts one on screen. Without it subtitles are offered and none is shown,
  because choosing is the viewer's job. Drive `handle.select(candidate)` yourself.

Two smaller packages do the same thing for one case each:

```js
import { attachSubtitleDb } from '@subtitledb/html5';     // a bare <video> element
import { attachSubtitleDb } from '@subtitledb/artplayer'; // ArtPlayer's own plugin shape
```

## Read more

- [docs/documentation.md](docs/documentation.md): options, the handle, load patterns, cost, limits.
- [docs/players.md](docs/players.md): every player, which binding reaches it, what has been run.
- [examples/minimal.html](examples/minimal.html): the smallest page that works.

## Development

```bash
npm install
npm test              # unit, hermetic, no network
npm run test:live     # contract tests against the real API
npm run typecheck
npm run build
npm run vendor        # copy built packages into examples/vendor
npm run serve         # http://localhost:4173
npm run e2e           # Playwright over the example pages
npm run lint          # Biome, which npm install brings in
```

`npm run typecheck` also fails if compiled output lands in `packages/*/src`. A stray
`.js` beside its `.ts` shadows the source for every `.js` import specifier here, and the
suite then runs against a snapshot of the code rather than the code.
