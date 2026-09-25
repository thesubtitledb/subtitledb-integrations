#!/usr/bin/env python3
"""Drive a live Jellyfin or Emby that has the SubtitleDB plugin installed.

    python3 mediaserver.py jellyfin http://localhost:8096 /path/to/media [--repository URL]
    python3 mediaserver.py emby     http://localhost:8096 /path/to/media

The server runs in a container with the media directory mounted at /media. This does
what a user does: finishes the setup wizard, installs the plugin from the repository
at URL when given one and restarts, adds a film library and a show library,
waits for the scan, then for each item asks the server for subtitles in each of the
sample's languages (the call its subtitle search dialog makes) and downloads the
first one SubtitleDB offered. It fails unless the plugin loaded and kept the count
per language it was set to; every row offered is in the language asked and is one
the index holds for the sample's own film or episode; no more rows were offered than
that count, and more than the API's first page of 100 where the index holds more;
the file landed beside the video named for that language; and for the title the
index has nothing for, the plugin offered nothing.

The libraries fetch nothing online, so the server holds the ids the NFO files give
and no more: an episode scraped from TVDB with no IMDb id of its own has to be found
by its series' id. Left on, the fetchers fill that id in and the route goes untested.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

import baseline
import media
from subtitledb import Client

CLIENT = 'MediaBrowser Client="subtitledb-ci", Device="ci", DeviceId="subtitledb-ci", Version="1.0"'
USER, PASSWORD = "ci", "ci-password"
PROVIDER = "SubtitleDB"
SUBTITLE_SUFFIXES = (".srt", ".ass", ".ssa", ".sub", ".vtt")
#: Both servers ask in ISO 639-2 codes, and spell Brazilian Portuguese "pob".
ALPHA3 = {"en": "eng", "es": "spa", "pb": "pob"}
#: What the saved file may be tagged with for each language.
FILE_TAGS = {"en": ("eng", "en"), "es": ("spa", "es"), "pb": ("pob", "pb", "pt-br", "por-br")}
#: No metadata or image fetcher for any type either library holds.
NO_FETCHERS = [{"Type": kind, "MetadataFetchers": [], "MetadataFetcherOrder": [],
                "ImageFetchers": [], "ImageFetcherOrder": []}
               for kind in ("Movie", "Series", "Season", "Episode")]


class Failure(Exception):
    pass


class Server:
    def __init__(self, kind: str, base: str):
        self.kind = kind
        self.base = base.rstrip("/")
        self.token = ""
        self.user_id = ""

    def call(self, method, path, body=None, query=None, ok=(200, 204), timeout=120):
        url = self.base + path + ("?" + urllib.parse.urlencode(query) if query else "")
        auth = CLIENT + (', Token="%s"' % self.token if self.token else "")
        # Jellyfin reads Authorization, Emby reads the X-Emby pair; each ignores the other.
        headers = {"Accept": "application/json", "Authorization": auth,
                   "X-Emby-Authorization": auth}
        if self.token:
            headers["X-Emby-Token"] = self.token
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(  # noqa: S310 - a server on localhost
            url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as reply:  # noqa: S310 - local
                raw, status = reply.read(), reply.status
        except urllib.error.HTTPError as err:
            raw, status = err.read(), err.code
        if status not in ok:
            said = raw[:400].decode("utf-8", "replace")
            raise Failure("%s %s answered %s: %s" % (method, path, status, said))
        return json.loads(raw) if raw[:1] in (b"{", b"[") else None

    def wait_ready(self, seconds=300):
        end, last = time.time() + seconds, None
        while time.time() < end:
            try:
                info = self.call("GET", "/System/Info/Public", timeout=10)
                # Jellyfin adds StartupWizardCompleted once it can be set up. Emby's
                # public info never carries it, and answering is all it has to do.
                if info and info.get("Version") and (
                        self.kind == "emby" or info.get("StartupWizardCompleted") is not None):
                    return info
                last = "it answered %s" % info
            except (Failure, OSError) as err:
                last = err
            time.sleep(3)
        raise Failure("the server was not ready: %s" % last)

    def setup(self):
        config = {"UICulture": "en-US", "MetadataCountryCode": "US",
                  "PreferredMetadataLanguage": "en"}
        # The wizard endpoints answer 503 for a while after the public info does.
        end = time.time() + 120
        while True:
            try:
                self.call("POST", "/Startup/Configuration", config)
                break
            except Failure:
                if time.time() > end:
                    raise
                time.sleep(3)
        self.call("GET", "/Startup/User")
        self.call("POST", "/Startup/User", {"Name": USER, "Password": PASSWORD})
        remote = {"EnableRemoteAccess": True, "EnableAutomaticPortMapping": False}
        self.call("POST", "/Startup/RemoteAccess", remote, ok=(200, 204, 404))
        self.call("POST", "/Startup/Complete")

    def login(self):
        reply = self.call("POST", "/Users/AuthenticateByName", {"Username": USER, "Pw": PASSWORD})
        self.token = reply["AccessToken"]
        self.user_id = reply["User"]["Id"]

    def install(self, manifest):
        """Install from a repository the way Jellyfin's catalog does, then restart. A
        copied folder skips all of what this runs through: the manifest parsing, the
        ABI filter, the MD5 check and the unpacking."""
        self.call("POST", "/Repositories", [{"Name": PROVIDER, "Url": manifest, "Enabled": True}])
        listed = [p for p in self.call("GET", "/Packages") or [] if p.get("name") == PROVIDER]
        if not listed:
            raise Failure("the catalog has no %s after adding %s" % (PROVIDER, manifest))
        print("catalog %s %s" % (PROVIDER, [v.get("version") for v in listed[0]["versions"]]))
        self.call("POST", "/Packages/Installed/" + PROVIDER,
                  query={"assemblyGuid": listed[0]["guid"], "repositoryUrl": manifest})
        self.call("POST", "/System/Restart")
        # The old process answers for a moment after it is asked to go.
        end = time.time() + 60
        while time.time() < end:
            try:
                self.call("GET", "/System/Info/Public", timeout=5)
            except (Failure, OSError):
                break
            time.sleep(0.5)
        else:
            raise Failure("asked to restart, the server never went down")
        self.wait_ready()

    def plugin(self):
        plugins = self.call("GET", "/Plugins") or []
        ours = [p for p in plugins if p.get("Name") == PROVIDER]
        if not ours:
            names = [p.get("Name") for p in plugins]
            raise Failure("%s is not loaded; the server lists %s" % (PROVIDER, names))
        # Jellyfin says Active, NotSupported or Malfunctioned; Emby has no status.
        status = ours[0].get("Status")
        if status not in (None, "Active"):
            raise Failure("%s loaded as %s" % (PROVIDER, status))
        return ours[0]

    def configure(self, plugin, **settings):
        """Change the plugin's settings the way its settings page does, then read them
        back: a setting the server does not keep is dropped without a word."""
        path = "/Plugins/%s/Configuration" % plugin["Id"]
        config = self.call("GET", path) or {}
        config.update(settings)
        self.call("POST", path, config)
        held = self.call("GET", path) or {}
        wrong = {k: held.get(k) for k, v in settings.items() if held.get(k) != v}
        if wrong:
            raise Failure("%s kept %s after being set to %s" % (PROVIDER, wrong, settings))
        return held

    def add_library(self, name, collection, path):
        query = {"name": name, "collectionType": collection, "paths": path,
                 "refreshLibrary": "false"}
        options = {"EnableRealtimeMonitor": False, "TypeOptions": NO_FETCHERS}
        body = {"LibraryOptions": options}
        if self.kind == "emby":
            options["PathInfos"] = [{"Path": path}]
            body.update({"Name": name, "CollectionType": collection, "Paths": [path]})
        self.call("POST", "/Library/VirtualFolders", body, query)

    def items(self, **extra):
        query = {"Recursive": "true", "IncludeItemTypes": "Movie,Episode",
                 "Fields": "ProviderIds,Path,MediaStreams", **extra}
        if self.kind == "jellyfin":
            query["userId"] = self.user_id
            path = "/Items"
        else:
            path = "/Users/%s/Items" % self.user_id
        return (self.call("GET", path, query=query) or {}).get("Items") or []

    def search(self, item, alpha3):
        found = self.call("GET", "/Items/%s/RemoteSearch/Subtitles/%s" % (item["Id"], alpha3)) or []
        return found, [s for s in found if s.get("ProviderName") == PROVIDER]

    def download(self, item, subtitle):
        path = "/Items/%s/RemoteSearch/Subtitles/%s" % (
            item["Id"], urllib.parse.quote(subtitle["Id"], safe=""))
        self.call("POST", path)


def looks_like_subtitles(path: pathlib.Path) -> bool:
    text = path.read_bytes()[:20000].decode("utf-8", "replace")
    return "-->" in text or "[Script Info]" in text or "{0}" in text or text.startswith("WEBVTT")


def ids_of(item) -> dict[str, str]:
    """An item's provider ids, keyed in lower case: the servers differ in case."""
    return {str(k).lower(): str(v) for k, v in (item.get("ProviderIds") or {}).items()}


def library_ids(sample) -> dict[str, str]:
    """The ids the NFO files give a sample's own item."""
    if not sample.known:
        return {}
    if not sample.is_episode:
        return {"imdb": sample.imdb, "tmdb": str(sample.tmdb)}
    out = {"tvdb": str(sample.episode_tvdb)}
    if sample.library_episode_imdb:
        out["imdb"] = sample.library_episode_imdb
    return out


def wait_for_items(server, wanted, seconds=300, ids_grace=60):
    """Every item, once the scan has it, and its ids once the NFO files are read.

    The ids get a short grace of their own; an item without them is still searched
    for, and fails its check with what the server holds instead.
    """
    end, all_found_at, found = time.time() + seconds, None, {}
    while time.time() < end:
        found = {}
        for item in server.items():
            for video in wanted:
                if (item.get("Path") or "").endswith(video.name):
                    found[video] = item
        if len(found) == len(wanted):
            all_found_at = all_found_at or time.time()
            if all(library_ids(wanted[video]).items() <= ids_of(item).items()
                   for video, item in found.items()):
                return found
            if time.time() - all_found_at > ids_grace:
                return found
        time.sleep(5)
    raise Failure("the scan never found %s" % [v.name for v in wanted if v not in found])


def row_language(subtitle):
    # Jellyfin's RemoteSubtitleInfo names the field one way, Emby's the other.
    return subtitle.get("ThreeLetterISOLanguageName") or subtitle.get("Language")


def row_id(subtitle) -> int | None:
    """The API's row id behind a result. The servers prefix the plugin's own id with
    the provider's hash, and Emby with the language as well."""
    try:
        return int(str(subtitle.get("Id")).rsplit("_", 1)[-1])
    except ValueError:
        return None


def check_ids(server, video, sample, item):
    """That the server holds what the NFO files say, and for an episode with no id of
    its own, nothing more: otherwise the check below tests some other route."""
    ids, want = ids_of(item), library_ids(sample)
    print("  ids %s" % json.dumps(item.get("ProviderIds") or {}, sort_keys=True))
    wrong = {k: ids.get(k) for k, v in want.items() if ids.get(k) != v}
    if wrong:
        raise Failure("the server holds %s for %s, the NFO says %s" % (
            wrong, video.name, {k: want[k] for k in wrong}))
    if not sample.is_episode:
        return
    if "imdb" in ids and not sample.library_episode_imdb:
        raise Failure("the server gave %s an IMDb id of its own, %s, so the series-id "
                      "route went untested" % (video.name, ids["imdb"]))
    series = server.items(Ids=item.get("SeriesId"), IncludeItemTypes="Series")
    held = ids_of(series[0]) if series else {}
    print("  series ids %s" % json.dumps(held, sort_keys=True))
    if held.get("imdb") != sample.imdb:
        raise Failure("the server holds %s as the IMDb id of the series of %s, the NFO "
                      "says %s" % (held.get("imdb"), video.name, sample.imdb))


def check_item(server, client, video, sample, item):
    check_ids(server, video, sample, item)
    for code in sample.languages:
        alpha3 = ALPHA3[code]
        before = set(video.parent.iterdir())
        started = time.time()
        found, ours = server.search(item, alpha3)
        took = time.time() - started
        print("  search %s %.1fs: %d results, %d from %s" % (
            alpha3, took, len(found), len(ours), PROVIDER))
        for sub in ours[:3]:
            print("    %s | %s | %s | %s" % (
                sub.get("Id"), row_language(sub), sub.get("Name"), sub.get("Comment")))
        if not sample.known:
            if ours:
                raise Failure("%s offered %d for %s, a title the index does not have" % (
                    PROVIDER, len(ours), video.name))
            continue
        if not ours:
            raise Failure("%s offered nothing in %s for %s" % (PROVIDER, alpha3, video.name))
        others = sorted({str(row_language(s)) for s in ours if row_language(s) != alpha3})
        if others:
            raise Failure("asked for %s, %s also offered %s" % (alpha3, PROVIDER, others))
        held = baseline.row_ids(client, sample, code)
        strays = [s.get("Id") for s in ours if row_id(s) not in held]
        if strays:
            raise Failure("%s offered %d of %d rows that are not %s's own in %s, first %s" % (
                PROVIDER, len(strays), len(ours), sample.name, code, strays[0]))
        problem = baseline.count_problem(len(ours), code in sample.many)
        if problem:
            raise Failure("%s %s in %s for %s" % (PROVIDER, problem, alpha3, video.name))

        server.download(item, ours[0])
        new, end = [], time.time() + 30
        while not new and time.time() < end:
            time.sleep(1)
            new = [p for p in set(video.parent.iterdir()) - before
                   if p.suffix.lower() in SUBTITLE_SUFFIXES]
        if not new:
            raise Failure("the download answered but no subtitle file appeared beside %s"
                          % video.name)
        for path in new:
            print("  saved %s (%d bytes)" % (path.name, path.stat().st_size))
            if not looks_like_subtitles(path):
                raise Failure("%s does not read as a subtitle file" % path.name)
            tags = {".%s." % tag for tag in FILE_TAGS[code]}
            if not any(tag in path.name.lower() for tag in tags):
                raise Failure("%s is not named for %s" % (path.name, alpha3))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("kind", choices=("jellyfin", "emby"))
    parser.add_argument("url")
    parser.add_argument("media", type=pathlib.Path)
    parser.add_argument("--repository", metavar="URL",
                        help="Jellyfin only: install the plugin from this repository first")
    args = parser.parse_args(argv)
    if args.repository and args.kind != "jellyfin":
        parser.error("--repository is Jellyfin's; Emby has no third-party repositories")

    server = Server(args.kind, args.url)
    info = server.wait_ready()
    print("%s %s" % (info.get("ProductName") or args.kind, info.get("Version")))
    server.setup()
    server.login()
    if args.repository:
        server.install(args.repository)
    plugin = server.plugin()
    print("plugin %s %s loaded" % (plugin.get("Name"), plugin.get("Version")))
    print("plugin settings %s" % server.configure(plugin, PerLanguage=media.PER_LANGUAGE))

    server.add_library("Films", "movies", "/media/movies")
    server.add_library("Shows", "tvshows", "/media/tv")
    server.call("POST", "/Library/Refresh")
    samples = dict(zip(media.videos(args.media.resolve()), media.SAMPLES))
    items = wait_for_items(server, samples)
    client = Client(client="ci-mediaserver")

    failures = []
    for video, sample in samples.items():
        print("%s:" % video.name)
        try:
            check_item(server, client, video, sample, items[video])
        except Failure as err:
            print("  FAIL %s" % err)
            failures.append(str(err))
    print("FAIL" if failures else "PASS")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
