#!/usr/bin/env python3
"""The sample library every live-host job plays.

    python3 media.py /path/to/media      writes the library, prints one line per video:
                                         path, title, languages, expectation, the
                                         subtitles per language every host is set to
                                         and the languages holding more, tab separated

Black twenty-minute 480p videos with a silent audio track, named the way releases
are named, with the NFO files Jellyfin, Emby and Kodi read so the ids do not hang on
a metadata site being up. Radarr and Sonarr will not import a file much shorter,
which they call a sample, or one with no audio. The film and the first episode are
the two titles the API's own live tests use, and the two asked for in more languages
than English. The shows are popular free-to-air ones, each as a 480p release, the
lowest quality that gets rips. Then a film with a non-ASCII name, which every host
has to carry through a path, a URL and a file name, and a title the index has
nothing for, which every host has to say plainly. The plugins read a file's name,
its ids and its release tags and never its picture, so a black 480p file walks the
same path a real one would.
"""

from __future__ import annotations

import pathlib
import subprocess
import sys
from dataclasses import dataclass

SIZE = "854x480"

#: Subtitles per language every host is set to, through its own settings. Past the
#: API's page of 100 and short of what the index holds for The Matrix in English, so
#: a host that stops at the first page and one that ignores the setting both fail.
PER_LANGUAGE = 120


@dataclass(frozen=True)
class Sample:
    """One video and what the metadata around it says. An episode has a season."""

    #: Under the media root: movies/<Film (year)>/... or tv/<Show>/Season NN/...
    path: str
    name: str
    year: int
    #: The film's IMDb id, or the series'. None for a title the index has nothing for.
    imdb: str | None
    tmdb: int | None
    tvdb: int | None = None
    episode_imdb: str | None = None
    episode_name: str | None = None
    season: int | None = None
    episode: int | None = None
    #: The API's codes for the languages every host is asked for, English first.
    languages: tuple[str, ...] = ("en",)
    #: The episode's own TVDB id, the default id of a TVDB-scraped library.
    episode_tvdb: int | None = None
    #: Whether the library holds the episode's own IMDb id. A TVDB-scraped episode
    #: often has none; for such a sample every host has to go by the series' id.
    episode_imdb_in_library: bool = True
    #: The languages the index holds more than PER_LANGUAGE subtitles in. baseline.py
    #: holds this to what the index says.
    many: tuple[str, ...] = ()

    @property
    def is_episode(self) -> bool:
        return self.season is not None

    @property
    def library_episode_imdb(self) -> str | None:
        """The episode's IMDb id as a host's library holds it."""
        return self.episode_imdb if self.episode_imdb_in_library else None

    @property
    def known(self) -> bool:
        """Whether the index holds the title. For one it does not, the right answer
        is nothing, said as such: not another title's subtitles, not an outage."""
        return self.imdb is not None

    @property
    def release(self) -> str:
        return pathlib.PurePosixPath(self.path).stem

    @property
    def folder(self) -> str:
        """The film's own folder, or the show's: what Radarr and Sonarr are pointed at."""
        return pathlib.PurePosixPath(self.path).parts[1]


#: Spanish, which the corpus is deep in, and Brazilian Portuguese, which the API
#: files under pb and every host spells its own way.
MORE = ("en", "es", "pb")

FILM = Sample("movies/The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv",
              "The Matrix", 1999, "tt0133093", 603, languages=MORE, many=("en",))
EPISODE = Sample("tv/Game of Thrones/Season 01/Game.of.Thrones.S01E01.720p.HDTV.x264-GROUP.mkv",
                 "Game of Thrones", 2011, "tt0944947", 1399, tvdb=121361,
                 episode_imdb="tt1480055", episode_name="Winter Is Coming", season=1, episode=1,
                 languages=MORE, episode_tvdb=3254641)

#: Popular free-to-air shows, the first episode of each at 480p. Where the index holds
#: a subtitle for a real 480p release of that episode the file is named after it, so
#: the check that the subtitle made for this very release comes first has something
#: to bite on. The episode ids are the ones the API's own season list gives.
SHOWS = [
    Sample("tv/Doctor Who (2005)/Season 01/Doctor.Who.2005.S01E01.480p.BluRay.nSD.x264-NhaNc3.mkv",
           "Doctor Who", 2005, "tt0436992", 57243, tvdb=78804,
           episode_imdb="tt0562992", episode_name="Rose", season=1, episode=1,
           episode_tvdb=295294),
    Sample("tv/Sherlock/Season 01/Sherlock.S01E01.480p.BRRip.x264.mkv",
           "Sherlock", 2010, "tt1475582", 19885, tvdb=176941,
           episode_imdb="tt1665071", episode_name="A Study in Pink", season=1, episode=1,
           episode_tvdb=2502511),
    Sample("tv/Downton Abbey/Season 01/Downton.Abbey.S01E01.480p.HDTV.x264-GROUP.mkv",
           "Downton Abbey", 2010, "tt1606375", 33907, tvdb=193131,
           episode_imdb="tt1608844", episode_name="Episode 1", season=1, episode=1,
           episode_tvdb=2887371),
    Sample("tv/Peaky Blinders/Season 01/Peaky.Blinders.S01E01.480p.HDTV.x264-mSD.mkv",
           "Peaky Blinders", 2013, "tt2442560", 60574, tvdb=270915,
           episode_imdb="tt2471500", episode_name="Episode 1", season=1, episode=1,
           episode_tvdb=4645420),
    # No IMDb id of its own in the library, so every host has to find it by the
    # series' id. By name, the API answers "Friends" with Matlock (2024).
    Sample("tv/Friends/Season 01/Friends.S01E01.480p.HDTV.x264-GROUP.mkv",
           "Friends", 1994, "tt0108778", 1668, tvdb=79168,
           episode_imdb="tt0583459", episode_name="The One Where Monica Gets a Roommate",
           season=1, episode=1, episode_tvdb=303821, episode_imdb_in_library=False),
    Sample("tv/The Simpsons/Season 01/The.Simpsons.S01E01.480p.HDTV.x264-GROUP.mkv",
           "The Simpsons", 1989, "tt0096697", 456, tvdb=71663,
           episode_imdb="tt0348034", episode_name="Simpsons Roasting on an Open Fire",
           season=1, episode=1, episode_tvdb=55452),
]

#: A name with a character outside ASCII in the folder, the file and the title.
ACCENTED = Sample("movies/Amélie (2001)/Amélie.2001.480p.BluRay.x264-GROUP.mkv",
                  "Amélie", 2001, "tt0211915", 194)
#: A title that exists nowhere, with a plausible release name and no ids.
UNKNOWN = Sample("movies/Qwxvbn Kfjtrl (2020)/Qwxvbn.Kfjtrl.2020.480p.WEB.x264-GROUP.mkv",
                 "Qwxvbn Kfjtrl", 2020, None, None)

SAMPLES = [FILM, EPISODE, *SHOWS, ACCENTED, UNKNOWN]
FILMS = [s for s in SAMPLES if not s.is_episode]
EPISODES = [s for s in SAMPLES if s.is_episode]

_MOVIE_NFO = """<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>%s</title>
  <year>%d</year>
%s</movie>
"""
# The default id is the scraper's own, as Kodi's TMDB and TVDB scrapers file it: the
# IMDb id is one id among several, and a host that reads only the default id gets a
# TMDB or TVDB number where it expects an IMDb id.
_MOVIE_IDS = """  <uniqueid type="tmdb" default="true">%d</uniqueid>
  <uniqueid type="imdb">%s</uniqueid>
"""
_SHOW_NFO = """<?xml version="1.0" encoding="UTF-8"?>
<tvshow>
  <title>%s</title>
  <year>%d</year>
  <uniqueid type="tvdb" default="true">%d</uniqueid>
  <uniqueid type="imdb">%s</uniqueid>
  <uniqueid type="tmdb">%d</uniqueid>
</tvshow>
"""
# Beside the video and named for it, which is where both servers look for an
# episode's own file.
_EPISODE_NFO = """<?xml version="1.0" encoding="UTF-8"?>
<episodedetails>
  <title>%s</title>
  <season>%d</season>
  <episode>%d</episode>
  <uniqueid type="tvdb" default="true">%d</uniqueid>
%s</episodedetails>
"""
_EPISODE_IMDB = """  <uniqueid type="imdb">%s</uniqueid>
"""


def nfo(sample: Sample) -> dict[str, str]:
    """The NFO files that describe a sample, by path under the media root."""
    if not sample.is_episode:
        ids = _MOVIE_IDS % (sample.tmdb, sample.imdb) if sample.known else ""
        text = _MOVIE_NFO % (sample.name, sample.year, ids)
        # movie.nfo is what a film in its own folder gets; Kodi reads the one named
        # for the video whatever the folder settings say.
        return {"movies/%s/movie.nfo" % sample.folder: text,
                sample.path[: -len(".mkv")] + ".nfo": text}
    own = sample.library_episode_imdb
    return {
        "tv/%s/tvshow.nfo" % sample.folder: _SHOW_NFO % (
            sample.name, sample.year, sample.tvdb, sample.imdb, sample.tmdb),
        sample.path[: -len(".mkv")] + ".nfo": _EPISODE_NFO % (
            sample.episode_name, sample.season, sample.episode, sample.episode_tvdb,
            _EPISODE_IMDB % own if own else ""),
    }


def videos(root: pathlib.Path) -> list[pathlib.Path]:
    return [root / sample.path for sample in SAMPLES]


def make(root: pathlib.Path) -> list[pathlib.Path]:
    for path in videos(root):
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(  # noqa: S603 - fixed arguments bar the output path
            ["ffmpeg", "-loglevel", "error", "-y",  # noqa: S607 - ffmpeg from PATH
             "-f", "lavfi", "-i", "color=c=black:s=%s:r=1" % SIZE,
             "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "1200",
             "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
             "-c:a", "aac", "-b:a", "8k", str(path)],
            check=True,
        )
    for sample in SAMPLES:
        for rel, text in nfo(sample).items():
            (root / rel).write_text(text, encoding="utf-8")
    # The servers run as their own users and write subtitles beside the videos.
    for path in [root, *root.rglob("*")]:
        path.chmod(0o777 if path.is_dir() else 0o666)
    return videos(root)


def line(sample: Sample, path: pathlib.Path) -> str:
    """One line for a shell loop: where the video is, and what to expect of it."""
    return "%s\t%s\t%s\t%s\t%d\t%s" % (path, sample.name, ",".join(sample.languages),
                                       "subtitles" if sample.known else "nothing",
                                       PER_LANGUAGE, ",".join(sample.many) or "-")


if __name__ == "__main__":
    for sample, made in zip(SAMPLES, make(pathlib.Path(sys.argv[1]).resolve())):
        print(line(sample, made))
