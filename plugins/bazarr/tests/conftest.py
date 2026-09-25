"""Stand-ins for the Bazarr modules the provider imports.

Bazarr is not installable as a package: it is an application with a vendored
``libs/`` tree, so there is nothing to depend on in a test. These are the classes
and functions the provider actually touches, with the behaviour it actually relies
on, which is what lets the provider itself be tested rather than only read.

The Language stub follows babelfish where the provider cares: alpha3 storage,
alpha2 access, an optional country, and value equality so a set of them dedupes.
"""

from __future__ import annotations

import sys
import types
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "python"))

from subtitledb.languages import ALPHA3

_ALPHA2 = {}
for _three, _two in ALPHA3.items():
    _ALPHA2.setdefault(_two, _three)


class Country:
    def __init__(self, alpha2: str) -> None:
        self.alpha2 = alpha2.upper()

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Country) and other.alpha2 == self.alpha2

    def __hash__(self) -> int:
        return hash(self.alpha2)

    def __repr__(self) -> str:
        return self.alpha2


class Language:
    def __init__(self, alpha3: str, country: str | Country | None = None) -> None:
        if len(alpha3) == 2:
            alpha3 = _ALPHA2.get(alpha3, alpha3)
        if len(alpha3) != 3 or not alpha3.isalpha():
            raise ValueError("not an alpha3 code: %r" % alpha3)
        self.alpha3 = alpha3.lower()
        self.country = (
            country if isinstance(country, Country) else (Country(country) if country else None)
        )

    @property
    def alpha2(self) -> str:
        return ALPHA3.get(self.alpha3, self.alpha3[:2])

    @classmethod
    def fromietf(cls, tag: str) -> Language:
        parts = str(tag).replace("_", "-").split("-")
        return cls(parts[0], parts[1] if len(parts) > 1 else None)

    def __eq__(self, other: object) -> bool:
        return (
            isinstance(other, Language)
            and other.alpha3 == self.alpha3
            and other.country == self.country
        )

    def __hash__(self) -> int:
        return hash((self.alpha3, self.country))

    def __repr__(self) -> str:
        return self.alpha3 + ("-" + self.country.alpha2 if self.country else "")


class Video:
    def __init__(self, name="", year=None, imdb_id=None):
        self.name = name
        self.year = year
        self.imdb_id = imdb_id


class Movie(Video):
    def __init__(self, name="", title="", year=None, imdb_id=None):
        super().__init__(name, year, imdb_id)
        self.title = title


class Episode(Video):
    def __init__(
        self, name="", series="", title="", season=None, episode=None, year=None,
        imdb_id=None, series_imdb_id=None,
    ):
        super().__init__(name, year, imdb_id)
        self.series = series
        self.title = title
        self.season = season
        self.episode = episode
        self.series_imdb_id = series_imdb_id


class Subtitle:
    def __init__(self, language, hearing_impaired=False):
        self.language = language
        self.hearing_impaired = hearing_impaired
        self.content = None


class Provider:
    pass


#: Every guess the provider handed to Bazarr's parser, newest last.
GUESSES = []


def guessit(name, options=None):
    return {"release": name, "type": (options or {}).get("type")}


def guess_matches(video, guess, partial=False):
    """Bazarr's parser is Bazarr's to test. This one shows the release name reached it."""
    GUESSES.append(guess)
    return {"source"} if "BluRay" in guess["release"] else set()


def _module(name: str, **members) -> types.ModuleType:
    mod = types.ModuleType(name)
    for key, value in members.items():
        setattr(mod, key, value)
    sys.modules[name] = mod
    return mod


_module("guessit", guessit=guessit)
_module("subliminal", Episode=Episode, Movie=Movie, Video=Video)
_module("subliminal.exceptions", AuthenticationError=Exception, ConfigurationError=Exception)
_module("subliminal_patch")
_module("subliminal_patch.providers", Provider=Provider)
_module("subliminal_patch.subtitle", Subtitle=Subtitle, guess_matches=guess_matches)
_module("subzero")
_module("subzero.language", Language=Language)


def _load_provider():
    """Load ../provider.py as ``subtitledb_provider``.

    It is called provider.py here and installed as subtitledb.py, because that is
    the module name Bazarr registers. Under its installed name it would be a
    submodule of subliminal_patch.providers and clash with nothing; in this repo it
    would be top level and shadow the very package it imports.
    """
    import importlib.util

    path = Path(__file__).resolve().parents[1] / "provider.py"
    spec = importlib.util.spec_from_file_location("subtitledb_provider", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules["subtitledb_provider"] = module
    spec.loader.exec_module(module)
    return module


_load_provider()


@pytest.fixture
def language():
    return Language
