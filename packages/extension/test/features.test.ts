import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { byFit, fileName, fit } from '../src/fit.js';
import { withoutHearingImpaired } from '../src/hi.js';
import { LOCALES, pickLocale } from '../src/i18n.js';
import { DEFAULT_SETTINGS, DEFAULT_STYLE, readSettings, readStyle } from '../src/shared.js';

const FILM = 6000;

describe('fit', () => {
  it('scores a file that ends in the credits as a full match', () => {
    expect(fit({ durationS: FILM - 300 }, { duration: FILM })).toEqual({
      score: 100,
      why: 'same',
      minutes: 5,
    });
  });

  it('marks a file that runs past the video down hard, one short of it gently', () => {
    const over = fit({ durationS: FILM + 180 }, { duration: FILM });
    const under = fit({ durationS: FILM - 1000 }, { duration: FILM });
    expect(over?.why).toBe('longer');
    expect(over?.minutes).toBe(3);
    expect(over?.score).toBeLessThan(10);
    expect(under?.why).toBe('shorter');
    expect(under?.score).toBeGreaterThan(over?.score ?? 0);
    expect(under?.score).toBeLessThan(100);
  });

  it('weighs the release against the file name', () => {
    const video = { duration: FILM, file: 'Film.2019.1080p.BluRay.x264-SPARKS.mkv' };
    const same = fit(
      { durationS: FILM - 200, release: 'Film.2019.1080p.BluRay.x264-SPARKS' },
      video,
    );
    const other = fit({ durationS: FILM - 200, release: 'Film.2019.720p.WEB-DL-NTb' }, video);
    expect(same?.score).toBe(100);
    expect(other?.score).toBe(70);
  });

  it('weighs a streaming tag against the site when there is no file', () => {
    const nf = fit({ release: 'Show.S01E01.1080p.NF.WEB-DL' }, { duration: 0, site: 'Netflix' });
    const amzn = fit(
      { release: 'Show.S01E01.1080p.AMZN.WEB-DL' },
      { duration: 0, site: 'Netflix' },
    );
    expect(nf).toEqual({ score: 100, why: 'release', minutes: 0 });
    expect(amzn?.score).toBe(70);
  });

  it('says nothing when there is nothing to compare', () => {
    expect(fit({ durationS: 0, release: '' }, { duration: FILM })).toBeNull();
    expect(fit({ durationS: 5000 }, { duration: 0 })).toBeNull();
  });

  it('sorts best first and keeps the API order on ties and unknowns', () => {
    const rows = [
      { id: 1, s: null },
      { id: 2, s: 50 },
      { id: 3, s: 90 },
      { id: 4, s: 50 },
    ];
    const got = byFit(rows, (r) =>
      r.s === null ? null : { score: r.s, why: 'other', minutes: 0 },
    );
    expect(got.map((r) => r.id)).toEqual([3, 2, 4, 1]);
  });

  it('reads a file name only from a plain video URL', () => {
    expect(fileName('https://x.org/a/Film%20(2019).1080p.mkv?t=1')).toBe('Film (2019).1080p.mkv');
    expect(fileName('https://x.org/master.m3u8')).toBeUndefined();
    expect(fileName('blob:https://x.org/1')).toBeUndefined();
  });
});

describe('withoutHearingImpaired', () => {
  it.each([
    ['[door slams]\nWho is there?', 'Who is there?'],
    ['JOHN: Get down!', 'Get down!'],
    ['- (gasps) Run!\n- MAN 2: Where?', '- Run!\n- Where?'],
    ['- [laughs]\n- Very funny.', 'Very funny.'],
    ['<i>NARRATOR: Long ago.</i>', '<i>Long ago.</i>'],
    ['♪ ♪', ''],
    ['♪ Happy birthday to you ♪', '♪ Happy birthday to you ♪'],
    ['I said OK: fine.', 'I said OK: fine.'],
  ])('%j', (input, want) => {
    expect(withoutHearingImpaired(input)).toBe(want);
  });
});

describe('styles and settings', () => {
  it('clamps what storage hands back and falls back on junk', () => {
    expect(readStyle(undefined)).toEqual(DEFAULT_STYLE);
    expect(
      readStyle({ size: 99, bottom: -5, box: 'x', color: 'red', font: 'comic', weight: 900 }),
    ).toEqual({ ...DEFAULT_STYLE, size: 9, bottom: 2 });
  });

  it('keeps what it knows and rejects the rest, the language folder included', () => {
    expect(readSettings({ theme: 'light', ui: 'pt_BR', hi: 'remove', bar: false })).toEqual({
      theme: 'light',
      ui: 'pt_BR',
      hi: 'remove',
      bar: false,
    });
    expect(readSettings({ theme: 'neon', ui: '../x' })).toEqual(DEFAULT_SETTINGS);
  });
});

describe('interface languages', () => {
  const dir = fileURLToPath(new URL('../static', import.meta.url));
  const read = (p: string) => JSON.parse(readFileSync(join(dir, p), 'utf8'));
  const en: Record<string, string> = read('locales/en.json');
  const holes = (s: string) => (s.match(/\$\d/g) ?? []).sort().join();

  it('ships every locale it offers, and nothing else', () => {
    expect(readdirSync(join(dir, 'locales')).sort()).toEqual(
      LOCALES.map((l) => `${l}.json`).sort(),
    );
    expect(readdirSync(join(dir, '_locales')).sort()).toEqual([...LOCALES].sort());
  });

  const PLURAL = /\.(zero|one|two|few|many)$/;
  const base = (keys: string[]) => keys.filter((k) => !PLURAL.test(k)).sort();

  it.each(LOCALES)('%s has every key, with the same placeholders', (l) => {
    const m: Record<string, string> = read(`locales/${l}.json`);
    expect(base(Object.keys(m))).toEqual(base(Object.keys(en)));
    for (const [k, v] of Object.entries(m)) {
      const of = k.replace(PLURAL, '');
      expect(en[of], `${l} ${k} counts nothing in English`).toBeDefined();
      expect(holes(v), `${l} ${k}`).toBe(holes(en[of] as string));
    }
    const app = read(`_locales/${l}/messages.json`);
    expect(app.appName.message.length).toBeLessThanOrEqual(75);
    expect(app.appDescription.message.length).toBeLessThanOrEqual(132);
  });

  it('maps browser languages to the folders', () => {
    expect(pickLocale('pt-BR')).toBe('pt_BR');
    expect(pickLocale('pt-PT')).toBe('pt_PT');
    expect(pickLocale('zh-HK')).toBe('zh_TW');
    expect(pickLocale('zh')).toBe('zh_CN');
    expect(pickLocale('de-AT')).toBe('de');
    expect(pickLocale('iw')).toBe('he');
    expect(pickLocale('xx')).toBe('en');
  });
});
