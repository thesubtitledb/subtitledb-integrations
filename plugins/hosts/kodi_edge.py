#!/usr/bin/env python3
"""The Kodi addon against a fake API that fails in every way it can.

    python3 kodi_edge.py make <dir>                          writes the edge videos
    python3 kodi_edge.py run <jsonrpc url> <dir> <kodi.log>  runs every case

Kodi must be running with the addon's API address set to FAKE, where `run` serves the
fake, and with kodi/script.subtitledb.set installed, which changes an addon setting
while Kodi runs. Each case plays a video and reads what the addon logged. The last
case tells Kodi to quit while a lookup hangs. Exits 1 if any case failed.
"""

from __future__ import annotations

import http.server
import json
import pathlib
import socketserver
import subprocess
import sys
import threading
import time
import types
import urllib.parse
import zlib

import kodi as H

PORT = 8099
FAKE = "http://127.0.0.1:%d" % PORT
FILM = "films/The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv"
OTHER = "films2/Amelie.2001.1080p.BluRay.x264-GROUP.mkv"
SRT = ("1\n00:00:01,000 --> 00:00:30,000\nSubtitleDB test %d\n\n"
       "2\n00:01:00,000 --> 00:02:00,000\nSecond cue\n")
#: Kodi waits this long for a script to stop before it kills it.
STOP_S = 5
#: A slow answer, inside the 4 s the lookup on play waits for one. The timing cases
#: delay the lookup and the download by this, to switch videos between them.
SLOW_S = 3.0


# -- media ---------------------------------------------------------------------


def ffmpeg(*args):
    subprocess.run(  # noqa: S603 - fixed arguments bar the paths
        ["ffmpeg", "-loglevel", "error", "-y", *args],  # noqa: S607 - ffmpeg from PATH
        check=True)


def video(path: pathlib.Path, seconds: int, sub_lang: str | None = None):
    path.parent.mkdir(parents=True, exist_ok=True)
    args = ["-f", "lavfi", "-i", "color=c=black:s=320x240:r=1",
            "-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono"]
    maps = ["-map", "0:v", "-map", "1:a"]
    srt = path.with_suffix(".tmp.srt")
    if sub_lang is not None:
        srt.write_text(SRT % 1, encoding="utf-8")
        args += ["-i", str(srt)]
        maps += ["-map", "2:s", "-c:s", "srt", "-metadata:s:s:0", "language=" + sub_lang]
    ffmpeg(*args, *maps, "-t", str(seconds), "-c:v", "libx264", "-preset", "ultrafast",
           "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "8k", str(path))
    if sub_lang is not None:
        srt.unlink()


def make(root: pathlib.Path):
    """Films long enough to be looked up, and the videos that must not be."""
    video(root / FILM, 400)
    video(root / OTHER, 400)
    video(root / "eng/The.Matrix.1999.1080p.BluRay.x264-ENG.mkv", 400, "eng")
    video(root / "und/The.Matrix.1999.1080p.BluRay.x264-UND.mkv", 400, "und")
    video(root / "fre/The.Matrix.1999.1080p.BluRay.x264-FRE.mkv", 400, "fre")
    video(root / "ext/The.Matrix.1999.1080p.BluRay.x264-EXT.mkv", 400)
    (root / "ext/The.Matrix.1999.1080p.BluRay.x264-EXT.en.srt").write_text(SRT % 9,
                                                                            encoding="utf-8")
    video(root / "clip/The.Matrix.1999.Trailer.1080p.mkv", 60)
    (root / "audio").mkdir(parents=True, exist_ok=True)
    ffmpeg("-f", "lavfi", "-i", "anullsrc=r=8000:cl=mono", "-t", "400", "-c:a", "aac",
           "-b:a", "8k", str(root / "audio/The.Matrix.1999.Soundtrack.m4a"))


# -- the fake API ------------------------------------------------------------------

S = types.SimpleNamespace(
    mode="ok",        # how lookups are answered
    dl="ok",          # how downloads are answered
    langs={"en"},     # the languages the fake holds subtitles in
    delay=0.0,        # seconds before a lookup or a download is answered
    requests=[],      # (time, path) of every API request
    release=threading.Event(),  # frees handlers that hang
    media=pathlib.Path("."),
    release_name="",  # the release the first row of every lookup was made for
    body=None,        # what every download sends instead of its own subtitle
    names={},         # title per subtitle id, for by-subid and to tell who asked
    served=[],        # (subtitle id, bytes) of every download answered
)

#: A 200 that is not what the addon asked for, by mode.
BROKEN = {
    "html200": "<!DOCTYPE html><html><body>Maintenance</body></html>",
    "json_empty": "{}",
    "json_nulls": json.dumps({"title": None, "subtitles": None}),
    "json_list": "[]",
    "json_badrows": json.dumps({
        "title": {"name": "The Matrix", "year": 1999, "imdb": "tt0133093"},
        "subtitles": {"items": [{"id": "x", "language": None}], "total": 1}}),
    # Past what the client checks, so the addon's last-resort catches are what is tested.
    "json_titlestr": json.dumps({"title": "The Matrix", "subtitles": {"items": [], "total": 0}}),
}


def sid_for(q: str) -> int:
    """A stable id per title, so two films get different subtitles."""
    return zlib.crc32(q.encode("utf-8")) % 90000 + 10000


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def send(self, code, body, ctype="application/json", headers=()):
        data = body if isinstance(body, bytes) else body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        for key, value in headers:
            self.send_header(key, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        url = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(url.query))
        if url.path.startswith("/media/"):
            return self.serve_media(urllib.parse.unquote(url.path[len("/media/"):]))
        S.requests.append((time.time(), self.path))
        if S.delay:
            time.sleep(S.delay)
        if url.path.startswith("/get/"):
            return self.download(int(url.path.rsplit("/", 1)[1]))
        if S.mode == "hang":
            S.release.wait(600)
            return None
        if S.mode == "html503":
            return self.send(503, "<html><body>Error 521: web server is down</body></html>",
                             "text/html")
        if S.mode == "r429":
            return self.send(429, json.dumps({"error": "rate_limited"}),
                             headers=[("Retry-After", "1")])
        if S.mode == "notitle":
            return self.send(404, json.dumps({"error": "not_found", "message": "no title"}))
        if S.mode in BROKEN:
            return self.send(200, BROKEN[S.mode],
                             "text/html" if S.mode == "html200" else "application/json")
        # The address the caller reached the fake by, so a download stays on the host
        # it asked: a server in a container reaches it by another name than Kodi does.
        base = "http://" + (self.headers.get("Host") or "127.0.0.1:%d" % PORT)
        if url.path.startswith("/v1/by-subid/"):
            rid = int(url.path.rsplit("/", 1)[1])
            name = S.names.get(rid // 10, "The Matrix")
            return self.send(200, json.dumps({
                "title": {"name": name, "year": 1999, "kind": "movie"},
                "subtitle": self.row(base, rid // 10, rid % 10, "en")}))
        name = q.get("q") or "The Matrix"
        sid = sid_for(name)
        S.names[sid] = name
        lang = q.get("lang") or "en"
        rows = []
        if lang in S.langs:
            rows = [self.row(base, sid, i, lang) for i in range(3)]
        return self.send(200, json.dumps({
            "title": {"name": name, "year": 1999, "imdb": "tt%07d" % sid, "kind": "movie"},
            "subtitles": {"items": rows, "total": len(rows)}}))

    @staticmethod
    def row(base, sid, i, lang):
        return {"id": sid * 10 + i, "language": lang, "format": "srt", "cues": 900 - i,
                "downloads": 10, "release_name": S.release_name if i == 0 else "",
                "hearing_impaired": False, "download_url": "%s/get/%d" % (base, sid * 10 + i)}

    def download(self, sid):
        if S.dl == "404":
            return self.send(404, json.dumps({"error": "not_found"}))
        if S.dl == "html200":
            return self.send(200, "<!DOCTYPE html><html><body>Blocked</body></html>", "text/html")
        if S.dl == "empty":
            return self.send(200, b"", "application/x-subrip")
        if S.dl == "foreign":
            return self.send(302, "", "text/plain", [("Location", "http://example.com/x.srt")])
        if S.dl == "hang":
            S.release.wait(600)
            return None
        body = (SRT % sid).encode("utf-8") if S.body is None else S.body
        S.served.append((sid, body))
        return self.send(200, body, "application/x-subrip")

    def serve_media(self, rel):
        """A video over HTTP, with the byte ranges Kodi seeks by."""
        path = S.media / rel
        size = path.stat().st_size
        start, end, code = 0, size - 1, 200
        rng = self.headers.get("Range") or ""
        if rng.startswith("bytes="):
            first, _, last = rng[6:].partition("-")
            start = int(first) if first else 0
            end = min(int(last), size - 1) if last else size - 1
            code = 206
        with open(path, "rb") as fh:
            fh.seek(start)
            data = fh.read(end - start + 1)
        headers = [("Accept-Ranges", "bytes")]
        if code == 206:
            headers.append(("Content-Range", "bytes %d-%d/%d" % (start, start + len(data) - 1,
                                                                 size)))
        return self.send(code, data, "video/x-matroska", headers)


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def serve(host="127.0.0.1"):
    srv = Server((host, PORT), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# -- driving Kodi ----------------------------------------------------------------------

RESULTS: list[tuple[str, bool, str]] = []


def record(case, ok, saw):
    RESULTS.append((case, ok, saw))
    print("%s  %s: %s" % ("PASS" if ok else "FAIL", case, saw), flush=True)


def tracebacks(log):
    return sum(1 for entry in H.addon_log(log) for line in entry if "Traceback" in line)


def wait_line(log, seen, seconds):
    """The on-play line after the first ``seen``, or None if none comes in time."""
    end = time.time() + seconds
    while time.time() < end:
        got = H.on_play(log)
        if len(got) > seen:
            return got[seen]
        time.sleep(0.5)
    return None


def open_and_wait(url, file, kind="video", seconds=45):
    H.rpc(url, "Player.Open", {"item": {"file": file}})
    name = file.rsplit("/", 1)[-1]
    end = time.time() + seconds
    while time.time() < end:
        for player in H.rpc(url, "Player.GetActivePlayers") or []:
            if player.get("type") != kind:
                continue
            item = H.rpc(url, "Player.GetItem",
                         {"playerid": player["playerid"], "properties": ["file"]})["item"]
            if (item.get("file") or "").endswith(name):
                return player["playerid"]
        time.sleep(0.5)
    raise H.Failure("Kodi never started playing %s" % name)


def stop_all(url):
    for player in H.rpc(url, "Player.GetActivePlayers") or []:
        H.stop(url, player["playerid"])


def showing(url, player, seconds=10):
    """The subtitle on screen. Kodi opens one handed to setSubtitles on its own thread
    after the call returns, so this waits up to ``seconds`` for it to have a name."""
    end = time.time() + seconds
    while True:
        props = H.rpc(url, "Player.GetProperties", {"playerid": player, "properties": [
            "subtitleenabled", "currentsubtitle", "subtitles"]})
        current = props.get("currentsubtitle") or {}
        if current.get("name") or time.time() > end:
            return {"on": props.get("subtitleenabled"), "lang": current.get("language"),
                    "name": current.get("name"), "streams": len(props.get("subtitles") or [])}
        time.sleep(0.5)


def still_playing(url, player):
    """True when the clock moves: the lookup did not hold playback up."""
    def now():
        t = H.rpc(url, "Player.GetProperties", {"playerid": player, "properties": ["time"]})["time"]
        return t["hours"] * 3600 + t["minutes"] * 60 + t["seconds"]
    first = now()
    time.sleep(2.5)
    return now() > first


def set_addon(url, log, setting, value, seconds=30):
    """Set one of the addon's settings and wait until script.subtitledb.set logs it saved.

    Addons.ExecuteAddon returns once Kodi has started the script, not once it has run.
    Each run saves every setting as it read them, so two at once lose one change: on
    Kodi 19 the lookup kept the old address, or stayed off for the rest of the run.
    """
    said = "[script.subtitledb.set] %s=%s" % (setting, value)

    def count():
        return sum(1 for line in log.read_text(encoding="utf-8", errors="replace").splitlines()
                   if line.rstrip().endswith(said))

    before, t0 = count(), time.time()
    H.rpc(url, "Addons.ExecuteAddon", {"addonid": "script.subtitledb.set", "wait": True,
                                       "params": {"id": setting, "value": value}})
    while count() <= before:
        if time.time() > t0 + seconds:
            raise H.Failure("script.subtitledb.set never set %s=%s" % (setting, value))
        time.sleep(0.25)
    print("set %s=%s in %.1fs" % (setting, value, time.time() - t0), flush=True)


def lookups(n):
    return [path for _, path in S.requests[n:]]


def in_flight(n, seconds=60):
    """Wait until the addon has asked the fake for a lookup since request ``n``.

    Kodi reports a file playing seconds before onAVStarted fires under software
    rendering, so a fixed sleep can switch or stop before the lookup has begun.
    """
    end = time.time() + seconds
    while time.time() < end:
        if any(p.startswith("/v1/") for p in lookups(n)):
            return
        time.sleep(0.2)
    raise H.Failure("the addon never asked for a lookup")


def play_case(url, log, file, wait, kind="video"):
    """Play, wait for the on-play line; what it said, how long, what the fake was asked,
    and how many new tracebacks the addon logged."""
    seen, n, tb = len(H.on_play(log)), len(S.requests), tracebacks(log)
    t0 = time.time()
    player = open_and_wait(url, file, kind)
    line = wait_line(log, seen, wait)
    return player, line, round(time.time() - t0, 1), lookups(n), tracebacks(log) - tb


def reset():
    S.mode, S.dl, S.delay, S.langs = "ok", "ok", 0.0, {"en"}
    S.release.set()
    time.sleep(0.5)
    S.release.clear()


def run(url, root: pathlib.Path, log: pathlib.Path) -> int:
    S.media = root
    srv = serve()
    H.wait_ready(url)
    version = H.rpc(url, "Application.GetProperties", {"properties": ["version"]})["version"]
    print("Kodi %s" % version)
    print("addon %s enabled" % H.enable_addon(url))
    H.rpc(url, "Addons.SetAddonEnabled", {"addonid": "script.subtitledb.set", "enabled": True})
    H.wait_started(log)
    film, other = str(root / FILM), str(root / OTHER)

    def case(name, file, expect, wait=30, setup=None, check=None, kind="video"):
        """``expect(line, asked, tracebacks)`` judges the line; ``check(player)``, when
        given, judges the player and says what it saw."""
        if setup:
            setup()
        try:
            player, line, took, asked, tb = play_case(url, log, file, wait, kind)
            good, saw = check(player) if check else (True, "")
            record(name, expect(line, asked, tb) and good,
                   "%s | %.1fs | asked %d %s | tracebacks %d %s" % (
                       line, took, len(asked), [p.split("?")[0] for p in asked][:4], tb, saw))
        except Exception as err:  # a case that breaks is a result too
            record(name, False, "driver error: %r" % err)
        finally:
            stop_all(url)
            reset()

    def loaded(line, asked, tb):
        return bool(line) and line.startswith("loaded ") and tb == 0

    def failed(line, asked, tb):
        return bool(line) and line.startswith("the lookup failed") and tb == 0

    def nothing(line, asked, tb):
        return bool(line) and line.startswith("nothing loaded") and tb == 0

    def unasked(line, asked, tb):
        return bool(line) and line.startswith("nothing loaded") and not asked and tb == 0

    def caught(line, asked, tb):
        # The service's last-resort catch logged it, and the next cases show it lives on.
        return bool(line) and line.startswith("Traceback") and tb == 1

    def silent(line, asked, tb):
        return line is None and not asked and tb == 0

    def shows(lang):
        def check(player):
            sh = showing(url, player)
            return bool(sh["on"]) and sh["lang"] == lang, "| shows %s" % sh
        return check

    def playing(player):
        moving = still_playing(url, player)
        return moving, "| playback %s" % ("moving" if moving else "STUCK")

    print("\n== the API answers")
    case("ok: a film loads English", film, loaded, check=shows("eng"))

    print("\n== the setting")
    set_addon(url, log, "instant", "false")
    case("off: nothing asked, nothing logged", film, silent, wait=10)
    set_addon(url, log, "instant", "true")
    case("back on: loads again without a restart", film, loaded)

    print("\n== the API down or broken")
    srv.shutdown()
    srv.server_close()
    case("refused: nothing listening", film, failed, wait=60, check=playing)
    srv = serve()
    set_addon(url, log, "api_base", "http://api.invalid")
    case("dns: the name does not resolve", film, failed, wait=60, check=playing)
    set_addon(url, log, "api_base", FAKE)

    def hang():
        S.mode = "hang"
    case("hang: the API never answers", film, failed, wait=120, setup=hang, check=playing)

    for mode, expect in (("html503", failed), ("html200", failed), ("r429", failed),
                         ("notitle", nothing), ("json_empty", nothing),
                         ("json_nulls", nothing), ("json_list", failed),
                         ("json_badrows", failed), ("json_titlestr", caught)):
        def setup(mode=mode):
            S.mode = mode
        case("api %s" % mode, film, expect, wait=60, setup=setup)

    for dl in ("404", "html200", "empty", "foreign", "hang"):
        def setup(dl=dl):
            S.dl = dl
        case("download %s" % dl, film, failed, wait=60, setup=setup)

    print("\n== playback")
    case("embedded English subtitles",
         str(root / "eng/The.Matrix.1999.1080p.BluRay.x264-ENG.mkv"), unasked)
    case("embedded subtitles with no language",
         str(root / "und/The.Matrix.1999.1080p.BluRay.x264-UND.mkv"), unasked)
    case("embedded French only, English wanted",
         str(root / "fre/The.Matrix.1999.1080p.BluRay.x264-FRE.mkv"), loaded, check=shows("eng"))
    case("an .en.srt beside the video",
         str(root / "ext/The.Matrix.1999.1080p.BluRay.x264-EXT.mkv"), unasked)
    case("a 60 s trailer", str(root / "clip/The.Matrix.1999.Trailer.1080p.mkv"), unasked)
    case("audio only", str(root / "audio/The.Matrix.1999.Soundtrack.m4a"), silent, wait=10,
         kind="audio")
    case("a stream known only by its name", "%s/media/%s" % (FAKE, FILM), unasked)

    def es_then_en():
        H.rpc(url, "Settings.SetSettingValue",
              {"setting": "subtitles.languages", "value": ["Spanish", "English"]})
    case("Spanish first, only English held", film, loaded, setup=es_then_en, check=shows("eng"))

    def es_only():
        H.rpc(url, "Settings.SetSettingValue",
              {"setting": "subtitles.languages", "value": ["Spanish"]})
        S.langs = {"es"}
    case("Spanish wanted and held", film, loaded, setup=es_only, check=shows("spa"))
    H.rpc(url, "Settings.SetSettingValue", {"setting": "subtitles.languages", "value": ["English"]})

    print("\n== timing")
    # A second video before the first one's lookup is back: the first must not land on it.
    seen, tb = len(H.on_play(log)), tracebacks(log)
    S.delay = SLOW_S
    try:
        n = len(S.requests)
        open_and_wait(url, film)
        in_flight(n)
        pb = open_and_wait(url, other)
        first, second = wait_line(log, seen, 40), wait_line(log, seen + 1, 40)
        sh = showing(url, pb)
        ok = (bool(first) and first.startswith("the video changed before")
              and bool(second) and second.startswith("loaded ") and "Amelie" in second
              and sh["on"] and sh["name"]
              and second.split()[1].split(".")[0].split("-")[1] in sh["name"]
              and tracebacks(log) == tb)
        record("switched video before the lookup was back", ok,
               "%s || %s || %s" % (first, second, sh))
    except Exception as err:
        record("switched video before the lookup was back", False, "driver error: %r" % err)
    finally:
        stop_all(url)
        reset()

    seen, tb = len(H.on_play(log)), tracebacks(log)
    S.delay = SLOW_S
    try:
        n = len(S.requests)
        player = open_and_wait(url, film)
        in_flight(n)
        H.stop(url, player)
        line = wait_line(log, seen, 40)
        record("stopped before the lookup was back",
               bool(line) and line.startswith("the video changed before")
               and tracebacks(log) == tb, str(line))
    except Exception as err:
        record("stopped before the lookup was back", False, "driver error: %r" % err)
    finally:
        stop_all(url)
        reset()

    print("\n== the subtitle dialog")
    # The on-play lookup off, so what the log says is the dialog's alone.
    set_addon(url, log, "instant", "false")
    for label, setup, want_tb in (("API down", "down", 0), ("API sends a list", "json_list", 0),
                                  ("API sends a string title", "json_titlestr", 1)):
        tb = tracebacks(log)
        if setup == "down":
            srv.shutdown()
            srv.server_close()
        else:
            S.mode = setup
        try:
            open_and_wait(url, film)
            time.sleep(3)  # the player's labels settle after the file opens
            listed = H.rpc(url, "Files.GetDirectory", {"directory": H.search_url("English"),
                                                       "media": "files"}, timeout=120) or {}
            said = [line for entry in H.addon_log(log)[-6:] for line in entry
                    if "search failed" in line]
            new_tb = tracebacks(log) - tb
            record("dialog: %s" % label,
                   not listed.get("files") and bool(said) and new_tb == want_tb,
                   "listed %d | %s | tracebacks %d" % (
                       len(listed.get("files") or []),
                       said[-1][-120:] if said else "no 'search failed' line", new_tb))
        except Exception as err:
            record("dialog: %s" % label, False, "driver error: %r" % err)
        finally:
            stop_all(url)
            if setup == "down":
                srv = serve()
            reset()
    set_addon(url, log, "instant", "true")

    print("\n== a malformed API address")
    set_addon(url, log, "api_base", "not a url")
    case("api_base 'not a url'", film, failed, wait=30)
    set_addon(url, log, "api_base", FAKE)

    print("\n== Kodi told to quit while a lookup hangs")
    # Last, as it ends Kodi. The fake hangs on until this process ends, so what Kodi
    # waits for is the addon's lookup, not a socket the fake closed.
    S.mode = "hang"
    try:
        n = len(S.requests)
        open_and_wait(url, film)
        in_flight(n)
        t0 = time.time()
        try:
            H.rpc(url, "Application.Quit", timeout=10)
        except Exception:
            pass  # Kodi may close the connection as it stops its web server
        said = []
        while time.time() < t0 + 90 and not any("termination took" in s for s in said):
            time.sleep(0.5)
            said = [s.split("on_play.py): ", 1)[1] for s in
                    log.read_text(encoding="utf-8", errors="replace").splitlines()
                    if "on_play.py): " in s and ("termination took" in s or "didn't stop" in s)]
        took = [int(s.split("took ")[1].split("ms")[0]) for s in said if "termination took" in s]
        record("quit while a lookup hangs",
               bool(took) and took[0] < STOP_S * 1000 and not any("didn't stop" in s for s in said),
               "%.1fs | %s" % (time.time() - t0, " | ".join(said) or "the addon never stopped"))
    except Exception as err:
        record("quit while a lookup hangs", False, "driver error: %r" % err)

    print("\n== RESULTS")
    for name, ok, _ in RESULTS:
        print("%s  %s" % ("PASS" if ok else "FAIL", name))
    failures = sum(not ok for _, ok, _ in RESULTS)
    print("%d of %d passed" % (len(RESULTS) - failures, len(RESULTS)))
    return failures


if __name__ == "__main__":
    if sys.argv[1] == "make":
        make(pathlib.Path(sys.argv[2]))
    else:
        sys.exit(1 if run(sys.argv[2], pathlib.Path(sys.argv[3]), pathlib.Path(sys.argv[4]))
                 else 0)
