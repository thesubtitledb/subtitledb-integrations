# TheSubtitleDB browser extension

Subtitles from TheSubtitleDB on any video in Chrome 116+ and Firefox 142+, and AI
subtitles made on the device by SubBot when there are none.

Open it on a page with a video. It finds the video, including one in an iframe or a
shadow root, guesses what is playing from the site's player, the page's metadata or the
tab title, and searches the API. Pick a file and it is drawn over the video, in
fullscreen too. Sync moves every line earlier or later; the appearance settings (size,
height, background, colour) apply on every site. A file from the computer works the same
way.

AI subtitles run SubBot, the same code as the site and the CDN loader, inside the
extension. They need a video served as a file over http(s): a stream a site plays
through its own player (YouTube, Netflix and most paid services) cannot be read.

## Install

From a release (`extension-v*` on the releases page):

- Chrome: unzip `subtitledb-chrome-<v>.zip`, open `chrome://extensions`, turn on
  Developer mode, Load unpacked, pick the folder.
- Firefox: open `about:debugging#/runtime/this-firefox`, Load Temporary Add-on, pick
  `subtitledb-firefox-<v>.xpi`. It stays until Firefox restarts; a permanent install
  needs the copy signed by addons.mozilla.org.

## How it works

Nothing runs on a page until the popup is opened there. The popup then injects
`content.js` into every frame of the tab and calls it through `scripting.executeScript`.
The content script lives in the extension's isolated world, so the page cannot see or
call it.

| File | Does |
|---|---|
| `src/popup.ts` | the popup: video picker, search, results, sync, appearance, AI subtitles |
| `src/content.ts` | per frame: lists the videos, guesses the title, draws the overlay |
| `src/overlay.ts` | a closed shadow root over the video's rectangle; a text track when the video itself is fullscreen |
| `src/sites.ts`, `src/hint.ts` | title, season and episode from each supported site, then page metadata, then the tab title |
| `src/ai.ts` | SubBot through a core session, as the loader runs it |
| `src/worker-host.ts` | `worker.html`, the hidden frame SubBot's workers run in, in the extension's origin |
| `src/api.ts` | client name `chrome-extension` or `firefox-extension`, and a User-Agent naming the extension |

SubBot's workers run in `worker.html` so their fetches carry the extension's host
access and its model cache is shared by every site. The frame is in the page, so it
starts a worker only for a token the content script sent it through `runtime`
messaging, which page scripts cannot reach.

The API sees `client=chrome-extension` or `client=firefox-extension` on every request
and download, and a User-Agent ending `TheSubtitleDB-Extension/<v> (chrome)` or
`(firefox)`: set on each fetch in Firefox, and by a `declarativeNetRequest` session rule
in Chrome, which does not let a fetch set it.

## Build and test

```bash
node build.mjs            # dist/chrome, dist/firefox and the two archives
npm test                  # unit tests
npm run e2e               # Chromium, the Chrome build, against the live API
npm run e2e:firefox       # Firefox and geckodriver, the Firefox build
npm run icons             # static/icons from scripts/icons.mjs
```

`e2e:firefox` takes `FIREFOX_BIN` and `GECKODRIVER` (geckodriver 0.36 or newer). CI runs
all of it in `.github/workflows/extension.yml`, only when the extension, `packages/core/src`
or `packages/subbot` changes.
