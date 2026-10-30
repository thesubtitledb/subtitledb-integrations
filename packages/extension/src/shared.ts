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

export interface LoadRequest {
  vid: number;
  cues: Cue[];
  label: string;
  language: string;
  id: number;
}

export interface Style {
  /** Text height as a percentage of the video's height. */
  size: number;
  /** Distance of the last line from the bottom, as a percentage of the video's height. */
  bottom: number;
  /** Opacity of the box behind the text, 0 to 1. */
  box: number;
  color: string;
}

export const DEFAULT_STYLE: Style = { size: 4.6, bottom: 8, box: 0.55, color: '#ffffff' };

export const STYLE_LIMITS = {
  size: [2.5, 9],
  bottom: [2, 40],
  box: [0, 1],
} as const;

export function readStyle(raw: unknown): Style {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Style, unknown>>;
  const clamp = (k: keyof typeof STYLE_LIMITS) => {
    const v = Number(r[k]);
    const [lo, hi] = STYLE_LIMITS[k];
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : DEFAULT_STYLE[k];
  };
  const color =
    typeof r.color === 'string' && /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : DEFAULT_STYLE.color;
  return { size: clamp('size'), bottom: clamp('bottom'), box: clamp('box'), color };
}

/** chrome.storage.sync keys. */
export const KEY_STYLE = 'style';
export const KEY_LANG = 'lang';
