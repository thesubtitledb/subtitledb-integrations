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
  /** Null for an anime-style absolute episode number, which has no season. */
  season: number | null;
  /** The first episode of a multi-episode file such as S02E01E02. */
  episode: number | null;
  /** Every episode of a multi-episode file, in order. Only present when there is more than one. */
  episodes?: number[];
  /** Release group: a trailing -GROUP or [GROUP], or the leading [Group] of an anime name. */
  group: string | null;
  /**
   * Recognised quality/source tags, lowercased, in the order they appeared. Dotted
   * audio and codec tags are collapsed: DDP5.1 is `ddp51`, H.265 is `h265`.
   */
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
  'ddp',
  'dd',
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

/**
 * S01E02, s01.e02, 1x02, Season 1 Episode 2. A multi-episode file (S01E02E03,
 * S01E02-E03) keeps every number in group 3.
 */
const EPISODE_PATTERNS: RegExp[] = [
  /\bs(\d{1,2})[\s._-]*e(\d{1,3})((?:[\s._-]*e\d{1,3})*)\b/i,
  /\b(\d{1,2})x(\d{1,3})\b/i,
  /\bseason[\s._-]*(\d{1,2})[\s._-]*episode[\s._-]*(\d{1,3})\b/i,
];

/**
 * The anime convention: `[Group] Title - 1100 [1080p]`, an absolute episode number
 * with no season, after " - " and before the end or the first bracketed tag. An
 * optional v2 marks a re-release.
 */
const ANIME = /^(\[[^\]]+\]\s*)(.+?)\s+-\s+(\d{1,4})(?:v\d)?(?=\s|\[|\(|$)/i;

const YEAR = /\b(19\d{2}|20\d{2})\b/g;

/** DDP5.1, DD+5.1, AAC2.0, DTS-HD5.1: audio tags whose dots would otherwise split them. */
const AUDIO = /\b(ddp|dd\+|dd|eac3|ac3|aac|dts-?hd|dts|truehd|flac|opus)[.\s-]?(\d)[.](\d)\b/gi;
/** A collapsed audio tag, such as `ddp51`. */
const AUDIO_TAG = /^(ddp|dd|eac3|ac3|aac|dtshd|dts|truehd|flac|opus)\d\d$/;

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

function isTag(token: string): boolean {
  const t = token.toLowerCase();
  return TAGS.has(t) || AUDIO_TAG.test(t);
}

/** Trailing "-GROUP" or "[GROUP]" on a release name, where GROUP has no spaces. */
function extractGroup(base: string): { rest: string; group: string | null } {
  // "-[YTS.MX]" and "[YTS.MX]": a bracketed group at the end. A bracketed tag
  // ("[1080p]") or an anime CRC32 ("[A1B2C3D4]") is not a group.
  const br = /\s*-?\s*\[([A-Za-z0-9_.]{2,20})\]$/.exec(base);
  if (br?.[1] && !isTag(br[1]) && !/^[0-9A-Fa-f]{8}$/.test(br[1])) {
    return { rest: base.slice(0, br.index), group: br[1] };
  }

  const m = /-([A-Za-z0-9_.]{2,20})$/.exec(base);
  if (!m || m[1] === undefined) return { rest: base, group: null };
  const candidate = m[1];

  // A trailing "-2160p" style token is a tag, not a group, and neither is the
  // "-E02.720p" tail of a multi-episode name.
  if (tokenise(candidate).some((t) => isTag(t) || /^e\d{1,3}$/i.test(t))) {
    return { rest: base, group: null };
  }

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

/** Collapse the dotted tags that splitting on "." would break apart: DDP5.1, H.265. */
function collapseTags(base: string): string {
  return base
    .replace(AUDIO, (_, codec: string, a: string, b: string) => {
      const c = codec.toLowerCase().replace('+', 'p').replace('-', '');
      return `${c}${a}${b}`;
    })
    .replace(/\bh[.\s-]?(264|265)\b/gi, 'h$1');
}

function tokenise(base: string): string[] {
  return collapseTags(base)
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
  let { rest, group } = extractGroup(base);

  let season: number | null = null;
  let episode: number | null = null;
  let episodes: number[] | undefined;
  let episodeCut = -1;

  for (const re of EPISODE_PATTERNS) {
    const m = re.exec(rest);
    if (m && m[1] !== undefined && m[2] !== undefined) {
      season = Number(m[1]);
      episode = Number(m[2]);
      episodeCut = m.index;
      const more = [...(m[3] ?? '').matchAll(/\d{1,3}/g)].map((e) => Number(e[0]));
      if (more.length) episodes = [episode, ...more];
      break;
    }
  }

  // No season marker: an anime name carries the group first and an absolute episode
  // number after the title. A number in the year range is a year, not an episode.
  if (episodeCut === -1) {
    const m = ANIME.exec(rest);
    if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined && !isYear(Number(m[3]))) {
      episode = Number(m[3]);
      group = m[1].slice(1, m[1].indexOf(']'));
      // Drop the leading [Group]; the title then runs up to the " - 1100".
      rest = rest.slice(m[1].length);
      episodeCut = m[2].length;
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
    if (!isYear(v)) continue;
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
  const tagIdx = headTokens.findIndex(isTag);
  const titleTokens = tagIdx === -1 ? headTokens : headTokens.slice(0, tagIdx);

  const allTokens = tokenise(rest);
  const tags = allTokens.map((t) => t.toLowerCase()).filter(isTag);

  if (cut === rest.length && titleTokens.length === 0) cut = 0;

  return {
    title: titleCase(titleTokens),
    year,
    season,
    episode,
    ...(episodes ? { episodes } : {}),
    group,
    tags: [...new Set(tags)],
    container,
    release: base,
  };
}

function isYear(v: number): boolean {
  return v >= 1900 && v <= new Date().getFullYear() + 2;
}
