import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = fileURLToPath(new URL('.', import.meta.url));
const tsc = join(here, '../../../node_modules/typescript/bin/tsc');

/**
 * A consumer compiling with exactOptionalPropertyTypes cannot pass `{ key: maybe }`
 * to an option typed `key?: string`. Every public option is `| undefined` for that
 * reason, and the only way to prove it is to compile as such a consumer would.
 */
function consumer(index: string): string {
  return `
import { createClient, createSession, query } from '${index}';
declare const s: string | undefined;
declare const n: number | undefined;
declare const b: boolean | undefined;

createClient({ key: s, apiBase: s, client: s, downloadClient: s, antispamId: s, timeoutMs: n, retries: n, fetch: undefined });
const c = createClient();
void c.byImdb('tt1', { lang: s, languages: undefined, limit: n, offset: n, format: s, sort: undefined, season: n, episode: n, signal: undefined });
void c.byTmdb(1, { season: n, episode: n, response_class: undefined, type: undefined });
void c.byTmdb(1, { type: 'tv' });
void c.byImdb('tt1', { sort: 'newest' });
// @ts-expect-error the API has no such sort
void c.byImdb('tt1', { sort: 'downloads' });
void c.search('x', { lang: s, languages: undefined, type: undefined, year: n, limit: n, dir: undefined });
void c.fetchSubtitleText({ download_url: '', format: 'srt' }, { encoding: s, signal: undefined });
void query({
  hint: { imdbId: s, tmdbId: n, tmdbType: undefined, seriesImdbId: s, title: s, year: n, season: n, episode: n, release: s },
  languages: undefined, lang: s, key: s, limit: n, hearingImpaired: b,
  convertTo: undefined, offsetMs: n, fps: undefined, encoding: s, cues: b,
  apiBase: s, clientName: s, downloadClient: s, antispamId: s,
});
createSession({ formats: [], languages: undefined, key: s, apiBase: s, autoSelect: undefined, limit: n, maxRequests: n, hearingImpaired: b, convertTo: undefined, onError: undefined, transcribe: undefined });
`;
}

// Fails under exactOptionalPropertyTypes, which proves the flag is on in this run.
const CONTROL =
  'declare const s: string | undefined;\nconst o: { a?: string } = { a: s };\nvoid o;\n';

describe('public option types', () => {
  it('compile for a consumer with exactOptionalPropertyTypes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sdb-types-'));
    try {
      const index = relative(dir, join(here, '../src/index.js')).replace(/\\/g, '/');
      writeFileSync(
        join(dir, 'consumer.ts'),
        consumer(index.startsWith('.') ? index : `./${index}`),
      );
      writeFileSync(join(dir, 'control.ts'), CONTROL);
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            exactOptionalPropertyTypes: true,
            noEmit: true,
            module: 'nodenext',
            moduleResolution: 'nodenext',
            target: 'es2022',
            lib: ['es2022', 'dom', 'dom.iterable'],
            skipLibCheck: true,
          },
          files: ['consumer.ts', 'control.ts'],
        }),
      );
      let out = '';
      try {
        out = execFileSync(process.execPath, [tsc, '-p', dir, '--pretty', 'false'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        const err = e as { stdout?: string; stderr?: string; message?: string };
        out = [err.stdout, err.stderr, err.message].map((x) => x ?? '').join('\n');
      }
      const errors = out.split('\n').filter((l) => /error TS\d+/.test(l));
      expect(
        errors.filter((l) => l.includes('control.ts')),
        out,
      ).toHaveLength(1);
      expect(
        errors.filter((l) => !l.includes('control.ts')),
        out,
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
