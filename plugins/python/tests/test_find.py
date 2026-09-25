"""The ladder. Which rung answered, how many requests it cost, and what it asked for."""

from __future__ import annotations

import pytest
from subtitledb import TIER_IMDB, TIER_NONE, TIER_SERIES_IMDB, TIER_TITLE, TIER_TMDB
from subtitledb.client import SubtitleDbError
from subtitledb.find import find, per_language
from subtitledb.match import Hint, Options


def sub(sid, **kw):
    row = {
        "id": sid,
        "language": "en",
        "format": "srt",
        "cues": 900,
        "release_name": "",
        "hearing_impaired": False,
        "season": None,
        "episode": None,
        "download_url": "https://api.example.test/get/%d" % sid,
    }
    row.update(kw)
    return row


def movie(subs, title=None):
    """The movie/whole-series bundle shape: a top-level subtitles page."""
    return {"title": title or {"name": "X"}, "subtitles": {"items": subs, "total": len(subs)}}


def episode(subs, title=None):
    """A drilled-episode bundle: the same shape as any other, narrowed to one episode."""
    return {"title": title or {}, "subtitles": {"items": subs, "total": len(subs)}}


class FakeClient:
    """Records every call and answers from a script keyed by verb name."""

    def __init__(self, **answers):
        self.answers = answers
        self.calls: list[tuple] = []

    def _answer(self, name, *args, **kw):
        self.calls.append((name, args, kw))
        value = self.answers.get(name)
        if isinstance(value, Exception):
            raise value
        if callable(value):
            return value(*args, **kw)
        if value is None:
            raise SubtitleDbError("no such thing", 404)
        return value

    def by_tmdb(self, tmdb, **kw):
        return self._answer("by_tmdb", tmdb, **kw)

    def by_imdb(self, imdb, **kw):
        return self._answer("by_imdb", imdb, **kw)

    def by_title(self, q, **kw):
        return self._answer("by_title", q, **kw)


def test_an_imdb_id_answers_in_one_request():
    c = FakeClient(by_imdb=movie([sub(1)], {"name": "Anatomy of a Fall"}))
    out = find(c, Hint(imdb_id="tt17009710"), Options(languages=["en"], formats=["srt"]))
    assert out.tier == TIER_IMDB
    assert [x.id for x in out.candidates] == [1]
    assert len(c.calls) == 1


def test_one_request_per_language_because_lang_takes_one_code():
    # A comma separated list passes the query parser, matches nothing and is dropped,
    # so the response comes back unfiltered and looks like the filter worked.
    pages = {
        "en": movie([sub(1, language="en")]),
        "fr": movie([sub(2, language="fr")]),
    }
    c = FakeClient(by_imdb=lambda imdb, **kw: pages[kw["lang"]])
    out = find(c, Hint(imdb_id="tt1"), Options(languages=["fr", "en"], formats=["srt"]))
    assert [kw["lang"] for _, _, kw in c.calls] == ["fr", "en"]
    assert [x.id for x in out.candidates] == [2, 1], "the caller's language order was lost"


def test_a_duplicate_id_across_two_language_pages_is_returned_once():
    c = FakeClient(by_imdb=lambda imdb, **kw: movie([sub(1)]))
    out = find(c, Hint(imdb_id="tt1"), Options(languages=["en", "fr"], formats=["srt"]))
    assert [x.id for x in out.candidates] == [1]


def test_no_language_preference_asks_once_unfiltered():
    c = FakeClient(by_imdb=movie([sub(1)]))
    find(c, Hint(imdb_id="tt1"), Options(formats=["srt"]))
    assert "lang" not in c.calls[0][2]


def test_tmdb_leads_the_ladder_when_it_is_present():
    # tmdb is the headline key: an explicit tmdb id is tried before an explicit imdb id.
    c = FakeClient(by_tmdb=movie([sub(1)]), by_imdb=movie([sub(2)]))
    out = find(c, Hint(tmdb_id=603, imdb_id="tt1"), Options(formats=["srt"]))
    assert out.tier == TIER_TMDB
    assert [name for name, _, _ in c.calls] == ["by_tmdb"], "imdb was hit despite a tmdb win"


def test_a_tmdb_404_falls_through_to_imdb():
    # The imdb->tmdb map is incomplete, so this 404 is ordinary, not exceptional.
    c = FakeClient(by_tmdb=SubtitleDbError("no map", 404), by_imdb=movie([sub(1)]))
    out = find(c, Hint(tmdb_id=496243, imdb_id="tt1"), Options(formats=["srt"]))
    assert out.tier == TIER_IMDB


def test_an_imdb_404_falls_through_to_the_title_rung():
    c = FakeClient(by_imdb=SubtitleDbError("unknown", 404), by_title=movie([sub(1)]))
    out = find(c, Hint(imdb_id="tt1", title="Parasite"), Options(formats=["srt"]))
    assert out.tier == TIER_TITLE


def test_a_server_error_is_not_swallowed_as_a_miss():
    # "the API is broken" and "we do not have this film" must not look the same.
    c = FakeClient(by_imdb=SubtitleDbError("upstream", 502))
    with pytest.raises(SubtitleDbError):
        find(c, Hint(imdb_id="tt1"), Options(formats=["srt"]))


def test_an_episode_drills_by_title_on_the_season_and_episode_numbers():
    # No imdb id, so the title rung resolves the series server-side and drills straight
    # to the episode; the returned page is the episode block's own subtitles.
    c = FakeClient(by_title=episode([sub(1, season=5, episode=14)]))
    out = find(
        c,
        Hint(title="Breaking Bad", episode_title="Ozymandias", season=5, episode=14),
        Options(formats=["srt"]),
    )
    assert out.tier == TIER_TITLE
    assert [x.id for x in out.candidates] == [1]
    _, args, kw = c.calls[0]
    assert args[0] == "Breaking Bad"
    assert kw["season"] == 5
    assert kw["episode"] == 14


def test_an_episode_with_no_id_of_its_own_goes_by_the_series_id_before_the_name():
    # Sonarr hands Bazarr the series' id and never the episode's. By name, the API
    # answers "Friends" with Matlock (2024); by the series' id it cannot.
    c = FakeClient(by_imdb=episode([sub(1)]), by_title=episode([sub(2)]))
    out = find(
        c,
        Hint(series_imdb_id="tt0108778", title="Friends", season=1, episode=1),
        Options(formats=["srt"]),
    )
    assert out.tier == TIER_SERIES_IMDB
    assert [x.id for x in out.candidates] == [1]
    assert c.calls == [("by_imdb", ("tt0108778",), {"season": 1, "episode": 1, "limit": 100})]


def test_the_episodes_own_id_comes_before_the_series_id():
    c = FakeClient(by_imdb=episode([sub(1)]))
    out = find(
        c,
        Hint(imdb_id="tt0583459", series_imdb_id="tt0108778", season=1, episode=1),
        Options(formats=["srt"]),
    )
    assert out.tier == TIER_IMDB
    assert [args[0] for _, args, _ in c.calls] == ["tt0583459"]


def test_an_episode_the_series_id_cannot_drill_to_falls_through_to_the_name():
    # A season or episode the index has no row for is a 404 like any other miss.
    c = FakeClient(by_imdb=SubtitleDbError("no such episode", 404), by_title=episode([sub(2)]))
    out = find(
        c,
        Hint(series_imdb_id="tt0108778", title="Friends", season=1, episode=99),
        Options(formats=["srt"]),
    )
    assert out.tier == TIER_TITLE
    assert [name for name, _, _ in c.calls] == ["by_imdb", "by_title"]


def test_a_series_id_given_as_the_episodes_is_asked_for_once():
    c = FakeClient(by_imdb=SubtitleDbError("no such episode", 404), by_title=episode([sub(2)]))
    find(
        c,
        Hint(imdb_id="tt0108778", series_imdb_id="tt0108778", title="Friends",
             season=1, episode=99),
        Options(formats=["srt"]),
    )
    assert [name for name, _, _ in c.calls] == ["by_imdb", "by_title"]


def test_a_wrong_episode_row_is_filtered_out():
    c = FakeClient(
        by_imdb=movie([sub(1, season=5, episode=14), sub(2, season=5, episode=15)]),
    )
    out = find(c, Hint(imdb_id="tt1", season=5, episode=14), Options(formats=["srt"]))
    assert [x.id for x in out.candidates] == [1]
    assert out.wrong_episode == 1


def test_a_resolved_title_with_no_usable_rows_still_stops_the_ladder():
    # The title resolved; it simply has nothing in the asked-for format. That is not a
    # fallthrough, so the title rung is never reached.
    c = FakeClient(by_imdb=movie([sub(1, format="rar")]), by_title=movie([sub(2)]))
    out = find(c, Hint(imdb_id="tt1", title="X"), Options(formats=["srt"]))
    assert out.tier == TIER_IMDB
    assert out.candidates == []
    assert [name for name, _, _ in c.calls] == ["by_imdb"]


def test_nothing_to_go_on_spends_no_requests():
    c = FakeClient()
    out = find(c, Hint(), Options(formats=["srt"]))
    assert out.tier == TIER_NONE
    assert c.calls == []


def paged(total, language="en", honour_offset=True, first=1):
    """An answer that pages the way the API does: at most 100 rows, from ``offset``."""

    def answer(*_, **kw):
        start = kw.get("offset", 0) if honour_offset else 0
        stop = min(start + min(kw["limit"], 100), total)
        rows = [sub(first + i, language=language) for i in range(start, stop)]
        return {"title": {"name": "X"}, "subtitles": {"items": rows, "total": total}}

    return answer


def asked(c):
    return [(kw.get("offset"), kw["limit"]) for _, _, kw in c.calls]


def test_a_long_list_is_read_past_the_first_hundred():
    # The API sends rows in the order they were added, so the one in sync with the
    # file can sit on page three. The Matrix has 147 English rows.
    c = FakeClient(by_imdb=paged(250))
    out = find(c, Hint(imdb_id="tt1"), Options(languages=["en"], formats=["srt"], limit=500))
    assert asked(c) == [(None, 100), (100, 100), (200, 100)]
    assert len(out.candidates) == 250


def test_the_limit_ends_the_read():
    c = FakeClient(by_imdb=paged(1000))
    out = find(c, Hint(imdb_id="tt1"), Options(languages=["en"], formats=["srt"], limit=150))
    assert asked(c) == [(None, 100), (100, 50)]
    assert len(out.candidates) == 150


def test_a_small_limit_still_ranks_a_whole_page():
    c = FakeClient(by_imdb=paged(1000))
    out = find(c, Hint(imdb_id="tt1"), Options(languages=["en"], formats=["srt"], limit=5))
    assert asked(c) == [(None, 100)]
    assert len(out.candidates) == 5


def test_a_page_that_brings_nothing_new_ends_the_read():
    # What a server that ignored offset would send, and what one past its offset cap
    # does send. Reading on would ask the same page again until the limit.
    c = FakeClient(by_imdb=paged(1000, honour_offset=False))
    out = find(c, Hint(imdb_id="tt1"), Options(languages=["en"], formats=["srt"], limit=500))
    assert len(c.calls) == 2
    assert len(out.candidates) == 100


def test_an_empty_page_ends_the_read_whatever_the_total_says():
    def answer(imdb, **kw):
        rows = [] if kw.get("offset") else [sub(1)]
        return {"title": {}, "subtitles": {"items": rows, "total": 300}}

    c = FakeClient(by_imdb=answer)
    out = find(c, Hint(imdb_id="tt1"), Options(languages=["en"], formats=["srt"], limit=500))
    assert len(c.calls) == 2
    assert [x.id for x in out.candidates] == [1]


def test_the_limit_holds_per_language():
    # One cap over the merged list let a hundred English rows push every French one
    # out, since a first language outscores a second.
    pages = {"en": paged(100, "en"), "fr": paged(3, "fr", first=1001)}
    c = FakeClient(by_imdb=lambda imdb, **kw: pages[kw["lang"]](**kw))
    out = find(c, Hint(imdb_id="tt1"), Options(languages=["en", "fr"], formats=["srt"]))
    assert sum(1 for x in out.candidates if x.subtitle["language"] == "fr") == 3


def test_a_setting_is_read_as_rows_per_language():
    assert per_language(None) == 500
    assert per_language("") == 500
    assert per_language("junk") == 500
    assert per_language("300") == 300
    assert per_language(" 700 ") == 700
    assert per_language(0) == 100
    assert per_language(50) == 100
    assert per_language(99999) == 2000
