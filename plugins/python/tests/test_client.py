"""The client, against a fake opener. No network."""

from __future__ import annotations

import gzip
import io
import json
import urllib.error

import pytest
from subtitledb.client import Client, SubtitleDbError, _imdb, _ours


class FakeResponse(io.BytesIO):
    def __init__(self, payload: bytes, headers: dict | None = None, url: str = "") -> None:
        super().__init__(payload)
        self.headers = headers or {}
        self._url = url

    def geturl(self) -> str:
        return self._url

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
        return False


def client_with(responses, calls=None):
    """A Client whose _open pops from `responses` and records the URL it was given."""
    c = Client(api_base="https://api.example.test", retries=1)
    c.timeout = 0.1
    queue = list(responses)

    def fake_open(url, accept):
        if calls is not None:
            calls.append(url)
        item = queue.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    c._open = fake_open  # type: ignore[method-assign]
    c.sleep_calls = []  # type: ignore[attr-defined]
    return c


def json_response(obj, headers=None, url=""):
    return FakeResponse(json.dumps(obj).encode("utf-8"), headers, url)


def test_by_title_sends_the_query_and_the_client_name():
    calls: list[str] = []
    c = client_with([json_response({"title": {}})], calls)
    c.by_title("anatomy of a fall", limit=5)
    assert calls[0].startswith("https://api.example.test/v1/by-title?")
    assert "q=anatomy+of+a+fall" in calls[0]
    assert "limit=5" in calls[0]
    assert "client=subtitledb-plugin" in calls[0]


def test_by_tmdb_builds_the_verb_path():
    calls: list[str] = []
    c = client_with([json_response({"title": {}})], calls)
    c.by_tmdb(603)
    assert calls[0].split("?")[0].endswith("/v1/by-tmdb/603")


def test_the_imdb_prefix_is_optional_on_the_way_in():
    calls: list[str] = []
    c = client_with([json_response({"title": {}}), json_response({"title": {}})], calls)
    c.by_imdb("tt17009710")
    c.by_imdb(17009710)
    assert calls[0].split("?")[0] == calls[1].split("?")[0]
    assert calls[0].split("?")[0].endswith("/v1/by-imdb/17009710")


def test_season_and_episode_drill_into_the_path_not_the_query():
    calls: list[str] = []
    c = client_with([json_response({"title": {}}), json_response({"title": {}})], calls)
    c.by_imdb("tt1", season=5, episode=14)
    c.by_title("Breaking Bad", season=5, episode=14)
    assert calls[0].split("?")[0].endswith("/v1/by-imdb/1/season/5/episode/14")
    assert calls[1].split("?")[0].endswith("/v1/by-title/season/5/episode/14")
    assert "q=Breaking+Bad" in calls[1]


def test_empty_parameters_are_left_off_rather_than_sent_empty():
    # `lang=` is not "no language filter", it is a filter for the empty language.
    calls: list[str] = []
    c = client_with([json_response({"title": {}})], calls)
    c.by_imdb("tt1", lang=None, format="", limit=10)
    assert "lang=" not in calls[0]
    assert "format=" not in calls[0]
    assert "limit=10" in calls[0]


def test_a_gzipped_body_is_decompressed():
    body = gzip.compress(json.dumps({"total": 1}).encode("utf-8"))
    c = client_with([FakeResponse(body, {"Content-Encoding": "gzip"})])
    assert c._get("/v1/by-imdb/1")["total"] == 1


def test_a_404_is_a_fallthrough_and_is_not_retried():
    err = urllib.error.HTTPError(
        "u", 404, "Not Found", {}, io.BytesIO(b'{"message":"no such title"}')
    )
    c = client_with([err])
    with pytest.raises(SubtitleDbError) as caught:
        c.by_imdb("tt1")
    assert caught.value.status == 404
    assert caught.value.fallthrough
    assert "no such title" in str(caught.value)


def test_a_500_is_retried_and_then_raised():
    calls: list[str] = []
    errs = [
        urllib.error.HTTPError("u", 500, "Server Error", {"Retry-After": "0"}, io.BytesIO(b"{}"))
        for _ in range(2)
    ]
    c = client_with(errs, calls)
    with pytest.raises(SubtitleDbError) as caught:
        c.by_title("x")
    assert len(calls) == 2, "a 5xx was not retried"
    assert not caught.value.fallthrough


def test_a_500_that_recovers_returns_the_second_answer():
    err = urllib.error.HTTPError("u", 503, "nope", {"Retry-After": "0"}, io.BytesIO(b"{}"))
    c = client_with([err, json_response({"total": 7})])
    assert c.by_title("x")["total"] == 7


def test_a_download_from_somewhere_else_is_refused():
    # download_url comes back inside a JSON body. A body is not a reason to fetch
    # whatever host it names.
    c = client_with([])
    with pytest.raises(SubtitleDbError, match="refusing"):
        c.download("https://example.invalid/evil.srt")


def test_a_download_that_redirects_off_our_hosts_is_refused():
    res = FakeResponse(b"1\n", {}, "https://example.invalid/evil.srt")
    c = client_with([res])
    with pytest.raises(SubtitleDbError, match="redirected"):
        c.download("https://api.example.test/get/1")


def test_a_download_that_redirects_to_the_files_host_is_allowed():
    res = FakeResponse(b"1\n00:00:01,000 --> 00:00:02,000\nhi\n", {}, "https://files.example.test/x")
    c = client_with([res])
    assert c.download("https://api.example.test/get/1").startswith(b"1\n")


@pytest.mark.parametrize(
    ("value", "want"),
    [("tt17009710", "17009710"), ("TT17009710", "17009710"), (17009710, "17009710")],
)
def test_imdb_normalisation(value, want):
    assert _imdb(value) == want


@pytest.mark.parametrize(
    ("url", "ok"),
    [
        ("https://api.example.test/get/1", True),
        ("https://files.example.test/x", True),
        ("https://example.test/x", True),
        ("https://api.example.test.evil.com/x", False),
        ("https://evil.com/x", False),
        ("not a url", False),
    ],
)
def test_which_hosts_count_as_ours(url, ok):
    assert _ours(url, "https://api.example.test") is ok
