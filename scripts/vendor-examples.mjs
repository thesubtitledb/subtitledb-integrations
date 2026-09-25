#!/usr/bin/env node
/**
 * Copy built packages and the player libraries into examples/vendor.
 *
 * The examples load real ES modules straight from disk with an import map, so there
 * is no bundler involved in any of them. Vendoring rather than pointing at somebody
 * else's CDN is a house rule, and it is also the only way the Playwright run stays
 * hermetic: an example that fetches its player from the network fails whenever the
 * network does, and that failure looks exactly like a broken adapter.
 *
 * That rule is about not handing our visitors' IP addresses to a third party, and
 * publishing our own origin for other people's pages is the opposite direction of
 * travel, not a reversal. packages/loader is that: examples/cdn.html and
 * examples/cdn-esm.html load it from a locally built tree served by
 * scripts/serve-cdn.mjs on a second port, so they stay hermetic too.
 *
 * examples/vendor is generated and gitignored. Run `npm run build` first.
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendor = join(root, 'examples', 'vendor');

/** [source, destination under examples/vendor, required]. Files and directories both. */
const COPIES = [
  ['packages/core/dist', 'core', true],
  ['packages/artplayer/dist', 'artplayer-adapter', true],
  ['packages/html5/dist', 'html5-adapter', true],
  ['packages/players/dist', 'players-adapter', true],

  // Player libraries, in the shape examples/players.html loads them. Optional so a
  // checkout that skipped the optional devDependencies still builds the other pages;
  // players.html reports a missing library rather than silently rendering nothing.
  ['node_modules/artplayer/dist', 'artplayer', true],
  ['node_modules/plyr/dist', 'plyr', false],
  ['node_modules/video.js/dist', 'videojs', false],
  [
    'node_modules/shaka-player/dist/shaka-player.compiled.js',
    'shaka/shaka-player.compiled.js',
    false,
  ],
  ['node_modules/vidstack/cdn', 'vidstack', false],
  ['node_modules/dplayer/dist', 'dplayer', false],
  ['node_modules/@clappr/player/dist', 'clappr', false],
  ['node_modules/openplayerjs/dist', 'openplayerjs', false],
  ['node_modules/xgplayer/dist', 'xgplayer', false],
  ['node_modules/mediaelement/build', 'mediaelement', false],
  ['node_modules/media-chrome/dist/iife', 'mediachrome', false],
  ['node_modules/hls.js/dist/hls.min.js', 'hlsjs/hls.min.js', false],

  // Commercial players. Their libraries load and construct without a licence, which
  // is enough to check the binding against the real API surface; playback and
  // side-loaded tracks are what the key unlocks.
  ['node_modules/bitmovin-player/bitmovinplayer.js', 'bitmovin/bitmovinplayer.js', false],
  ['node_modules/bitmovin-player/bitmovinplayer-ui.js', 'bitmovin/bitmovinplayer-ui.js', false],
  ['node_modules/bitmovin-player/bitmovinplayer-ui.css', 'bitmovin/bitmovinplayer-ui.css', false],
  ['node_modules/theoplayer', 'theoplayer', false],
  ['node_modules/@flowplayer/player', 'flowplayer', false],
];

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  for (const [from, , required] of COPIES) {
    if (required && !(await exists(join(root, from)))) {
      console.error(`missing ${from}. Run npm install and npm run build first.`);
      process.exit(1);
    }
  }

  await rm(vendor, { recursive: true, force: true });
  await mkdir(vendor, { recursive: true });

  const skipped = [];
  for (const [from, to] of COPIES) {
    if (!(await exists(join(root, from)))) {
      skipped.push(from);
      continue;
    }
    const dest = join(vendor, to);
    await mkdir(dirname(dest), { recursive: true });
    await cp(join(root, from), dest, { recursive: true });
    console.log(`vendored ${from} -> examples/vendor/${to}`);
  }
  if (skipped.length) console.log(`skipped ${skipped.length} optional: ${skipped.join(', ')}`);
}

await main();
