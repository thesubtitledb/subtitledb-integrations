import { describe, expect, it } from 'vitest';
import { hasLanguageName, languageName, localeLanguages } from '../src/languages.js';

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
});

describe('the package entry', () => {
  it('exports localeLanguages and its LocaleSource type', async () => {
    // The entry itself, not languages.ts: a helper the entry does not export cannot be
    // imported from @subtitledb/core at all. npm-publish.sh check does the same
    // against the built dist.
    const entry = await import('../src/index.js');
    const nav: import('../src/index.js').LocaleSource = { languages: ['pt-BR'] };
    expect(entry.localeLanguages(nav)).toEqual(['pb', 'pt']);
  });
});
