/**
 * Where the chunks are asked for.
 *
 * The whole package is one round trip away from working or being completely broken on
 * every host page at once, and the difference is this file. A classic script resolves
 * `import()` against the page, so a wrong answer here means example.com serves its
 * own 404 page in place of our module, on every site that ever embeds this.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dirOf, withSlash } from '../src/base.js';

/** Re-import so the module-level capture of document.currentScript runs again. */
async function reload(currentScript: { src?: string } | null) {
  vi.resetModules();
  const host = globalThis as Record<string, unknown>;
  host.document = currentScript === null ? undefined : { currentScript };
  const mod = await import('../src/base.js');
  host.document = undefined;
  return mod;
}

describe('dirOf', () => {
  it('keeps the directory and the slash', () => {
    expect(dirOf('https://cdn.test/v/1.0.0/subtitle-helper.js')).toBe('https://cdn.test/v/1.0.0/');
  });

  it('drops a query string, which a cache buster puts there', () => {
    expect(dirOf('https://cdn.test/v/1.0.0/subtitle-helper.js?v=2')).toBe(
      'https://cdn.test/v/1.0.0/',
    );
  });

  it('drops a fragment', () => {
    expect(dirOf('https://cdn.test/v/1.0.0/subtitle-helper.js#x')).toBe(
      'https://cdn.test/v/1.0.0/',
    );
  });

  it('answers nothing for something with no path at all', () => {
    expect(dirOf('subtitle-helper.js')).toBe('');
  });
});

describe('withSlash', () => {
  it('adds the one that is missing', () => {
    expect(withSlash('https://cdn.test/v/1')).toBe('https://cdn.test/v/1/');
  });

  it('does not add a second', () => {
    expect(withSlash('https://cdn.test/v/1/')).toBe('https://cdn.test/v/1/');
  });

  it('leaves empty empty, so a caller can tell it apart from a root path', () => {
    expect(withSlash('')).toBe('');
  });
});

describe('basePath', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('uses the module URL when there is one, because a module knows where it is', async () => {
    const { basePath } = await reload(null);
    expect(basePath('https://elsewhere.test/js/subtitle-helper.esm.js')).toBe(
      'https://elsewhere.test/js/',
    );
  });

  it('falls back to the script element, which is all a classic script has', async () => {
    const { basePath } = await reload({ src: 'https://cdn.test/v/1.0.0/subtitle-helper.js' });
    expect(basePath()).toBe('https://cdn.test/v/1.0.0/');
  });

  it('prefers the module URL over the script element', async () => {
    const { basePath } = await reload({ src: 'https://wrong.test/a/subtitle-helper.js' });
    expect(basePath('https://right.test/b/subtitle-helper.esm.js')).toBe('https://right.test/b/');
  });

  it('falls back to the stamped origin when nothing on the page says', async () => {
    const { basePath } = await reload(null);
    expect(basePath()).toBe('https://cdn.example.test/v/0.0.0-test/');
  });

  it('an override beats everything, which is what self-hosting needs', async () => {
    const { basePath, setBasePath } = await reload({
      src: 'https://cdn.test/v/1.0.0/subtitle-helper.js',
    });
    setBasePath('https://mine.test/subtitles');
    expect(basePath('https://elsewhere.test/js/subtitle-helper.esm.js')).toBe(
      'https://mine.test/subtitles/',
    );
  });

  it('survives a document with no currentScript, which is every module', async () => {
    const { basePath } = await reload({});
    expect(basePath()).toBe('https://cdn.example.test/v/0.0.0-test/');
  });

  it('survives no document at all, which is a worker', async () => {
    const { basePath } = await reload(null);
    expect(() => basePath()).not.toThrow();
  });
});
