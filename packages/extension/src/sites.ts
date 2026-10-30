/**
 * The streaming sites whose pages say what is playing somewhere we can read. Every
 * other page with a video works the same way; these only get a better first guess at
 * the title. Selectors are tried in order and the first with text wins, so a site
 * that renames a class falls back to its page title rather than to nothing.
 *
 * Pure apart from `readSite`, which takes the document it reads.
 */

export interface Site {
  id: string;
  name: string;
  hosts: RegExp;
  /** The show or film name. */
  title?: string[];
  /** Season, episode and episode name, in any of the forms parseEpisode reads. */
  episode?: string[];
  /** Removed from document.title / og:title before it is used. */
  suffix?: RegExp;
}

export const SITES: Site[] = [
  {
    id: 'youtube',
    name: 'YouTube',
    hosts: /(^|\.)(youtube\.com|youtube-nocookie\.com|youtu\.be)$/,
    title: ['h1.ytd-watch-metadata yt-formatted-string', '#title h1', '.ytp-title-link'],
    suffix: /\s+-\s+YouTube$/i,
  },
  {
    id: 'netflix',
    name: 'Netflix',
    hosts: /(^|\.)netflix\.com$/,
    title: ['[data-uia="video-title"] h4', '.video-title h4', '.ellipsize-text h4'],
    episode: ['[data-uia="video-title"]', '.video-title', '.ellipsize-text'],
    suffix: /\s*[|-]\s*Netflix.*$/i,
  },
  {
    id: 'primevideo',
    name: 'Prime Video',
    hosts: /(^|\.)(primevideo\.com|amazon\.[a-z.]+)$/,
    title: ['.atvwebplayersdk-title-text', '[data-automation-id="title"]'],
    episode: ['.atvwebplayersdk-subtitle-text'],
    suffix: /^(Prime Video:\s*|Amazon\.[a-z.]+:\s*(Watch\s+)?)|\s*[|-]\s*Prime Video$/i,
  },
  {
    id: 'disneyplus',
    name: 'Disney+',
    hosts: /(^|\.)(disneyplus\.com|disney\.[a-z.]+)$/,
    title: ['.title-field', '[data-testid="title-field"]'],
    episode: ['.subtitle-field', '[data-testid="subtitle-field"]'],
    suffix: /\s*[|-]\s*Disney\+$/i,
  },
  {
    id: 'max',
    name: 'Max',
    hosts: /(^|\.)(max\.com|hbomax\.com)$/,
    title: ['[data-testid="player-ux-asset-title"]', '[data-testid="title-main"]'],
    episode: ['[data-testid="player-ux-season-episode"]', '[data-testid="title-sub"]'],
    suffix: /\s*[|-]\s*(HBO\s*)?Max$/i,
  },
  {
    id: 'mubi',
    name: 'MUBI',
    hosts: /(^|\.)mubi\.com$/,
    title: ['[data-testid="film-title"]', 'h1'],
    suffix: /^Watch\s+|\s*[|-]\s*MUBI$/i,
  },
  {
    id: 'vimeo',
    name: 'Vimeo',
    hosts: /(^|\.)vimeo\.com$/,
    title: ['.vp-title-header a', 'h1'],
    suffix: /\s+(on|from)\s+Vimeo$/i,
  },
  {
    id: 'dailymotion',
    name: 'Dailymotion',
    hosts: /(^|\.)(dailymotion\.com|dai\.ly)$/,
    title: ['[class*="VideoInfoTitle"]', '.dmp_VideoInfo-title-text', 'h1'],
    suffix: /\s+-\s+(video\s+)?Dailymotion$/i,
  },
  {
    id: 'metastream',
    name: 'Metastream',
    hosts: /(^|\.)getmetastream\.com$/,
    title: ['[class^="QueueInfoContent__title"]', '[class*="MediaInfo__title"]'],
  },
  {
    id: 'fandango',
    name: 'Fandango at Home',
    hosts: /(^|\.)(vudu\.com|athome\.fandango\.com|fandangonow\.com)$/,
    title: ['[class*="playerTitle"]', 'h1'],
    suffix: /^Watch\s+|\s*[|-]\s*(Fandango at Home|Vudu).*$/i,
  },
];

export function siteFor(host: string): Site | undefined {
  const h = host.toLowerCase().replace(/\.$/, '');
  return SITES.find((s) => s.hosts.test(h));
}

export interface Episode {
  season?: number;
  episode?: number;
  episodeTitle?: string;
}

// S1:E3, S01E03, S1 E3, S1.E3, S1 - E3, "Season 1 Episode 3", "Season 1, Ep. 3", 1x03.
const EPISODE: RegExp[] = [
  /\bS(?:eason)?\s*(\d{1,3})\s*[:.,\s-]*\s*E(?:p(?:isode)?\.?)?\s*(\d{1,4})\b/i,
  /\bSeason\s+(\d{1,3})\s*[,:-]?\s*(?:Episode|Ep\.?)\s*(\d{1,4})\b/i,
  /\b(\d{1,2})x(\d{2,3})\b/,
];

/** Season and episode from text a player shows, plus the episode name after them. */
export function parseEpisode(text: string): Episode {
  const t = text.replace(/\s+/g, ' ').trim();
  for (const re of EPISODE) {
    const m = re.exec(t);
    if (!m) continue;
    const out: Episode = { season: Number(m[1]), episode: Number(m[2]) };
    const rest = t
      .slice((m.index ?? 0) + m[0].length)
      .replace(/^[\s:.,"'“—–-]+|["'”]+$/g, '')
      .trim();
    if (rest) out.episodeTitle = rest;
    return out;
  }
  return {};
}

export interface Guess extends Episode {
  title?: string;
  year?: number;
}

/**
 * A page or player title read as a film or episode: the site's suffix off, a year in
 * brackets or at the end taken as the year, and an episode marker split off with
 * everything after it as the episode name.
 */
export function cleanTitle(raw: string, site?: Site): Guess {
  let t = raw.replace(/\s+/g, ' ').trim();
  if (site?.suffix) t = t.replace(site.suffix, '').trim();
  // Generic noise many sites add.
  t = t
    .replace(/^\(\d+\)\s*/, '')
    .replace(/^(watch|stream)\s+/i, '')
    .replace(/\s+(online|full movie|free)(\s+(free|online|hd))*$/i, '')
    .replace(/\s*[|•·]\s*[^|•·]*$/, (m) => (/\d/.test(m) ? m : ''))
    .trim();
  const out: Guess = {};
  const ep = parseEpisode(t);
  for (const re of EPISODE) {
    const m = re.exec(t);
    if (m) {
      Object.assign(out, ep);
      t = t.slice(0, m.index).replace(/[\s:,—–-]+$/, '');
      break;
    }
  }
  const y = /\s*[([]\s*((?:19|20)\d{2})\s*[)\]]\s*$|\s+((?:19|20)\d{2})$/.exec(t);
  // A bare number at the end is a year only if it could be one: Blade Runner 2049 is not.
  if (y && y.index > 0 && Number(y[1] ?? y[2]) <= new Date().getFullYear() + 1) {
    out.year = Number(y[1] ?? y[2]);
    t = t.slice(0, y.index);
  }
  t = t.replace(/[\s:,—–-]+$/, '').trim();
  if (t) out.title = t;
  return out;
}

// Words a video's own title adds after the film's: "Sintel movie 4K", "Dune Official Trailer".
const NOISE =
  /\s+(?:(?:full|open|official|short|feature|animated|hd)\s+)?(?:movie|film|trailer|teaser|clip|4k|uhd|hd|2160p|1080p|720p)\b.*$/i;

/**
 * Shorter forms of a title that matched nothing, best first: the part before a spaced
 * separator ("Sintel - Open Movie by Blender Foundation", "Sintel : Blender Foundation
 * : Internet Archive"), then without trailing noise words. A colon with no space
 * before it stays, so "Mission: Impossible" is not cut.
 */
export function shorterTitles(title: string): string[] {
  const t = title.replace(/\s+/g, ' ').trim();
  const out: string[] = [];
  const add = (s: string) => {
    const v = s.replace(/[\s:,—–-]+$/, '').trim();
    if (v.length > 1 && v !== t && !out.includes(v)) out.push(v);
  };
  const head = t.split(/\s+[-–—|•·:]\s+/)[0] ?? t;
  add(head);
  add(head.replace(NOISE, ''));
  add(t.replace(NOISE, ''));
  return out;
}

/**
 * An element's text with its pieces kept apart: players put the show, "S1:E3" and the
 * episode name in sibling spans, and textContent runs them together.
 */
export function textOf(el: Node): string {
  const parts: string[] = [];
  const walk = (n: Node) => {
    if (n.nodeType === 3) parts.push(n.nodeValue ?? '');
    else for (const c of Array.from(n.childNodes)) walk(c);
  };
  walk(el);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** What the site's own player shows, read off the document. */
export function readSite(doc: Document, site: Site): Guess {
  const text = (sels: string[] | undefined) => {
    for (const sel of sels ?? []) {
      try {
        const el = doc.querySelector(sel);
        const s = el ? textOf(el) : '';
        if (s) return s;
      } catch {
        // A selector this browser cannot parse is a selector that matches nothing.
      }
    }
    return '';
  };
  const title = text(site.title);
  const out: Guess = title ? cleanTitle(title, site) : {};
  const ep = parseEpisode(text(site.episode));
  if (ep.season !== undefined) Object.assign(out, ep);
  return out;
}
