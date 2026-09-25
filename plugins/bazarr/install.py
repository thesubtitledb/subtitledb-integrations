#!/usr/bin/env python3
"""Copy the provider and the shared client into a Bazarr install.

    python3 install.py /opt/bazarr
    python3 install.py /opt/bazarr --uninstall

Bazarr finds providers by listing its providers directory at import time, so there
is no registry to edit: the file being there is the registration, and the module
name becomes the provider name. The only thing left is turning it on, which is a
line in config.yaml that Bazarr's web UI cannot show, because that list is built
into the frontend bundle.

Bazarr is GPL-3.0 and both pieces are MIT, so each says so once it is in Bazarr's
tree: the module in its header, the client with plugins/LICENSE beside it.
"""

from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

PROVIDER_NAME = "subtitledb"
HERE = Path(__file__).resolve().parent
SHARED = HERE.parent / "python" / "subtitledb"
LICENSE = HERE.parent / "LICENSE"


def paths(root: Path) -> tuple[Path, Path]:
    """Where the two pieces go. custom_libs is on Bazarr's sys.path."""
    custom = root / "custom_libs"
    return custom / PROVIDER_NAME, custom / "subliminal_patch" / "providers" / (
        PROVIDER_NAME + ".py"
    )


def check(root: Path) -> Path:
    providers = root / "custom_libs" / "subliminal_patch" / "providers"
    if not providers.is_dir():
        raise SystemExit(
            "%s does not look like a Bazarr install: no custom_libs/subliminal_patch/providers"
            % root
        )
    return providers


def install(root: Path) -> None:
    check(root)
    package, module = paths(root)
    if package.exists():
        shutil.rmtree(package)
    shutil.copytree(SHARED, package, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
    shutil.copyfile(LICENSE, package / "LICENSE")
    shutil.copyfile(HERE / "provider.py", module)
    print("installed:")
    print("  %s" % package)
    print("  %s" % module)
    print()
    print("Now add it to the providers you have enabled, in Bazarr's config.yaml:")
    print()
    print("  general:")
    print("    enabled_providers:")
    print("      - subtitledb")
    print()
    print("then restart Bazarr. The web UI's provider list is part of its frontend")
    print("bundle, so this one is enabled in the file rather than on the page.")


def uninstall(root: Path) -> None:
    package, module = paths(root)
    for target in (package, module):
        if target.is_dir():
            shutil.rmtree(target)
            print("removed %s" % target)
        elif target.exists():
            target.unlink()
            print("removed %s" % target)
    print("Remember to take subtitledb out of enabled_providers in config.yaml.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("root", type=Path, help="the Bazarr install, the directory holding libs/")
    parser.add_argument("--uninstall", action="store_true")
    args = parser.parse_args(argv)
    root = args.root.expanduser().resolve()
    if args.uninstall:
        uninstall(root)
    else:
        install(root)
    return 0


if __name__ == "__main__":
    sys.exit(main())
