/**
 * Scene / release filename parser.
 *
 * This is the only rung of the match ladder that works with no metadata at all, so
 * it carries most of the accuracy for players that know nothing but a src URL. It is
 * a pure function over a string with no I/O, which is what makes it cheap to test
 * exhaustively.
 *
 * It deliberately does not try to be a general-purpose release parser. It extracts
 * the four things the API can actually be queried with (title, year, season,
 * episode) and stops.
 */

export interface ParsedFilename {
  /** Best-effort human title. Empty string when nothing survived the tag stripping. */
  title: string;
  year: number | null;
  season: number | null;
  episode: number | null;
  /** Release group, when the name ends in the conventional -GROUP form. */
  group: string | null;
  /** Recognised quality/source tags, lowercased, in the order they appeared. */
  tags: string[];
  container: string | null;
  /**
   * The name as it arrived, minus the container. This is what a subtitle's
   * release_name is compared against, so it keeps the tags and the group: they are
   * most of what tells one encode of a film from another.
   */
  release: string;
}

const CONTAINERS = new Set([
  'mkv',
  'mp4',
  'avi',
  'm4v',
  'mov',
  'wmv',
  'flv',
  'webm',
  'mpg',
  'mpeg',
  'ts',
  'm2ts',
  'ogv',
]);

/**
 * Tokens that mark the end of a title and the start of release metadata. Order does
 * not matter; membership does. Kept as a Set so the title cut is a single scan.
 */
const TAGS = new Set([
  '2160p',
  '1080p',
  '1080i',
  '720p',
  '576p',
  '480p',
  '4k',
  'uhd',
  'bluray',
  'blu-ray',
  'brrip',
  'bdrip',
  'bdremux',
  'remux',
  'webrip',
  'web-dl',
  'webdl',
  'web',
  'hdtv',
  'pdtv',
  'dvdrip',
  'dvdscr',
  'dvd',
  'hdrip',
  'cam',
  'camrip',
  'telesync',
  'telecine',
  'workprint',
  'r5',
  'vodrip',
  'hdcam',
  'x264',
  'x265',
  'h264',
  'h265',
  'h',
  'hevc',
  'avc',
  'xvid',
  'divx',
  'vp9',
  'av1',
  '10bit',
  '8bit',
  'hdr',
  'hdr10',
  'hdr10plus',
  'dovi',
  'dv',
  'sdr',
  'hlg',
  'aac',
  'aac2',
  'ac3',
  'eac3',
  'dts',
  'dtshd',
  'truehd',
  'atmos',
  'flac',
  'mp3',
  'opus',
  'ddp5',
  'ddp',
  'dd5',
  'dd',
  '5',
  '7',
  'commentary',
  'proper',
  'repack',
  'internal',
  'limited',
  'extended',
  'uncut',
  'unrated',
  'remastered',
  'directors',
  'imax',
  'theatrical',
  'criterion',
  'anniversary',
  'multi',
  'dual',
  'subbed',
  'dubbed',
  'subs',
  'sub',
  'hardsub',
  'raw',
  'complete',
  'amzn',
  'nf',
  'netflix',
  'dsnp',
  'hmax',
  'max',
  'atvp',
  'hulu',
  'pcok',
  'stan',
  'crav',
  'ma',
]);

/** S01E02, s01.e02, 1x02, S01E02E03 (first episode wins), Season 1 Episode 2. */
const EPISODE_PATTERNS: RegExp[] = [
  /\bs(\d{1,2})[\s._-]*e(\d{1,3})\b/i,
  /\b(\d{1,2})x(\d{1,3})\b/i,
  /\bseason[\s._-]*(\d{1,2})[\s._-]*episode[\s._-]*(\d{1,3})\b/i,
];

const YEAR = /\b(19\d{2}|20\d{2})\b/g;

function stripContainer(name: string): { base: string; container: string | null } {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return { base: name, container: null };
  const ext = name.slice(dot + 1).toLowerCase();
  if (!CONTAINERS.has(ext)) return { base: name, container: null };
  return { base: name.slice(0, dot), container: ext };
}

/**
 * Take the last path segment and drop any query or fragment. Handles both URL and
 * filesystem inputs, since a browser adapter usually has a src URL and a desktop
 * adapter usually has a path.
 */
export function basename(input: string): string {
  let s = input.trim();
  const q = s.search(/[?#]/);
  if (q !== -1) s = s.slice(0, q);
  const parts = s.split(/[/\\]/);
  const last = parts[parts.length - 1] ?? '';
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** Trailing "-GROUP" on a release name, where GROUP has no spaces. */
function extractGroup(base: string): { rest: string; group: string | null } {
  const m = /-([A-Za-z0-9_.]{2,20})$/.exec(base);
  if (!m || m[1] === undefined) return { rest: base, group: null };
  const candidate = m[1];

  // A trailing "-2160p" style token is a tag, not a group.
  if (TAGS.has(candidate.toLowerCase())) return { rest: base, group: null };

  // Hyphenated tags are the trap here: WEB-DL and Blu-Ray both end in a hyphen
  // followed by a short token, so a naive match reports groups called "DL" and
  // "Ray". Rejoin with the preceding token and check that too.
  const head = base.slice(0, m.index);
  const prev = tokenise(head).pop();
  if (prev && TAGS.has(`${prev}-${candidate}`.toLowerCase())) {
    return { rest: base, group: null };
  }

  return { rest: head, group: candidate };
}

function tokenise(base: string): string[] {
  return base
    .replace(/[[\]()_{}]/g, ' ')
    .replace(/[.\-+]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function titleCase(words: string[]): string {
  return words.join(' ').replace(/\s+/g, ' ').trim();
}

export function parseFilename(input: string): ParsedFilename {
  const name = basename(input);
  const { base, container } = stripContainer(name);
  const { rest, group } = extractGroup(base);

  let season: number | null = null;
  let episode: number | null = null;
  let episodeCut = -1;

  for (const re of EPISODE_PATTERNS) {
    const m = re.exec(rest);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      season = Number(m[1]);
      episode = Number(m[2]);
      episodeCut = m.index;
      break;
    }
  }

  // Year: prefer the last one before any episode marker, so "2012 S01E01" reads as a
  // series called 2012 rather than a year. A four digit token that is also a
  // resolution (2160) never matches, since YEAR requires 19xx or 20xx and 2160 is
  // excluded by the second digit check below.
  let year: number | null = null;
  let yearCut = -1;
  const searchSpace = episodeCut === -1 ? rest : rest.slice(0, episodeCut);
  YEAR.lastIndex = 0;
  for (const m of searchSpace.matchAll(YEAR)) {
    const v = Number(m[0]);
    if (v < 1900 || v > new Date().getFullYear() + 2) continue;
    // Nothing in front of it means it is the name, not the date: "2012.S01E01" is a
    // series called 2012, and reading it as a year leaves no title to search with.
    if (tokenise(searchSpace.slice(0, m.index)).length === 0) continue;
    year = v;
    yearCut = m.index;
  }

  // The title ends at whichever comes first: the episode marker, the year, or the
  // first recognised release tag.
  const cuts = [episodeCut, yearCut].filter((c) => c >= 0);
  let cut = cuts.length ? Math.min(...cuts) : rest.length;

  const head = rest.slice(0, cut);
  const headTokens = tokenise(head);
  const tagIdx = headTokens.findIndex((t) => TAGS.has(t.toLowerCase()));
  const titleTokens = tagIdx === -1 ? headTokens : headTokens.slice(0, tagIdx);

  const allTokens = tokenise(rest);
  const tags = allTokens.map((t) => t.toLowerCase()).filter((t) => TAGS.has(t));

  if (cut === rest.length && titleTokens.length === 0) cut = 0;

  return {
    title: titleCase(titleTokens),
    year,
    season,
    episode,
    group,
    tags: [...new Set(tags)],
    container,
    release: base,
  };
}
