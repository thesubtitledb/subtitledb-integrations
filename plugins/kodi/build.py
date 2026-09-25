#!/usr/bin/env python3
"""Build the installable Kodi addon.

    python3 build.py            -> dist/service.subtitles.subtitledb-0.3.1.zip
    python3 build.py --repo     -> and dist/addons.xml, dist/addons.xml.md5

Kodi installs a zip whose single top-level directory is the addon id, so the zip is
built around that name rather than around this directory. The shared client is
vendored in at this point: Kodi ships its own Python with no package manager, so
whatever the addon needs has to be inside the zip. So is plugins/LICENSE, as the
LICENSE.txt Kodi's repository expects at the addon root.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ADDON_ID = "service.subtitles.subtitledb"
SOURCE = HERE / ADDON_ID
SHARED = HERE.parent / "python" / "subtitledb"
LICENSE = HERE.parent / "LICENSE"
DIST = HERE / "dist"

SKIP = shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", ".DS_Store")


def version() -> str:
    # The addon's own manifest, checked in beside this script: nothing to defuse.
    return ET.parse(SOURCE / "addon.xml").getroot().attrib["version"]  # noqa: S314


def stage(into: Path) -> Path:
    """Lay the addon out exactly as it will be installed."""
    root = into / ADDON_ID
    if root.exists():
        shutil.rmtree(root)
    shutil.copytree(SOURCE, root, ignore=SKIP)
    shutil.copytree(SHARED, root / "resources" / "lib" / "subtitledb", ignore=SKIP)
    shutil.copyfile(LICENSE, root / "LICENSE.txt")
    return root


def build(repo: bool = False) -> Path:
    DIST.mkdir(exist_ok=True)
    work = DIST / "_stage"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir()
    root = stage(work)

    out = DIST / ("%s-%s.zip" % (ADDON_ID, version()))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(work).as_posix())
    shutil.rmtree(work)

    if repo:
        write_repo_index(out)
    return out


def write_repo_index(zip_path: Path) -> None:
    """The two files a Kodi repository is, beside the zip.

    Kodi reads addons.xml to learn what a repository holds and addons.xml.md5 to
    decide whether to read it again. A stale md5 means nobody ever sees an update.
    """
    addon = ET.parse(SOURCE / "addon.xml").getroot()  # noqa: S314 - our own manifest
    addons = ET.Element("addons")
    addons.append(addon)
    xml = ET.tostring(addons, encoding="utf-8", xml_declaration=True)
    (DIST / "addons.xml").write_bytes(xml)
    (DIST / "addons.xml.md5").write_text(
        hashlib.md5(xml).hexdigest(),  # noqa: S324 - Kodi defines the file as md5
        encoding="utf-8",
    )
    print("repository index written beside %s" % zip_path.name)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", action="store_true", help="also write addons.xml and its md5")
    args = parser.parse_args(argv)
    out = build(repo=args.repo)
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
