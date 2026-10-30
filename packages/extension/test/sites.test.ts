import { describe, expect, it } from 'vitest';
import { cleanTitle, parseEpisode, SITES, siteFor } from '../src/sites.js';

describe('siteFor', () => {
  it.each([
    ['www.youtube.com', 'youtube'],
    ['m.youtube.com', 'youtube'],
    ['www.youtube-nocookie.com', 'youtube'],
    ['www.netflix.com', 'netflix'],
    ['www.primevideo.com', 'primevideo'],
    ['www.amazon.co.uk', 'primevideo'],
    ['www.amazon.de', 'primevideo'],
    ['www.disneyplus.com', 'disneyplus'],
    ['play.max.com', 'max'],
    ['play.hbomax.com', 'max'],
    ['mubi.com', 'mubi'],
    ['vimeo.com', 'vimeo'],
    ['player.vimeo.com', 'vimeo'],
    ['www.dailymotion.com', 'dailymotion'],
    ['app.getmetastream.com', 'metastream'],
    ['www.vudu.com', 'fandango'],
    ['athome.fandango.com', 'fandango'],
  ])('%s is %s', (host, id) => {
    expect(siteFor(host)?.id).toBe(id);
  });

  it('matches whole labels only', () => {
    expect(siteFor('notnetflix.com')).toBeUndefined();
    expect(siteFor('netflix.com.evil.example')).toBeUndefined();
    expect(siteFor('example.org')).toBeUndefined();
  });

  it('gives every site a title selector', () => {
    for (const s of SITES) expect(s.title?.length, s.id).toBeGreaterThan(0);
  });
});

describe('parseEpisode', () => {
  it.each([
    ['S1:E3 The Vanishing', { season: 1, episode: 3, episodeTitle: 'The Vanishing' }],
    ['S01E03', { season: 1, episode: 3 }],
    ['S2 E10: Pilot', { season: 2, episode: 10, episodeTitle: 'Pilot' }],
    ['Season 1, Ep. 3 Name', { season: 1, episode: 3, episodeTitle: 'Name' }],
    ['Season 4 Episode 12', { season: 4, episode: 12 }],
    ['Stranger Things S1:E3 Holly, Jolly', { season: 1, episode: 3, episodeTitle: 'Holly, Jolly' }],
    ['3x07 "Title"', { season: 3, episode: 7, episodeTitle: 'Title' }],
  ])('%s', (text, want) => {
    expect(parseEpisode(text)).toEqual(want);
  });

  it('finds nothing in a film title', () => {
    expect(parseEpisode('Se7en')).toEqual({});
    expect(parseEpisode('2001: A Space Odyssey')).toEqual({});
  });
});

describe('cleanTitle', () => {
  const site = (id: string) => SITES.find((s) => s.id === id);

  it('takes the site off the tab title', () => {
    expect(cleanTitle('The Matrix (1999) - YouTube', site('youtube'))).toEqual({
      title: 'The Matrix',
      year: 1999,
    });
    expect(cleanTitle('Big Buck Bunny on Vimeo', site('vimeo'))).toEqual({
      title: 'Big Buck Bunny',
    });
    expect(cleanTitle('Watch Perfect Days | MUBI', site('mubi'))).toEqual({
      title: 'Perfect Days',
    });
    expect(cleanTitle('Some clip - video Dailymotion', site('dailymotion'))).toEqual({
      title: 'Some clip',
    });
  });

  it('splits an episode marker off a show title', () => {
    expect(cleanTitle('Friends S03E05 The One with Frank Jr.')).toEqual({
      title: 'Friends',
      season: 3,
      episode: 5,
      episodeTitle: 'The One with Frank Jr.',
    });
  });

  it('reads a trailing year and leaves numbers in the middle alone', () => {
    expect(cleanTitle('Heat 1995')).toEqual({ title: 'Heat', year: 1995 });
    expect(cleanTitle('Blade Runner 2049')).toEqual({ title: 'Blade Runner 2049' });
    expect(cleanTitle('2001: A Space Odyssey')).toEqual({ title: '2001: A Space Odyssey' });
  });
});
