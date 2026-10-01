# SubtitleDB for Bazarr

A subliminal provider for subtitles from `api.thesubtitledb.org`. No key, account or
quota. It adds nothing to Bazarr's dependencies: the client under `plugins/python` is
standard library only.

## Install

Download `subtitledb-bazarr-<version>.zip` from the newest `bazarr-v` [release](https://github.com/thesubtitledb/subtitledb-integrations/releases),
unzip it, and point its installer at Bazarr:

```bash
python3 subtitledb-bazarr-<version>/bazarr/install.py /opt/bazarr
```

From a checkout, run `python3 install.py /opt/bazarr` in this directory. `python3 build.py`
writes the same zip into `dist/`.

It copies:

| To | What |
|---|---|
| `custom_libs/subtitledb/` | the shared client, on Bazarr's import path |
| `custom_libs/subliminal_patch/providers/subtitledb.py` | the provider |

Bazarr registers each file in the providers directory when it starts, named after the
file. Enable it in `config/config.yaml`:

```yaml
general:
  enabled_providers:
    - subtitledb
```

Then restart Bazarr. It cannot appear on Bazarr's settings page, whose provider list is
built into Bazarr's frontend.

Uninstall: `python3 install.py /opt/bazarr --uninstall`.

## Settings

Up to 500 subtitles per language. To change it, set `SUBTITLEDB_PER_LANGUAGE` (100 to
2000) in Bazarr's environment; for Docker, `-e SUBTITLEDB_PER_LANGUAGE=200`. Each 100 is
one API request. `SUBTITLEDB_API_BASE` points it at your own copy of the API.

## What it uses

| Bazarr has | The provider |
|---|---|
| an IMDb id | asks for that title, one request |
| a series (IMDb id or name), season and episode | asks by the series' id, else its name, drilled to that episode, and keeps only that episode's rows |
| the episode title | chooses between episodes of the series |
| the file's release name | prefers a subtitle recorded against that release |
| a language list | sends one request per language |

Bazarr scores only the matches a provider claims, and drops an episode's subtitle unless
series, season and episode are among them. The provider claims only what it checked: the
title the lookup resolved to (by IMDb id when both sides have one, else by name and
year), the season and episode it drilled to, and what Bazarr's parser reads off the
subtitle's release name.

## Languages

The shared client maps Bazarr's babelfish languages to the API's two-letter codes plus
four OpenSubtitles additions, the same mapping every SubtitleDB plugin uses. Brazilian
Portuguese is `pb`; `pt` is European Portuguese.

## Tests

```bash
python3 -m pytest
```

Bazarr is an application, not a package, so `tests/conftest.py` stands in for the parts
the provider touches. Ranking is tested in `plugins/python/tests`. In a real Bazarr:
[`plugins/hosts`](../hosts/README.md).

## License

MIT. The text is in [`plugins/LICENSE`](../LICENSE); `install.py` copies it beside the
client in Bazarr's tree, and `provider.py` says so in its first two lines.
