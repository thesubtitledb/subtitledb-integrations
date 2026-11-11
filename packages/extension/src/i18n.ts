/**
 * The popup's words, in the language the viewer picked in Settings or else the
 * browser's. chrome.i18n follows the browser only, so the popup reads locales/*.json
 * itself; only the manifest's name and description use _locales and __MSG_ keys.
 */
import { languageName } from '@subtitledb/core';

export const LOCALES = [
  'en',
  'ar',
  'de',
  'es',
  'fr',
  'he',
  'hi',
  'id',
  'it',
  'ja',
  'ko',
  'nl',
  'pl',
  'pt_BR',
  'pt_PT',
  'ro',
  'ru',
  'sr',
  'tr',
  'uk',
  'vi',
  'zh_CN',
  'zh_TW',
] as const;

const RTL = new Set(['ar', 'he']);

/** The _locales folder for a browser language tag: pt-BR is pt_BR, zh-HK is zh_TW. */
export function pickLocale(tag: string): string {
  const t = tag.replace('_', '-').toLowerCase();
  const [base = 'en', region = ''] = t.split('-');
  if (base === 'zh') return /^(tw|hk|mo|hant)$/.test(region) ? 'zh_TW' : 'zh_CN';
  if (base === 'pt') return region === 'pt' ? 'pt_PT' : 'pt_BR';
  if (base === 'iw') return 'he';
  if (base === 'in') return 'id';
  return (LOCALES as readonly string[]).includes(base) ? base : 'en';
}

/** The BCP 47 tag of a _locales folder, for Intl. */
export function bcp47(locale: string): string {
  return locale.replace('_', '-');
}

/** Key to text. Kept out of _locales, whose keys may not hold dots. */
type Messages = Record<string, string>;

let en: Messages = {};
let mine: Messages = {};
let current = 'en';

async function read(locale: string): Promise<Messages> {
  const r = await fetch(chrome.runtime.getURL(`locales/${locale}.json`));
  if (!r.ok) throw new Error(`no messages for ${locale}`);
  return (await r.json()) as Messages;
}

export async function loadMessages(locale: string): Promise<void> {
  en = await read('en');
  current = (LOCALES as readonly string[]).includes(locale) ? locale : 'en';
  mine = current === 'en' ? en : await read(current).catch(() => en);
}

export function locale(): string {
  return current;
}

export function isRtl(): boolean {
  return RTL.has(current);
}

/** A message with $1 to $9 filled in; the English one when this language lacks it. */
export function t(key: string, ...subs: (string | number)[]): string {
  const m = mine[key] ?? en[key] ?? key;
  return m.replace(/\$(\d)/g, (_, n: string) => String(subs[Number(n) - 1] ?? ''));
}

/**
 * A message that counts something: `key.one`, `key.few` and so on by the language's
 * plural rules for `n`, else `key`. Never another language's plural form.
 */
export function tn(key: string, n: number, ...subs: (string | number)[]): string {
  const form = new Intl.PluralRules(bcp47(current)).select(n);
  const k = `${key}.${form}`;
  return form !== 'other' && mine[k] !== undefined ? t(k, ...subs) : t(key, ...subs);
}

/** A number in the interface language. */
export function num(n: number): string {
  return n.toLocaleString(bcp47(current));
}

/**
 * Fills every element that names a message: data-i18n sets the text, data-i18n-label
 * the aria-label and title, data-i18n-title the title alone, data-i18n-ph the
 * placeholder.
 */
export function localize(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n as string);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-label]')) {
    const s = t(el.dataset.i18nLabel as string);
    el.setAttribute('aria-label', s);
    el.title = s;
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle as string);
  }
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-ph]')) {
    el.placeholder = t(el.dataset.i18nPh as string);
  }
  document.documentElement.lang = bcp47(current);
  document.documentElement.dir = isRtl() ? 'rtl' : 'ltr';
}

/** Corpus codes that are not BCP 47 tags. */
const CORPUS_TAGS: Record<string, string> = {
  ea: 'es-419',
  pb: 'pt-BR',
  zt: 'zh-Hant',
  zh: 'zh-Hans',
  pt: 'pt-PT',
};

let names: Intl.DisplayNames | null = null;
let namesFor = '';

/** A subtitle language's name in the interface language. */
export function languageLabel(code: string): string {
  try {
    if (namesFor !== current) {
      names = new Intl.DisplayNames([bcp47(current)], { type: 'language' });
      namesFor = current;
    }
    const tag = CORPUS_TAGS[code] ?? code;
    const got = names?.of(tag);
    if (got && got.toLowerCase() !== tag.toLowerCase()) {
      return got.charAt(0).toLocaleUpperCase(bcp47(current)) + got.slice(1);
    }
  } catch {
    // An unknown tag throws; the corpus's own English name is next.
  }
  return languageName(code);
}
