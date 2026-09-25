#!/usr/bin/env python3
"""Drive a live Kodi that has the SubtitleDB addon installed, over JSON-RPC.

    python3 kodi.py http://localhost:8080/jsonrpc /path/to/media ~/.kodi/temp/kodi.log

Kodi runs under Xvfb with its web server on. Every sample video is played two ways.
First by its path alone, which leaves the addon nothing but the file's name: a file
opened from a share or a stick. Then from the library, once Kodi has scanned the
media folders and read the NFO files beside the videos, which is how it knows the
ids: the route a user who keeps a library takes. The order matters, since a file
Kodi has in its library is played with the library's details even by path.

For each, this runs the addon the way Kodi's subtitle dialog does (the plugin://
search URL, then the download URL the search listed), once per language the sample
is asked for, and checks that the addon resolved the sample's own title by the
route expected, listed only the language asked, as many as its settings allow and
past the API's first page where the index holds more, and saved a subtitle file. For the
title the index has nothing for it must list nothing and log as much, and so must a
download the API refuses. The addon's own log lines, and any traceback, are printed
either way.

The NFO files make the scraper's own id the default, as Kodi's TMDB and TVDB
scrapers do, so the library route only passes if the addon reads the IMDb id by
name rather than the default one, and finds the episode with no IMDb id of its own
by its show's.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import sqlite3
import time
import urllib.parse
import urllib.request

import baseline
import media

ADDON = "service.subtitles.subtitledb"
STAMP = re.compile(r"^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d")
#: The rung the addon logs as having answered: "resolved to ... via <rung>, ...".
VIA = re.compile(r" via ([\w-]+)")
#: Kodi names languages in English in the search URL and in the addon's list.
KODI_NAMES = {"en": "English", "es": "Spanish", "pb": "Portuguese (Brazil)"}
BY_NAME = ("title",)
#: A download link the API answers with an error: there is no subtitle 0.
REFUSED = "https://api.thesubtitledb.org/get/0"


def by_library(sample: media.Sample) -> tuple[str, ...]:
    """The rungs that may answer for a sample played from the library. A film has its
    TMDB and IMDb ids, and TMDB leads; an episode has its own IMDb id or its show's."""
    if not sample.is_episode:
        return ("explicit-tmdb", "explicit-imdb")
    return ("explicit-imdb",) if sample.library_episode_imdb else ("series-imdb",)


class Failure(Exception):
    pass


def rpc(url, method, params=None, timeout=60):
    body = {"jsonrpc": "2.0", "id": 1, "method": method}
    if params is not None:
        body["params"] = params
    data = json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    request = urllib.request.Request(url, data=data, headers=headers)  # noqa: S310 - Kodi, local
    with urllib.request.urlopen(request, timeout=timeout) as reply:  # noqa: S310 - Kodi, local
        answer = json.loads(reply.read())
    if "error" in answer:
        raise Failure("%s: %s" % (method, answer["error"]))
    return answer.get("result")


def wait_ready(url, seconds=240):
    end, last = time.time() + seconds, None
    while time.time() < end:
        try:
            if rpc(url, "JSONRPC.Ping", timeout=5) == "pong":
                return
        except (Failure, OSError) as err:
            last = err
        time.sleep(2)
    raise Failure("Kodi's JSON-RPC never answered: %s" % last)


def enable_addon(url):
    details = rpc(url, "Addons.GetAddonDetails",
                  {"addonid": ADDON, "properties": ["enabled", "version", "broken"]})["addon"]
    if details.get("broken"):
        raise Failure("Kodi marked the addon broken: %s" % details["broken"])
    if not details.get("enabled"):
        # An addon dropped into the addons directory arrives disabled.
        rpc(url, "Addons.SetAddonEnabled", {"addonid": ADDON, "enabled": True})
    return details.get("version")


def search_url(language):
    return "plugin://%s/?%s" % (ADDON, urllib.parse.urlencode(
        {"action": "search", "languages": language, "preferredlanguage": language}))


def play(url, item, video, seconds=45):
    """Play `item` (a file, or a library id) and wait until it is `video` on screen."""
    rpc(url, "Player.Open", {"item": item})
    end = time.time() + seconds
    while time.time() < end:
        # The player that was stopped a moment ago can still be listed, so wait for
        # this file rather than for any player.
        for player in rpc(url, "Player.GetActivePlayers") or []:
            if player.get("type") != "video":
                continue
            playing = rpc(url, "Player.GetItem",
                          {"playerid": player["playerid"], "properties": ["file"]})["item"]
            if pathlib.PurePath(playing.get("file") or "").name == video.name:
                time.sleep(3)  # the VideoPlayer info labels fill in a moment after playback starts
                return player["playerid"]
        time.sleep(1)
    raise Failure("Kodi never started playing %s" % video.name)


def stop(url, player, seconds=15):
    rpc(url, "Player.Stop", {"playerid": player})
    end = time.time() + seconds
    while rpc(url, "Player.GetActivePlayers") and time.time() < end:
        time.sleep(0.5)


def looks_like_subtitles(path: pathlib.Path) -> bool:
    text = path.read_bytes()[:20000].decode("utf-8", "replace")
    return "-->" in text or "[Script Info]" in text or "{0}" in text or text.startswith("WEBVTT")


def resolved_line(log):
    """What the addon logged its last search as resolving to."""
    lines = [line for entry in addon_log(log) for line in entry if "resolved to" in line]
    return lines[-1].split("resolved to", 1)[1].strip() if lines else "nothing logged"


def check_video(url, item, video, sample, log, tiers):
    player = play(url, item, video)
    try:
        known = rpc(url, "Player.GetItem", {"playerid": player, "properties": [
            "title", "year", "showtitle", "season", "episode", "imdbnumber", "uniqueid",
            "tvshowid"]})["item"]
        print("  Kodi knows %s" % {k: v for k, v in known.items() if v not in ("", 0, -1, None)})
        for code in sample.languages:
            language = KODI_NAMES[code]
            started = time.time()
            listed = rpc(url, "Files.GetDirectory",
                         {"directory": search_url(language), "media": "files"}, timeout=180) or {}
            files = listed.get("files") or []
            print("  search %s %.1fs: %d listed" % (language, time.time() - started, len(files)))
            for entry in files[:3]:
                print("    %s | %s | %s" % (entry.get("label"), entry.get("label2", ""),
                                            entry.get("file", "")[:100]))
            said = resolved_line(log)
            print("  resolved to %s" % said)

            if not sample.known:
                if files:
                    raise Failure("the addon listed %d for %s, a title the index does not have"
                                  % (len(files), video.name))
                if not said.startswith("nothing"):
                    raise Failure("the addon resolved %s to %s, and should have found nothing"
                                  % (video.name, said))
                continue
            if not files:
                raise Failure("the addon listed nothing in %s for %s" % (language, video.name))
            via = VIA.search(said)
            if sample.imdb not in said or not via or via.group(1) not in tiers:
                raise Failure("the addon resolved %s to %s, expected %s via %s" % (
                    video.name, said, sample.imdb, " or ".join(tiers)))
            others = sorted({str(f.get("label")) for f in files if f.get("label") != language})
            if others:
                raise Failure("asked for %s, the addon also listed %s" % (language, others))
            problem = baseline.count_problem(len(files), code in sample.many)
            if problem:
                raise Failure("the addon %s in %s for %s" % (problem, language, video.name))

            fetched = rpc(url, "Files.GetDirectory",
                          {"directory": files[0]["file"], "media": "files"}, timeout=180) or {}
            saved = [pathlib.Path(f["file"]) for f in fetched.get("files") or []]
            if not saved or not saved[0].is_file():
                raise Failure("the download listed %s, which is not a file" % saved)
            print("  saved %s (%d bytes)" % (saved[0], saved[0].stat().st_size))
            if not looks_like_subtitles(saved[0]):
                raise Failure("%s does not read as a subtitle file" % saved[0].name)
    finally:
        stop(url, player)


def set_content(userdata: pathlib.Path, root: pathlib.Path):
    """Tell Kodi's video database that the media folders hold films and shows whose
    details are in the NFO files beside them.

    Kodi has no JSON-RPC call for this. Its "set content" dialog writes one row per
    folder into the path table of the video database, so this does the same, naming
    the scraper that reads NFO files and nothing else.
    """
    found = sorted(userdata.glob("Database/MyVideos*.db"))
    if not found:
        raise Failure("no video database under %s" % userdata)
    connection = sqlite3.connect(str(found[-1]), timeout=30)
    with connection:
        for folder, content, own_folders in (("movies", "movies", 1), ("tv", "tvshows", 0)):
            path = "%s/%s/" % (root, folder)
            connection.execute("DELETE FROM path WHERE strPath = ?", (path,))
            connection.execute(
                "INSERT INTO path (strPath, strContent, strScraper, scanRecursive, useFolderNames,"
                " strSettings, noUpdate, exclude) VALUES (?, ?, 'metadata.local', ?, ?, '', 0, 0)",
                (path, content, 2147483647, own_folders))
    connection.close()
    print("content set on %s" % found[-1].name)


def scan_library(url, userdata, root, samples, seconds=300):
    """Scan, then the library id of every sample video, by its file."""
    set_content(userdata, root)
    rpc(url, "VideoLibrary.Scan", {"showdialogs": False})
    end, ids = time.time() + seconds, {}
    while time.time() < end:
        ids = {}
        movies = rpc(url, "VideoLibrary.GetMovies", {"properties": ["file"]}) or {}
        episodes = rpc(url, "VideoLibrary.GetEpisodes", {"properties": ["file"]}) or {}
        by_name = {}
        for row in movies.get("movies") or []:
            by_name[pathlib.PurePath(row["file"]).name] = {"movieid": row["movieid"]}
        for row in episodes.get("episodes") or []:
            by_name[pathlib.PurePath(row["file"]).name] = {"episodeid": row["episodeid"]}
        for sample, video in samples:
            if video.name in by_name:
                ids[sample] = by_name[video.name]
        if len(ids) == len(samples):
            return ids
        time.sleep(5)
    missing = [video.name for sample, video in samples if sample not in ids]
    raise Failure("the library scan never found %s" % missing)


def set_count(userdata: pathlib.Path):
    """The addon's settings file, the way Kodi writes one, holding the count per
    language every host is set to. Kodi reads it the first time the addon asks for a
    setting, which is after enable_addon, so writing it first is in time."""
    folder = userdata / "addon_data" / ADDON
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "settings.xml").write_text(
        '<settings version="2">\n    <setting id="per_language">%d</setting>\n</settings>\n'
        % media.PER_LANGUAGE, encoding="utf-8")


def addon_log(log: pathlib.Path):
    """kodi.log entries that mention the addon, each with its continuation lines.

    An entry starts with a timestamp; a Python exception is one entry whose traceback
    follows on unstamped lines, so an entry is ours if the addon id is anywhere in it.
    """
    if not log.is_file():
        return []
    entries = []
    for line in log.read_text(encoding="utf-8", errors="replace").splitlines():
        if STAMP.match(line) or not entries:
            entries.append([line])
        else:
            entries[-1].append(line)
    return [entry for entry in entries if any(ADDON in line for line in entry)]


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("url")
    parser.add_argument("media", type=pathlib.Path)
    parser.add_argument("log", type=pathlib.Path)
    args = parser.parse_args(argv)
    root = args.media.resolve()
    userdata = args.log.resolve().parents[1] / "userdata"
    set_count(userdata)

    wait_ready(args.url)
    version = rpc(args.url, "Application.GetProperties", {"properties": ["version"]})["version"]
    print("Kodi %s.%s %s" % (version["major"], version["minor"], version.get("tag", "")))
    print("addon %s enabled" % enable_addon(args.url))

    failures = []
    # Playback can stop between the subtitle dialog opening and the search running.
    try:
        idle = rpc(args.url, "Files.GetDirectory",
                   {"directory": search_url("English"), "media": "files"})
        print("with nothing playing: %d listed" % len((idle or {}).get("files") or []))
    except Failure as err:
        print("  FAIL with nothing playing: %s" % err)
        failures.append(str(err))

    # A download the host refuses, as it does an expired link: the addon must say so
    # and end the listing. The HTTP error once escaped it as a traceback.
    refused = "plugin://%s/?%s" % (ADDON, urllib.parse.urlencode(
        {"action": "download", "id": 0, "format": "srt", "url": REFUSED}))
    try:
        got = rpc(args.url, "Files.GetDirectory", {"directory": refused, "media": "files"})
        if (got or {}).get("files"):
            raise Failure("a refused download listed %s" % got["files"])
        if not any("download failed" in line for entry in addon_log(args.log) for line in entry):
            raise Failure("a refused download logged no failure")
        print("a refused download: listed nothing, logged the failure")
    except Failure as err:
        print("  FAIL a refused download: %s" % err)
        failures.append(str(err))

    samples = list(zip(media.SAMPLES, media.videos(root)))
    print("By the file alone, before Kodi has a library:")
    for sample, video in samples:
        print("%s:" % video.name)
        try:
            check_video(args.url, {"file": str(video)}, video, sample, args.log, BY_NAME)
        except Failure as err:
            print("  FAIL %s" % err)
            failures.append(str(err))

    print("From the library:")
    try:
        ids = scan_library(args.url, userdata, root, samples)
    except Failure as err:
        print("  FAIL %s" % err)
        failures.append(str(err))
        ids = {}
    for sample, video in samples:
        if sample not in ids:
            continue
        print("%s %s:" % (video.name, ids[sample]))
        try:
            check_video(args.url, ids[sample], video, sample, args.log, by_library(sample))
        except Failure as err:
            print("  FAIL %s" % err)
            failures.append(str(err))

    entries = addon_log(args.log)
    print("kodi.log entries that mention the addon (%d):" % len(entries))
    for entry in entries[-60:]:
        for line in entry:
            print("  " + line)
    if any("Traceback" in line for entry in entries for line in entry):
        failures.append("a Python traceback from the addon in kodi.log")
    print("FAIL" if failures else "PASS")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
