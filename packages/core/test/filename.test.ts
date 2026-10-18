import { describe, expect, it } from 'vitest';
import { basename, parseFilename } from '../src/filename.js';

describe('basename', () => {
  it('takes the last segment of a path or URL and drops query and fragment', () => {
    expect(basename('/media/movies/The.Matrix.1999.mkv')).toBe('The.Matrix.1999.mkv');
    expect(basename('C:\\Media\\The.Matrix.1999.mkv')).toBe('The.Matrix.1999.mkv');
    expect(basename('https://cdn.example.com/v/The.Matrix.1999.mkv?token=abc#t=10')).toBe(
      'The.Matrix.1999.mkv',
    );
  });

  it('percent-decodes, because a src attribute usually is encoded', () => {
    expect(basename('https://x/The%20Matrix%20(1999).mkv')).toBe('The Matrix (1999).mkv');
  });

  it('survives a malformed percent escape rather than throwing', () => {
    expect(basename('https://x/bad%ZZname.mkv')).toBe('bad%ZZname.mkv');
  });
});

describe('parseFilename', () => {
  const cases: Array<{
    input: string;
    title: string;
    year: number | null;
    season: number | null;
    episode: number | null;
  }> = [
    {
      input: 'The.Matrix.1999.1080p.BluRay.x264-AMIABLE.mkv',
      title: 'The Matrix',
      year: 1999,
      season: null,
      episode: null,
    },
    {
      input: 'The Matrix (1999) [1080p].mp4',
      title: 'The Matrix',
      year: 1999,
      season: null,
      episode: null,
    },
    {
      input: 'Game.of.Thrones.S01E01.Winter.Is.Coming.1080p.WEB-DL.x265-GRP.mkv',
      title: 'Game of Thrones',
      year: null,
      season: 1,
      episode: 1,
    },
    {
      input: 'Breaking.Bad.1x01.Pilot.HDTV.XviD.avi',
      title: 'Breaking Bad',
      year: null,
      season: 1,
      episode: 1,
    },
    {
      input: 'The Wire - S02E05 - Undertow.mkv',
      title: 'The Wire',
      year: null,
      season: 2,
      episode: 5,
    },
    {
      input: 'Stranger Things Season 4 Episode 9 2160p.mkv',
      title: 'Stranger Things',
      year: null,
      season: 4,
      episode: 9,
    },
    {
      input: 'Blade.Runner.2049.2017.2160p.UHD.BluRay.x265-TERMiNAL.mkv',
      title: 'Blade Runner 2049',
      year: 2017,
      season: null,
      episode: null,
    },
  ];

  for (const c of cases) {
    it(`parses ${c.input}`, () => {
      const got = parseFilename(c.input);
      expect(got.title).toBe(c.title);
      expect(got.year).toBe(c.year);
      expect(got.season).toBe(c.season);
      expect(got.episode).toBe(c.episode);
    });
  }

  it('does not mistake a resolution for a year', () => {
    // 2160 is not in 19xx/20xx range, but 1080 and 2160 both look year-shaped to a
    // careless regex. This is the specific bug the year bounds exist to prevent.
    const got = parseFilename('Some.Movie.1080p.BluRay.mkv');
    expect(got.year).toBeNull();
  });

  it('keeps a numeric title that happens to look like a year', () => {
    const got = parseFilename('2012.2009.1080p.BluRay.x264.mkv');
    expect(got.title).toBe('2012');
    expect(got.year).toBe(2009);
  });

  it('keeps a series whose name is a year', () => {
    // Reading 2012 as the date leaves no title, and a search with no title and no
    // id has nothing to ask for.
    const got = parseFilename('2012.S01E01.720p.HDTV.x264.mkv');
    expect(got.title).toBe('2012');
    expect(got.year).toBeNull();
    expect(got.season).toBe(1);
    expect(got.episode).toBe(1);
  });

  it('extracts the release group and quality tags', () => {
    const got = parseFilename('The.Matrix.1999.1080p.BluRay.x264-AMIABLE.mkv');
    expect(got.group).toBe('AMIABLE');
    expect(got.tags).toContain('1080p');
    expect(got.tags).toContain('bluray');
    expect(got.tags).toContain('x264');
    expect(got.container).toBe('mkv');
  });

  it('does not treat a trailing quality token as a release group', () => {
    const got = parseFilename('Movie.Name.2020.WEB-DL.mkv');
    expect(got.group).toBeNull();
  });

  it('returns an empty title rather than throwing on junk', () => {
    const got = parseFilename('1080p.x264.mkv');
    expect(got.title).toBe('');
    expect(got.season).toBeNull();
  });

  it('handles an episode marker with no series year', () => {
    const got = parseFilename('Show.Name.S10E24.mkv');
    expect(got.season).toBe(10);
    expect(got.episode).toBe(24);
    expect(got.title).toBe('Show Name');
    expect(got.episodes).toBeUndefined();
  });

  it('reads a multi-episode file as its first episode, and lists them all', () => {
    for (const name of ['Show.Name.S02E01E02.720p.mkv', 'Show.Name.S02E01-E02.720p.mkv']) {
      const got = parseFilename(name);
      expect(got.title, name).toBe('Show Name');
      expect(got.season, name).toBe(2);
      expect(got.episode, name).toBe(1);
      expect(got.episodes, name).toEqual([1, 2]);
    }
  });

  it('reads an anime name: leading group, absolute episode, no season', () => {
    const got = parseFilename('[Group] Title - 1100 [1080p].mkv');
    expect(got.title).toBe('Title');
    expect(got.episode).toBe(1100);
    expect(got.season).toBeNull();
    expect(got.year).toBeNull();
    expect(got.group).toBe('Group');
    expect(got.tags).toContain('1080p');

    const crc = parseFilename('[SubsPlease] Show Name - 05v2 (1080p) [A1B2C3D4].mkv');
    expect(crc.title).toBe('Show Name');
    expect(crc.episode).toBe(5);
    expect(crc.group).toBe('SubsPlease');
  });

  it('strips dotted audio and codec tags', () => {
    const got = parseFilename('Show.Name.S01E01.2160p.WEB-DL.DDP5.1.H.265-GRP.mkv');
    expect(got.title).toBe('Show Name');
    expect(got.group).toBe('GRP');
    expect(got.tags).toEqual(['2160p', 'web', 'ddp51', 'h265']);

    const untagged = parseFilename('Some.Film.DD5.1.H265.10bit.HEVC.x265.mkv');
    expect(untagged.title).toBe('Some Film');
    expect(untagged.tags).toEqual(['dd51', 'h265', '10bit', 'hevc', 'x265']);
  });

  it('reads season packs and ranges, and keeps them out of the title', () => {
    const cases: [string, number, number[] | undefined][] = [
      ['Friends.S01-S10.COMPLETE.1080p.BluRay.x264-GROUP.mkv', 1, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
      ['Friends.S01-S03.720p', 1, [1, 2, 3]],
      ['Friends S01-03 720p', 1, [1, 2, 3]],
      ['Friends Season 1-3 1080p', 1, [1, 2, 3]],
      ['Friends.Seasons.2.to.4.1080p', 2, [2, 3, 4]],
      ['Friends.S02.1080p.BluRay-GROUP', 2, undefined],
      ['Friends Season 4 720p', 4, undefined],
    ];
    for (const [name, season, seasons] of cases) {
      const got = parseFilename(name);
      expect(got.title, name).toBe('Friends');
      expect(got.season, name).toBe(season);
      expect(got.seasons, name).toEqual(seasons);
      expect(got.episode, name).toBeNull();
    }
  });

  it('stops the title at Complete Series', () => {
    for (const name of [
      'Friends.Complete.Series.1080p.BluRay',
      'Friends.The.Complete.Series.1080p',
      'Friends (1994) Complete Series',
    ]) {
      const got = parseFilename(name);
      expect(got.title, name).toBe('Friends');
      expect(got.season, name).toBeNull();
    }
  });

  it('reads a trailing [YTS.MX] as the group', () => {
    for (const name of [
      'Movie.Name.2020.1080p.BluRay.x264.AAC5.1-[YTS.MX].mp4',
      'Movie.Name.2020.1080p.BluRay.x264.AAC5.1.[YTS.MX].mp4',
      'Movie Name (2020) [1080p] [YTS.MX].mp4',
    ]) {
      const got = parseFilename(name);
      expect(got.title, name).toBe('Movie Name');
      expect(got.year, name).toBe(2020);
      expect(got.group, name).toBe('YTS.MX');
    }
  });
});
