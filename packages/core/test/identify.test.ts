import { describe, expect, it } from 'vitest';
import { identify, isResolvable } from '../src/identify.js';

/**
 * A hand-rolled stand-in for the two Document methods identify() uses. Cheaper and
 * more legible than pulling in jsdom for six assertions, and it keeps the package
 * dependency-free all the way through its tests.
 */
function fakeDoc(opts: {
  metas?: Record<string, string>;
  jsonld?: unknown[];
  imdbHref?: string;
}): Document {
  const metas = opts.metas ?? {};
  const doc = {
    querySelector(sel: string) {
      if (sel.includes('imdb.com/title/tt')) {
        return opts.imdbHref ? { getAttribute: () => opts.imdbHref } : null;
      }
      const m = /\[(?:property|name|itemprop)="([^"]+)"\]/.exec(sel);
      const key = m?.[1];
      if (key && Object.hasOwn(metas, key)) {
        return { getAttribute: (a: string) => (a === 'content' ? metas[key] : null) };
      }
      return null;
    },
    querySelectorAll(sel: string) {
      if (sel.includes('ld+json')) {
        return (opts.jsonld ?? []).map((v) => ({ textContent: JSON.stringify(v) }));
      }
      return [];
    },
  };
  return doc as unknown as Document;
}

function fakeVideo(dataset: Record<string, string>, src = ''): Element {
  return { dataset, currentSrc: src, src } as unknown as Element;
}

describe('identify precedence', () => {
  it('prefers explicit config over everything else', () => {
    const hint = identify({
      config: { imdbId: 'tt0000001', title: 'Configured' },
      element: fakeVideo({ imdbId: 'tt9999999' }, 'The.Matrix.1999.mkv'),
      doc: fakeDoc({ metas: { 'og:title': 'From The Page' } }),
    });
    expect(hint.imdbId).toBe('tt0000001');
    expect(hint.title).toBe('Configured');
    expect(hint.source).toBe('config');
  });

  it('reads data attributes off the media element', () => {
    const hint = identify({
      element: fakeVideo({ imdbId: 'tt1480055', season: '1', episode: '1' }),
      doc: null,
    });
    expect(hint.imdbId).toBe('tt1480055');
    expect(hint.season).toBe(1);
    expect(hint.episode).toBe(1);
    expect(hint.source).toBe('dataset');
  });

  it('ignores a data-imdb-id that is not an imdb id', () => {
    const hint = identify({ element: fakeVideo({ imdbId: 'garbage' }), doc: null });
    expect(hint.imdbId).toBeUndefined();
  });

  it('falls back to the filename when nothing else knows anything', () => {
    const hint = identify({ src: '/media/The.Matrix.1999.1080p.mkv', doc: null });
    expect(hint.title).toBe('The Matrix');
    expect(hint.year).toBe(1999);
    expect(hint.source).toBe('filename');
  });

  it('fills gaps rather than overwriting: config title plus filename episode', () => {
    const hint = identify({
      config: { title: 'Real Series Name' },
      src: 'Whatever.S03E07.1080p.mkv',
      doc: null,
    });
    expect(hint.title).toBe('Real Series Name');
    expect(hint.season).toBe(3);
    expect(hint.episode).toBe(7);
  });
});

describe('identify from page metadata', () => {
  it('reads og:title and a release date year', () => {
    const hint = identify({
      doc: fakeDoc({
        metas: { 'og:title': 'The Matrix', 'video:release_date': '1999-03-31' },
      }),
    });
    expect(hint.title).toBe('The Matrix');
    expect(hint.year).toBe(1999);
  });

  it('picks up an imdb link anywhere in the document', () => {
    const hint = identify({
      doc: fakeDoc({ imdbHref: 'https://www.imdb.com/title/tt0133093/' }),
    });
    expect(hint.imdbId).toBe('tt0133093');
  });

  it('extracts an imdb id from a JSON-LD Movie sameAs', () => {
    const hint = identify({
      doc: fakeDoc({
        jsonld: [
          {
            '@context': 'https://schema.org',
            '@type': 'Movie',
            name: 'The Matrix',
            datePublished: '1999-03-31',
            sameAs: ['https://www.imdb.com/title/tt0133093/'],
          },
        ],
      }),
    });
    expect(hint.imdbId).toBe('tt0133093');
    expect(hint.title).toBe('The Matrix');
    expect(hint.year).toBe(1999);
  });

  it('walks a nested @graph and reads TVEpisode season and episode numbers', () => {
    const hint = identify({
      doc: fakeDoc({
        jsonld: [
          {
            '@graph': [
              { '@type': 'WebSite', name: 'Not The Video' },
              {
                '@type': 'TVEpisode',
                name: 'Winter Is Coming',
                episodeNumber: 1,
                partOfSeason: { '@type': 'TVSeason', seasonNumber: 1 },
                partOfSeries: {
                  '@type': 'TVSeries',
                  sameAs: 'https://www.imdb.com/title/tt0944947/',
                },
                sameAs: 'https://www.imdb.com/title/tt1480055/',
              },
            ],
          },
        ],
      }),
    });
    expect(hint.imdbId).toBe('tt1480055');
    expect(hint.seriesImdbId).toBe('tt0944947');
    expect(hint.season).toBe(1);
    expect(hint.episode).toBe(1);
  });

  it('survives malformed JSON-LD without throwing', () => {
    const doc = {
      querySelector: () => null,
      querySelectorAll: (sel: string) =>
        sel.includes('ld+json') ? [{ textContent: '{not json' }] : [],
    } as unknown as Document;
    expect(() => identify({ doc })).not.toThrow();
  });

  it('does not loop on a self-referential JSON-LD graph', () => {
    const node: Record<string, unknown> = { '@type': 'Movie', name: 'Loop' };
    node.self = node;
    const doc = {
      querySelector: () => null,
      querySelectorAll: (sel: string) => {
        if (!sel.includes('ld+json')) return [];
        // Simulate a parsed cyclic object by handing back a pre-built node.
        return [{ textContent: '{"@type":"Movie","name":"Loop"}' }];
      },
    } as unknown as Document;
    expect(identify({ doc }).title).toBe('Loop');
  });
});

describe('isResolvable', () => {
  it('accepts anything the ladder can act on', () => {
    expect(isResolvable({ imdbId: 'tt0133093' })).toBe(true);
    expect(isResolvable({ tmdbId: 603 })).toBe(true);
    expect(isResolvable({ title: 'The Matrix' })).toBe(true);
  });

  it('rejects an empty or useless hint', () => {
    expect(isResolvable({})).toBe(false);
    expect(isResolvable({ title: 'x' })).toBe(false);
    expect(isResolvable({ year: 1999 })).toBe(false);
  });
});
