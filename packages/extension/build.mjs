#!/usr/bin/env node
/**
 * Builds the browser extension for Chrome and Firefox from one source:
 *
 *   dist/chrome/                      unpacked, for "Load unpacked"
 *   dist/firefox/                     unpacked, for about:debugging
 *   dist/subtitledb-chrome-<v>.zip    what the Chrome Web Store takes
 *   dist/subtitledb-firefox-<v>.xpi   what addons.mozilla.org takes
 *
 * Bundled from the packages' TypeScript sources, as the unit tests read them, so no
 * tsc build has to run first. The zips are byte-for-byte reproducible: fixed order,
 * fixed timestamps, no extra fields.
 *
 *   node build.mjs [chrome|firefox ...]   both when none is named
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
const { version } = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['chrome', 'firefox'];

const pkg = (p) => join(root, 'packages', p);
const ALIAS = {
  '@subtitledb/core': pkg('core/src/index.ts'),
  '@subtitledb/subbot/worker': pkg('subbot/src/asr/worker.ts'),
  '@subtitledb/subbot': pkg('subbot/src/index.ts'),
};

const NAME = 'TheSubtitleDB: subtitles for any video';
const DESCRIPTION =
  'Subtitles from TheSubtitleDB on any video you watch, and AI subtitles made on your device when there are none.';

export function manifest(target) {
  const m = {
    manifest_version: 3,
    name: NAME,
    short_name: 'TSDB',
    version,
    description: DESCRIPTION,
    homepage_url: 'https://thesubtitledb.org/developer/integrations',
    icons: { 16: 'icons/16.png', 32: 'icons/32.png', 48: 'icons/48.png', 128: 'icons/128.png' },
    action: {
      default_title: 'TheSubtitleDB',
      default_popup: 'popup.html',
      default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' },
    },
    permissions: ['scripting', 'storage'],
    // The pages the popup is opened on, and the API and the speech models. Nothing
    // runs on a page until the popup is opened there.
    host_permissions: ['<all_urls>'],
    // The frame SubBot's workers run in, which the content script puts in the page.
    web_accessible_resources: [{ resources: ['worker.html'], matches: ['<all_urls>'] }],
    // whisper.cpp is WebAssembly, shipped in the package.
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  };
  if (target === 'chrome') {
    m.minimum_chrome_version = '116';
    // Sets the User-Agent on the extension's own requests to the API; see src/api.ts.
    m.permissions.push('declarativeNetRequestWithHostAccess');
  } else {
    m.browser_specific_settings = {
      gecko: {
        id: 'browser-extension@thesubtitledb.org',
        strict_min_version: '142.0',
        data_collection_permissions: { required: ['websiteContent', 'searchTerms'] },
      },
    };
  }
  return m;
}

async function bundle(target, out) {
  const common = {
    bundle: true,
    platform: 'browser',
    target: target === 'chrome' ? 'chrome116' : 'firefox142',
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    alias: ALIAS,
    define: { __TARGET__: JSON.stringify(target), __VERSION__: JSON.stringify(version) },
    logLevel: 'warning',
  };
  await build({
    ...common,
    format: 'iife',
    entryPoints: {
      content: join(here, 'src/content.ts'),
      ai: join(here, 'src/ai.ts'),
      popup: join(here, 'src/popup.ts'),
      'worker-host': join(here, 'src/worker-host.ts'),
    },
    outdir: out,
  });
  // A module worker, as the CDN loader builds it.
  await build({
    ...common,
    format: 'esm',
    entryPoints: { 'subbot-worker': ALIAS['@subtitledb/subbot/worker'] },
    outdir: out,
  });
}

async function one(target) {
  const out = join(here, 'dist', target);
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await bundle(target, out);
  await cp(join(here, 'static'), out, { recursive: true });
  await cp(pkg('subbot/wasm/dist/subbot.wasm'), join(out, 'subbot.wasm'));
  await writeFile(join(out, 'manifest.json'), `${JSON.stringify(manifest(target), null, 2)}\n`);

  for (const f of ['content.js', 'popup.js', 'ai.js', 'subbot-worker.js', 'worker-host.js']) {
    const text = await readFile(join(out, f), 'utf8');
    if (text.length < 200) throw new Error(`${target}/${f} came out empty`);
    // Remotely hosted code is not allowed in either store: nothing may be imported
    // from a URL, and no bare package name may be left for a browser to resolve.
    if (/\bimport\s*\(\s*["'`]https?:/.test(text) || /from\s*["']https?:/.test(text)) {
      throw new Error(`${target}/${f} imports code from a URL`);
    }
    if (text.includes('@subtitledb/')) throw new Error(`${target}/${f} names a bare specifier`);
  }

  const ext = target === 'firefox' ? 'xpi' : 'zip';
  const archive = join(here, 'dist', `subtitledb-${target}-${version}.${ext}`);
  await writeFile(archive, await zip(out));
  console.log(`${target} ${version} -> ${relative(root, archive)}`);
}

/** Every file under dir, sorted, as [path in the zip, absolute path]. */
async function files(dir) {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  const walk = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push([relative(dir, p).split('\\').join('/'), p]);
    }
  };
  await walk(dir);
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * A plain zip: deflate, 1980-01-01 timestamps, no extra fields. Small enough to write
 * here rather than take a dependency for.
 */
export async function zip(dir) {
  const parts = [];
  const central = [];
  let offset = 0;
  const DOS_DATE = (0 << 9) | (1 << 5) | 1;
  for (const [name, path] of await files(dir)) {
    const data = await readFile(path);
    const packed = deflateRawSync(data, { level: 9 });
    const stored = packed.length >= data.length;
    const body = stored ? data : packed;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data) >>> 0;
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(stored ? 0 : 8, 8);
    head.writeUInt16LE(0, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(body.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(nameBuf.length, 26);
    head.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(stored ? 0 : 8, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(DOS_DATE, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    parts.push(head, nameBuf, body);
    central.push(cen, nameBuf);
    offset += head.length + nameBuf.length + body.length;
  }
  const cenSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const t of targets) {
    if (t !== 'chrome' && t !== 'firefox') throw new Error(`unknown target ${t}`);
    await one(t);
  }
}
