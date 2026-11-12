/**
 * Title suggestions while the viewer types, and a show's seasons and episodes.
 *
 * Suggestions come from the site's own autocomplete (/app/search/suggest): it is open,
 * cached at the edge, and /v1 has no list-of-titles verb without a key. Episodes come
 * from /v1/by-imdb, which answers a show with its season tree.
 */
import { API_HOST, apiFetch, CLIENT } from './api.js';

const BASE = `https://${API_HOST}`;

export interface Suggestion {
  imdb: string;
  name: string;
  year: number | null;
  tv: boolean;
  poster: string | null;
  files: number;
  /** For an episode: its show, season and number. */
  series: { imdb: string; name: string } | null;
  season: number | null;
  episode: number | null;
}

interface RawSuggestion {
  imdb?: string;
  name?: string;
  year?: number | null;
  media_type?: string | null;
  kind?: string;
  poster_path?: string | null;
  subtitle_count?: number;
  series?: { imdb?: string; name?: string } | null;
  season?: number | null;
  episode?: number | null;
}

export async function suggest(q: string, signal?: AbortSignal): Promise<Suggestion[]> {
  const u = new URL('/app/search/suggest', BASE);
  u.searchParams.set('q', q);
  u.searchParams.set('limit', '6');
  u.searchParams.set('client', CLIENT);
  const r = await apiFetch(u, { signal });
  if (!r.ok) throw new Error(`suggest answered ${r.status}`);
  const body = (await r.json()) as { results?: RawSuggestion[] };
  return (body.results ?? [])
    .filter((s) => s.imdb && s.name)
    .map((s) => ({
      imdb: s.imdb as string,
      name: s.name as string,
      year: s.year ?? null,
      tv: s.media_type === 'tv' || Boolean(s.series),
      poster: s.poster_path ?? null,
      files: s.subtitle_count ?? 0,
      series: s.series?.imdb ? { imdb: s.series.imdb, name: s.series.name ?? '' } : null,
      season: s.season ?? null,
      episode: s.episode ?? null,
    }));
}

export interface Episode {
  episode: number;
  name: string;
  files: number;
}

export interface Season {
  season: number;
  episodes: Episode[];
}

interface RawSeason {
  season?: number;
  episodes?: { episode?: number; name?: string | null; subtitle_count?: number }[];
}

/** A show's seasons that have files, each with its episodes, in order. */
export async function seasons(seriesImdb: string, signal?: AbortSignal): Promise<Season[]> {
  const u = new URL(`/v1/by-imdb/${encodeURIComponent(seriesImdb)}`, BASE);
  u.searchParams.set('limit', '1');
  u.searchParams.set('client', CLIENT);
  const r = await apiFetch(u, { signal });
  if (!r.ok) throw new Error(`seasons answered ${r.status}`);
  const body = (await r.json()) as { seasons?: RawSeason[] };
  return (body.seasons ?? [])
    .filter((s) => typeof s.season === 'number' && s.season > 0)
    .map((s) => ({
      season: s.season as number,
      episodes: (s.episodes ?? [])
        .filter((e) => typeof e.episode === 'number')
        .map((e) => ({
          episode: e.episode as number,
          name: e.name ?? '',
          files: e.subtitle_count ?? 0,
        }))
        .sort((a, b) => a.episode - b.episode),
    }))
    .sort((a, b) => a.season - b.season);
}

/** A poster through the API's own artwork proxy, as the core client builds it. */
export function posterUrl(path: string | null, size = 'w92'): string | null {
  return path ? `${BASE}/p/${size}${path.startsWith('/') ? path : `/${path}`}` : null;
}
