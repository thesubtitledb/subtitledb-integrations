"""The shared cases, run against the Python rules.

plugins/shared/match-cases.json is the same file the TypeScript, C# and Lua suites
read. A rule changed in one language and not the others fails here.
"""

from __future__ import annotations

import json
import pathlib

import pytest
from subtitledb import languages
from subtitledb.match import (
    Hint,
    Options,
    rank,
    similarity,
)

CASES = json.loads(
    (pathlib.Path(__file__).resolve().parents[2] / "shared" / "match-cases.json").read_text(
        encoding="utf-8"
    )
)


def ident(case: dict, *keys: str) -> str:
    return case.get("why") or " ".join(str(case.get(k)) for k in keys)


@pytest.mark.parametrize("case", CASES["similarity"], ids=lambda c: ident(c, "a", "b"))
def test_similarity(case: dict) -> None:
    got = similarity(case["a"], case["b"])
    if "min" in case:
        assert got >= case["min"] - 1e-9, got
    if "max" in case:
        assert got <= case["max"] + 1e-9, got


@pytest.mark.parametrize("case", CASES["languages"], ids=lambda c: c["input"] or "(empty)")
def test_language_resolution(case: dict) -> None:
    code = languages.to_code(case["input"])
    assert code == case["code"]
    assert languages.language_name(code) == case["name"]


@pytest.mark.parametrize("case", CASES["subtitle_ranking"], ids=lambda c: c["why"])
def test_subtitle_ranking(case: dict) -> None:
    opts_in = case["options"]
    hint = Hint(
        release=opts_in.get("release"),
        season=opts_in.get("season"),
        episode=opts_in.get("episode"),
    )
    opts = Options(
        languages=opts_in.get("languages") or [],
        formats=opts_in.get("formats") or [],
        hearing_impaired=opts_in.get("hearing_impaired"),
    )
    ranked = rank(case["subtitles"], hint, opts)
    assert [c.id for c in ranked.candidates] == case["expect_order"]
    if "expect_unrenderable" in case:
        assert ranked.unrenderable == case["expect_unrenderable"]
