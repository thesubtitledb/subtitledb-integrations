/**
 * What is playing in this frame, as a lookup hint, and how much to trust it. The popup
 * asks every frame and keeps the strongest: an embedded player's own frame often knows
 * only "Vimeo video player", while the page around it names the film.
 */
import { identify, type MediaHint } from '@subtitledb/core';
import { cleanTitle, type Guess, readSite, type Site, siteFor } from './sites.js';

export interface Found {
  hint: MediaHint;
  /** 3: an IMDb id or the site's own player. 2: page metadata or a release name. 1: the tab title. 0: nothing. */
  strength: number;
  site?: string;
}

export function pageHint(doc: Document, video: HTMLVideoElement | null, host: string): Found {
  const site = siteFor(host);
  const src = video?.currentSrc || video?.src || '';
  // A blob: or data: address is a stream handle, not a file name.
  const named = src && !/^(blob|data|mediasource):/i.test(src) ? src : undefined;
  const meta = identify({ doc, element: video, ...(named ? { src: named } : { src: '' }) });

  const fromSite = site ? readSite(doc, site) : {};
  if (fromSite.title) {
    return found(withIds(guessHint(fromSite), meta), 3, site);
  }
  if (meta.imdbId || meta.seriesImdbId || meta.tmdbId) {
    return found(tidy(meta, site), 3, site);
  }
  // A bare file name ("sintel-excerpt.webm") says less than the tab title; a release
  // name with a year says more.
  const weakFile = meta.source === 'filename' && !meta.year;
  if (meta.title && !weakFile) return found(tidy(meta, site), 2, site);
  const tab = cleanTitle(doc.title || '', site);
  if (tab.title) return found(guessHint(tab), 1, site);
  if (meta.title) return found(meta, 1, site);
  return found({}, 0, site);
}

function found(hint: MediaHint, strength: number, site: Site | undefined): Found {
  return { hint, strength, ...(site ? { site: site.name } : {}) };
}

function guessHint(g: Guess): MediaHint {
  const h: MediaHint = {};
  if (g.title) h.title = g.title;
  if (g.year) h.year = g.year;
  if (g.season !== undefined) h.season = g.season;
  if (g.episode !== undefined) h.episode = g.episode;
  if (g.episodeTitle) h.episodeTitle = g.episodeTitle;
  return h;
}

/** Page metadata titles carry the same suffixes as the tab title. */
function tidy(meta: MediaHint, site: Site | undefined): MediaHint {
  if (!meta.title || meta.source === 'filename') return meta;
  const g = cleanTitle(meta.title, site);
  return { ...meta, ...guessHint(g), ...(meta.year ? { year: meta.year } : {}) };
}

function withIds(h: MediaHint, meta: MediaHint): MediaHint {
  const out = { ...h };
  if (meta.imdbId) out.imdbId = meta.imdbId;
  if (meta.seriesImdbId) out.seriesImdbId = meta.seriesImdbId;
  return out;
}
