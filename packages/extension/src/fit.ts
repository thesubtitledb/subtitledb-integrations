/**
 * How well a subtitle file fits the video on the page, 0 to 100, from what the popup
 * can see without downloading it: the file's length against the video's, and its
 * release name against the video's file name or the site's own release tag. Pure.
 */

export interface FitVideo {
  /** Seconds; 0 when the player has not said. */
  duration: number;
  /** The video's file name, when it is a plain file. */
  file?: string;
  /** The site the popup recognised, as sites.ts names it. */
  site?: string;
}

export interface FitSub {
  /** Seconds to the end of the last line. */
  durationS?: number | null;
  release?: string | null;
}

export type FitWhy = 'same' | 'longer' | 'shorter' | 'release' | 'other';

export interface Fit {
  score: number;
  why: FitWhy;
  /** Whole minutes the file runs past or short of the video, for 'longer' and 'shorter'. */
  minutes: number;
}

/** The tag a scene release carries for each streaming service. */
const SITE_TAGS: Record<string, string[]> = {
  Netflix: ['nf'],
  'Prime Video': ['amzn'],
  'Disney+': ['dsnp'],
  Max: ['hmax', 'max'],
  'Fandango at Home': ['vudu'],
};

const RES = ['2160p', '1080p', '720p', '576p', '480p'];
const SOURCES: Record<string, string> = {
  bluray: 'bluray',
  bdrip: 'bluray',
  brrip: 'bluray',
  bdremux: 'bluray',
  remux: 'bluray',
  web: 'web',
  webrip: 'web',
  webdl: 'web',
  hdtv: 'hdtv',
  dvdrip: 'dvd',
  dvd: 'dvd',
};

/** The words of a release name, lower case, with web-dl and web.dl as one word. */
export function releaseWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(/\.(mkv|mp4|m4v|avi|webm|mov|srt|vtt|ass|ssa)$/, '')
    .replace(/web[ ._-]?dl/g, 'webdl')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

interface Traits {
  res?: string;
  source?: string;
  group?: string;
  tags: string[];
}

function traits(name: string): Traits {
  const w = releaseWords(name);
  const res = w.find((x) => RES.includes(x));
  const source = w.map((x) => SOURCES[x]).find(Boolean);
  // The group closes a scene name: "...x264-GROUP".
  const group = /-([a-z0-9]+)$/i.exec(name.replace(/\.[a-z0-9]{2,4}$/i, ''))?.[1]?.toLowerCase();
  const tags = Object.values(SITE_TAGS)
    .flat()
    .filter((t) => w.includes(t));
  return { res, source, group, tags };
}

/**
 * The release half: 100 when the file name and the release share resolution, source
 * and group, lower for each that differs, null when there is nothing to compare.
 */
function releaseScore(release: string, video: FitVideo): number | null {
  const r = traits(release);
  if (video.file) {
    const f = traits(video.file);
    let points = 0;
    let out = 0;
    const weigh = (a: string | undefined, b: string | undefined, w: number) => {
      if (!a || !b) return;
      out += w;
      if (a === b) points += w;
    };
    weigh(f.res, r.res, 1);
    weigh(f.source, r.source, 2);
    weigh(f.group, r.group, 3);
    if (out) return Math.round((points / out) * 100);
  }
  const want = video.site ? SITE_TAGS[video.site] : undefined;
  if (want && r.source)
    return r.tags.some((t) => want.includes(t)) ? 100 : r.source === 'web' ? 70 : 40;
  return null;
}

/**
 * The length half. A file ends before the video by the credits, so anything from
 * a few seconds past the end down to the credits allowance is a perfect fit; past
 * the end costs fast (a different cut or frame rate), short of it costs slowly.
 */
function lengthScore(subS: number, videoS: number): { score: number; d: number } {
  const credits = Math.min(600, Math.max(120, videoS * 0.12));
  const d = subS - videoS;
  const over = Math.max(0, d - 5);
  const under = Math.max(0, -d - credits);
  return { score: Math.max(0, Math.round(100 - over * 1.2 - under * 0.12)), d };
}

export function fit(sub: FitSub, video: FitVideo): Fit | null {
  const len =
    sub.durationS && sub.durationS > 0 && video.duration > 60
      ? lengthScore(sub.durationS, video.duration)
      : null;
  const rel = sub.release ? releaseScore(sub.release, video) : null;
  if (!len && rel === null) return null;
  const score =
    len && rel !== null ? Math.round(len.score * 0.7 + rel * 0.3) : (len?.score ?? (rel as number));
  if (!len) return { score, why: score >= 80 ? 'release' : 'other', minutes: 0 };
  const minutes = Math.round(Math.abs(len.d) / 60);
  const why: FitWhy = len.score >= 95 ? 'same' : len.d > 0 ? 'longer' : 'shorter';
  return { score, why, minutes };
}

/** Results with a fit, best first; ties keep the API's order. */
export function byFit<T>(rows: readonly T[], fitOf: (r: T) => Fit | null): T[] {
  return rows
    .map((r, i) => ({ r, i, s: fitOf(r)?.score ?? -1 }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.r);
}

/** The file name of a video served as a plain file, for the match score. */
export function fileName(src: string): string | undefined {
  if (!/^https?:/i.test(src)) return undefined;
  try {
    const last = decodeURIComponent(new URL(src).pathname.split('/').pop() ?? '');
    return /\.(mkv|mp4|m4v|webm|avi|mov)$/i.test(last) ? last : undefined;
  } catch {
    return undefined;
  }
}
