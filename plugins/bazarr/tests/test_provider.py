"""The Bazarr provider, against the stubs in conftest.

What is worth testing here is the seam: what Bazarr hands in, what the shared ladder
gets asked, and what goes back as a match set. The ranking itself is already covered
by the shared cases in plugins/python/tests.
"""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import subtitledb_provider as provider
from conftest import GUESSES, Episode, Language, Movie
from subtitledb.client import SubtitleDbError
from subtitledb.match import Hint

#: The title each lookup resolved to, the way the API reports it.
FILM = {"imdb": "tt17009710", "tmdb_id": 915935, "media_type": "movie",
        "name": "Anatomy of a Fall", "year": 2023}
SHOW = {"imdb": "tt0903747", "tmdb_id": 1396, "media_type": "tv",
        "name": "Breaking Bad", "year": 2008}

#: The match names Bazarr 1.6.1 scores an episode on. Its manual search throws away
#: every other name before it checks for series, season and episode.
EPISODE_SCORES = {"hash", "series", "year", "season", "episode", "source", "release_group",
                  "audio_codec", "resolution", "video_codec", "hearing_impaired",
                  "streaming_service"}


def row(sid=1, **kw):
    """One subtitle as the API lists it. Which title it belongs to is not on the row."""
    out = {
        "id": sid,
        "language": "en",
        "format": "srt",
        "cues": 900,
        "release_name": "",
        "hearing_impaired": False,
        "download_url": "https://api.thesubtitledb.org/get/1",
    }
    out.update(kw)
    return out


def bundle(subs, title=None):
    """What a lookup verb returns: the title it resolved to and a subtitles page."""
    return {"title": FILM if title is None else title,
            "subtitles": {"items": subs, "total": len(subs)}}


def breaking_bad(**kw):
    """Ozymandias as Sonarr hands it to Bazarr."""
    fields = {"name": "/tv/Breaking.Bad.S05E14.mkv", "series": "Breaking Bad",
              "title": "Ozymandias", "season": 5, "episode": 14, "year": 2008,
              "series_imdb_id": "tt0903747"}
    fields.update(kw)
    return Episode(**fields)


class FakeClient:
    def __init__(self, page=None, error=None):
        self.page = page if page is not None else bundle([])
        self.error = error
        self.calls = []
        self.downloaded = []

    def by_imdb(self, imdb, **kw):
        self.calls.append(("by_imdb", imdb, kw))
        if self.error:
            raise self.error
        return self.page

    def by_tmdb(self, tmdb, **kw):
        self.calls.append(("by_tmdb", tmdb, kw))
        raise SubtitleDbError("no map", 404)

    def by_title(self, q, **kw):
        self.calls.append(("by_title", q, kw))
        if self.error:
            raise self.error
        return self.page

    def download(self, url):
        self.downloaded.append(url)
        return b"1\n00:00:01,000 --> 00:00:02,000\nhello\n"


def make(page=None, error=None):
    p = provider.SubtitleDbProvider()
    p.client = FakeClient(page, error)
    return p


# -- what Bazarr knows becomes what we ask ---------------------------------


def test_a_film_hint_carries_the_id_the_year_and_the_release():
    video = Movie(
        name="/media/Anatomy.of.a.Fall.2023.1080p.BluRay.x264-KOVAL.mkv",
        title="Anatomy of a Fall",
        year=2023,
        imdb_id="tt17009710",
    )
    hint = provider.hint_for(video)
    assert hint.imdb_id == "tt17009710"
    assert hint.title == "Anatomy of a Fall"
    assert hint.year == 2023
    assert hint.release == "Anatomy.of.a.Fall.2023.1080p.BluRay.x264-KOVAL"


def test_an_episode_hint_carries_the_series_the_numbers_and_the_episode_title():
    video = Episode(
        name="/tv/Breaking.Bad.S05E14.1080p.BluRay.x264-DEMAND.mkv",
        series="Breaking Bad",
        title="Ozymandias",
        season=5,
        episode=14,
        year=2013,
        series_imdb_id="tt0903747",
    )
    hint = provider.hint_for(video)
    assert (hint.title, hint.episode_title, hint.season, hint.episode) == (
        "Breaking Bad", "Ozymandias", 5, 14,
    )
    assert hint.series_imdb_id == "tt0903747"
    assert hint.imdb_id is None, "the series id is not the episode's id"


@pytest.mark.parametrize(
    ("stored", "want"),
    [("tt0133093", "tt0133093"), ("133093", "tt0133093"), (133093, "tt0133093"),
     ("", None), (None, None), (0, None), ("0", None)],
)
def test_however_bazarr_spelled_the_imdb_id(stored, want):
    assert provider.clean_imdb(stored) == want


# -- languages -------------------------------------------------------------


def test_brazilian_portuguese_is_asked_for_as_pb_not_pt():
    # The corpus files it under pb. Asking for pt returns European Portuguese, and
    # the user who configured Brazilian Portuguese gets subtitles they cannot read.
    assert provider.api_code(Language("por", "BR")) == "pb"
    assert provider.api_code(Language("por")) == "pt"


def test_pb_comes_back_as_brazilian_portuguese_rather_than_portuguese():
    assert provider.from_api_code("pb") == Language("por", "BR")


def test_a_code_babelfish_has_never_heard_of_is_skipped_not_raised():
    assert provider.from_api_code("qq") is None


def test_the_provider_offers_the_whole_table():
    langs = provider.supported_languages()
    assert Language("eng") in langs
    assert Language("por", "BR") in langs
    assert len(langs) > 60


# -- the seam --------------------------------------------------------------


def test_a_listed_subtitle_carries_the_download_link_and_the_page_link():
    p = make(bundle([row(481207)]))
    subs = p.list_subtitles(
        Movie(name="/m/Anatomy.mkv", title="Anatomy of a Fall", year=2023, imdb_id="tt17009710"),
        [Language("eng")],
    )
    assert len(subs) == 1
    assert subs[0].id == "subtitledb-481207"
    assert subs[0].download_link == "https://api.thesubtitledb.org/get/1"
    assert "481207" in subs[0].page_link


def test_a_format_bazarr_cannot_use_never_reaches_it():
    p = make(bundle([row(1, format="rar")]))
    assert p.list_subtitles(Movie(imdb_id="tt1"), [Language("eng")]) == []


def test_an_api_failure_returns_nothing_rather_than_taking_the_search_down():
    # Bazarr runs providers in one pass. Ours being unreachable is not a reason for
    # the others' results to be lost.
    p = make(error=SubtitleDbError("upstream", 502))
    assert p.list_subtitles(Movie(imdb_id="tt1"), [Language("eng")]) == []


def test_download_puts_the_bytes_on_the_subtitle():
    p = make(bundle([row(1)]))
    sub = p.list_subtitles(Movie(imdb_id="tt17009710"), [Language("eng")])[0]
    p.download_subtitle(sub)
    assert sub.content.startswith(b"1\n")
    assert p.client.downloaded == ["https://api.thesubtitledb.org/get/1"]


# -- what we claim to have matched ------------------------------------------


def matches_for(video, page):
    return make(page).list_subtitles(video, [Language("eng")])[0].get_matches(video)


def test_a_film_found_by_its_id_claims_the_title_and_the_year():
    video = Movie(name="/m/x.mkv", title="Anatomy of a Fall", year=2023, imdb_id="tt17009710")
    assert {"imdb_id", "title", "year"} <= matches_for(video, bundle([row()]))


def test_a_film_with_another_id_claims_nothing_about_the_title():
    video = Movie(name="/m/x.mkv", title="Anatomy of a Fall", year=2023, imdb_id="tt0000001")
    assert not {"imdb_id", "title", "year"} & matches_for(video, bundle([row()]))


def test_with_no_id_to_compare_the_name_and_year_decide():
    same = Movie(name="/m/x.mkv", title="Anatomy Of A Fall!", year=2023)
    assert {"title", "year"} <= matches_for(same, bundle([row()]))

    other = Movie(name="/m/x.mkv", title="Anatomy of a Murder", year=1959)
    assert not {"title", "year"} & matches_for(other, bundle([row()]))


def test_an_episode_claims_what_bazarr_keeps_it_by():
    # Found by the live run: a row carries no series, season or episode, so none was
    # claimed, and Bazarr's manual search threw away all 97 subtitles for the episode.
    matches = matches_for(breaking_bad(), bundle([row()], SHOW)) & EPISODE_SCORES
    assert {"series", "season", "episode", "year"} <= matches


def test_an_episode_whose_series_id_sonarr_does_not_have_goes_by_the_name():
    matches = matches_for(breaking_bad(series_imdb_id=None), bundle([row()], SHOW))
    assert {"series", "season", "episode", "year"} <= matches


def test_another_series_is_not_claimed_even_under_the_same_name():
    matches = matches_for(breaking_bad(series_imdb_id="tt9999999"), bundle([row()], SHOW))
    assert "series" not in matches


def test_an_episode_found_by_its_own_id_claims_that_id():
    video = breaking_bad(imdb_id="tt2301451")
    assert "imdb_id" in matches_for(video, bundle([row()], SHOW))


def test_the_release_name_is_read_by_bazarrs_own_parser():
    stem = "Anatomy.of.a.Fall.2023.1080p.BluRay.x264-KOVAL"
    video = Movie(name="/m/%s.mkv" % stem, title="Anatomy of a Fall", year=2023)
    assert "source" in matches_for(video, bundle([row(release_name=stem)]))
    assert GUESSES[-1] == {"release": stem, "type": "movie"}

    matches_for(breaking_bad(), bundle([row(release_name="Breaking.Bad.S05E14")], SHOW))
    assert GUESSES[-1]["type"] == "episode"


def test_the_hint_is_the_shape_the_shared_ladder_takes():
    # If these ever diverge, every plugin that shares the ladder breaks at once.
    hint = provider.hint_for(Movie(name="/m/x.mkv", title="x", year=2000, imdb_id="tt1"))
    assert isinstance(hint, Hint)


def test_an_episode_goes_by_the_series_id_sonarr_gave_and_is_kept():
    # Bazarr's refiner fills series_imdb_id from Sonarr and never the episode's own
    # id, so without the series rung every episode went by its name, and the API
    # answers "Friends" with another show. The live run caught it.
    video = breaking_bad()
    p = make(bundle([row()], SHOW))
    subs = p.list_subtitles(video, [Language("eng")])
    name, imdb, kw = p.client.calls[0]
    assert (name, imdb, kw["season"], kw["episode"]) == ("by_imdb", "tt0903747", 5, 14)
    # What Bazarr keeps an episode's subtitle by.
    assert {"series", "season", "episode"} <= subs[0].get_matches(video)


def test_a_second_language_is_not_starved_by_the_first():
    # Bazarr scores and picks per language. Asked for in one lookup, a profile of
    # English and Spanish got the top hundred rows of one ranked list, all English,
    # and Bazarr had nothing to pick for Spanish. The live run caught it.
    class PerLanguage(FakeClient):
        def by_imdb(self, imdb, **kw):
            self.calls.append(("by_imdb", imdb, kw))
            return self.page[kw.get("lang")]

    p = provider.SubtitleDbProvider()
    p.client = PerLanguage({
        "en": bundle([row(n) for n in range(1, 151)]),
        "es": bundle([row(n, language="es") for n in range(1001, 1004)]),
    })
    subs = p.list_subtitles(
        Movie(name="/m/Anatomy.mkv", title="Anatomy of a Fall", year=2023, imdb_id="tt17009710"),
        [Language("eng"), Language("spa")],
    )
    assert sum(s.language == Language("spa") for s in subs) == 3
    assert sum(s.language == Language("eng") for s in subs) == 150
    assert [call[2]["lang"] for call in p.client.calls] == ["en", "es"]


def test_rows_per_language_can_be_set(monkeypatch):
    asked, real = [], provider.find

    def find(client, hint, opts):
        asked.append(opts.limit)
        return real(client, hint, opts)

    monkeypatch.setattr(provider, "find", find)
    monkeypatch.delenv("SUBTITLEDB_PER_LANGUAGE", raising=False)
    film = Movie(name="/m/Anatomy.mkv", title="Anatomy of a Fall", year=2023, imdb_id="tt17009710")
    for given, env, want in ((None, None, 500), (None, "200", 200), ("1000", "200", 1000),
                             (None, "lots", 500)):
        if env is None:
            monkeypatch.delenv("SUBTITLEDB_PER_LANGUAGE", raising=False)
        else:
            monkeypatch.setenv("SUBTITLEDB_PER_LANGUAGE", env)
        p = provider.SubtitleDbProvider(per_language=given)
        p.client = FakeClient(bundle([row(1)]))
        p.list_subtitles(film, [Language("eng")])
        assert asked.pop() == want
