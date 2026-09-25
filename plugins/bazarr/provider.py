# SPDX-License-Identifier: MIT
# Copyright (c) 2026 TheSubtitleDb.org

"""SubtitleDB provider for Bazarr.

Installed as ``bazarr/libs/subliminal_patch/providers/subtitledb.py``, which is the
module name Bazarr registers. See README.md, or run install.py.

Bazarr already knows what it is looking at: Sonarr and Radarr hand it an IMDb id,
a series name, a season and an episode number, and the file's release name. That is
the strongest evidence this API can be asked with, so this provider does no guessing
of its own beyond what subtitledb.find already does for every plugin.

The shared client is standard library only, so this adds nothing to Bazarr's
dependency tree.
"""


import logging
import os

from guessit import guessit
from subliminal import Episode, Movie
from subliminal.exceptions import AuthenticationError, ConfigurationError  # noqa: F401
from subliminal_patch.providers import Provider
from subliminal_patch.subtitle import Subtitle, guess_matches
from subtitledb import (
    TIER_IMDB,
    Client,
    Hint,
    Options,
    SubtitleDbError,
    candidate_label,
    find,
    language_name,
)
from subtitledb import per_language as read_per_language
from subtitledb.match import normalise
from subzero.language import Language

logger = logging.getLogger(__name__)

#: What Bazarr can use. The API never converts, so this is a hard filter.
FORMATS = ["srt", "ass", "ssa", "vtt", "sub"]


def hint_for(video):
    """Everything Bazarr knows about this file, in the shape the shared ladder takes."""
    # Video.name is the path Bazarr is filling a subtitle for. Its stem is the
    # release name, which is the field that decides whether a subtitle is in sync.
    name = getattr(video, "name", None)
    stem = os.path.splitext(os.path.basename(name))[0] if name else None

    if isinstance(video, Episode):
        return Hint(
            # Sonarr fills the episode's own id only sometimes; the series id is not
            # interchangeable with it, so it is passed as what it is and the ladder
            # falls through to the series search when the episode id is missing.
            imdb_id=clean_imdb(getattr(video, "imdb_id", None)),
            series_imdb_id=clean_imdb(getattr(video, "series_imdb_id", None)),
            title=video.series,
            episode_title=video.title,
            year=video.year,
            season=video.season,
            episode=video.episode,
            release=stem,
        )
    return Hint(
        imdb_id=clean_imdb(getattr(video, "imdb_id", None)),
        title=video.title,
        year=video.year,
        release=stem,
    )


def clean_imdb(value):
    """Bazarr stores these as `tt0133093`, and sometimes as `133093` or an int."""
    if not value:
        return None
    text = str(value).strip().lower()
    if not text or text in ("none", "0"):
        return None
    return text if text.startswith("tt") else "tt" + text.zfill(7)


def api_code(language):
    """babelfish Language to the code the API files it under.

    Brazilian Portuguese is the one that matters: babelfish spells it
    ``pt-BR`` and the corpus files it under ``pb``. Asking for ``pt`` returns
    European Portuguese, which is not what the user configured.
    """
    from subtitledb import to_code

    code = to_code(str(language.alpha3))
    if getattr(language, "country", None) is not None:
        specific = to_code("%s-%s" % (language.alpha2, language.country.alpha2))
        if specific:
            return specific
    return code or str(language.alpha2)


def from_api_code(code):
    """Back the other way, for the Language object Bazarr wants on the subtitle."""
    if not code:
        return None
    if code == "pb":
        return Language("por", "BR")
    if code in ("zt", "ze"):
        return Language("zho", "TW") if code == "zt" else Language("zho")
    try:
        return Language.fromietf(code)
    except (ValueError, AttributeError):
        try:
            return Language(code)
        except Exception:
            logger.debug("subtitledb: no babelfish language for %r (%s)", code, language_name(code))
            return None


def _named(name, names):
    """Whether the API's name for the title is one of Bazarr's names for it."""
    return bool(name) and normalise(name) in {normalise(n) for n in names if n}


class SubtitleDbSubtitle(Subtitle):
    """One candidate, carrying the evidence that produced it."""

    provider_name = "subtitledb"
    hash_verifiable = False

    def __init__(self, language, row, reason, found=None, tier=None, hint=None):
        super().__init__(
            language, hearing_impaired=bool(row.get("hearing_impaired"))
        )
        self.row = row
        self.reason = reason
        self.release_info = row.get("release_name") or ""
        self.page_link = "https://thesubtitledb.org/#/subtitle/%s" % row.get("id")
        self.download_link = row.get("download_url") or ""
        #: The title the lookup resolved to: imdb, name and year. A row carries none
        #: of them; which title it belongs to is the lookup's answer, not the row's.
        self.found = found or {}
        self.tier = tier
        self.hint = hint
        self.matches = set()

    @property
    def id(self):
        return "subtitledb-%s" % self.row.get("id")

    def get_matches(self, video):
        """What Bazarr scores the pick on, and what it keeps an episode's subtitle by.

        Only claims what was checked: the title the lookup resolved to, the episode
        it was drilled to, and what the release name says, read by Bazarr's own
        parser. Bazarr drops an episode's subtitle unless series, season and episode
        are all claimed, so a set that claims too little hides every subtitle, and
        one that claims too much wins picks it should lose.
        """
        episode = isinstance(video, Episode)
        found = self.found
        matches = set()

        # An id both sides know settles which title this is. The name and the year
        # are compared only when one side has no id.
        ours = found.get("imdb")
        theirs = clean_imdb(getattr(video, "series_imdb_id" if episode else "imdb_id", None))
        if ours and theirs:
            if ours == theirs:
                matches |= ({"series_imdb_id", "series", "year"} if episode
                            else {"imdb_id", "title", "year"})
        else:
            if episode:
                names = [video.series, *getattr(video, "alternative_series", [])]
            else:
                names = [video.title, *getattr(video, "alternative_titles", [])]
            if _named(found.get("name"), names):
                matches.add("series" if episode else "title")
            if found.get("year") and found.get("year") == getattr(video, "year", None):
                matches.add("year")

        hint = self.hint
        if episode and hint is not None and (hint.season, hint.episode) == (
                video.season, video.episode):
            # The lookup was drilled to this season and episode, and a row filed
            # under another one was dropped before it got here.
            matches |= {"season", "episode"}
            if self.tier == TIER_IMDB and hint.imdb_id:
                matches.add("imdb_id")

        if self.release_info:
            guess = guessit(self.release_info, {"type": "episode" if episode else "movie"})
            matches |= guess_matches(video, guess)

        self.matches = matches
        return matches


def supported_languages():
    """Every language the corpus files subtitles under, as babelfish knows them.

    Built from the shared table rather than written out again, and any code
    babelfish will not accept is skipped instead of failing the import: a provider
    that cannot be loaded is worse than one that offers 70 languages instead of 74.
    """
    from subtitledb.languages import NAMES

    out = set()
    for code in NAMES:
        language = from_api_code(code)
        if language is not None:
            out.add(language)
    return out


class SubtitleDbProvider(Provider):
    """No key, no account, no quota."""

    languages = supported_languages()
    video_types = (Episode, Movie)
    subtitle_class = SubtitleDbSubtitle

    def __init__(self, api_base=None, per_language=None):
        self.api_base = api_base or os.environ.get(
            "SUBTITLEDB_API_BASE", "https://api.thesubtitledb.org"
        )
        # Rows read per language. Bazarr's settings page has no field for it, so the
        # environment carries it, the same way it carries the address.
        self.per_language = read_per_language(
            per_language or os.environ.get("SUBTITLEDB_PER_LANGUAGE"))
        self.client = None

    def initialize(self):
        self.client = Client(api_base=self.api_base, client="bazarr")

    def terminate(self):
        self.client = None

    # -- lookup -------------------------------------------------------------

    def list_subtitles(self, video, languages):
        hint = hint_for(video)
        out = []
        # One lookup per language, each read to its own limit. Found by the live run:
        # with a profile of English, Spanish and Brazilian Portuguese in one ask, the
        # English rows filled the list and no Spanish reached Bazarr, which scores and
        # picks per language itself.
        codes = []
        for lang in languages:
            code = api_code(lang)
            if code not in codes:
                codes.append(code)
        for code in codes:
            opts = Options(languages=[code], formats=FORMATS, limit=self.per_language)
            try:
                result = find(self.client, hint, opts)
            except SubtitleDbError as err:
                # A provider that raises takes the whole search down with it. Bazarr
                # has other providers; ours being unreachable is not their problem.
                logger.error("subtitledb: %s", err)
                return out

            logger.debug(
                "subtitledb: %s in %s -> %d candidates via %s (%d dropped as unrenderable, "
                "%d wrong episode)",
                hint.release or hint.title,
                code,
                len(result.candidates),
                result.tier,
                result.unrenderable,
                result.wrong_episode,
            )
            for candidate in result.candidates:
                row = candidate.subtitle
                language = from_api_code(row.get("language"))
                if language is None:
                    continue
                out.append(SubtitleDbSubtitle(
                    language, row, candidate.reason, found=result.title, tier=result.tier,
                    hint=hint,
                ))
        return out

    def download_subtitle(self, subtitle):
        if not subtitle.download_link:
            return
        try:
            subtitle.content = self.client.download(subtitle.download_link)
        except SubtitleDbError as err:
            logger.error("subtitledb: download failed: %s", err)


__all__ = ["SubtitleDbProvider", "SubtitleDbSubtitle", "candidate_label"]
