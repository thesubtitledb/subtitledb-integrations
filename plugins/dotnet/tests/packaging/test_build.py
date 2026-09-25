"""The packaging rules, without a compiler.

What each host will accept is decided here rather than by dotnet publish, so these
run in the Python job and fail in seconds instead of after a build.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import pathlib
import sys
import zipfile

import pytest

HERE = pathlib.Path(__file__).resolve().parents[2]

_spec = importlib.util.spec_from_file_location("build_plugins", HERE / "tools" / "build-plugins.py")
assert _spec and _spec.loader
build = importlib.util.module_from_spec(_spec)
sys.modules["build_plugins"] = build
_spec.loader.exec_module(build)


def published(folder: pathlib.Path) -> None:
    """What dotnet publish leaves behind, including what must not ship."""
    folder.mkdir(parents=True, exist_ok=True)
    for name in (
        "SubtitleDb.Core.dll",
        "SubtitleDb.Jellyfin.dll",
        # Both hosts ship these. A plugin that carries its own copy shadows the
        # server's and breaks in ways that read like a server bug.
        "MediaBrowser.Controller.dll",
        "MediaBrowser.Model.dll",
        "System.Text.Json.dll",
        "SubtitleDb.Jellyfin.deps.json",
        "SubtitleDb.Jellyfin.pdb",
    ):
        (folder / name).write_bytes(b"x")
    (folder / "runtimes" / "win").mkdir(parents=True)
    (folder / "runtimes" / "win" / "native.dll").write_bytes(b"x")


def test_the_version_is_the_one_in_the_build_props():
    # One place. A zip named for one version holding an assembly stamped with another
    # is how a host reports an update that changes nothing.
    props = (HERE / "Directory.Build.props").read_text(encoding="utf-8")
    assert build.version() == props.split("<Version>")[1].split("</Version>")[0].strip()


def test_only_our_own_assemblies_are_published(tmp_path):
    folder = tmp_path / "SubtitleDB_0.1.0"
    published(folder)

    build.keep_only_ours(folder)

    assert sorted(p.name for p in folder.iterdir()) == [
        "SubtitleDb.Core.dll",
        "SubtitleDb.Jellyfin.dll",
    ]


def test_the_jellyfin_zip_has_no_folder_inside(tmp_path, monkeypatch):
    # Jellyfin unpacks a repository download into a folder it names itself. A folder
    # inside the zip puts meta.json one level down, where Jellyfin never reads it.
    monkeypatch.setattr(build, "DIST", tmp_path)
    monkeypatch.setattr(build, "publish", lambda project, framework, out, dotnet: published(out))

    archive = build.build_jellyfin("dotnet", "0.1.0")

    with zipfile.ZipFile(archive) as zf:
        assert sorted(zf.namelist()) == [
            "LICENSE", "SubtitleDb.Core.dll", "SubtitleDb.Jellyfin.dll", "meta.json"]


RELEASES = "https://github.com/o/r/releases/download/jellyfin-v0.1.0"


def built_repo(tmp_path, monkeypatch, url=RELEASES, history=None):
    monkeypatch.setattr(build, "DIST", tmp_path)
    monkeypatch.setattr(build, "publish", lambda project, framework, out, dotnet: published(out))
    jellyfin = build.build_jellyfin("dotnet", "0.1.0")
    return build.build_repo(url, jellyfin, history)


def manifest(repo):
    (package,) = json.loads((repo / "manifest.json").read_text(encoding="utf-8"))
    return package


def test_the_repository_names_the_zip_it_serves_and_its_md5(tmp_path, monkeypatch):
    repo = built_repo(tmp_path, monkeypatch)

    (release,) = manifest(repo)["versions"]
    served = repo / "subtitledb-jellyfin-0.1.0.zip"
    # The URL is the folder the zip is served from: a release's download folder.
    assert release["sourceUrl"] == RELEASES + "/" + served.name
    # Jellyfin hashes the download and refuses the install on any difference.
    md5 = hashlib.md5(served.read_bytes(), usedforsecurity=False).hexdigest()
    assert release["checksum"] == md5
    assert served.read_bytes() == (tmp_path / served.name).read_bytes()
    assert release["version"] == "0.1.0"
    # Jellyfin hides a version whose targetAbi is above its own.
    assert release["targetAbi"] == "10.10.0.0"


def test_the_repository_and_the_zip_name_the_same_plugin(tmp_path, monkeypatch):
    # Jellyfin marks a plugin malfunctioned when the guid in its meta.json differs
    # from the repository's, so both come from the one file.
    repo = built_repo(tmp_path, monkeypatch)

    package = manifest(repo)
    with zipfile.ZipFile(repo / "subtitledb-jellyfin-0.1.0.zip") as zf:
        meta = json.loads(zf.read("meta.json"))
    assert package["guid"] == meta["guid"] == build.GUID
    assert package["name"] == meta["name"] == "SubtitleDB"
    assert package["versions"][0]["timestamp"] == meta["timestamp"]


def test_the_repository_url_takes_a_trailing_slash(tmp_path, monkeypatch):
    repo = built_repo(tmp_path, monkeypatch, url="http://localhost:8000/")

    assert manifest(repo)["versions"][0]["sourceUrl"] == (
        "http://localhost:8000/subtitledb-jellyfin-0.1.0.zip")


def earlier_manifest(tmp_path, *versions, guid=None):
    path = tmp_path / "earlier.json"
    path.write_text(json.dumps([{
        "guid": guid or build.GUID,
        "name": "SubtitleDB",
        "versions": [{"version": v, "checksum": "old-" + v,
                      "sourceUrl": "https://example/%s.zip" % v} for v in versions],
    }]), encoding="utf-8")
    return path


def test_the_repository_keeps_listing_every_earlier_version(tmp_path, monkeypatch):
    # Each release's manifest replaces the last on the CDN. A version it dropped could
    # no longer be installed, and a server holding it would be offered nothing.
    history = earlier_manifest(tmp_path, "0.0.9", "0.0.8")

    repo = built_repo(tmp_path / "dist", monkeypatch, history=history)

    versions = manifest(repo)["versions"]
    assert [v["version"] for v in versions] == ["0.1.0", "0.0.9", "0.0.8"]
    assert versions[1] == {"version": "0.0.9", "checksum": "old-0.0.9",
                           "sourceUrl": "https://example/0.0.9.zip"}


def test_a_version_built_again_replaces_its_earlier_entry(tmp_path, monkeypatch):
    history = earlier_manifest(tmp_path, "0.1.0", "0.0.9")

    repo = built_repo(tmp_path / "dist", monkeypatch, history=history)

    versions = manifest(repo)["versions"]
    assert [v["version"] for v in versions] == ["0.1.0", "0.0.9"]
    assert versions[0]["checksum"] != "old-0.1.0"


def test_history_from_another_plugin_fails_the_repository(tmp_path, monkeypatch):
    history = earlier_manifest(tmp_path, "0.0.9", guid="00000000-0000-0000-0000-000000000000")

    with pytest.raises(SystemExit):
        built_repo(tmp_path / "dist", monkeypatch, history=history)


def test_a_zip_without_meta_json_at_its_root_fails_the_repository(tmp_path, monkeypatch):
    monkeypatch.setattr(build, "DIST", tmp_path)
    nested = tmp_path / "nested.zip"
    with zipfile.ZipFile(nested, "w") as zf:
        zf.writestr("SubtitleDB_0.1.0/meta.json", "{}")

    with pytest.raises(KeyError):
        build.build_repo(RELEASES, nested)


def emby_published(folder: pathlib.Path, *extra: str) -> None:
    folder.mkdir(parents=True, exist_ok=True)
    names = ("SubtitleDb.Emby.dll", "System.Text.Json.dll", "SubtitleDb.Emby.deps.json")
    for name in (*names, *extra):
        (folder / name).write_bytes(b"x")


def test_the_emby_zip_is_the_one_dll(tmp_path, monkeypatch):
    # Emby has no plugin folder: the DLL goes straight into its plugins directory.
    monkeypatch.setattr(build, "DIST", tmp_path)
    monkeypatch.setattr(build, "publish", lambda project, framework, out, dotnet: emby_published(
        out))

    archive = build.build_emby("dotnet", "0.1.0")

    with zipfile.ZipFile(archive) as zf:
        assert zf.namelist() == ["SubtitleDb.Emby.dll"]


def test_a_core_dll_beside_the_emby_one_fails_the_build(tmp_path, monkeypatch):
    # What the live run against Emby 4.8 found: Emby loads SubtitleDb.Emby.dll, cannot
    # resolve the SubtitleDb.Core.dll sitting next to it, and the plugin never loads.
    monkeypatch.setattr(build, "DIST", tmp_path)
    monkeypatch.setattr(build, "publish", lambda project, framework, out, dotnet: emby_published(
        out, "SubtitleDb.Core.dll"))

    with pytest.raises(SystemExit):
        build.build_emby("dotnet", "0.1.0")


def test_the_emby_project_compiles_core_in_rather_than_referencing_it():
    csproj = (HERE / "src" / "SubtitleDb.Emby" / "SubtitleDb.Emby.csproj").read_text(
        encoding="utf-8")
    assert '<Compile Include="../SubtitleDb.Core/*.cs"' in csproj
    assert "SubtitleDb.Core.csproj" not in csproj


def test_the_manifest_says_what_jellyfin_reads(tmp_path, monkeypatch):
    # A folder with no meta.json loads, shows no version, and can never be updated.
    calls = []
    monkeypatch.setattr(build, "DIST", tmp_path)
    monkeypatch.setattr(build, "publish", lambda project, framework, out, dotnet: (
        calls.append(framework), published(out)
    ))

    build.build_jellyfin("dotnet", "0.1.0")

    folder = tmp_path / "jellyfin" / "SubtitleDB_0.1.0"
    meta = json.loads((folder / "meta.json").read_text(encoding="utf-8"))
    assert meta["guid"] == build.GUID
    assert meta["version"] == "0.1.0"
    # Jellyfin refuses a plugin whose targetAbi is above its own server version.
    assert meta["targetAbi"] == "10.10.0.0"
    assert calls == ["net8.0"]


def test_the_jellyfin_folder_carries_the_license(tmp_path, monkeypatch):
    monkeypatch.setattr(build, "DIST", tmp_path)
    monkeypatch.setattr(build, "publish", lambda project, framework, out, dotnet: published(out))

    build.build_jellyfin("dotnet", "0.1.0")

    text = (tmp_path / "jellyfin" / "SubtitleDB_0.1.0" / "LICENSE").read_text(encoding="utf-8")
    assert text == build.LICENSE.read_text(encoding="utf-8")


def test_every_assembly_is_stamped_mit_and_ours():
    # The Emby zip unpacks into a shared directory, so its DLLs are where this lives.
    props = (HERE / "Directory.Build.props").read_text(encoding="utf-8")
    assert "<PackageLicenseExpression>MIT</PackageLicenseExpression>" in props
    assert "<Copyright>Copyright (c) 2026 TheSubtitleDb.org</Copyright>" in props


def test_the_guid_is_the_one_the_config_page_asks_for():
    # The dashboard page fetches the configuration by this id. A mismatch shows an
    # empty form that saves nothing, with no error anywhere.
    page = (HERE / "src" / "SubtitleDb.Jellyfin" / "Configuration" / "configPage.html").read_text(
        encoding="utf-8"
    )
    plugin = (HERE / "src" / "SubtitleDb.Jellyfin" / "Plugin.cs").read_text(encoding="utf-8")

    assert build.GUID in page
    assert build.GUID in plugin
