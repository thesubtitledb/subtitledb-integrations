import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JavaScript.
import { manifest, zip } from '../build.mjs';
import { unreadable } from '../src/ai-check.js';
import { CLIENT, userAgent } from '../src/api.js';
import { DEFAULT_STYLE, readStyle } from '../src/shared.js';

describe('manifest', () => {
  it.each(['chrome', 'firefox'])('%s: MV3, opened on demand, wasm allowed, no remote code', (t) => {
    const m = manifest(t);
    expect(m.manifest_version).toBe(3);
    expect(m.content_scripts).toBeUndefined();
    expect(m.background).toBeUndefined();
    expect(m.content_security_policy.extension_pages).toBe(
      "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    );
    expect(m.web_accessible_resources).toEqual([
      { resources: ['worker.html'], matches: ['<all_urls>'] },
    ]);
    expect(m.name.length).toBeLessThanOrEqual(75);
    expect(m.description.length).toBeLessThanOrEqual(132);
  });

  it('gives Firefox a fixed id and Chrome the header rule permission', () => {
    expect(manifest('firefox').browser_specific_settings.gecko.id).toBe(
      'browser-extension@thesubtitledb.org',
    );
    expect(manifest('firefox').permissions).not.toContain('declarativeNetRequestWithHostAccess');
    expect(manifest('chrome').permissions).toContain('declarativeNetRequestWithHostAccess');
    expect(manifest('chrome').browser_specific_settings).toBeUndefined();
  });
});

describe('zip', () => {
  const dirs: string[] = [];
  afterAll(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  it('is reproducible and every entry inflates back to its file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tsdb-zip-'));
    dirs.push(dir);
    await writeFile(join(dir, 'b.txt'), 'b'.repeat(5000));
    await writeFile(join(dir, 'a.json'), '{}');
    const one = await zip(dir);
    const two = await zip(dir);
    expect(Buffer.compare(one, two)).toBe(0);

    const names: string[] = [];
    let p = 0;
    while (one.readUInt32LE(p) === 0x04034b50) {
      const method = one.readUInt16LE(p + 8);
      const size = one.readUInt32LE(p + 18);
      const nameLen = one.readUInt16LE(p + 26);
      const name = one.toString('utf8', p + 30, p + 30 + nameLen);
      const body = one.subarray(p + 30 + nameLen, p + 30 + nameLen + size);
      const data = method === 8 ? inflateRawSync(body) : body;
      expect(data.toString()).toBe(name === 'a.json' ? '{}' : 'b'.repeat(5000));
      names.push(name);
      p += 30 + nameLen + size;
    }
    expect(names).toEqual(['a.json', 'b.txt']);
  });
});

describe('naming', () => {
  it('names the browser in the client and the User-Agent', () => {
    expect(CLIENT).toBe('chrome-extension');
    expect(userAgent('Mozilla/5.0 X')).toBe(
      'Mozilla/5.0 X TheSubtitleDB-Extension/0.0.0-test (chrome)',
    );
  });
});

describe('unreadable', () => {
  const v = (src: string) => ({ currentSrc: src, src }) as HTMLVideoElement;
  it('lets SubBot try a file and refuses a stream it cannot read', () => {
    expect(unreadable(v('https://example.org/film.mp4'))).toBeNull();
    expect(unreadable(v('blob:https://example.org/0b8e'))).toMatch(/own player/);
    expect(unreadable(v(''))).toMatch(/not started/);
    expect(unreadable(v('file:///x.mp4'))).toMatch(/http/);
  });
});

describe('readStyle', () => {
  it('clamps what storage hands back and falls back on junk', () => {
    expect(readStyle(undefined)).toEqual(DEFAULT_STYLE);
    expect(readStyle({ size: 99, bottom: -5, box: 'x', color: 'red' })).toEqual({
      size: 9,
      bottom: 2,
      box: DEFAULT_STYLE.box,
      color: DEFAULT_STYLE.color,
    });
  });
});
