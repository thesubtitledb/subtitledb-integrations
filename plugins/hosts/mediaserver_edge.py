#!/usr/bin/env python3
"""The Jellyfin and Emby plugins against a fake API that fails in every way it can.

    python3 mediaserver_edge.py make <dir>
    python3 mediaserver_edge.py run jellyfin|emby <url> <dir> <log dir> <api base>

`make` writes the edge films, one folder each. `run` takes the server mediaserver.py
set up, serves kodi_edge's fake API on every address, points the plugin at <api base>
(the address the server reaches this machine by) and adds a film library over <dir>,
which the server sees as /media/edge. It reads the newest file in <log dir>. Then:

- the search dialog lists nothing from SubtitleDB and logs no error under every way
  the API can fail, and its download saves no file under every way a download can;
- a film that starts playing gets SubtitleDB's subtitle saved beside it in the
  library's download language, also when it has subtitles of its own, and the server
  lists it; when that same file is there already, nothing is saved;
- a subtitle saved on play is downloaded once, on both hosts;
- under the library's perfect-match rule only a subtitle made for that release is
  saved, and nothing is asked when the lookup on play is off, the library has no
  download languages, SubtitleDB is not ticked for it, or the film's audio is in the
  download language and the library skips a subtitle for that;
- a lookup on play that fails logs one line and saves nothing.

Exits 1 if any case failed.
"""

from __future__ import annotations

import pathlib
import re
import sys
import time
import urllib.parse

import kodi_edge as F
import mediaserver as M

MOUNT = "/media/edge"
LIBRARY = "Edge"
THEIRS = "1\n00:00:01,000 --> 00:00:30,000\nSomeone else's subtitle\n"
#: What the API sends for every download in the case where the film already has it.
HELD = b"1\n00:00:01,000 --> 00:00:30,000\nSubtitleDB test held\n"
#: Exceptions that mean a failure got past the plugin's own handling.
LEAKED = ("TaskCanceledException", "OperationCanceledException", "HttpRequestException",
          "JsonException", "NullReferenceException", "MissingMethodException",
          "TypeLoadException", "InvalidCastException")

#: One film per case, as a folder and a file name: a lookup on play asks once per
#: video in ten minutes, so no case can reuse another's film. Jellyfin files a name
#: ending in -other, -sample, -trailer, -extra and the like as an extra, not a film.
FILMS = {
    "dialog": ("The Matrix (1999)", "The.Matrix.1999.1080p.BluRay.x264-GROUP"),
    "plain": ("Heat (1995)", "Heat.1995.1080p.BluRay.x264-PLAIN"),
    "embedded": ("Alien (1979)", "Alien.1979.1080p.BluRay.x264-ENG"),
    "external": ("Ran (1985)", "Ran.1985.1080p.BluRay.x264-EXT"),
    "held": ("Jaws (1975)", "Jaws.1975.1080p.BluRay.x264-HELD"),
    "404": ("Brazil (1985)", "Brazil.1985.1080p.BluRay.x264-GONE"),
    "html200": ("Amadeus (1984)", "Amadeus.1984.1080p.BluRay.x264-PAGE"),
    "empty": ("Gandhi (1982)", "Gandhi.1982.1080p.BluRay.x264-EMPTY"),
    "foreign": ("Tootsie (1982)", "Tootsie.1982.1080p.BluRay.x264-AWAY"),
    "hang": ("Platoon (1986)", "Platoon.1986.1080p.BluRay.x264-HANG"),
    "search": ("Network (1976)", "Network.1976.1080p.BluRay.x264-DOWN"),
    "perfect other": ("Fargo (1996)", "Fargo.1996.1080p.BluRay.x264-DIFF"),
    "perfect same": ("Seven (1995)", "Seven.1995.1080p.BluRay.x264-SAME"),
    "no languages": ("Vertigo (1958)", "Vertigo.1958.1080p.BluRay.x264-NOLANG"),
    "not ticked": ("Rocky (1976)", "Rocky.1976.1080p.BluRay.x264-UNTICKED"),
    "off": ("Psycho (1960)", "Psycho.1960.1080p.BluRay.x264-OFF"),
    "audio": ("Chinatown (1974)", "Chinatown.1974.1080p.BluRay.x264-AUDIO"),
}

#: Why a download fails, as the plugin says it.
DOWNLOADS = {"404": "download failed: 404", "html200": "sent a web page, not a subtitle",
             "empty": "sent nothing, not a subtitle",
             "foreign": "download redirected off our hosts", "hang": "timed out"}

RESULTS: list[tuple[str, bool]] = []


def make(root: pathlib.Path):
    for key, (folder, stem) in FILMS.items():
        F.video(root / folder / (stem + ".mkv"), 30, "eng" if key == "embedded" else None,
                "eng" if key == "audio" else None)
    folder, stem = FILMS["external"]
    (root / folder / (stem + ".en.srt")).write_text(THEIRS, encoding="utf-8")
    folder, stem = FILMS["held"]
    (root / folder / (stem + ".en.srt")).write_bytes(HELD)


class Log:
    """What the server wrote since the last mark, from the newest file in a directory."""

    def __init__(self, kind: str, directory: pathlib.Path):
        self.kind, self.dir = kind, directory
        self.file: pathlib.Path | None = None
        self.offset = 0

    def newest(self):
        # The server's own log, not the FFmpeg ones Jellyfin keeps beside it.
        files = list(self.dir.glob("log_*.log" if self.kind == "jellyfin" else "embyserver*.txt"))
        return max(files, key=lambda p: p.stat().st_mtime) if files else None

    def mark(self):
        self.file = self.newest()
        self.offset = self.file.stat().st_size if self.file else 0

    def lines(self) -> list[str]:
        now = self.newest()
        if now is None:
            return []
        text = self.read(now, self.offset if now == self.file else 0)
        if self.file is not None and now != self.file:
            text = self.read(self.file, self.offset) + text
        return text.splitlines()

    @staticmethod
    def read(path, offset):
        with open(path, "rb") as fh:
            fh.seek(offset)
            return fh.read().decode("utf-8", "replace")

    def is_error(self, line: str) -> bool:
        if self.kind == "jellyfin":
            return bool(re.search(r"\[(ERR|FTL)\]", line))
        return bool(re.match(r"\S+ \S+ (Error|Fatal) ", line))

    def wait_for(self, text, seconds):
        # Jellyfin's file log quotes each value written into a line.
        end = time.time() + seconds
        while time.time() < end:
            if any(text in line.replace('"', "") for line in self.lines()):
                return True
            time.sleep(0.5)
        return False

    def trouble(self, allow_errors=False):
        """Errors about subtitles and leaked exceptions since the mark, as text."""
        lines = self.lines()
        bad = [] if allow_errors else [
            line for line in lines if self.is_error(line) and "subtitle" in line.lower()]
        bad += [line for line in lines if any(name in line for name in LEAKED)]
        return " || ".join(line.strip()[:220] for line in bad[:3])


def record(name, ok, saw):
    RESULTS.append((name, ok))
    print("%s  %s: %s" % ("PASS" if ok else "FAIL", name, saw), flush=True)


def title_of(key):
    return FILMS[key][0].rsplit(" (", 1)[0]


def is_film(key, name):
    """Whether the fake answered ``name`` for ``key``'s film. A host may search by the
    folder's name, year and all, as Jellyfin does when no metadata was fetched."""
    return (name or "").lower().startswith(title_of(key).lower())


def asked_for(key, since):
    """The fake's requests since ``since`` about ``key``'s film: its lookups by name,
    and the by-subid lookups and downloads of its subtitles."""
    out = []
    for _, path in F.S.requests[since:]:
        url = urllib.parse.urlsplit(path)
        if url.path.startswith(("/v1/by-subid/", "/get/")):
            name = F.S.names.get(int(url.path.rsplit("/", 1)[1]) // 10)
        else:
            name = dict(urllib.parse.parse_qsl(url.query)).get("q")
        if is_film(key, name):
            out.append(path)
    return out


def downloads(asked):
    return [p for p in asked if p.startswith("/get/")]


def subtitle_files(folder: pathlib.Path):
    return {p for p in folder.iterdir() if p.suffix.lower() in M.SUBTITLE_SUFFIXES}


def reset():
    F.S.mode, F.S.dl, F.S.langs, F.S.body, F.S.release_name = "ok", "ok", {"en"}, None, ""
    F.S.release.set()
    time.sleep(0.5)
    F.S.release.clear()


class Edge:
    def __init__(self, server: M.Server, root: pathlib.Path, log: Log, api_base: str):
        self.server, self.root, self.log, self.api_base = server, root, log, api_base
        self.plugin = server.plugin()
        self.items: dict[str, dict] = {}
        self.plays = 0

    # -- the library -----------------------------------------------------------------

    def add_library(self):
        options = {"EnableRealtimeMonitor": False, "TypeOptions": M.NO_FETCHERS,
                   # None while the scan runs, or the server's own download of
                   # missing subtitles gets to the films first.
                   "SubtitleDownloadLanguages": [], "RequirePerfectSubtitleMatch": False,
                   "SaveSubtitlesWithMedia": True}
        query = {"name": LIBRARY, "collectionType": "movies", "paths": MOUNT,
                 "refreshLibrary": "false"}
        body = {"LibraryOptions": options}
        if self.server.kind == "emby":
            options["PathInfos"] = [{"Path": MOUNT}]
            body.update({"Name": LIBRARY, "CollectionType": "movies", "Paths": [MOUNT]})
        self.server.call("POST", "/Library/VirtualFolders", body, query)
        self.server.call("POST", "/Library/Refresh")

    def library(self):
        for folder in self.server.call("GET", "/Library/VirtualFolders") or []:
            if folder.get("Name") == LIBRARY:
                return folder
        raise M.Failure("the server lists no %s library" % LIBRARY)

    def set_library(self, **settings):
        """Change the library's options as its settings page does, and read them back."""
        folder = self.library()
        options = dict(folder.get("LibraryOptions") or {})
        options.update(settings)
        # Jellyfin names a library by ItemId; Emby's update has taken Id and ItemId.
        for key in ("ItemId", "Id"):
            if not folder.get(key):
                continue
            self.server.call("POST", "/Library/VirtualFolders/LibraryOptions",
                             {"Id": folder[key], "LibraryOptions": options},
                             ok=(200, 204, 400, 404, 500))
            held = self.library().get("LibraryOptions") or {}
            if all(held.get(k) == v for k, v in settings.items()):
                return
        raise M.Failure("the %s library did not keep %s" % (LIBRARY, settings))

    def wait_for_films(self, seconds=300):
        """Every film, once scanned, with the subtitle streams its files carry."""
        stems = {stem: key for key, (_, stem) in FILMS.items()}
        end, found = time.time() + seconds, {}
        while time.time() < end:
            found = {}
            for item in self.server.items():
                stem = pathlib.PurePosixPath(item.get("Path") or "").stem
                if (item.get("Path") or "").startswith(MOUNT + "/") and stem in stems:
                    found[stems[stem]] = item
            if len(found) == len(FILMS) and all(
                    self.streams(found[k]) for k in ("embedded", "external", "held")):
                self.items = found
                return
            time.sleep(5)
        raise M.Failure("the scan never found %s, or their subtitle streams" % sorted(
            set(FILMS) - set(found)))

    @staticmethod
    def streams(item, external=None):
        return [s for s in item.get("MediaStreams") or [] if s.get("Type") == "Subtitle"
                and (external is None or bool(s.get("IsExternal")) == external)]

    def item(self, key):
        """The film as the server lists it now."""
        path = "%s/%s/%s.mkv" % (MOUNT, *FILMS[key])
        for item in self.server.items():
            if item.get("Path") == path:
                return item
        raise M.Failure("the server no longer lists %s" % path)

    def folder(self, key):
        return self.root / FILMS[key][0]

    # -- the search dialog -----------------------------------------------------------

    def dialog_search(self, label, mode="ok", base=None, warns=None, rows=0):
        F.S.mode = mode
        if base:
            self.server.configure(self.plugin, ApiBase=base)
        self.log.mark()
        try:
            t0 = time.time()
            found, ours = self.server.search(self.items["dialog"], "eng")
            took = time.time() - t0
            said = self.log.wait_for(warns, 15) if warns else True
            trouble = self.log.trouble()
            record("dialog search: %s" % label,
                   len(ours) == rows and said and not trouble,
                   "%.1fs | %d of %d from SubtitleDB | %s | %s" % (
                       took, len(ours), len(found),
                       ("logged '%s'" % warns if said else "no '%s' line" % warns)
                       if warns else "nothing to log", trouble or "no errors"))
        except Exception as err:  # a case that breaks is a result too
            record("dialog search: %s" % label, False, "driver error: %r" % err)
        finally:
            if base:
                self.server.configure(self.plugin, ApiBase=self.api_base)
            reset()

    def dialog_download(self, dl):
        """The dialog's download of a row it listed, with the download answering ``dl``."""
        name = "dialog download: %s" % dl
        folder, before = self.folder("dialog"), subtitle_files(self.folder("dialog"))
        try:
            _, ours = self.server.search(self.items["dialog"], "eng")
            if not ours:
                raise M.Failure("the search listed nothing to download")
            F.S.dl = dl
            self.log.mark()
            item = self.items["dialog"]
            self.server.call("POST", "/Items/%s/RemoteSearch/Subtitles/%s" % (
                item["Id"], urllib.parse.quote(ours[0]["Id"], safe="")), ok=(200, 204, 500))
            time.sleep(3)
            new = subtitle_files(folder) - before
            if dl == "ok":
                record(name, len(new) == 1 and not self.log.trouble(),
                       "saved %s | %s" % ([p.name for p in new], self.log.trouble() or "no errors"))
                return
            said = self.log.wait_for(DOWNLOADS[dl], 10)
            # The server logs a download its provider failed as an error of its own.
            trouble = self.log.trouble(allow_errors=True)
            record(name, not new and said and not trouble,
                   "saved %s | %s | %s" % ([p.name for p in new],
                                           "logged '%s'" % DOWNLOADS[dl] if said
                                           else "no '%s' line" % DOWNLOADS[dl],
                                           trouble or "no leaked exceptions"))
        except Exception as err:
            record(name, False, "driver error: %r" % err)
        finally:
            reset()

    # -- the lookup on play ----------------------------------------------------------

    def play(self, key, want, label, setup=None):
        """Start ``key``'s film playing and judge what followed: ``want`` is saved,
        held (fetched, already there), asked (nothing to save), unasked, failed or
        search failed."""
        name = "on play: %s" % label
        folder = self.folder(key)
        before, since = subtitle_files(folder), len(F.S.requests)
        self.plays += 1
        session = "subtitledb-edge-%d" % self.plays
        item = self.items[key]
        try:
            if setup:
                setup()
            self.log.mark()
            self.server.call("POST", "/Sessions/Playing", {
                "ItemId": item["Id"], "PlaySessionId": session, "PositionTicks": 0,
                "IsPaused": False, "CanSeek": True, "PlayMethod": "DirectPlay"})
            ok, saw = getattr(self, "judge_" + want.replace(" ", "_"))(key, before, since)
            asked = asked_for(key, since)
            trouble = self.log.trouble()
            record(name, ok and not trouble, "%s | asked %d %s | %s" % (
                saw, len(asked), [p.split("?")[0] for p in asked][:3],
                trouble or "no errors"))
        except Exception as err:
            record(name, False, "driver error: %r" % err)
        finally:
            try:
                self.server.call("POST", "/Sessions/Playing/Stopped", {
                    "ItemId": item["Id"], "PlaySessionId": session,
                    "PositionTicks": 10_000_000})
            except M.Failure as err:
                print("  could not stop %s: %s" % (session, err))
            reset()

    def new_file(self, key, before, seconds):
        end = time.time() + seconds
        while time.time() < end:
            new = subtitle_files(self.folder(key)) - before
            if new:
                time.sleep(1)  # written whole before it is read
                return sorted(new)
            time.sleep(1)
        return []

    def judge_saved(self, key, before, since):
        new = self.new_file(key, before, 90)
        if len(new) != 1:
            return False, "saved %s" % [p.name for p in new]
        path = new[0]
        sent = {body for sid, body in F.S.served if is_film(key, F.S.names.get(sid // 10))}
        tags = {".%s." % tag for tag in M.FILE_TAGS["en"]}
        problems = []
        if path.read_bytes() not in sent:
            problems.append("not the bytes the API sent")
        if not any(tag in path.name.lower() for tag in tags):
            problems.append("not named for English")
        if not self.log.wait_for("started playing, saved SubtitleDB's", 15):
            problems.append("no 'saved' line from the lookup")
        # Emby saves by asking the provider for the subtitle again; the plugin hands
        # back the bytes it fetched rather than downloading the file a second time.
        fetched = len(downloads(asked_for(key, since)))
        if fetched != 1:
            problems.append("downloaded %d times" % fetched)
        listed, end = False, time.time() + 60
        while not listed and time.time() < end:
            listed = any((s.get("Path") or "").endswith("/" + path.name)
                         for s in self.streams(self.item(key), external=True))
            if not listed:
                time.sleep(2)
        if not listed:
            problems.append("the server does not list it")
        return not problems, "saved %s%s" % (path.name, " | " + ", ".join(problems)
                                             if problems else ", listed")

    def judge_held(self, key, before, since):
        end = time.time() + 60
        while not downloads(asked_for(key, since)) and time.time() < end:
            time.sleep(0.5)
        fetched = len(downloads(asked_for(key, since)))
        new = self.new_file(key, before, 10)
        return fetched == 1 and not new, "fetched %d, saved %s" % (
            fetched, [p.name for p in new])

    def judge_asked(self, key, before, since):
        end = time.time() + 60
        while not asked_for(key, since) and time.time() < end:
            time.sleep(0.5)
        new = self.new_file(key, before, 10)
        asked = asked_for(key, since)
        return bool(asked) and not downloads(asked) and not new, "saved %s" % [
            p.name for p in new]

    def judge_unasked(self, key, before, since):
        new = self.new_file(key, before, 12)
        return not asked_for(key, since) and not new, "saved %s" % [p.name for p in new]

    def judge_failed(self, key, before, since):
        reason = DOWNLOADS[F.S.dl]
        said = self.log.wait_for("the lookup on play failed for", 60)
        lines = [line for line in self.log.lines() if "the lookup on play failed for" in line]
        new = self.new_file(key, before, 5)
        ok = said and len(lines) == 1 and reason in lines[0] and not new
        return ok, "%s | saved %s" % (lines[0].strip()[-160:] if lines else "no failure line",
                                      [p.name for p in new])

    def judge_search_failed(self, key, before, since):
        said = self.log.wait_for("search failed for", 60)
        new = self.new_file(key, before, 8)
        return said and not new, "%s | saved %s" % (
            "logged 'search failed'" if said else "no 'search failed' line",
            [p.name for p in new])


def run(kind, url, root: pathlib.Path, logs: pathlib.Path, api_base: str) -> int:
    server = M.Server(kind, url)
    info = server.wait_ready()
    print("%s %s" % (info.get("ProductName") or kind, info.get("Version")))
    server.login()
    F.serve("0.0.0.0")  # noqa: S104 - the server's container reaches it from outside
    edge = Edge(server, root, Log(kind, logs), api_base)
    print("plugin settings %s" % server.configure(edge.plugin, ApiBase=api_base,
                                                   LookUpOnPlay=True))
    edge.add_library()
    edge.wait_for_films()
    edge.set_library(SubtitleDownloadLanguages=["eng"])

    print("\n== the search dialog")
    edge.dialog_search("ok", rows=3)
    edge.dialog_search("refused", base=re.sub(r":\d+$", ":9", api_base), warns="cannot reach")
    edge.dialog_search("dns", base="http://subtitledb.invalid", warns="cannot reach")
    edge.dialog_search("hang", "hang", warns="timed out")
    edge.dialog_search("html503", "html503", warns="HTTP 503")
    edge.dialog_search("r429", "r429", warns="rate_limited")
    edge.dialog_search("notitle", "notitle")
    for mode in ("json_empty", "json_nulls"):
        edge.dialog_search(mode, mode)
    for mode in ("html200", "json_list", "json_badrows", "json_titlestr"):
        edge.dialog_search(mode, mode, warns="not JSON")
    for dl in ("ok", "404", "html200", "empty", "foreign", "hang"):
        edge.dialog_download(dl)

    print("\n== the lookup on play")
    edge.play("plain", "saved", "a film with no subtitles")
    edge.play("embedded", "saved", "a film with English subtitles inside it")
    edge.play("external", "saved", "a film with an English subtitle beside it")

    def held():
        F.S.body = HELD
    edge.play("held", "held", "a film that already has that subtitle", held)
    for dl in DOWNLOADS:
        def fail(dl=dl):
            F.S.dl = dl
        edge.play(dl, "failed", "download %s" % dl, fail)

    def down():
        F.S.mode = "html503"
    edge.play("search", "search failed", "search html503", down)

    print("\n== the library's rules and the setting")
    edge.set_library(RequirePerfectSubtitleMatch=True)
    edge.play("perfect other", "asked", "perfect match only, made for another release")

    def same():
        F.S.release_name = FILMS["perfect same"][1]
    edge.play("perfect same", "saved", "perfect match only, made for this release", same)
    edge.set_library(RequirePerfectSubtitleMatch=False)

    edge.set_library(SubtitleDownloadLanguages=[])
    edge.play("no languages", "unasked", "no download languages")
    edge.set_library(SubtitleDownloadLanguages=["eng"])

    edge.set_library(DisabledSubtitleFetchers=["SubtitleDB"])
    edge.play("not ticked", "unasked", "SubtitleDB not ticked for the library")
    edge.set_library(DisabledSubtitleFetchers=[])

    edge.set_library(SkipSubtitlesIfAudioTrackMatches=True)
    edge.play("audio", "unasked", "the audio is in the download language, which the library skips")
    edge.set_library(SkipSubtitlesIfAudioTrackMatches=False)

    server.configure(edge.plugin, LookUpOnPlay=False)
    edge.play("off", "unasked", "the lookup on play turned off")
    server.configure(edge.plugin, LookUpOnPlay=True)

    print("\n== RESULTS")
    for name, ok in RESULTS:
        print("%s  %s" % ("PASS" if ok else "FAIL", name))
    failures = sum(not ok for _, ok in RESULTS)
    print("%d of %d passed" % (len(RESULTS) - failures, len(RESULTS)))
    return failures


if __name__ == "__main__":
    if sys.argv[1] == "make":
        make(pathlib.Path(sys.argv[2]))
    else:
        sys.exit(1 if run(sys.argv[2], sys.argv[3], pathlib.Path(sys.argv[4]),
                          pathlib.Path(sys.argv[5]), sys.argv[6]) else 0)
