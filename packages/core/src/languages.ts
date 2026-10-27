/**
 * ISO639 code to English display name.
 *
 * Most codes are ordinary ISO639-1. Six are OpenSubtitles conventions with no ISO
 * name, spelled out here so a language menu never shows "PB" to a user who wanted
 * Brazilian Portuguese.
 */
const NAMES: Record<string, string> = {
  // OpenSubtitles-specific codes, not ISO639.
  pb: 'Portuguese (Brazil)',
  ze: 'Chinese and English',
  zt: 'Chinese (Traditional)',
  ea: 'Spanish (Latin America)',
  sp: 'Spanish (Spain)',
  pm: 'Portuguese (Mozambique)',

  ar: 'Arabic',
  bg: 'Bulgarian',
  bn: 'Bengali',
  bs: 'Bosnian',
  ca: 'Catalan',
  cs: 'Czech',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  en: 'English',
  eo: 'Esperanto',
  es: 'Spanish',
  et: 'Estonian',
  eu: 'Basque',
  fa: 'Persian',
  fi: 'Finnish',
  fr: 'French',
  gl: 'Galician',
  he: 'Hebrew',
  hi: 'Hindi',
  hr: 'Croatian',
  hu: 'Hungarian',
  hy: 'Armenian',
  id: 'Indonesian',
  is: 'Icelandic',
  it: 'Italian',
  ja: 'Japanese',
  ka: 'Georgian',
  kk: 'Kazakh',
  km: 'Khmer',
  ko: 'Korean',
  ku: 'Kurdish',
  lt: 'Lithuanian',
  lv: 'Latvian',
  mk: 'Macedonian',
  ml: 'Malayalam',
  mn: 'Mongolian',
  ms: 'Malay',
  my: 'Burmese',
  nl: 'Dutch',
  no: 'Norwegian',
  oc: 'Occitan',
  pl: 'Polish',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  si: 'Sinhala',
  sk: 'Slovak',
  sl: 'Slovenian',
  sq: 'Albanian',
  sr: 'Serbian',
  sv: 'Swedish',
  sw: 'Swahili',
  ta: 'Tamil',
  te: 'Telugu',
  th: 'Thai',
  tl: 'Tagalog',
  tr: 'Turkish',
  tt: 'Tatar',
  uk: 'Ukrainian',
  ur: 'Urdu',
  uz: 'Uzbek',
  vi: 'Vietnamese',
  zh: 'Chinese',
};

/** Display name for a code, falling back to the uppercased code when unknown. */
export function languageName(code: string): string {
  const key = code.trim().toLowerCase();
  return NAMES[key] ?? key.toUpperCase();
}

/** True when we have a real name rather than a fallback. Useful in tests. */
export function hasLanguageName(code: string): boolean {
  return Object.hasOwn(NAMES, code.trim().toLowerCase());
}

/**
 * Base language subtag, lowercased: `en-US` -> `en`, `pt_BR` -> `pt`, `EN` -> `en`.
 *
 * Subtitle languages are single codes with no region (see LanguageCode), so an
 * `autoSelect` of `en-US` can only ever match on the base. This is also how a
 * viewer's `navigator.languages`, which are BCP-47 tags, are compared to it.
 */
export function baseLanguage(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/**
 * A caller's language tag as the code the corpus files it under: `en-US` -> `en`,
 * `pt-BR` -> `pb`, `zh-Hant` or `zh-TW` -> `zt`, `es-419` or `es-MX` -> `ea`. The API
 * also accepts BCP 47 tags and maps them the same way; mapping here first means each
 * language is one request and one cache entry, whatever tag the caller spelled it with.
 */
export function corpusLanguage(code: string): string {
  const tag = code.trim().toLowerCase().replace(/_/g, '-');
  if (tag === 'pt-br') return 'pb';
  if (/^zh-(hant|tw|hk|mo)/.test(tag)) return 'zt';
  // A script subtag is skipped, as the API does: es-Latn-MX is es-MX.
  const [base, ...rest] = tag.split('-');
  const region = rest[0]?.length === 4 ? rest[1] : rest[0];
  if (base === 'es' && region && LATIN_AMERICAN_SPANISH.has(region)) return 'ea';
  return baseLanguage(tag);
}

/** Codes the identify route files under one spoken language: SubBot hears Portuguese. */
const FAMILY: Record<string, string> = {
  pb: 'pt',
  pm: 'pt',
  ea: 'es',
  sp: 'es',
  zt: 'zh',
  ze: 'zh',
  zc: 'zh',
};

/** The spoken language a tag or corpus code belongs to: `pt-BR` and `pb` are `pt`. */
export function languageFamily(code: string): string {
  const c = corpusLanguage(code);
  return FAMILY[c] ?? c;
}

/**
 * Spanish regions the API files under `ea`, checked live with `?lang=` 2026-10-18. Every
 * other region, es-ES included, is `es`. 419 is Latin America; the UN subregions
 * (005, 013, 029) are not on the list.
 */
const LATIN_AMERICAN_SPANISH = new Set([
  '419',
  'ar',
  'bo',
  'cl',
  'co',
  'cr',
  'cu',
  'do',
  'ec',
  'gt',
  'hn',
  'mx',
  'ni',
  'pa',
  'pe',
  'pr',
  'py',
  'sv',
  'us',
  'uy',
  've',
]);

/** Shape of the parts of `navigator` this reads. Injectable so tests need no DOM. */
export interface LocaleSource {
  languages?: readonly string[];
  language?: string;
}

/**
 * The viewer's preferred languages as corpus codes, best first, deduplicated. Each
 * locale gives its corpus code and then its base code as a second choice: `pt-BR`
 * gives `pb` then `pt`, `es-MX` gives `ea` then `es`, `en-US` gives `en`.
 *
 * Reads `navigator.languages` in a browser and is empty off it (SSR, Node tests) so
 * callers fall back cleanly. `autoSelect: 'locale'` uses it both to fetch the right
 * languages and to pick among the candidates.
 */
export function localeLanguages(
  nav: LocaleSource | undefined = (globalThis as { navigator?: LocaleSource }).navigator,
): string[] {
  const raw = nav?.languages?.length ? nav.languages : nav?.language ? [nav.language] : [];
  const out: string[] = [];
  for (const tag of raw) {
    for (const code of [corpusLanguage(tag), baseLanguage(tag)]) {
      if (code && !out.includes(code)) out.push(code);
    }
  }
  return out;
}
