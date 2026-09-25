#!/usr/bin/env node
/**
 * Copies every already-published release into the tree about to be deployed.
 *
 * A Cloudflare Pages deployment is a whole site, not a patch. Uploading `cdn/` after
 * a version bump would therefore delete `/v/0.1.0/` on the way in, and every page
 * that pinned it would start 404ing -- against a `Cache-Control: immutable` header
 * that promised the opposite for a year, and with no error anywhere on our side,
 * because from here the deploy succeeded.
 *
 * So before publishing, the live site is asked what it is already serving and each
 * older release is fetched back into the new tree. The source of truth is what is
 * actually being served rather than anything in this repo, which is what makes it
 * self-healing: a release published from a laptop, or one whose commit was lost, is
 * still carried forward.
 *
 * Nothing here is quiet. A version listed and not fetchable fails the deploy, because
 * the alternative is publishing a tree that silently drops it.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Kept out of the module scope so the tests can drive it without a network. */
export async function retain({ base, out, version, fetch: get = fetch, log = () => {} }) {
  const origin = base.replace(/\/+$/, '');

  const published = await versions(origin, get);
  const older = published.filter((v) => v !== version);
  log(`live: ${published.length ? published.join(', ') : 'nothing published yet'}`);

  for (const old of older) {
    const dir = join(out, 'v', old);
    await mkdir(dir, { recursive: true });

    const manifest = await json(`${origin}/v/${old}/manifest.json`, get);
    // An old manifest with no `files` predates this script. It cannot be carried
    // forward correctly and guessing at the contents would publish a half-copy that
    // looks complete, so it stops the deploy and gets fixed by hand once.
    if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
      throw new Error(
        `${origin}/v/${old}/manifest.json lists no files, so that release cannot be ` +
          'carried forward. Copy it into the deploy directory by hand, or drop the ' +
          'version from versions.json if nothing is pinned to it.',
      );
    }

    for (const file of manifest.files) {
      // Filenames come off the live site, and they are used to build a path on this
      // filesystem. Anything with a separator in it is not a file this build wrote.
      if (file.includes('/') || file.includes('\\') || file.startsWith('.')) {
        throw new Error(`${old}/manifest.json names a file that is not a plain name: ${file}`);
      }
      await writeFile(join(dir, file), await bytes(`${origin}/v/${old}/${file}`, get));
    }
    log(`retained v/${old} (${manifest.files.length} files)`);
  }

  // Written last and covering everything, including this release. The next deploy
  // reads it back.
  const all = [...new Set([...published, version])].sort(compare);
  await writeFile(join(out, 'versions.json'), `${JSON.stringify(all, null, 2)}\n`);
  return { retained: older, versions: all };
}

/** What the live site says it is serving. Absent on the very first deploy. */
async function versions(origin, get) {
  const res = await get(`${origin}/versions.json`);
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new Error(`${origin}/versions.json answered ${res.status}; refusing to deploy blind`);
  }
  const list = await res.json();
  if (!Array.isArray(list) || list.some((v) => typeof v !== 'string')) {
    throw new Error(`${origin}/versions.json is not a list of version strings`);
  }
  return list;
}

async function json(url, get) {
  const res = await get(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
}

async function bytes(url, get) {
  const res = await get(url);
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Numeric where it can be, so 0.10.0 sorts after 0.9.0 rather than before it. */
function compare(a, b) {
  const left = a.split(/[.-]/);
  const right = b.split(/[.-]/);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? '';
    const y = right[i] ?? '';
    const nx = Number(x);
    const ny = Number(y);
    if (Number.isInteger(nx) && Number.isInteger(ny) && x !== '' && y !== '') {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

const self = fileURLToPath(import.meta.url);
// Compared as paths rather than URLs: on Windows the two spellings of a file URL
// differ by a drive-letter case and a slash direction, and the check quietly fails.
if (process.argv[1] && resolve(process.argv[1]) === self) {
  const here = dirname(self);
  const root = dirname(dirname(here));
  const { version } = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
  const result = await retain({
    base: process.env.CDN_ORIGIN ?? 'https://cdn.thesubtitledb.org',
    out: process.env.CDN_OUT ? resolve(process.env.CDN_OUT) : join(root, 'cdn'),
    version,
    log: (line) => console.log(line),
  });
  console.log(`versions.json -> ${result.versions.join(', ')}`);
}
