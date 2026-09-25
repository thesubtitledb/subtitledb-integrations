"""The release zip, unpacked somewhere else and installed from there."""

from __future__ import annotations

import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import build
import install
import subtitledb


@pytest.fixture
def built(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(build, "DIST", tmp_path / "dist")
    return build.build()


def test_the_version_is_the_shared_clients(built: Path):
    # One version for what is mostly one package, written in two places.
    assert build.version() == subtitledb.__version__
    assert built.name == "subtitledb-bazarr-%s.zip" % subtitledb.__version__


def test_everything_sits_in_one_folder_and_nothing_compiled_ships(built: Path):
    with zipfile.ZipFile(built) as zf:
        names = zf.namelist()
    top = built.name[: -len(".zip")]
    assert all(name.startswith(top + "/") for name in names)
    assert "%s/bazarr/install.py" % top in names
    assert "%s/bazarr/provider.py" % top in names
    assert "%s/python/subtitledb/match.py" % top in names
    assert "%s/LICENSE" % top in names
    assert not [name for name in names if "__pycache__" in name or name.endswith(".pyc")]


def test_it_installs_from_where_it_is_unpacked(built: Path, tmp_path: Path):
    # install.py finds the client and the license beside itself, so the zip has to
    # keep this repository's layout for the release to install at all.
    unpacked = tmp_path / "unpacked"
    with zipfile.ZipFile(built) as zf:
        zf.extractall(unpacked)
    bazarr = tmp_path / "bazarr"
    (bazarr / "custom_libs" / "subliminal_patch" / "providers").mkdir(parents=True)
    script = unpacked / built.name[: -len(".zip")] / "bazarr" / "install.py"

    subprocess.run([sys.executable, str(script), str(bazarr)], check=True,  # noqa: S603
                   capture_output=True)

    module = bazarr / "custom_libs" / "subliminal_patch" / "providers" / "subtitledb.py"
    assert module.read_bytes() == (build.HERE / "provider.py").read_bytes()
    package = bazarr / "custom_libs" / "subtitledb"
    assert (package / "match.py").read_bytes() == (build.SHARED / "match.py").read_bytes()
    assert (package / "LICENSE").read_bytes() == install.LICENSE.read_bytes()
