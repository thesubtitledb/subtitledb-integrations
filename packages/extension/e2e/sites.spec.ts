import { expect, openPopup, test } from './fixtures.js';

/**
 * Title detection on each supported site. The real host names are routed to pages
 * carrying the markup each site's player shows, so the content script runs on the
 * address it would in use and reads what the site would put there.
 */

interface Case {
  url: string;
  title: string;
  body: string;
  want: { q: string; year?: string; season?: string; episode?: string; from: string };
}

const CASES: Case[] = [
  {
    url: 'https://www.netflix.com/watch/80077368',
    title: 'Netflix',
    body: '<div data-uia="video-title"><h4>Stranger Things</h4><span>S1:E3</span><span>Holly, Jolly</span></div>',
    want: { q: 'Stranger Things', season: '1', episode: '3', from: 'From Netflix' },
  },
  {
    url: 'https://www.primevideo.com/detail/0ABC',
    title: 'Prime Video: The Boys',
    body: '<div class="atvwebplayersdk-title-text">The Boys</div><div class="atvwebplayersdk-subtitle-text">Season 1, Ep. 2 Cherry</div>',
    want: { q: 'The Boys', season: '1', episode: '2', from: 'From Prime Video' },
  },
  {
    url: 'https://www.amazon.co.uk/gp/video/detail/B0',
    title: 'Amazon.co.uk: Watch Fleabag',
    body: '<p>No player markup here</p>',
    want: { q: 'Fleabag', from: 'From Prime Video' },
  },
  {
    url: 'https://www.disneyplus.com/play/1234',
    title: 'Disney+',
    body: '<div class="title-field">The Mandalorian</div><div class="subtitle-field">S1:E1 Chapter 1: The Mandalorian</div>',
    want: { q: 'The Mandalorian', season: '1', episode: '1', from: 'From Disney+' },
  },
  {
    url: 'https://play.max.com/video/watch/1',
    title: 'Max',
    body: '<span data-testid="player-ux-asset-title">The Last of Us</span><span data-testid="player-ux-season-episode">S1 E1</span>',
    want: { q: 'The Last of Us', season: '1', episode: '1', from: 'From Max' },
  },
  {
    url: 'https://www.youtube.com/watch?v=aqz-KE-bpKQ',
    title: 'Big Buck Bunny 60fps 4K - Official Blender Foundation Short Film - YouTube',
    body: '<h1 class="ytd-watch-metadata"><yt-formatted-string>Big Buck Bunny (2008)</yt-formatted-string></h1>',
    want: { q: 'Big Buck Bunny', year: '2008', from: 'From YouTube' },
  },
  {
    url: 'https://mubi.com/en/films/paris-texas/player',
    title: 'Watch Paris, Texas | MUBI',
    body: '<h2 data-testid="film-title">Paris, Texas</h2>',
    want: { q: 'Paris, Texas', from: 'From MUBI' },
  },
  {
    url: 'https://vimeo.com/1084537',
    title: 'Big Buck Bunny on Vimeo',
    body: '<p>player</p>',
    want: { q: 'Big Buck Bunny', from: 'From Vimeo' },
  },
  {
    url: 'https://www.dailymotion.com/video/x8abc',
    title: 'Sintel - video Dailymotion',
    body: '<h1 class="dmp_VideoInfo-title-text">Sintel (2010)</h1>',
    want: { q: 'Sintel', year: '2010', from: 'From Dailymotion' },
  },
  {
    url: 'https://athome.fandango.com/content/movies/details/1',
    title: 'Fandango at Home',
    body: '<h1>Watch Inception</h1>',
    want: { q: 'Inception', from: 'From Fandango at Home' },
  },
  {
    url: 'https://app.getmetastream.com/',
    title: 'Metastream',
    body: '<div class="QueueInfoContent__title-x1">Sintel</div>',
    want: { q: 'Sintel', from: 'From Metastream' },
  },
  {
    url: 'https://example.org/watch/tears',
    title: 'Something on the page',
    body: '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Movie","name":"Tears of Steel","sameAs":"https://www.imdb.com/title/tt2285752/"}</script>',
    want: { q: 'Tears of Steel', from: 'Found on the page: tt2285752' },
  },
];

for (const c of CASES) {
  test(`${new URL(c.url).hostname}: ${c.want.q}`, async ({ context }) => {
    await context.route(c.url, (r) =>
      r.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="en"><head><title>${c.title}</title></head><body>${c.body}<video width="640" height="360"></video></body></html>`,
      }),
    );
    const page = await context.newPage();
    await page.goto(c.url);
    const popup = await openPopup(context, page.url());
    await expect(popup.locator('#q')).toHaveValue(c.want.q);
    await expect(popup.locator('#from')).toHaveText(c.want.from);
    await expect(popup.locator('#year')).toHaveValue(c.want.year ?? '');
    await expect(popup.locator('#season')).toHaveValue(c.want.season ?? '');
    await expect(popup.locator('#episode')).toHaveValue(c.want.episode ?? '');
  });
}
