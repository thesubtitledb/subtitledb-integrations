import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
// @ts-expect-error build.mjs is plain JavaScript.
import { manifest, zip } from '../build.mjs';
import { unreadable } from '../src/ai-check.js';

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
    expect(m.name).toBe('__MSG_appName__');
    expect(m.description).toBe('__MSG_appDescription__');
    expect(m.default_locale).toBe('en');
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

describe('unreadable', () => {
  const v = (src: string) => ({ currentSrc: src, src }) as HTMLVideoElement;
  it('lets SubBot try a file and refuses a stream it cannot read', () => {
    expect(unreadable(v('https://example.org/film.mp4'))).toBeNull();
    expect(unreadable(v('blob:https://example.org/0b8e'))).toBe('ai.why.ownPlayer');
    expect(unreadable(v(''))).toBe('ai.why.notStarted');
    expect(unreadable(v('file:///x.mp4'))).toBe('ai.why.http');
  });
});
