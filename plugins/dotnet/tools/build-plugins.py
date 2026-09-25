#!/usr/bin/env python3
"""Publish both plugins and package them the way each host installs.

    python3 plugins/dotnet/tools/build-plugins.py
    python3 plugins/dotnet/tools/build-plugins.py --repo URL [--history manifest.json]

Writes plugins/dotnet/dist:

    jellyfin/SubtitleDB_<version>/       the folder to drop in Jellyfin's plugins dir
    subtitledb-jellyfin-<version>.zip    that folder's files, with no folder around them
    emby/SubtitleDb.Emby.dll             the one file to drop in Emby's plugins dir
    subtitledb-emby-<version>.zip

and with --repo, a Jellyfin repository whose zip is served from the folder at URL:

    repo/manifest.json                   what a Jellyfin server adds, naming URL/<zip>
    repo/subtitledb-jellyfin-<version>.zip

--history is an earlier manifest.json. Its versions stay listed below the new one, so
a server can still install any of them.

Only our own assemblies are published. Both hosts already carry everything else,
and a plugin that ships its own copy of a host assembly shadows the server's and
breaks in ways that read like a server bug.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
import zipfile

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
DIST = ROOT / "dist"
LICENSE = ROOT.parent / "LICENSE"

# Ours, and nothing else: everything under here is what the host does not already have.
OURS = ("SubtitleDb.Core.dll", "SubtitleDb.Jellyfin.dll", "SubtitleDb.Emby.dll")

# Emby resolves a plugin's references only against its own assemblies, so the Emby
# plugin is one DLL with Core compiled in. A Core DLL beside it would mean the csproj
# went back to a project reference, and Emby would fail to load the plugin.
EMBY = ("SubtitleDb.Emby.dll",)

# The oldest server this is built against. Jellyfin refuses a plugin whose targetAbi
# is above its own, so this is a floor, not a pin.
JELLYFIN_TARGET_ABI = "10.10.0.0"

GUID = "e8067282-ad64-415a-b9ed-9057e6679483"

# The meta.json fields a Jellyfin repository lists once for the plugin, and once for
# each version of it.
PACKAGE = ("category", "description", "guid", "name", "overview", "owner")
RELEASE = ("changelog", "targetAbi", "timestamp", "version")


def version() -> str:
    # Our own file, checked in beside this script, so there is nothing to defuse.
    props = ET.parse(ROOT / "Directory.Build.props").getroot()  # noqa: S314
    found = props.find(".//Version")
    if found is None or not found.text:
        raise SystemExit("no <Version> in Directory.Build.props")
    return found.text.strip()


def publish(project: pathlib.Path, framework: str, out: pathlib.Path, dotnet: str) -> None:
    out.mkdir(parents=True, exist_ok=True)
    subprocess.run(  # noqa: S603 - every argument is ours bar --dotnet, which is the caller
        [dotnet, "publish", str(project), "-c", "Release",
         "-f", framework, "-o", str(out), "--nologo"],
        check=True,
    )


def write_json(path: pathlib.Path, data: object) -> None:
    # Bytes, not write_text(newline=...), which is 3.10 and later: this has to run on
    # the same Python the addon does. Writing the bytes keeps Windows from turning the
    # file into CRLF either way.
    path.write_bytes((json.dumps(data, indent=2, sort_keys=True) + "\n").encode("utf-8"))


def keep_only_ours(folder: pathlib.Path) -> None:
    for path in folder.iterdir():
        if path.is_dir():
            shutil.rmtree(path)
        elif path.name not in OURS:
            path.unlink()


def zip_folder(folder: pathlib.Path, archive: pathlib.Path) -> pathlib.Path:
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(folder.rglob("*")):
            if path.is_file() and path != archive:
                zf.write(path, str(path.relative_to(folder)).replace("\\", "/"))
    return archive


def build_jellyfin(dotnet: str, ver: str) -> pathlib.Path:
    folder = DIST / "jellyfin" / ("SubtitleDB_" + ver)
    if folder.exists():
        shutil.rmtree(folder)
    project = ROOT / "src" / "SubtitleDb.Jellyfin" / "SubtitleDb.Jellyfin.csproj"
    publish(project, "net8.0", folder, dotnet)
    keep_only_ours(folder)

    # Jellyfin reads this to name, version and update the plugin. Without it the
    # assembly still loads, and the dashboard shows a plugin with no version that can
    # never be updated.
    meta = {
        "category": "Subtitles",
        "changelog": "",
        "description": "Subtitles from the SubtitleDB open index. No account, no key, no quota.",
        "guid": GUID,
        "name": "SubtitleDB",
        "overview": "Subtitles from the SubtitleDB open index",
        "owner": "SubtitleDB",
        "targetAbi": JELLYFIN_TARGET_ABI,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "version": ver,
    }
    write_json(folder / "meta.json", meta)
    # The folder is the plugin's own, so the license can sit in it. Emby has no such
    # folder; there the assemblies carry the copyright from Directory.Build.props.
    shutil.copyfile(LICENSE, folder / "LICENSE")

    # No folder inside the zip. Jellyfin unpacks a repository download into a folder
    # it names itself, and one more level hides meta.json from it.
    return zip_folder(folder, DIST / ("subtitledb-jellyfin-%s.zip" % ver))


def build_emby(dotnet: str, ver: str) -> pathlib.Path:
    folder = DIST / "emby"
    if folder.exists():
        shutil.rmtree(folder)
    project = ROOT / "src" / "SubtitleDb.Emby" / "SubtitleDb.Emby.csproj"
    publish(project, "netstandard2.0", folder, dotnet)
    keep_only_ours(folder)
    names = tuple(sorted(p.name for p in folder.iterdir()))
    if names != EMBY:
        raise SystemExit("the Emby plugin must be exactly %s, got %s" % (EMBY, names))
    # Emby has no manifest file: the DLL goes straight in its plugins directory. The
    # zip goes beside the folder, not inside it, so what to copy is unambiguous.
    return zip_folder(folder, DIST / ("subtitledb-emby-%s.zip" % ver))


def build_repo(
    url: str, jellyfin: pathlib.Path, history: pathlib.Path | None = None
) -> pathlib.Path:
    repo = DIST / "repo"
    if repo.exists():
        shutil.rmtree(repo)
    repo.mkdir(parents=True)
    shutil.copyfile(jellyfin, repo / jellyfin.name)
    # Read back from the zip, so the repository cannot disagree with it: Jellyfin
    # marks a plugin malfunctioned when the two name different guids, and a zip with
    # no meta.json at its root fails here rather than on a user's server.
    with zipfile.ZipFile(jellyfin) as zf:
        meta = json.loads(zf.read("meta.json"))
    release = {key: meta[key] for key in RELEASE}
    release["sourceUrl"] = "%s/%s" % (url.rstrip("/"), jellyfin.name)
    # Jellyfin installs nothing whose MD5 differs from this.
    release["checksum"] = hashlib.md5(jellyfin.read_bytes(), usedforsecurity=False).hexdigest()
    package = {key: meta[key] for key in PACKAGE}
    package["versions"] = [release, *earlier(history, package["guid"], release["version"])]
    write_json(repo / "manifest.json", [package])
    return repo


def earlier(history: pathlib.Path | None, guid: str, ver: str) -> list[dict]:
    """The versions an earlier manifest lists, bar the one being built now."""
    if history is None:
        return []
    (package,) = json.loads(history.read_text(encoding="utf-8"))
    if package["guid"] != guid:
        raise SystemExit("%s is the repository of another plugin, %s" % (history, package["guid"]))
    return [entry for entry in package["versions"] if entry["version"] != ver]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dotnet", default="dotnet", help="path to the dotnet CLI")
    parser.add_argument("--host", choices=("jellyfin", "emby"), help="build only one of them")
    parser.add_argument("--repo", metavar="URL",
                        help="also write dist/repo, a Jellyfin repository serving its zip from URL")
    parser.add_argument("--history", metavar="FILE", type=pathlib.Path,
                        help="an earlier manifest.json, whose versions the new one keeps")
    args = parser.parse_args()
    if args.repo and args.host == "emby":
        parser.error("--repo is the Jellyfin repository, which --host emby does not build")
    if args.history and not args.repo:
        parser.error("--history only means something with --repo")

    ver = version()
    jellyfin = build_jellyfin(args.dotnet, ver) if args.host in (None, "jellyfin") else None
    emby = build_emby(args.dotnet, ver) if args.host in (None, "emby") else None
    built = [path for path in (jellyfin, emby) if path]
    if args.repo and jellyfin:
        built.append(build_repo(args.repo, jellyfin, args.history))

    for path in built:
        print(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
