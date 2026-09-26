/**
 * What actually gets uploaded.
 *
 * Every other test in this package runs against source through vitest's aliases,
 * which resolve bare specifiers, hand back TypeScript and stamp the four build-time
 * constants themselves. The published artefact has none of that: it is one minified
 * file that a browser fetches from another origin and runs with no resolver behind
 * it. The failures that only exist there are the ones this file is for, and each of
 * them ships a working-looking build that is dead on arrival.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = dirname(dirname(dirname(here)));

const ORIGIN = 'https://cdn.build.test';

/**
 * The headers _headers gives one exact path pattern.
 *
 * Cloudflare's format: an unindented line opens a pattern, indented lines below it are
 * its headers. Matching the whole file as one string would pass on a rule written under
 * the wrong pattern, which is the only mistake here worth a test.
 */
function block(text: string, pattern: string): Record<string, string> {
  const out: Record<string, string> = {};
  let inside = false;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      inside = line.trim() === pattern;
      continue;
    }
    if (!inside) continue;
    const at = line.indexOf(':');
    if (at > 0) out[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return out;
}

let out: string;
let version: string;
let iife: string;
let esm: string;
let latestIife: string;
let manifest: {
  version: string;
  base: string;
  chunks: Record<string, string>;
  files: string[];
  entries: Record<string, { bytes: number; integrity: string }>;
};

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), 'sdb-cdn-'));
  await run('node', [join(root, 'packages/loader/build.mjs')], {
    cwd: root,
    env: { ...process.env, CDN_OUT: out, CDN_ORIGIN: ORIGIN },
  });
  ({ version } = JSON.parse(await readFile(join(root, 'packages/loader/package.json'), 'utf8')));
  const v = join(out, 'v', version);
  iife = await readFile(join(v, 'subtitle-helper.js'), 'utf8');
  esm = await readFile(join(v, 'subtitle-helper.esm.js'), 'utf8');
  latestIife = await readFile(join(out, 'latest/subtitle-helper.js'), 'utf8');
  manifest = JSON.parse(await readFile(join(v, 'manifest.json'), 'utf8'));
}, 120_000);

describe('the tree', () => {
  it('has both entry formats at the versioned path and at latest', async () => {
    const v = await readdir(join(out, 'v', version));
    expect(v).toEqual(
      expect.arrayContaining(['subtitle-helper.js', 'subtitle-helper.esm.js', 'manifest.json']),
    );
    expect(await readdir(join(out, 'latest'))).toEqual(
      expect.arrayContaining(['subtitle-helper.js', 'subtitle-helper.esm.js']),
    );
  });

  it('ships _headers, without which every cross-origin import fails', async () => {
    const headers = await readFile(join(out, '_headers'), 'utf8');
    expect(headers).toMatch(/^\/v\/\*$/m);
    expect(headers).toMatch(/^\/latest\/\*$/m);
    expect(headers).toMatch(/Access-Control-Allow-Origin: \*/);
    expect(headers).toMatch(/Cross-Origin-Resource-Policy: cross-origin/);
    expect(headers).toMatch(/immutable/);
  });

  it('and versions.json is never cached, because a stale one deletes a release', async () => {
    // retain.mjs reads this file off the live site to decide what to carry forward.
    // Served from a four hour edge cache it answers with the list as it was before the
    // last publish, and the release missing from that list is left out of the tree
    // that goes up. The deploy then reports success while 404ing a version it
    // promised a year of immutability to.
    const rules = block(await readFile(join(out, '_headers'), 'utf8'), '/versions.json');
    expect(rules['cache-control']).toBe('no-store');
    // Fetched by a Node script rather than a browser today, but the file is the
    // manifest of what this origin serves, and a page has every reason to read it.
    expect(rules['access-control-allow-origin']).toBe('*');
  });

  it('and the plugins are re-read within minutes, because every deploy rewrites them', async () => {
    // The Emby zip keeps one name for every version, and the Jellyfin manifest one name
    // for every deploy. Held for Pages' four hour default, both answer with the release
    // before for the rest of the afternoon.
    const rules = block(await readFile(join(out, '_headers'), 'utf8'), '/plugins/*');
    expect(rules['cache-control']).toBe('public, max-age=300, must-revalidate');
  });

  it('ships _redirects, so the names this file had before still answer', async () => {
    // sdb.js was the published snippet in 0.1.0, and subtitle-finder.js until 0.5.0.
    // Both are paths somebody may have copied, and a rename that 404s them is a rename
    // that breaks pages we cannot see. Each goes straight to the current name, so a
    // page pays one hop, not a chain. Only /latest/ is redirected: an older /v/<ver>/
    // file is real, carried forward by retain.mjs and served under a year of
    // immutability, so it has to keep answering as itself.
    const rules = (await readFile(join(out, '_redirects'), 'utf8'))
      .split('\n')
      .filter((l) => l.startsWith('/'))
      .map((l) => l.trim().split(/\s+/));
    expect(rules).toEqual([
      ['/latest/sdb.js', '/latest/subtitle-helper.js', '301'],
      ['/latest/sdb.esm.js', '/latest/subtitle-helper.esm.js', '301'],
      ['/latest/subtitle-finder.js', '/latest/subtitle-helper.js', '301'],
      ['/latest/subtitle-finder.esm.js', '/latest/subtitle-helper.esm.js', '301'],
    ]);
    // A target this build does not write is a redirect to a 404.
    const latest = await readdir(join(out, 'latest'));
    for (const [, to] of rules) expect(latest).toContain(to.slice('/latest/'.length));
  });

  it('and the copy served is the one under review, not a second one drifting', async () => {
    // A copy in scripts/ or a hand-written one in the Pages dashboard is the version
    // that would actually be deployed, and nothing here would notice it changing.
    expect(await readFile(join(out, '_redirects'), 'utf8')).toBe(
      await readFile(join(root, 'packages/loader/public/_redirects'), 'utf8'),
    );
    expect(await readFile(join(out, '_headers'), 'utf8')).toBe(
      await readFile(join(root, 'packages/loader/public/_headers'), 'utf8'),
    );
  });
});

describe('every chunk the loader can ask for exists', () => {
  it('by the exact name stamped into the entry', async () => {
    const files = await readdir(join(out, 'v', version));
    for (const [name, file] of Object.entries(manifest.chunks)) {
      expect(files, `${name} chunk is named but not emitted`).toContain(file);
      // The name has to appear in the entry too, or the entry is asking for
      // something else entirely and only a browser would find out.
      expect(iife).toContain(file);
      expect(esm).toContain(file);
    }
  });

  it('names all three chunks, the transcription one among them', async () => {
    // The transcription chunk is the third entry and the last-loaded: pulled only on a
    // synthetic select. It has to be named in the entry so the loader can ask for it.
    expect(Object.keys(manifest.chunks).sort()).toEqual(['engine', 'players', 'transcribe']);
    const files = await readdir(join(out, 'v', version));
    expect(files).toContain(manifest.chunks.transcribe);
    expect(iife).toContain(manifest.chunks.transcribe);
    expect(esm).toContain(manifest.chunks.transcribe);
  });

  it('including the shared file the two chunks both import', async () => {
    const files = await readdir(join(out, 'v', version));
    const shared = files.filter((f) => f.startsWith('sdb-') && f.endsWith('.js'));
    // Splitting is what keeps core in one file. Without it a page that loads the
    // bindings after the engine runs a second copy of the registry, which is the
    // exact thing guard.ts exists to prevent between loaders.
    expect(shared, 'splitting produced no shared chunk').toHaveLength(1);
    const engine = await readFile(join(out, 'v', version, manifest.chunks.engine), 'utf8');
    expect(engine).toContain(shared[0]);
  });
});

describe('nothing survives that a browser cannot resolve', () => {
  it('no bare @subtitledb/ specifier', () => {
    // Resolvable today only through the import map in the mainsite's own HTML. On
    // anyone else's page it is a bare specifier and the module fails to load.
    expect(iife).not.toContain('@subtitledb/');
    expect(esm).not.toContain('@subtitledb/');
  });

  it('no import.meta in the classic script', () => {
    // esbuild rewrites it to an object literal in IIFE format, so it does not throw.
    // It resolves to something that is not a URL, and every chunk request then goes
    // somewhere plausible and wrong.
    expect(iife).not.toMatch(/import\s*\.\s*meta/);
  });

  it('and the module build keeps the one it needs', () => {
    expect(esm).toMatch(/import\s*\.\s*meta/);
  });

  it('exactly one dynamic import, built at runtime', () => {
    // More than one means a literal specifier got through and esbuild followed it,
    // which inlines the graph and leaves nothing lazy.
    expect(iife.match(/\bimport\(/g)).toHaveLength(1);
    expect(esm.match(/\bimport\(/g)).toHaveLength(1);
  });

  it('and it is not a stub', () => {
    // A bundler that silently writes nothing serves a valid, empty, dead 200. The
    // page reports no error at all, which is the worst failure mode available.
    expect(iife.trim().length).toBeGreaterThan(200);
    expect(esm.trim().length).toBeGreaterThan(200);
  });
});

describe('latest is pinned to a version', () => {
  it('so a cached entry cannot pair with chunks from a newer release', () => {
    // The whole reason two copies of the same file exist. latest/subtitle-helper.js is
    // overwritten every release and may be five minutes stale in a browser; if it
    // resolved chunks next to itself it would pull the new ones and put two versions
    // of the WeakMaps on one page.
    expect(latestIife).toContain(`${ORIGIN}/v/${version}/`);
  });

  it('while the versioned copy still resolves next to itself', () => {
    // Self-hosting and the /v/ path both depend on this branch surviving.
    expect(iife).toContain('currentScript');
  });
});

describe('the manifest', () => {
  it('describes the immutable copies and only those', () => {
    // An integrity hash for a file that is overwritten every release breaks every
    // page holding it, which is why latest is not in here.
    expect(Object.keys(manifest.entries).sort()).toEqual([
      'subtitle-helper.esm.js',
      'subtitle-helper.js',
    ]);
    expect(manifest.version).toBe(version);
    expect(manifest.base).toBe(`${ORIGIN}/v/${version}/`);
  });

  it('names every file in the directory, because that is what carries a release forward', async () => {
    // retain.mjs copies an old release into the next deploy from this list alone. A
    // file emitted and not listed is a file the next version bump deletes from a
    // tree that is meant to be immutable, and nothing on our side reports it.
    const files = await readdir(join(out, 'v', version));
    expect([...manifest.files].sort()).toEqual(files.sort());
  });

  it('quotes a hash that matches the bytes on disk', async () => {
    const { createHash } = await import('node:crypto');
    for (const [name, meta] of Object.entries(manifest.entries)) {
      const text = await readFile(join(out, 'v', version, name), 'utf8');
      const sri = `sha384-${createHash('sha384').update(text).digest('base64')}`;
      expect(meta.integrity, `${name} integrity does not match the file`).toBe(sri);
      expect(meta.bytes).toBe(Buffer.byteLength(text));
    }
  });
});

describe('the entry stays small enough to be worth splitting', () => {
  it('under 6 KB, or the lazy loading is paying for itself in the entry', async () => {
    const { gzipSync } = await import('node:zlib');
    for (const [name, text] of [
      ['subtitle-helper.js', iife],
      ['subtitle-helper.esm.js', esm],
    ] as const) {
      const gz = gzipSync(Buffer.from(text)).length;
      expect(gz, `${name} is ${gz} B gzipped`).toBeLessThan(6 * 1024);
    }
  });
});

// The temp tree is a build artefact, not a fixture worth keeping.
afterAll(async () => {
  if (out) await rm(out, { recursive: true, force: true });
});
