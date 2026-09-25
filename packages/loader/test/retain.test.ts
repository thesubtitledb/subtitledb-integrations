/**
 * Carrying the already-published releases into the next deploy.
 *
 * This is the file standing between a version bump and every pinned page on the
 * internet 404ing. A Cloudflare Pages deployment replaces the whole site, so the
 * failure needs no bug to happen: publishing the ordinary way is what causes it, the
 * deploy reports success, and the only symptom is on somebody else's page against a
 * header that told their browser not to check for a year.
 */
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// @ts-expect-error deploy-time script, plain JavaScript with no declarations
import { retain } from '../retain.mjs';

const ORIGIN = 'https://cdn.test';

/** A stand-in for the live site: a path-to-body map, and a record of what was asked. */
function site(files: Record<string, string>) {
  const asked: string[] = [];
  const get = async (url: string) => {
    asked.push(url);
    const path = url.slice(ORIGIN.length);
    const body = files[path];
    if (body === undefined) {
      return { ok: false, status: 404, json: fail, arrayBuffer: fail };
    }
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(body),
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    };
  };
  const fail = async () => {
    throw new Error('no body');
  };
  return { get, asked };
}

function manifest(version: string, files: string[]) {
  return JSON.stringify({ version, files: [...files, 'manifest.json'] });
}

let out: string;

beforeEach(async () => {
  out = await mkdtemp(join(tmpdir(), 'sdb-retain-'));
});

afterEach(async () => {
  await rm(out, { recursive: true, force: true });
});

describe('the first deploy', () => {
  it('has nothing to carry and says so rather than failing', async () => {
    const { get } = site({});
    const result = await retain({ base: ORIGIN, out, version: '0.1.0', fetch: get });
    expect(result.retained).toEqual([]);
    expect(result.versions).toEqual(['0.1.0']);
  });

  it('leaves a versions.json for the next one to read', async () => {
    const { get } = site({});
    await retain({ base: ORIGIN, out, version: '0.1.0', fetch: get });
    expect(JSON.parse(await readFile(join(out, 'versions.json'), 'utf8'))).toEqual(['0.1.0']);
  });
});

describe('a release after one that is already live', () => {
  const live = {
    '/versions.json': JSON.stringify(['0.1.0']),
    '/v/0.1.0/manifest.json': manifest('0.1.0', ['subtitle-finder.js', 'engine-AAAA.js']),
    '/v/0.1.0/subtitle-finder.js': 'the old entry',
    '/v/0.1.0/engine-AAAA.js': 'the old chunk',
  };

  it('fetches every file the old manifest names', async () => {
    const { get } = site(live);
    const result = await retain({ base: ORIGIN, out, version: '0.2.0', fetch: get });

    expect(result.retained).toEqual(['0.1.0']);
    expect((await readdir(join(out, 'v/0.1.0'))).sort()).toEqual([
      'engine-AAAA.js',
      'manifest.json',
      'subtitle-finder.js',
    ]);
    expect(await readFile(join(out, 'v/0.1.0/subtitle-finder.js'), 'utf8')).toBe('the old entry');
  });

  it('adds the new version to the list without dropping the old', async () => {
    const { get } = site(live);
    const result = await retain({ base: ORIGIN, out, version: '0.2.0', fetch: get });
    expect(result.versions).toEqual(['0.1.0', '0.2.0']);
  });

  it('does not fetch the version being published, which is already on disk', async () => {
    const { get, asked } = site({ ...live, '/versions.json': JSON.stringify(['0.1.0', '0.2.0']) });
    // A redeploy of the same version. The built tree is the newer one and must win.
    await retain({ base: ORIGIN, out, version: '0.2.0', fetch: get });
    expect(asked.filter((u) => u.includes('/v/0.2.0/'))).toEqual([]);
  });

  it('sorts numerically, so 0.10.0 comes after 0.9.0', async () => {
    const { get } = site({
      '/versions.json': JSON.stringify(['0.9.0', '0.1.0']),
      '/v/0.9.0/manifest.json': manifest('0.9.0', ['subtitle-finder.js']),
      '/v/0.9.0/subtitle-finder.js': 'nine',
      '/v/0.1.0/manifest.json': manifest('0.1.0', ['subtitle-finder.js']),
      '/v/0.1.0/subtitle-finder.js': 'one',
    });
    const result = await retain({ base: ORIGIN, out, version: '0.10.0', fetch: get });
    expect(result.versions).toEqual(['0.1.0', '0.9.0', '0.10.0']);
  });
});

describe('what it refuses to publish over', () => {
  it('a versions.json that answers with an error', async () => {
    // Not the same as absent. A 500 means the site is there and something is wrong,
    // and treating it as "nothing published yet" deletes everything.
    const get = async () => ({ ok: false, status: 503, json: null, arrayBuffer: null });
    await expect(retain({ base: ORIGIN, out, version: '0.2.0', fetch: get })).rejects.toThrow(
      /503/,
    );
  });

  it('a listed version whose files are gone', async () => {
    const { get } = site({
      '/versions.json': JSON.stringify(['0.1.0']),
      '/v/0.1.0/manifest.json': manifest('0.1.0', ['subtitle-finder.js']),
      // subtitle-finder.js missing.
    });
    await expect(retain({ base: ORIGIN, out, version: '0.2.0', fetch: get })).rejects.toThrow(
      /subtitle-finder\.js answered 404/,
    );
  });

  it('a manifest from before this script existed, which names nothing', async () => {
    const { get } = site({
      '/versions.json': JSON.stringify(['0.1.0']),
      '/v/0.1.0/manifest.json': JSON.stringify({ version: '0.1.0' }),
    });
    await expect(retain({ base: ORIGIN, out, version: '0.2.0', fetch: get })).rejects.toThrow(
      /lists no files/,
    );
  });

  it('a filename off the live site that is really a path', async () => {
    // The names are joined onto a local path, and the live site is not a trusted
    // input just because it is ours: a compromised or wrong manifest would otherwise
    // write outside the deploy directory.
    const { get } = site({
      '/versions.json': JSON.stringify(['0.1.0']),
      '/v/0.1.0/manifest.json': JSON.stringify({ files: ['../../../evil.js'] }),
    });
    await expect(retain({ base: ORIGIN, out, version: '0.2.0', fetch: get })).rejects.toThrow(
      /not a plain name/,
    );
  });

  it('a versions.json holding something that is not a list of versions', async () => {
    const { get } = site({ '/versions.json': JSON.stringify({ latest: '0.1.0' }) });
    await expect(retain({ base: ORIGIN, out, version: '0.2.0', fetch: get })).rejects.toThrow(
      /not a list/,
    );
  });
});
