"""The Kodi addon: the decisions, and the zip.

Only service.py and resources/lib/kodi_side.py import Kodi's modules, and they do
nothing this module does not, so the logic is tested here and the Kodi side is left
to Kodi.
"""

from __future__ import annotations

import re
import struct
import sys
import zipfile
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE.parent / "python"))
sys.path.insert(0, str(HERE / "service.subtitles.subtitledb" / "resources" / "lib"))
sys.path.insert(0, str(HERE))

import build  # noqa: E402
import logic  # noqa: E402
from subtitledb.match import Candidate  # noqa: E402


def row(**kw):
    out = {
        "id": 481207,
        "language": "pb",
        "format": "srt",
        "cues": 900,
        "downloads": 10,
        "release_name": "",
        "hearing_impaired": False,
        "download_url": "https://api.thesubtitledb.org/get/481207",
    }
    out.update(kw)
    return out


# -- what Kodi is playing ---------------------------------------------------


@pytest.mark.parametrize(
    ("path", "want"),
    [
        ("/media/Anatomy.of.a.Fall.2023.1080p.BluRay.x264-KOVAL.mkv",
         "Anatomy.of.a.Fall.2023.1080p.BluRay.x264-KOVAL"),
        ("smb://nas/tv/Breaking.Bad.S05E14.mkv", "Breaking.Bad.S05E14"),
        (r"C:\\Films\\Solaris.2002.mkv", "Solaris.2002"),
        # A stack is several files playing as one. The first is the one with a name.
        ("stack:///m/Film.cd1.avi , /m/Film.cd2.avi", "Film.cd1"),
        ("", None),
        (None, None),
    ],
)
def test_the_release_name_out_of_whatever_is_playing(path, want):
    assert logic.video_name(path) == want


def test_a_file_inside_an_archive_still_has_a_name():
    inner = "rar://%2fmedia%2fFilm.rar/Film.2023.1080p.BluRay-GROUP.mkv"
    assert logic.video_name(inner) == "Film.2023.1080p.BluRay-GROUP"


@pytest.mark.parametrize(
    ("value", "want"),
    [("tt0133093", "tt0133093"), ("0133093", "tt0133093"), ("", None), ("12345", None),
     ("tvdb://81189", None)],
)
def test_the_imdb_number_kodi_reports(value, want):
    # For TV, Kodi's IMDBNumber is sometimes a TVDB id. Sending that as an IMDb id
    # would resolve to somebody else's film.
    assert logic.clean_imdb(value) == want


@pytest.mark.parametrize("value", ["915935", "303821", "603", "tvdb://81189"])
def test_a_default_id_that_is_not_imdb_is_not_sent_as_one(value):
    # IMDBNumber is the default id, and Kodi's TMDB and TVDB scrapers make theirs the
    # default. Anatomy of a Fall's TMDB id, 915935, read as tt0915935, is another title.
    assert logic.clean_imdb(value, typed=False) is None
    assert logic.clean_imdb("tt0133093", typed=False) == "tt0133093"


def test_a_film_scraped_from_tmdb_goes_by_its_tmdb_and_imdb_ids():
    hint = logic.hint_from({
        "path": "/m/Anatomy.of.a.Fall.2023.1080p.mkv", "title": "Anatomy of a Fall",
        "year": "2023", "imdb": "tt17009710", "imdb_number": "915935", "tmdb": "915935",
    })
    assert (hint.imdb_id, hint.tmdb_id) == ("tt17009710", 915935)


def test_an_episode_with_no_imdb_id_of_its_own_carries_its_shows():
    # A TVDB-scraped episode: its default id is TVDB's and it has no IMDb id, and
    # its show has one. By name, the API answers "Friends" with Matlock.
    hint = logic.hint_from({
        "path": "/tv/Friends.S01E01.mkv", "title": "The One Where Monica Gets a Roommate",
        "tvshow": "Friends", "season": "1", "episode": "1",
        "imdb": "", "imdb_number": "303821", "tmdb": "85987", "tvshow_imdb": "tt0108778",
    })
    assert (hint.imdb_id, hint.series_imdb_id) == (None, "tt0108778")
    assert (hint.title, hint.season, hint.episode) == ("Friends", 1, 1)
    # An episode's TMDB id is the episode's, not a key the API maps.
    assert hint.tmdb_id is None


def test_a_film_hint():
    hint = logic.hint_from({
        "path": "/m/Solaris.2002.1080p.mkv",
        "title": "Solaris",
        "year": "2002",
        "imdb": "tt0307479",
    })
    assert (hint.imdb_id, hint.title, hint.year) == ("tt0307479", "Solaris", 2002)
    assert hint.season is None
    assert hint.release == "Solaris.2002.1080p"


def test_an_episode_hint_takes_the_show_title_not_the_episode_title():
    hint = logic.hint_from({
        "path": "/tv/Breaking.Bad.S05E14.mkv",
        "title": "Ozymandias",
        "tvshow": "Breaking Bad",
        "season": "5",
        "episode": "14",
    })
    assert hint.title == "Breaking Bad"
    assert hint.episode_title == "Ozymandias"
    assert (hint.season, hint.episode) == (5, 14)


def test_a_show_title_with_no_numbers_is_not_treated_as_an_episode():
    # Kodi leaves these labels set from the last thing that played.
    hint = logic.hint_from({"path": "/m/x.mkv", "title": "Solaris", "tvshow": "Breaking Bad"})
    assert hint.title == "Solaris"
    assert hint.season is None


def test_season_zero_is_not_a_season():
    # Kodi reports "0" rather than an empty string for a film.
    assert logic.to_int("0") is None
    assert logic.to_int("") is None
    assert logic.to_int("5") == 5


# A file played from outside the library: Kodi has no id and no year, and its title
# is the file's own name, which matches no title the API has. Found by the live run.
@pytest.mark.parametrize("title", [
    "The.Matrix.1999.1080p.BluRay.x264-GROUP",
    "The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv",
    "",
])
def test_a_film_played_from_outside_the_library_is_read_off_its_name(title):
    hint = logic.hint_from({
        "path": "/m/The Matrix (1999)/The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv",
        "title": title, "year": "", "imdb": "", "tvshow": "", "season": "", "episode": "",
    })
    assert (hint.title, hint.year, hint.season) == ("The Matrix", 1999, None)
    assert hint.release == "The.Matrix.1999.1080p.BluRay.x264-GROUP"


def test_an_episode_played_from_outside_the_library_is_read_off_its_name():
    hint = logic.hint_from({
        "path": "/tv/Game.of.Thrones.S01E01.720p.HDTV.x264-GROUP.mkv",
        "title": "Game.of.Thrones.S01E01.720p.HDTV.x264-GROUP",
    })
    assert (hint.title, hint.season, hint.episode) == ("Game of Thrones", 1, 1)
    assert hint.episode_title is None


def test_a_title_typed_into_the_manual_search_wins_over_the_file_name():
    hint = logic.hint_from({"path": "/tv/Game.of.Thrones.S01E01.mkv", "title": "Solaris"})
    assert (hint.title, hint.season) == ("Solaris", None)


@pytest.mark.parametrize(
    ("name", "want"),
    [
        ("2001.A.Space.Odyssey.1968.1080p.BluRay", ("2001 A Space Odyssey", 1968)),
        ("Blade.Runner.2049.2017.2160p.UHD", ("Blade Runner 2049", 2017)),
        ("Charlottes.Web.2006.DVDRip", ("Charlottes Web", 2006)),
        ("The Matrix (1999)", ("The Matrix", 1999)),
        ("Some.Film.1080p.WEB-DL", ("Some Film", None)),
        ("Solaris", ("Solaris", None)),
    ],
)
def test_a_film_name(name, want):
    read = logic.from_name(name)
    assert (read["title"], read["year"]) == want
    assert read["season"] is None


@pytest.mark.parametrize(
    "name", ["Show.Name.S02E05.1080p", "Show.Name.s02.e05", "Show Name - 2x05 - Title"])
def test_an_episode_name(name):
    read = logic.from_name(name)
    assert (read["tvshow"], read["season"], read["episode"]) == ("Show Name", 2, 5)


def test_a_resolution_is_not_an_episode():
    assert logic.from_name("Film.2020.1920x1080")["season"] is None


# -- what the list says -----------------------------------------------------


def test_a_row_is_labelled_with_the_language_kodi_can_draw():
    item = logic.list_item(Candidate(subtitle=row(), score=1, reason="preferred language pb"))
    assert item["language_name"] == "Portuguese (Brazil)"
    assert item["language_code"] == "pb"


def test_the_right_column_is_the_release_or_a_translated_line_count():
    # Kodi draws the language on the left and hearing impaired as an icon, so neither
    # is repeated, and the words come from strings.po, as Kodi's add-on rules require.
    def item(**kw):
        return logic.list_item(Candidate(subtitle=row(**kw), score=1, reason=""))

    assert logic.describe(item(release_name=" The.Matrix.1999.1080p "), "{0} lines") == (
        "The.Matrix.1999.1080p")
    assert logic.describe(item(cues=1386), "{0} Zeilen") == "1386 Zeilen"
    assert logic.describe(item(cues=0), "{0} lines") == ""


def test_every_string_the_addon_shows_is_in_strings_po():
    addon = HERE / "service.subtitles.subtitledb"
    strings = (addon / "resources" / "language" / "resource.language.en_gb" / "strings.po"
               ).read_text(encoding="utf-8")
    side = (addon / "resources" / "lib" / "kodi_side.py").read_text(encoding="utf-8")
    ids = re.findall(r"getLocalizedString\((\d+)\)", side)
    assert ids
    for i in ids:
        assert 'msgctxt "#%s"' % i in strings


def test_a_subtitle_recorded_against_this_release_is_the_one_marked_in_sync():
    # The star rating is the only other thing Kodi draws, so it carries this rather
    # than an invented number.
    same = logic.list_item(Candidate(subtitle=row(), score=1, reason="same release"))
    other = logic.list_item(Candidate(subtitle=row(), score=1, reason="preferred language en"))
    assert (same["sync"], same["rating"]) == (True, 5)
    assert (other["sync"], other["rating"]) == (False, 0)


@pytest.mark.parametrize(
    ("fmt", "want"),
    [("srt", "subtitledb-1.srt"), ("ass", "subtitledb-1.ass"), ("", "subtitledb-1.srt"),
     ("rar", "subtitledb-1.srt")],
)
def test_the_file_keeps_the_extension_kodi_will_parse_it_by(fmt, want):
    # A subtitle saved as .srt that is really ASS renders as a screen of tag soup.
    assert logic.filename_for({"id": 1, "format": fmt}) == want


def test_a_search_asks_in_the_languages_kodi_named_them():
    # Kodi sends display names, not codes.
    class FakeClient:
        def __init__(self):
            self.langs = []

        def by_imdb(self, imdb, **kw):
            self.langs.append(kw.get("lang"))
            sid = len(self.langs)
            items = [row(id=sid, language=kw.get("lang"))]
            return {"title": {}, "subtitles": {"items": items, "total": len(items)}}

    client = FakeClient()
    items = logic.search(
        client,
        {"path": "/m/x.mkv", "title": "x", "imdb": "tt1"},
        ["English", "Portuguese (Brazil)"],
    )
    assert client.langs == ["en", "pb"]
    assert [i["language_name"] for i in items] == ["English", "Portuguese (Brazil)"]


def test_a_search_lists_past_the_first_hundred():
    # The Matrix has 147 English rows, and the API sends 100 a request.
    class FakeClient:
        def by_imdb(self, imdb, **kw):
            start = kw.get("offset", 0)
            items = [row(id=i + 1, language="en") for i in range(start, min(start + 100, 147))]
            return {"title": {}, "subtitles": {"items": items, "total": 147}}

    items = logic.search(FakeClient(), {"path": "/m/x.mkv", "imdb": "tt1"}, ["English"])
    assert len(items) == 147


def test_the_setting_kodi_shows_is_the_one_the_search_reads():
    import xml.etree.ElementTree as ET

    from subtitledb.find import MOST_PER_LANGUAGE, PAGE, PER_LANGUAGE

    addon = HERE / "service.subtitles.subtitledb"
    tree = ET.parse(addon / "resources" / "settings.xml")  # noqa: S314 - the addon's own file
    setting = tree.find(".//setting[@id='per_language']")
    assert setting is not None
    assert int(setting.findtext("default")) == PER_LANGUAGE
    assert int(setting.findtext("constraints/minimum")) == PAGE
    assert int(setting.findtext("constraints/maximum")) == MOST_PER_LANGUAGE
    strings = (addon / "resources" / "language" / "resource.language.en_gb" / "strings.po"
               ).read_text(encoding="utf-8")
    for key in ("label", "help"):
        assert 'msgctxt "#%s"' % setting.get(key) in strings
    side = (addon / "resources" / "lib" / "kodi_side.py").read_text(encoding="utf-8")
    assert 'per_language(ADDON.getSetting("per_language"))' in side


def test_the_log_says_which_title_the_search_was_answered_for():
    # Found by the live run: a name read off a file can resolve to another title,
    # and the list Kodi draws gives no sign of it.
    class FakeClient:
        def by_title(self, q, **kw):
            return {"title": {"imdb": "tt26591147", "name": "Matlock", "year": 2024},
                    "subtitles": {"items": [row(id=1, language="en")], "total": 1}}

    logged = []
    logic.search(FakeClient(), {"path": "/tv/Friends.S01E01.mkv", "tvshow": "Friends",
                                "season": 1, "episode": 1}, ["English"], log=logged.append)
    assert logged == ["resolved to Matlock (2024) tt26591147 via title, 1 candidates"]


# -- the zip ----------------------------------------------------------------


def test_the_zip_has_one_top_level_directory_named_for_the_addon(tmp_path, monkeypatch):
    # Kodi refuses an archive shaped any other way.
    monkeypatch.setattr(build, "DIST", tmp_path)
    out = build.build()
    with zipfile.ZipFile(out) as zf:
        tops = {name.split("/")[0] for name in zf.namelist()}
    assert tops == {"service.subtitles.subtitledb"}


def test_the_zip_carries_the_client_because_kodi_has_no_package_manager(tmp_path, monkeypatch):
    monkeypatch.setattr(build, "DIST", tmp_path)
    with zipfile.ZipFile(build.build()) as zf:
        names = zf.namelist()
    assert "service.subtitles.subtitledb/resources/lib/subtitledb/match.py" in names
    assert "service.subtitles.subtitledb/resources/lib/logic.py" in names
    assert "service.subtitles.subtitledb/resources/lib/kodi_side.py" in names
    assert "service.subtitles.subtitledb/addon.xml" in names
    assert "service.subtitles.subtitledb/resources/icon.png" in names
    assert not [n for n in names if "__pycache__" in n or n.endswith(".pyc")]


def test_the_zip_is_named_for_the_version_in_addon_xml(tmp_path, monkeypatch):
    monkeypatch.setattr(build, "DIST", tmp_path)
    assert build.build().name == "service.subtitles.subtitledb-%s.zip" % build.version()


def test_the_repository_index_and_its_md5_are_written_together(tmp_path, monkeypatch):
    # A stale md5 means Kodi never reads addons.xml again, so nobody sees an update.
    import hashlib

    monkeypatch.setattr(build, "DIST", tmp_path)
    build.build(repo=True)
    xml = (tmp_path / "addons.xml").read_bytes()
    digest = hashlib.md5(xml).hexdigest()  # noqa: S324 - Kodi defines the file as md5
    assert (tmp_path / "addons.xml.md5").read_text(encoding="utf-8") == digest
    assert b'id="service.subtitles.subtitledb"' in xml


def test_the_addon_declares_itself_a_subtitle_module():
    xml = (HERE / "service.subtitles.subtitledb" / "addon.xml").read_text(encoding="utf-8")
    assert 'point="xbmc.subtitle.module"' in xml
    assert 'library="service.py"' in xml


def test_the_zip_carries_the_license_addon_xml_names(tmp_path, monkeypatch):
    # Kodi's repository wants the text at the addon root, matching <license>.
    monkeypatch.setattr(build, "DIST", tmp_path)
    with zipfile.ZipFile(build.build()) as zf:
        text = zf.read("service.subtitles.subtitledb/LICENSE.txt").decode("utf-8")
    assert text == build.LICENSE.read_text(encoding="utf-8")
    lines = text.splitlines()
    assert lines[0] == "MIT License"
    assert "Copyright (c) 2026 TheSubtitleDb.org" in lines
    xml =(HERE / "service.subtitles.subtitledb" / "addon.xml").read_text(encoding="utf-8")
    assert "<license>MIT</license>" in xml


def test_the_source_link_is_this_directory_in_the_public_repository():
    # The checker follows it, and a reviewer reads the tests and the vendored client
    # there, which the repo-scripts copy does not carry.
    xml = (HERE / "service.subtitles.subtitledb" / "addon.xml").read_text(encoding="utf-8")
    assert re.findall(r"<source>(.*?)</source>", xml) == [
        "https://github.com/thesubtitledb/subtitledb-integrations/tree/main/plugins/kodi"]


# -- what Kodi's repository checker rejects -----------------------------------


def png_chunks(data):
    """(type, body) for every chunk after the signature."""
    i = 8
    while i < len(data):
        (size,) = struct.unpack(">I", data[i : i + 4])
        yield data[i + 4 : i + 8], data[i + 8 : i + 8 + size]
        i += 12 + size


def test_the_icon_is_a_solid_square_because_kodi_rejects_transparency():
    # kodi-addon-checker fails an icon with any alpha: the skin applies its own mask.
    png = (HERE / "service.subtitles.subtitledb" / "resources" / "icon.png").read_bytes()
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    chunks = list(png_chunks(png))
    ihdr = chunks[0][1]
    assert chunks[0][0] == b"IHDR"
    assert struct.unpack(">II", ihdr[:8]) in ((256, 256), (512, 512))
    assert ihdr[9] in (0, 2, 3)  # grey, truecolour or palette: no alpha channel
    assert b"tRNS" not in [kind for kind, _ in chunks]


def test_the_entry_point_stays_a_few_lines():
    # The checker warns past 15 lines in the file addon.xml names as the library.
    src = (HERE / "service.subtitles.subtitledb" / "service.py").read_text(encoding="utf-8")
    code = [ln for ln in src.splitlines() if ln.strip() and not ln.lstrip().startswith("#")]
    assert len(code) <= 15
