#!/usr/bin/env node
/**
 * Builds the tree that is served from cdn.thesubtitledb.org.
 *
 * Two passes, because the loader has to name files that do not exist until they are
 * built. Pass one bundles the two chunk entries with splitting on, which produces
 * content-hashed names and a third shared file holding core. Pass two bundles the
 * loader entries with those names stamped in.
 *
 * Layout, and the reason for it:
 *
 *   v/<version>/       every file, written once, never overwritten, cached for a year
 *   latest/            two entry files, overwritten each release, cached for minutes
 *
 * The `latest` entries are pinned to `v/<version>/` for their chunks, so a browser
 * holding a ten minute old entry cannot pair it with chunks from a newer release.
 * Only two files on the whole CDN are ever rewritten.
 */
import { createHash } from 'node:crypto';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(here));
// CDN_OUT lets the build test write a real tree somewhere disposable rather than
// over the one a dev server may be serving.
const out = process.env.CDN_OUT ? resolve(process.env.CDN_OUT) : join(root, 'cdn');

const { version } = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));

/** Where this tree will be served from. Only used when nothing better is available. */
const ORIGIN = process.env.CDN_ORIGIN ?? 'https://cdn.thesubtitledb.org';
const PINNED = `${ORIGIN.replace(/\/+$/, '')}/v/${version}/`;

const versioned = join(out, 'v', version);
const latest = join(out, 'latest');

const SHARED = {
  bundle: true,
  format: 'esm',
  platform: 'browser',
  // Matches tsconfig.base.json. Anything that cannot run ES2022 cannot run the
  // packages either, so down-levelling here would ship bytes for a browser that
  // would fail on the next file it loaded.
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  charset: 'utf8',
};

await rm(out, { recursive: true, force: true });
await mkdir(versioned, { recursive: true });
await mkdir(latest, { recursive: true });

// ---- pass one: the chunks --------------------------------------------------

const chunks = await build({
  ...SHARED,
  entryPoints: [
    join(here, 'src/chunks/engine.ts'),
    join(here, 'src/chunks/players.ts'),
    join(here, 'src/chunks/transcribe.ts'),
  ],
  outdir: versioned,
  // Splitting is what puts core in one file that both entries import rather than in
  // both of them. Without it a page that loads the bindings after the engine
  // downloads and runs a second copy of the client, the session and the registry --
  // and a second registry is two handles on one player.
  splitting: true,
  entryNames: '[name]-[hash]',
  chunkNames: 'sdb-[hash]',
  metafile: true,
});

/** Source entry basename to the hashed file it produced. */
const named = {};
for (const [file, meta] of Object.entries(chunks.metafile.outputs)) {
  const from = meta.entryPoint;
  if (!from) continue;
  const name = from.slice(from.lastIndexOf('/') + 1).replace(/\.ts$/, '');
  named[name] = file.slice(file.lastIndexOf('/') + 1);
}
for (const name of ['engine', 'players', 'transcribe']) {
  if (!named[name]) throw new Error(`chunk pass produced no ${name} entry`);
}

// ---- pass two: the loader --------------------------------------------------

const ENTRIES = [
  { file: 'entry.iife.ts', name: 'subtitle-helper.js', format: 'iife', global: 'SubtitleDB' },
  { file: 'entry.esm.ts', name: 'subtitle-helper.esm.js', format: 'esm' },
];

async function loader({ file, name, format, global: globalName }, dir, pinned) {
  const result = await build({
    ...SHARED,
    entryPoints: [join(here, 'src', file)],
    outfile: join(dir, name),
    format,
    splitting: false,
    ...(globalName ? { globalName } : {}),
    define: {
      __SDB_VERSION__: JSON.stringify(version),
      __SDB_CHUNKS__: JSON.stringify(named),
      __SDB_BASE__: JSON.stringify(PINNED),
      __SDB_PIN__: JSON.stringify(pinned),
    },
    // The chunk specifier is built at runtime, so esbuild cannot follow it and says
    // so. That is the intent: following it would inline the graph and there would be
    // nothing lazy left.
    logOverride: { 'unsupported-dynamic-import': 'silent' },
    write: false,
  });
  const [file0] = result.outputFiles;
  const text = new TextDecoder().decode(file0.contents);

  // A bundler that silently emits nothing is how an empty 200 gets served as valid
  // but dead JavaScript, and the page then reports no error at all.
  if (text.trim().length < 200) throw new Error(`${name} came out empty; refusing to write a stub`);
  if (text.includes('@subtitledb/')) {
    throw new Error(`${name} still names a bare specifier, which only an import map resolves`);
  }
  // import.meta in an IIFE is rewritten to an object that is not a URL, which would
  // send every chunk request somewhere harmless-looking and wrong.
  if (format === 'iife' && /import\s*\.\s*meta/.test(text)) {
    throw new Error(`${name} contains import.meta, which has no meaning in a classic script`);
  }
  await writeFile(join(dir, name), text);
  return { name, bytes: Buffer.byteLength(text), sri: sri(text) };
}

function sri(text) {
  return `sha384-${createHash('sha384').update(text).digest('base64')}`;
}

// The versioned copies are the ones the manifest describes. Building both into one
// list and slicing it produced a manifest quoting the size and hash of the mutable
// copy, which is the one thing that must never be quoted anywhere.
const built = [];
for (const entry of ENTRIES) {
  built.push(await loader(entry, versioned, false));
  await loader(entry, latest, true);
}

// ---- what is served with it ------------------------------------------------

await cp(join(here, 'public/_headers'), join(out, '_headers'));
await cp(join(here, 'public/_redirects'), join(out, '_redirects'));

/**
 * Sizes and integrity hashes for the versioned entries, so the docs can quote an
 * `integrity` attribute without anyone computing one by hand. Only the immutable
 * copies get one: a hash for a file that is overwritten every release is a hash that
 * breaks every page holding it.
 *
 * `files` is the complete contents of this directory, and it is not documentation.
 * A Cloudflare Pages deployment replaces the whole site, so publishing a new release
 * would delete every earlier `/v/x.y.z/` tree and 404 every page that pinned one --
 * against headers that told the browser to cache it for a year. retain.mjs reads this
 * list off the live site to copy each older release forward, and it can only copy
 * what something names.
 */
const files = (await readdir(versioned)).concat('manifest.json').sort();
const manifest = {
  version,
  base: PINNED,
  chunks: named,
  files,
  entries: Object.fromEntries(built.map((e) => [e.name, { bytes: e.bytes, integrity: e.sri }])),
};
await writeFile(join(versioned, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
console.log(`subtitledb ${version} -> cdn/`);
for (const entry of built) {
  console.log(`  ${entry.name.padEnd(12)} ${kb(entry.bytes)}`);
}
// Keyed by a path relative to cwd, which is not the output directory and need not be
// anywhere near it, so match on the filename esbuild actually emitted.
const sized = Object.fromEntries(
  Object.entries(chunks.metafile.outputs).map(([file, meta]) => [
    file.slice(file.lastIndexOf('/') + 1),
    meta.bytes,
  ]),
);
for (const [name, file] of Object.entries(named)) {
  console.log(`  ${name.padEnd(12)} ${file} ${kb(sized[file] ?? 0)}`);
}
