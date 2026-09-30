/**
 * The debugger chunk.
 *
 * Fetched only when a page passes a debugger key, and in parallel with the engine,
 * so a page without one never downloads a byte of it. It shares no runtime code with
 * the other chunks.
 *
 * Turning what SubtitleDB resolved into the debugger's terms happens here rather
 * than in the entry, so the entry pays nothing for it.
 */
import type { LoadedSubtitle, MediaHint, ResolveResult } from '@subtitledb/core';
import { type Context, type Stoppable, watch, watchPage as watchAll } from '@subtitledb/debug';

/** One attached video, as the loader drives it. */
export interface Attached {
  resolved(result: ResolveResult): void;
  selected(loaded: LoadedSubtitle): void;
  stop(): void;
}

const imdbNumber = (id: unknown): number => Number(String(id ?? '').replace(/^tt/, '')) || 0;

/** What a page's own hint says is playing, in the debugger's terms. */
function contextOf(hint: MediaHint | undefined): Context | undefined {
  if (!hint) return undefined;
  return {
    imdb: imdbNumber(hint.imdbId),
    tmdb: Number(hint.tmdbId) || 0,
    season: Number(hint.season) || 0,
    episode: Number(hint.episode) || 0,
  };
}

/** Every video on the page, each filed under the page's hint when it gave one. */
export function watchPage(o: {
  key: string;
  loadId: string;
  hint?: MediaHint | undefined;
}): Stoppable {
  return watchAll({ key: o.key, loadId: o.loadId, context: contextOf(o.hint) });
}

export function watchAttached(
  media: HTMLVideoElement,
  key: string,
  loadId: string,
  player: string | undefined,
): Attached {
  const w = watch(media, { key, loadId });
  if (player) w.context({ player });
  return {
    resolved(r) {
      const title = r.title;
      w.context({
        imdb: imdbNumber(title?.imdb ?? r.hint.imdbId),
        tmdb: title?.tmdb_id ?? r.hint.tmdbId ?? 0,
        season: r.hint.season ?? 0,
        episode: r.hint.episode ?? 0,
      });
      const name = title?.name
        ? `${title.name}${title.year ? ` (${title.year})` : ''}`
        : 'no title';
      w.record('offered', `${r.candidates.length} subtitles for ${name}, by ${r.tier}`);
    },
    selected(loaded) {
      const s = loaded.candidate.subtitle;
      w.select({
        id: s.id,
        language: s.language,
        source: loaded.candidate.synthetic ? 'ai' : 'sdb',
      });
    },
    stop: () => w.stop(),
  };
}
