import type { DrillParams, SubtitleDbClient } from './client.js';
import { SubtitleDbError } from './errors.js';
import type { MediaHint } from './identify.js';
import { languageName } from './languages.js';
import type { BundleSubtitle, LookupBundle, LookupTitle } from './types.js';

/**
 * Rungs of the match ladder, strongest first. Each falls through to the next.
 *
 * tmdb is the headline key and leads the ladder; imdb sits right behind it, because
 * media servers identify content by IMDb id and the imdb->tmdb map is only partial, so
 * `explicit-tmdb` 404s for many ids and hands off to `explicit-imdb`. Free text is the
 * last automatic rung: the server matches the title and drills to the episode, so no
 * ranked list of titles crosses the wire.
 */
export type MatchTier = 'explicit-tmdb' | 'explicit-imdb' | 'title' | 'manual';

export interface Candidate {
  subtitle: BundleSubtitle;
  /** Higher is better. Only comparable within one result set. */
  score: number;
  /** Human-readable justification, safe to surface in a picker. */
  reason: string;
  /**
   * A placeholder for on-device transcription rather than a corpus subtitle. It
   * carries no bytes and no `download_url`: selecting it runs the media's own audio
   * through a speech-to-text engine (see `transcribe.ts`) instead of a download.
   * Offered only when `transcribe` is configured and a transcriber is wired, and
   * never chosen by `autoSelect`, which only ever picks a real corpus candidate.
   */
  synthetic?: true;
}

/**
 * What a viewer reads in the captions menu.
 *
 * One function, because three adapters had three versions of it and a menu is the
 * only place a viewer meets this integration at all. The hard part is that most of
 * the corpus carries no release name: thirty English candidates for one film then
 * produced thirty entries reading "English", and picking one was a lottery. The cue
 * count is the only other field that differs between them, so it is what tells them
 * apart when there is no name to use.
 */
export function candidateLabel(c: Candidate): string {
  const s = c.subtitle;
  // A synthetic row is not a corpus file and must never read like one: it is the
  // media's own audio transcribed on the device, so it is labelled as such and marked
  // with the language it will produce rather than a cue count it does not have yet.
  if (c.synthetic) return `AI transcription (${languageName(s.language)})`;
  const bits: string[] = [languageName(s.language)];
  if (s.hearing_impaired) bits.push('HI');
  if (s.release_name) bits.push(s.release_name.slice(0, 40));
  else if (s.cues > 0) bits.push(`${s.cues} lines`);
  return bits.join(' - ');
}

export interface MatchResult {
  /** The title we resolved to, when we resolved one. */
  title: LookupTitle | null;
  /** Ranked, already filtered to formats the player can render. */
  candidates: Candidate[];
  /** Which rung produced the result. `manual` means nothing automatic worked. */
  tier: MatchTier;
  /** Subtitles dropped purely because the player cannot render their format. */
  unrenderable: number;
  /**
   * Subtitles dropped because sub_meta files them under a different episode. Counted
   * rather than shown: the wrong episode's lines are worse than no lines.
   */
  wrongEpisode: number;
}

/** Everything ranking needs. No client, because ranking issues no requests. */
export interface RankOptions {
  hint: MediaHint;
  /** Preference order. Earlier is better. Empty means no language preference. */
  languages?: string[];
  /**
   * Formats this session can put in front of a viewer: what the player parses
   * natively, plus anything the client side converter can reach. A hard filter, not
   * a preference, because handing a player a format it cannot parse produces a
   * silent empty caption track, the most confusing failure a subtitle plugin has.
   */
  formats: string[];
  /** Prefer, or avoid, hearing-impaired subtitles. Undefined means no preference. */
  hearingImpaired?: boolean;
  /** Maximum candidates to return. */
  limit?: number;
}

export interface MatchOptions extends RankOptions {
  client: SubtitleDbClient;
  signal?: AbortSignal;
}

const DEFAULT_LIMIT = 100;
/** How much each step down the language preference list costs. */
const LANGUAGE_STEP = 20;
/** How close two release names have to be before we call it the same encode. */
const EXACT_RELEASE = 0.95;

function normalise(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      // Strip combining marks so "Amelie" and "Amelie" with an accent compare equal.
      // Uses a Unicode property escape so this source file stays pure ASCII.
      .replace(/\p{M}/gu, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
  );
}

/** Dice coefficient over bigrams. Cheap, and forgiving of word order and punctuation. */
export function similarity(a: string, b: string): number {
  const x = normalise(a);
  const y = normalise(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string) => {
    const out = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(x);
  const gb = grams(y);
  let overlap = 0;
  let total = 0;
  for (const n of ga.values()) total += n;
  for (const [g, n] of gb) {
    total += n;
    const have = ga.get(g);
    if (have) overlap += Math.min(have, n);
  }
  return total === 0 ? 0 : (2 * overlap) / total;
}

function scoreSubtitle(s: BundleSubtitle, opts: RankOptions): { score: number; reason: string } {
  const reasons: string[] = [];
  let score = 0;

  const langs = opts.languages ?? [];
  if (langs.length) {
    const idx = langs.indexOf(s.language);
    if (idx >= 0) {
      score += 100 - idx * LANGUAGE_STEP;
      reasons.push(`preferred language ${s.language}`);
    } else {
      score -= 50;
    }
  }

  if (opts.hearingImpaired !== undefined) {
    if (s.hearing_impaired === opts.hearingImpaired) {
      score += 15;
      reasons.push(opts.hearingImpaired ? 'hearing impaired' : 'not hearing impaired');
    } else {
      score -= 15;
    }
  }

  // Release-name agreement is the strongest signal a subtitle matches this exact
  // encode, and it is a comparison between two release names. Comparing one against
  // the film's title, as this did before sub_meta made release_name real, could not
  // agree with anything.
  const release = s.release_name?.trim();
  if (release && opts.hint.release) {
    const sim = similarity(release, opts.hint.release);
    if (sim >= EXACT_RELEASE) {
      score += 60;
      reasons.push('same release');
    } else if (sim > 0.5) {
      score += sim * 30;
      reasons.push('release name is close');
    }
  }

  // An episode we could confirm, rather than one we merely could not rule out.
  if (opts.hint.season !== undefined && s.season !== null && !wrongEpisode(s, opts.hint)) {
    score += 20;
    reasons.push(`season ${opts.hint.season} episode ${opts.hint.episode}`);
  }

  // A subtitle with no cues cannot render. Known corpus defect, tracked as a repo
  // task; cheap to defend against here.
  if (s.cues === 0) {
    score -= 500;
    reasons.push('no cues');
  }

  return { score, reason: reasons.join(', ') || `${s.language} ${s.format}` };
}

/**
 * Whether sub_meta files this subtitle under a different episode.
 *
 * A row with no season at all is kept: sub_meta has no entry for every id, and
 * unknown is not wrong.
 */
function wrongEpisode(s: BundleSubtitle, hint: MediaHint): boolean {
  if (hint.season === undefined || hint.episode === undefined) return false;
  if (s.season === null || s.episode === null) return false;
  return s.season !== hint.season || s.episode !== hint.episode;
}

/**
 * Filter, score and order. Exported because this is the behaviour the shared cases in
 * plugins/shared/match-cases.json pin, which every host language reads.
 *
 * The bundle already sorts a page newest-first and carries no download count, so ties
 * break on the id: two runs of the same query then agree on the order.
 */
export function rank(
  subs: BundleSubtitle[],
  opts: RankOptions,
): { candidates: Candidate[]; dropped: number; wrong: number } {
  const renderable = new Set(opts.formats.map((f) => f.toLowerCase()));
  const playable = subs.filter((s) => renderable.has(s.format.toLowerCase()));
  const dropped = subs.length - playable.length;

  // The wrong episode is not a worse match, it is the wrong file: showing it is how
  // a viewer ends up watching episode 14 with episode 15's lines. So it is a filter,
  // the same as a format the player cannot parse.
  const usable = playable.filter((s) => !wrongEpisode(s, opts.hint));
  const wrong = playable.length - usable.length;

  const candidates = usable
    .map((subtitle) => {
      const { score, reason } = scoreSubtitle(subtitle, opts);
      return { subtitle, score, reason };
    })
    .sort((a, b) => b.score - a.score || a.subtitle.id - b.subtitle.id)
    .slice(0, opts.limit ?? DEFAULT_LIMIT);

  return { candidates, dropped, wrong };
}

/** 404 and 400 are "this rung does not apply", not failures worth aborting on. */
function isFallthrough(err: unknown): boolean {
  return err instanceof SubtitleDbError && (err.status === 404 || err.status === 400);
}

/**
 * The scoped subtitle page inside a bundle: the files that belong to exactly what was
 * asked for. The API puts them in the top-level `subtitles` page at every scope, so a
 * drilled episode, a drilled season, a movie and a whole series all read the same way.
 * This used to branch on `'episode' in b` and `'season' in b`; neither key exists.
 */
function scopedItems(b: LookupBundle): BundleSubtitle[] {
  return b.subtitles.items;
}

/**
 * Fetch a bundle, one request per preferred language, and merge the scoped pages.
 *
 * The API `lang` parameter takes a single ISO code. Passing a comma separated list is
 * silently ignored rather than rejected, which is the dangerous shape: the request
 * succeeds, the filter does not apply, and the default `sort=lang` returns the
 * alphabetically earliest languages. For The Matrix, 715 subtitles at limit=100 yields
 * ar through de and no English at all, so a naive multi-language client looks like it
 * works and quietly never finds the language the user asked for.
 *
 * Fanning out costs one small request per configured language, which is typically one
 * to three, and each is independently cacheable at the edge.
 */
export async function fetchBundlePage(
  fetchOne: (lang: string | undefined) => Promise<LookupBundle>,
  langs: string[] | undefined,
): Promise<{ title: LookupTitle; subs: BundleSubtitle[] }> {
  if (!langs || langs.length === 0) {
    const b = await fetchOne(undefined);
    return { title: b.title, subs: scopedItems(b) };
  }
  if (langs.length === 1 && langs[0]) {
    const b = await fetchOne(langs[0]);
    return { title: b.title, subs: scopedItems(b) };
  }

  const bundles = await Promise.all(langs.map((lang) => fetchOne(lang)));
  const first = bundles[0];
  if (!first) {
    const b = await fetchOne(undefined);
    return { title: b.title, subs: scopedItems(b) };
  }

  // Preserve the caller's language priority, and drop any duplicate id defensively.
  const seen = new Set<number>();
  const subs: BundleSubtitle[] = [];
  for (const b of bundles) {
    for (const s of scopedItems(b)) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      subs.push(s);
    }
  }

  return { title: first.title, subs };
}

/**
 * Walk the ladder and return ranked candidates.
 *
 * Only ever issues lookup-shaped requests. Subtitle bytes are never fetched here,
 * which is what keeps eager loading affordable: one cacheable JSON request per player
 * (per language), regardless of how many subtitles come back.
 */
export async function findSubtitles(opts: MatchOptions): Promise<MatchResult> {
  const { client, hint, signal } = opts;
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const langs = opts.languages?.length ? opts.languages : undefined;

  const finish = (
    title: LookupTitle | null,
    subs: BundleSubtitle[],
    tier: MatchTier,
  ): MatchResult => {
    const { candidates, dropped, wrong } = rank(subs, opts);
    return { title, candidates, tier, unrenderable: dropped, wrongEpisode: wrong };
  };

  // The drill and paging shared by every verb on every rung. A movie ignores
  // `season`/`episode`; a series narrows to exactly them.
  const drill: DrillParams = {
    ...(hint.season !== undefined ? { season: hint.season } : {}),
    ...(hint.episode !== undefined ? { episode: hint.episode } : {}),
    limit,
    ...(signal ? { signal } : {}),
  };

  const via = async (
    verb: (p: DrillParams) => Promise<LookupBundle>,
    tier: MatchTier,
  ): Promise<MatchResult | null> => {
    try {
      const { title, subs } = await fetchBundlePage(
        (lang) => verb(lang ? { ...drill, lang } : drill),
        langs,
      );
      return finish(title, subs, tier);
    } catch (err) {
      if (isFallthrough(err)) return null;
      throw err;
    }
  };

  // Rung 1: an explicit TMDB id. tmdb is the headline key. The imdb->tmdb map is only
  // partial in production, so this 404s for many ids and falls through to imdb.
  if (hint.tmdbId !== undefined) {
    const r = await via((p) => client.byTmdb(hint.tmdbId as number, p), 'explicit-tmdb');
    if (r) return r;
  }

  // Rung 2: an explicit IMDb id. Works for films and, importantly, for TV episodes:
  // the corpus stores each episode under its own episode-level IMDb id. This is the
  // rung media servers hit, since they hand over an IMDb id.
  if (hint.imdbId) {
    const r = await via((p) => client.byImdb(hint.imdbId as string, p), 'explicit-imdb');
    if (r) return r;
  }

  // Rung 3: free text, drilled to the episode when the numbers are known. The server
  // matches the title (top-1) and narrows by season/episode, so no title list crosses
  // the wire.
  if (hint.title && hint.title.length > 1) {
    const r = await via((p) => client.byTitle(hint.title as string, p), 'title');
    if (r) return r;
  }

  return finish(null, [], 'manual');
}
