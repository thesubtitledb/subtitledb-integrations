#!/usr/bin/env python3
"""Build the Bazarr release zip.

    python3 build.py            -> dist/subtitledb-bazarr-<version>.zip

install.py copies the provider and the shared client out of this repository's layout,
so the zip keeps that layout and installs from wherever it is unpacked:

    subtitledb-bazarr-<version>/bazarr/install.py, provider.py, README.md
    subtitledb-bazarr-<version>/python/subtitledb/
    subtitledb-bazarr-<version>/LICENSE

The version is the shared client's, which is most of what ships.
"""

from __future__ import annotations

import re
import shutil
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGINS = HERE.parent
SHARED = PLUGINS / "python" / "subtitledb"
DIST = HERE / "dist"
SHIPPED = ("install.py", "provider.py", "README.md")

SKIP = shutil.ignore_patterns("__pycache__", "*.pyc", "*.pyo", ".DS_Store")


def version() -> str:
    text = (PLUGINS / "python" / "pyproject.toml").read_text(encoding="utf-8")
    found = re.search(r'^version = "([^"]+)"', text, re.MULTILINE)
    if not found:
        raise SystemExit("no version in plugins/python/pyproject.toml")
    return found.group(1)


def build() -> Path:
    name = "subtitledb-bazarr-%s" % version()
    DIST.mkdir(exist_ok=True)
    work = DIST / "_stage"
    if work.exists():
        shutil.rmtree(work)
    root = work / name
    (root / "bazarr").mkdir(parents=True)
    for file in SHIPPED:
        shutil.copyfile(HERE / file, root / "bazarr" / file)
    shutil.copytree(SHARED, root / "python" / "subtitledb", ignore=SKIP)
    shutil.copyfile(PLUGINS / "LICENSE", root / "LICENSE")

    out = DIST / (name + ".zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                zf.write(path, path.relative_to(work).as_posix())
    shutil.rmtree(work)
    return out


def main() -> int:
    print(build())
    return 0


if __name__ == "__main__":
    sys.exit(main())
