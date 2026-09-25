"""The installer, against a fake Bazarr tree."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import install


@pytest.fixture
def bazarr(tmp_path: Path) -> Path:
    (tmp_path / "custom_libs" / "subliminal_patch" / "providers").mkdir(parents=True)
    (tmp_path / "libs").mkdir()
    return tmp_path


def test_it_puts_the_module_where_bazarr_scans_for_providers(bazarr: Path):
    # Bazarr lists this directory at import time. The filename is the provider name.
    install.install(bazarr)
    module = bazarr / "custom_libs" / "subliminal_patch" / "providers" / "subtitledb.py"
    assert module.is_file()
    assert "SubtitleDbProvider" in module.read_text(encoding="utf-8")


def test_it_puts_the_shared_client_on_the_import_path(bazarr: Path):
    # custom_libs is on sys.path, which is what makes `import subtitledb` resolve.
    install.install(bazarr)
    package = bazarr / "custom_libs" / "subtitledb"
    assert (package / "__init__.py").is_file()
    assert (package / "match.py").is_file()
    assert (package / "find.py").is_file()


def test_both_pieces_say_they_are_mit_inside_a_gpl_tree(bazarr: Path):
    # Bazarr is GPL-3.0. What we put in its tree has to carry its own license.
    install.install(bazarr)
    package = bazarr / "custom_libs" / "subtitledb"
    assert (package / "LICENSE").read_text(encoding="utf-8") == install.LICENSE.read_text(
        encoding="utf-8"
    )
    module = bazarr / "custom_libs" / "subliminal_patch" / "providers" / "subtitledb.py"
    head = module.read_text(encoding="utf-8").splitlines()[:2]
    assert head == ["# SPDX-License-Identifier: MIT", "# Copyright (c) 2026 TheSubtitleDb.org"]


def test_installing_twice_leaves_one_copy_and_no_stale_files(bazarr: Path):
    install.install(bazarr)
    stale = bazarr / "custom_libs" / "subtitledb" / "gone.py"
    stale.write_text("# left over from an older version", encoding="utf-8")
    install.install(bazarr)
    assert not stale.exists(), "an old file survived the reinstall"
    assert (bazarr / "custom_libs" / "subtitledb" / "match.py").is_file()


def test_uninstall_takes_both_pieces_away(bazarr: Path):
    install.install(bazarr)
    install.uninstall(bazarr)
    assert not (bazarr / "custom_libs" / "subtitledb").exists()
    assert not (
        bazarr / "custom_libs" / "subliminal_patch" / "providers" / "subtitledb.py"
    ).exists()


def test_uninstalling_what_was_never_installed_is_not_an_error(bazarr: Path):
    install.uninstall(bazarr)


def test_a_directory_that_is_not_bazarr_is_refused(tmp_path: Path):
    # Better than copying a package into somebody's home directory and reporting success.
    with pytest.raises(SystemExit, match="does not look like a Bazarr install"):
        install.install(tmp_path)


def test_no_pycache_is_carried_across(bazarr: Path):
    cache = install.SHARED / "__pycache__"
    cache.mkdir(exist_ok=True)
    (cache / "match.cpython-312.pyc").write_bytes(b"\x00")
    try:
        install.install(bazarr)
        assert not (bazarr / "custom_libs" / "subtitledb" / "__pycache__").exists()
    finally:
        for f in cache.glob("*.pyc"):
            f.unlink()
