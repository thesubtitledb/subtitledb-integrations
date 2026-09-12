/**
 * ISO639 code to English display name.
 *
 * The corpus uses 185 distinct codes, most of them ordinary ISO639-1. Four are
 * OpenSubtitles conventions rather than standards and have no ISO name at all, which
 * is why a plain lookup table leaves them rendering as bare uppercase codes in any
 * UI built on this data. They are spelled out here so a language menu never shows
 * "PB" to a user who wanted Brazilian Portuguese.
 */
const NAMES: Record<string, string> = {
  // OpenSubtitles-specific codes, not ISO639.
  pb: 'Portuguese (Brazil)',
  ze: 'Chinese (bilingual)',
  zt: 'Chinese (traditional)',
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
 * The corpus stores single codes with no region (`types.ts` LanguageCode), so an
 * `autoSelect` of `en-US` can only ever match on the base. This is also how a
 * viewer's `navigator.languages`, which are BCP-47 tags, are compared to it.
 */
export function baseLanguage(code: string): string {
  return code.trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/** Shape of the parts of `navigator` this reads. Injectable so tests need no DOM. */
export interface LocaleSource {
  languages?: readonly string[];
  language?: string;
}

/**
 * The viewer's preferred languages as base codes, best first, deduplicated.
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
    const base = baseLanguage(tag);
    if (base && !out.includes(base)) out.push(base);
  }
  return out;
}
