/**
 * What the popup and the content script pass each other, and the settings both read.
 */
import type { Cue, MediaHint } from '@subtitledb/core';

export interface VideoInfo {
  /** Stable for the life of the frame's content script. */
  vid: number;
  width: number;
  height: number;
  duration: number;
  currentTime: number;
  paused: boolean;
  /** Why SubBot cannot read this video's audio, or null when it can. */
  aiBlocked: string | null;
  /** The file name when the video is a plain file over http(s), for the match score. */
  file?: string;
}

export interface AiStart {
  vid: number;
  quality: 'fast' | 'balanced' | 'best';
  /** The language spoken in the video, or '' to detect it. */
  spoken: string;
  /** The viewer's languages: a corpus match is shown in the first one that has it. */
  languages: string[];
}

export type AiStatus =
  | { phase: 'idle' }
  | {
      phase: 'loading';
      step: 'engine' | 'model' | 'audio';
      loaded: number;
      total: number;
      quality: AiStart['quality'];
    }
  | { phase: 'listening' }
  | { phase: 'live'; covered: number; duration: number; language: string | null }
  | { phase: 'paused' }
  | { phase: 'complete'; lines: number }
  | { phase: 'identified'; subId: number; lang: string }
  | { phase: 'error'; message: string };

export interface Loaded {
  vid: number;
  label: string;
  language: string;
  /** Corpus id, or 0 for a file from disk. */
  id: number;
  count: number;
  offsetMs: number;
  hidden: boolean;
}

export interface FrameScan {
  url: string;
  top: boolean;
  videos: VideoInfo[];
  hint: MediaHint;
  strength: number;
  site?: string;
  loaded: Loaded | null;
}

/** The control bar's labels, in the popup's language: the page has no messages of its own. */
export interface BarText {
  earlier: string;
  later: string;
  smaller: string;
  bigger: string;
  hide: string;
  show: string;
  remove: string;
  label: string;
}

export interface LoadRequest {
  vid: number;
  cues: Cue[];
  label: string;
  language: string;
  id: number;
  bar: BarText;
  /** Right to left, for the bar. */
  rtl: boolean;
}

export const FONTS = ['system', 'serif', 'rounded', 'mono'] as const;
export const WEIGHTS = [400, 500, 700] as const;
export const EDGES = ['none', 'outline', 'shadow', 'raised', 'depressed'] as const;
export type Font = (typeof FONTS)[number];
export type Weight = (typeof WEIGHTS)[number];
export type Edge = (typeof EDGES)[number];

export interface Style {
  /** Text height as a percentage of the video's height. */
  size: number;
  /** Distance of the last line from the bottom, as a percentage of the video's height. */
  bottom: number;
  /** Opacity of the box behind the text, 0 to 1. */
  box: number;
  color: string;
  font: Font;
  weight: Weight;
  edge: Edge;
  /** Colour of the box behind the text. */
  boxColor: string;
}

export const DEFAULT_STYLE: Style = {
  size: 4.6,
  bottom: 8,
  box: 0.55,
  color: '#ffffff',
  font: 'system',
  weight: 500,
  edge: 'shadow',
  boxColor: '#000000',
};

/** The one-tap looks on the style page, after the Subtitles & Captioning styles. */
export const PRESETS = {
  classic: DEFAULT_STYLE,
  large: { ...DEFAULT_STYLE, size: 6.4, weight: 700 },
  outline: { ...DEFAULT_STYLE, box: 0, edge: 'outline', weight: 700 },
  clear: { ...DEFAULT_STYLE, box: 0, edge: 'shadow' },
  yellow: { ...DEFAULT_STYLE, box: 0, edge: 'outline', color: '#ffd60a', weight: 700 },
} as const satisfies Record<string, Style>;
export type Preset = keyof typeof PRESETS;

export const TEXT_COLORS = ['#ffffff', '#ffd60a', '#64d2ff', '#30d158', '#ff9f0a', '#ff6482'];
export const BOX_COLORS = ['#000000', '#1c1c1e', '#0b1f4d', '#3b0a2a'];

export const STYLE_LIMITS = {
  size: [2.5, 9],
  bottom: [2, 40],
  box: [0, 1],
} as const;

const HEX = /^#[0-9a-f]{6}$/i;

export function readStyle(raw: unknown): Style {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Style, unknown>>;
  const clamp = (k: keyof typeof STYLE_LIMITS) => {
    const v = Number(r[k]);
    const [lo, hi] = STYLE_LIMITS[k];
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_STYLE[k];
  };
  const pick = <T>(list: readonly T[], v: unknown, d: T) => (list.includes(v as T) ? (v as T) : d);
  return {
    size: clamp('size'),
    bottom: clamp('bottom'),
    box: clamp('box'),
    color: typeof r.color === 'string' && HEX.test(r.color) ? r.color : DEFAULT_STYLE.color,
    font: pick(FONTS, r.font, DEFAULT_STYLE.font),
    weight: pick(WEIGHTS, Number(r.weight), DEFAULT_STYLE.weight),
    edge: pick(EDGES, r.edge, DEFAULT_STYLE.edge),
    boxColor:
      typeof r.boxColor === 'string' && HEX.test(r.boxColor) ? r.boxColor : DEFAULT_STYLE.boxColor,
  };
}

/** The preset a style is, or null when it has been changed from all of them. */
export function presetOf(s: Style): Preset | null {
  for (const [k, p] of Object.entries(PRESETS)) {
    if ((Object.keys(p) as (keyof Style)[]).every((f) => p[f] === s[f])) return k as Preset;
  }
  return null;
}

export const THEMES = ['dark', 'light', 'auto'] as const;
export type Theme = (typeof THEMES)[number];

export interface Settings {
  theme: Theme;
  /** Interface language, a folder name under _locales, or '' for the browser's. */
  ui: string;
  /** Hearing-impaired text: kept, or taken out of every line. */
  hi: 'show' | 'remove';
  /** The control bar over the video. */
  bar: boolean;
}

export const DEFAULT_SETTINGS: Settings = { theme: 'dark', ui: '', hi: 'show', bar: true };

export function readSettings(raw: unknown): Settings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  return {
    theme: THEMES.includes(r.theme as Theme) ? (r.theme as Theme) : DEFAULT_SETTINGS.theme,
    ui: typeof r.ui === 'string' && /^[a-z]{2}(_[A-Z]{2})?$/.test(r.ui) ? r.ui : '',
    hi: r.hi === 'remove' ? 'remove' : 'show',
    bar: r.bar !== false,
  };
}

/** chrome.storage.sync keys. */
export const KEY_STYLE = 'style';
export const KEY_LANG = 'lang';
export const KEY_SETTINGS = 'settings';
