#!/usr/bin/env python3
"""Drive a live Bazarr, fed by a live Radarr and Sonarr, with the provider installed.

    python3 bazarr.py /path/to/media

The three run in containers on the host network with the media directory mounted at
/movies and /tv in each, and with the API keys below written into their config files
(bazarr/*) before they start. This adds each film to Radarr and each series to Sonarr,
waits for them to import the existing files, has Bazarr sync from them, gives all of
them one language profile of English, Spanish and Brazilian Portuguese, then runs
Bazarr's manual search for each video (the call behind its search dialog) and, in
each language the sample is asked for, downloads the first subtitle the SubtitleDB
provider offered. It fails unless the provider answered for every video, claimed the
title or the series (which it does only when the lookup resolved to the title Sonarr
or Radarr named), offered each language asked, as many as SUBTITLEDB_PER_LANGUAGE
allows and past the API's first page where the index holds more, and the file landed
beside the video named for its language. The title the index has nothing for is not
here: Radarr holds nothing TMDB does not know.
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

# Throwaway keys for throwaway containers, the same ones bazarr/* seeds each config with.
RADARR = ("http://127.0.0.1:7878", "a" * 32)
SONARR = ("http://127.0.0.1:8989", "b" * 32)
BAZARR = ("http://127.0.0.1:6767", "c" * 32)
PROVIDER = "subtitledb"
#: Bazarr's own code for each language the samples are asked for, as a profile and
#: the enabled-languages setting take it. Brazilian Portuguese is "pb" there, its
#: custom language; "pt-BR" is read by its first two letters and becomes Portuguese.
BAZARR_CODES = {"en": "en", "es": "es", "pb": "pb"}
#: How its manual search reports a result's language and tags the saved file: the
#: language object's IETF form.
SHOWN_AS = {"en": "en", "es": "es", "pb": "pt-BR"}
#: What the saved file may be tagged with for each language.
FILE_TAGS = {"en": ("en", "eng"), "es": ("es", "spa"), "pb": ("pt-br", "pob", "pb")}
PROFILE = [{
    "profileId": 1, "name": "Three languages", "cutoff": None,
    "items": [{"id": n, "language": code, "audio_exclude": "False",
               "audio_only_include": "False", "hi": "False", "forced": "False"}
              for n, code in enumerate(BAZARR_CODES.values(), 1)],
    "mustContain": [], "mustNotContain": [], "originalFormat": False, "tag": None,
}]
SUFFIXES = (".srt", ".ass", ".ssa", ".sub", ".vtt")


class Failure(Exception):
    pass


def call(app, method, path, body=None, form=None, query=None, ok=(200, 201, 202, 204),
         timeout=120):
    base, key = app
    url = base + path + ("?" + urllib.parse.urlencode(query, doseq=True) if query else "")
    # Radarr and Sonarr read X-Api-Key, Bazarr X-API-KEY; HTTP headers ignore case.
    headers = {"Accept": "application/json", "X-Api-Key": key}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    elif form is not None:
        data = urllib.parse.urlencode(form, doseq=True).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
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


def wait(what, check, seconds=300, every=5):
    end, last = time.time() + seconds, None
    while time.time() < end:
        try:
            found = check()
            if found:
                return found
        except (Failure, OSError) as err:
            last = err
        time.sleep(every)
    raise Failure("gave up waiting for %s%s" % (what, ": %s" % last if last else ""))


def wait_import(app, what, check, folder):
    """Wait for an import, and on giving up say why the app turned the file down."""
    try:
        return wait(what, check)
    except Failure as err:
        try:
            rows = call(app, "GET", "/api/v3/manualimport",
                        query={"folder": folder, "filterExistingFiles": "false"})
            said = "; ".join("%s: %s" % (
                row.get("relativePath") or row.get("path"),
                ", ".join(r.get("reason", "") for r in row.get("rejections") or []) or "accepted",
            ) for row in rows or []) or "no video found"
        except (Failure, OSError) as why:
            said = "manualimport failed: %s" % why
        raise Failure("%s (%s)" % (err, said)) from None


def add_film(sample):
    """A film into Radarr, pointed at the folder the sample already sits in."""
    quality = call(RADARR, "GET", "/api/v3/qualityprofile")[0]["id"]
    movie = call(RADARR, "GET", "/api/v3/movie/lookup/tmdb", query={"tmdbId": sample.tmdb})
    movie.update({
        "qualityProfileId": quality, "rootFolderPath": "/movies", "monitored": True,
        "path": "/movies/" + sample.folder, "minimumAvailability": "released",
        "addOptions": {"searchForMovie": False, "monitor": "movieOnly"},
    })
    return call(RADARR, "POST", "/api/v3/movie", movie)["id"]


def add_series(sample):
    """A show into Sonarr, the same way. Sonarr scans the folder once it is added."""
    quality = call(SONARR, "GET", "/api/v3/qualityprofile")[0]["id"]
    series = call(SONARR, "GET", "/api/v3/series/lookup",
                  query={"term": "tvdb:%d" % sample.tvdb})[0]
    series.update({
        "qualityProfileId": quality, "rootFolderPath": "/tv", "monitored": True,
        "path": "/tv/" + sample.folder, "seasonFolder": True,
        "addOptions": {"searchForMissingEpisodes": False, "monitor": "all"},
    })
    return call(SONARR, "POST", "/api/v3/series", series)["id"]


def imported(radarr_ids, sonarr_ids):
    """Wait for every file to be imported. The scans were started by the adds."""
    for sample, radarr_id in radarr_ids.items():
        wait_import(RADARR, "Radarr to import %s" % sample.release,
                    lambda radarr_id=radarr_id: call(
                        RADARR, "GET", "/api/v3/movie/%d" % radarr_id).get("hasFile"),
                    "/movies/" + sample.folder)
    for sample, sonarr_id in sonarr_ids.items():
        wait_import(SONARR, "Sonarr to import %s" % sample.release,
                    lambda sonarr_id=sonarr_id: call(SONARR, "GET", "/api/v3/episodefile",
                                                     query={"seriesId": sonarr_id}),
                    "/tv/" + sample.folder)


def bazarr_items(radarr_ids, sonarr_ids):
    """Sync Bazarr from both, then find each film and each episode in it."""
    for task in ("update_movies", "update_series"):
        call(BAZARR, "POST", "/api/system/tasks", form={"taskid": task})

    def film(radarr_id):
        rows = call(BAZARR, "GET", "/api/movies", query={"radarrid[]": radarr_id})["data"]
        return rows[0] if rows else None

    def episode(sample, sonarr_id):
        rows = call(BAZARR, "GET", "/api/episodes", query={"seriesid[]": sonarr_id})["data"]
        return next((r for r in rows if r.get("season") == sample.season
                     and r.get("episode") == sample.episode), None)

    films = {sample: wait("Bazarr to sync %s" % sample.name, lambda i=radarr_id: film(i))
             for sample, radarr_id in radarr_ids.items()}
    episodes = {sample: wait("Bazarr to sync %s" % sample.name,
                             lambda s=sample, i=sonarr_id: episode(s, i))
                for sample, sonarr_id in sonarr_ids.items()}
    return films, episodes


def check(kind, video, sample, search_query, download_form, claim):
    started = time.time()
    found = call(BAZARR, "GET", "/api/providers/%s" % kind, query=search_query,
                 timeout=300)["data"]
    ours = [s for s in found if s.get("provider") == PROVIDER]
    took = time.time() - started
    print("  search %.1fs: %d results, %d from %s, in %s" % (
        took, len(found), len(ours), PROVIDER, sorted({str(s.get("language")) for s in ours})))
    for sub in ours[:3]:
        print("    score %s | %s | %s | matches %s" % (
            sub.get("score"), sub.get("language"),
            ", ".join(sub.get("release_info") or []) or "-",
            ",".join(sorted(sub.get("matches") or []))))
    if not ours:
        raise Failure("%s offered nothing for %s" % (PROVIDER, video.name))
    # Claimed only when the lookup resolved to the title Radarr or Sonarr named, and
    # each language is a lookup of its own, so a row without it is for something else.
    unclaimed = [s for s in ours if claim not in (s.get("matches") or [])]
    if unclaimed:
        raise Failure("%s did not claim the %s for %d of the %d it offered for %s" % (
            PROVIDER, claim, len(unclaimed), len(ours), video.name))

    for code in sample.languages:
        want = SHOWN_AS[code]
        rows = [s for s in ours if s.get("language") == want]
        if not rows:
            raise Failure("%s offered nothing in %s for %s" % (PROVIDER, want, video.name))
        problem = baseline.count_problem(len(rows), code in sample.many)
        if problem:
            raise Failure("%s %s in %s for %s" % (PROVIDER, problem, want, video.name))
        before = set(video.parent.iterdir())
        form = dict(download_form, hi="False", forced="False", original_format="False",
                    provider=PROVIDER, subtitle=rows[0]["subtitle"])
        call(BAZARR, "POST", "/api/providers/%s" % kind, form=form)
        new = wait("the %s subtitle file beside %s" % (want, video.name), lambda before=before: [
            p for p in set(video.parent.iterdir()) - before if p.suffix.lower() in SUFFIXES
        ], seconds=90, every=2)
        for path in new:
            text = path.read_bytes()[:20000].decode("utf-8", "replace")
            print("  saved %s (%d bytes)" % (path.name, path.stat().st_size))
            if "-->" not in text and "[Script Info]" not in text:
                raise Failure("%s does not read as a subtitle file" % path.name)
            if not any(".%s." % tag in path.name.lower() for tag in FILE_TAGS[code]):
                raise Failure("%s is not named for %s" % (path.name, want))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("media", type=pathlib.Path)
    args = parser.parse_args(argv)
    root = args.media.resolve()

    for name, app in (("Radarr", RADARR), ("Sonarr", SONARR), ("Bazarr", BAZARR)):
        status = wait(name, lambda app=app: call(app, "GET", (
            "/api/system/status" if app is BAZARR else "/api/v3/system/status")), 300)
        version = status.get("version") or (status.get("data") or {}).get("bazarr_version")
        print("%s %s" % (name, version))

    enabled = call(BAZARR, "GET", "/api/system/settings")["general"]["enabled_providers"]
    print("Bazarr enabled providers: %s" % enabled)
    if PROVIDER not in enabled:
        raise Failure("%s is not in enabled_providers" % PROVIDER)

    call(RADARR, "POST", "/api/v3/rootfolder", {"path": "/movies"})
    call(SONARR, "POST", "/api/v3/rootfolder", {"path": "/tv"})
    radarr_ids = {sample: add_film(sample) for sample in media.FILMS if sample.known}
    sonarr_ids = {sample: add_series(sample) for sample in media.EPISODES}
    for sample in media.FILMS:
        if not sample.known:
            print("%s: not added, Radarr holds nothing TMDB does not know" % sample.release)
    imported(radarr_ids, sonarr_ids)
    print("Radarr and Sonarr imported the samples")

    call(BAZARR, "POST", "/api/system/settings", form={
        "languages-enabled": list(BAZARR_CODES.values()),
        "languages-profiles": json.dumps(PROFILE)})
    films, episodes = bazarr_items(radarr_ids, sonarr_ids)
    for radarr_id in radarr_ids.values():
        call(BAZARR, "POST", "/api/movies", form={"radarrid": radarr_id, "profileid": 1})
    for sonarr_id in sonarr_ids.values():
        call(BAZARR, "POST", "/api/series", form={"seriesid": sonarr_id, "profileid": 1})

    checks = []
    for sample in films:
        radarr_id = radarr_ids[sample]
        checks.append((sample, "movies", {"radarrid": radarr_id}, {"radarrid": radarr_id},
                       "title"))
    for sample, row in episodes.items():
        episode_id = row["sonarrEpisodeId"]
        checks.append((sample, "episodes", {"episodeid": episode_id},
                       {"seriesid": sonarr_ids[sample], "episodeid": episode_id}, "series"))

    failures = []
    for sample, kind, query, form, claim in checks:
        video = root / sample.path
        print("%s:" % video.name)
        try:
            check(kind, video, sample, query, form, claim)
        except Failure as err:
            print("  FAIL %s" % err)
            failures.append(str(err))
    print("FAIL" if failures else "PASS")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
