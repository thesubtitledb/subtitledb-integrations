#!/usr/bin/env python3
"""What the API answers for every sample, by each route a host takes to it.

    python3 baseline.py

Each host job prints this before driving its host, so a host that finds nothing can
be told apart from an index that has nothing, and the api job runs it on its own.
The hosts identify a file three ways: by the ids a library keeps (Jellyfin, Emby, a
Kodi library), by the series' id alone for an episode (all Sonarr gives Bazarr, and
all a TVDB-scraped library holds for some episodes), and by the name Kodi and VLC
read off a file. Every route must resolve to the sample's own title, by the rung
meant for it, or to nothing for the title the index does not have, and wherever the
index holds a subtitle for the sample's very release, the ranking must put one
first. The film and the episode are also asked for in the other languages the hosts
are, and every candidate must be in the language asked. Every ask reads up to
media.PER_LANGUAGE subtitles per language, as every host is set to, so where the
index holds more, the read has to go past the API's first page of 100 and stop there.
"""

from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "python"))

import media
from subtitledb import (
    TIER_IMDB,
    TIER_SERIES_IMDB,
    TIER_TITLE,
    TIER_TMDB,
    Client,
    Hint,
    Options,
    find,
)
from subtitledb.match import EXACT_RELEASE, similarity

#: The rungs that may answer for a film found by its ids: TMDB leads, and IMDb takes
#: over wherever the index has no TMDB id for the film.
FILM_IDS = (TIER_TMDB, TIER_IMDB)


def routes(sample: media.Sample) -> dict[str, tuple[Hint, tuple[str, ...]]]:
    """The hints the hosts derive from this sample, by route, with the rungs that
    may answer each."""
    if not sample.is_episode:
        return {
            "ids": (Hint(imdb_id=sample.imdb, tmdb_id=sample.tmdb, title=sample.name,
                         year=sample.year, release=sample.release), FILM_IDS),
            "name": (Hint(title=sample.name, year=sample.year, release=sample.release),
                     (TIER_TITLE,)),
        }
    numbers = {"title": sample.name, "episode_title": sample.episode_name,
               "season": sample.season, "episode": sample.episode, "release": sample.release}
    own = sample.library_episode_imdb
    return {
        "ids": (Hint(imdb_id=own, series_imdb_id=sample.imdb, **numbers),
                (TIER_IMDB,) if own else (TIER_SERIES_IMDB,)),
        "series id": (Hint(series_imdb_id=sample.imdb, **numbers), (TIER_SERIES_IMDB,)),
        "name": (Hint(**numbers), (TIER_TITLE,)),
    }


def problems(sample: media.Sample, result, tiers: tuple[str, ...]) -> list[str]:
    title = result.title or {}
    if not sample.known:
        if result.candidates or title:
            return ["resolved to %s %s (%s), and the index should have nothing" % (
                title.get("imdb"), title.get("name"), title.get("year"))]
        return []
    if not result.candidates:
        return ["nothing"]
    out = []
    if title.get("imdb") != sample.imdb:
        out.append("resolved to %s %s (%s), not %s" % (
            title.get("imdb"), title.get("name"), title.get("year"), sample.name))
    if result.tier not in tiers:
        out.append("answered via %s, not %s" % (result.tier, " or ".join(tiers)))
    ours = [c for c in result.candidates if similarity(
        str(c.subtitle.get("release_name") or ""), sample.release) >= EXACT_RELEASE]
    if ours and result.candidates[0] not in ours:
        out.append("a subtitle for this very release is listed, but %s came first" % (
            result.candidates[0].subtitle.get("release_name") or "one with no release name"))
    return out


def language_problems(code: str, result) -> list[str]:
    if not result.candidates:
        return ["nothing in %s" % code]
    others = [c for c in result.candidates if c.subtitle.get("language") != code]
    if others:
        return ["%d of %d candidates are not %s: %s" % (
            len(others), len(result.candidates), code,
            sorted({str(c.subtitle.get("language")) for c in others}))]
    return []


def count_problem(offered: int, many: bool) -> str | None:
    """What is wrong with offering ``offered`` subtitles in one language when the
    setting is media.PER_LANGUAGE, or None. ``many`` is whether the index holds more."""
    if offered > media.PER_LANGUAGE:
        return "offered %d, more than the %d per language it is set to" % (
            offered, media.PER_LANGUAGE)
    if many and offered <= 100:
        return "offered %d of more than %d, so it stopped at the API's first page" % (
            offered, media.PER_LANGUAGE)
    return None


def row_ids(client: Client, sample: media.Sample, code: str) -> set[int]:
    """The id of every row the index holds for the sample's own film or episode in one
    language, by the series' id for an episode. Row ids belong to one title and one
    episode, so whatever a host offers must be among them, however it got there."""
    drill = {"season": sample.season, "episode": sample.episode} if sample.is_episode else {}
    ids: set[int] = set()
    offset = 0
    while True:
        page = client.by_imdb(sample.imdb, lang=code, limit=100, offset=offset,
                              **drill).get("subtitles") or {}
        items = page.get("items") or []
        ids.update(int(row["id"]) for row in items)
        offset += len(items)
        if not items or offset >= int(page.get("total") or 0):
            return ids


def main() -> int:
    client = Client(client="ci-baseline")
    failed, asks = [], 0
    for sample in media.SAMPLES:
        print(sample.release)
        hints = routes(sample)
        for route, (hint, tiers) in hints.items():
            asks += 1
            result = find(client, hint, Options(languages=["en"], limit=media.PER_LANGUAGE))
            title = result.title or {}
            print("  by %s: %d English candidates via %s, %s (%s) %s" % (
                route, len(result.candidates), result.tier,
                title.get("name"), title.get("year"), title.get("imdb")))
            for candidate in result.candidates[:3]:
                row = candidate.subtitle
                print("    %s | %s | %s" % (
                    row.get("id"), row.get("release_name"), candidate.reason))
            # A count is only worth checking for the right title.
            found = problems(sample, result, tiers) or [
                count_problem(len(result.candidates), "en" in sample.many)]
            for problem in filter(None, found):
                print("    FAIL %s" % problem)
                failed.append("%s by %s: %s" % (sample.release, route, problem))
        for code in sample.languages[1:]:
            asks += 1
            result = find(client, hints["ids"][0],
                          Options(languages=[code], limit=media.PER_LANGUAGE))
            print("  by ids in %s: %d candidates" % (code, len(result.candidates)))
            found = language_problems(code, result)
            found.append(count_problem(len(result.candidates), code in sample.many))
            for problem in filter(None, found):
                print("    FAIL %s" % problem)
                failed.append("%s in %s: %s" % (sample.release, code, problem))
        for code in sample.languages if sample.known else ():
            # The hosts are held to `many`, so it is held to the index here.
            asks += 1
            held = len(row_ids(client, sample, code))
            print("  the index holds %d in %s" % (held, code))
            if (held > media.PER_LANGUAGE) != (code in sample.many):
                problem = "media.py %s %s in its many, and the index holds %d" % (
                    "has" if code in sample.many else "does not have", code, held)
                print("    FAIL %s" % problem)
                failed.append("%s: %s" % (sample.release, problem))
    # Not a failure of any plugin, but every host would meet it, so it is said here.
    if failed:
        print("the API failed %d of %d asks:" % (len(failed), asks))
        for line in failed:
            print("  " + line)
    else:
        print("the API answered every ask, %d of them, as it should" % asks)
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
