import { describe, expect, it, vi } from 'vitest';
import {
  corpusLanguage,
  hasLanguageName,
  languageName,
  localeLanguages,
} from '../src/languages.js';

describe('languageName', () => {
  it('names the six corpus codes that are not ISO', () => {
    expect(languageName('pb')).toBe('Portuguese (Brazil)');
    expect(languageName('zt')).toBe('Chinese (Traditional)');
    expect(languageName('ze')).toBe('Chinese and English');
    expect(languageName('ea')).toBe('Spanish (Latin America)');
    expect(languageName('sp')).toBe('Spanish (Spain)');
    expect(languageName('pm')).toBe('Portuguese (Mozambique)');
    for (const code of ['pb', 'zt', 'ze', 'ea', 'sp', 'pm'])
      expect(hasLanguageName(code)).toBe(true);
  });
});

describe('localeLanguages', () => {
  it('gives the corpus code first and the base code second', () => {
    expect(localeLanguages({ languages: ['pt-BR'] })).toEqual(['pb', 'pt']);
    expect(localeLanguages({ languages: ['zh-TW'] })).toEqual(['zt', 'zh']);
    expect(localeLanguages({ languages: ['es-MX'] })).toEqual(['ea', 'es']);
    expect(localeLanguages({ languages: ['es-ES'] })).toEqual(['es']);
  });

  it('keeps the viewer order and drops repeats', () => {
    expect(localeLanguages({ languages: ['en-US', 'en', 'pt-BR', 'pt-PT', 'fr'] })).toEqual([
      'en',
      'pb',
      'pt',
      'fr',
    ]);
  });

  it('reads navigator.language when there is no list, and nothing when there is neither', () => {
    expect(localeLanguages({ language: 'es-419' })).toEqual(['ea', 'es']);
    expect(localeLanguages({})).toEqual([]);
  });

  it('prefers the list over the single language, and falls back on an empty list', () => {
    expect(localeLanguages({ languages: ['de-DE'], language: 'fr-FR' })).toEqual(['de']);
    expect(localeLanguages({ languages: [], language: 'fr-FR' })).toEqual(['fr']);
  });

  it('skips an empty tag rather than asking for language ""', () => {
    expect(localeLanguages({ languages: ['', ' ', 'en-GB'] })).toEqual(['en']);
  });

  it('reads the global navigator by default, and is empty without one', () => {
    vi.stubGlobal('navigator', { languages: ['zh-HK', 'en'] });
    try {
      expect(localeLanguages()).toEqual(['zt', 'zh', 'en']);
      // SSR and workers with no navigator: callers fall back to their own default.
      vi.stubGlobal('navigator', undefined);
      expect(localeLanguages()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('corpusLanguage', () => {
  it('files every spelling of a language under one corpus code', () => {
    // One request and one cache entry per language, however the caller spells it.
    const cases: [string, string][] = [
      ['en', 'en'],
      ['EN', 'en'],
      [' en-US ', 'en'],
      ['en_GB', 'en'],
      ['pt-BR', 'pb'],
      ['pt_BR', 'pb'],
      ['PT-br', 'pb'],
      ['pt-PT', 'pt'],
      ['pt', 'pt'],
      ['zh-TW', 'zt'],
      ['zh_TW', 'zt'],
      ['zh-HK', 'zt'],
      ['zh-MO', 'zt'],
      ['zh-Hant', 'zt'],
      ['zh-Hant-TW', 'zt'],
      ['zh-CN', 'zh'],
      ['zh-Hans', 'zh'],
      ['es-Latn-MX', 'ea'],
      ['es-Latn-ES', 'es'],
      ['sr-Latn', 'sr'],
      ['', ''],
    ];
    for (const [tag, code] of cases) expect(corpusLanguage(tag), tag).toBe(code);
  });
});

describe('languageName fallbacks', () => {
  it('reads a code in any case and with stray spaces', () => {
    expect(languageName(' EN ')).toBe('English');
    expect(languageName('PB')).toBe('Portuguese (Brazil)');
    expect(hasLanguageName(' Fr ')).toBe(true);
  });

  it('shows an unknown code uppercased and says it has no name for it', () => {
    // Unknown passes through rather than resolving to some other language.
    expect(languageName('qq')).toBe('QQ');
    expect(hasLanguageName('qq')).toBe(false);
  });
});
