# SubtitleDB for Bazarr

A subtitle provider for Bazarr. It needs no key or account, and it adds nothing to
Bazarr's dependencies: the client in `plugins/python` uses the standard library only.

## Install

Download `subtitledb-bazarr-<version>.zip` from the newest `bazarr-v`
[release](https://github.com/thesubtitledb/subtitledb-integrations/releases), unzip it
and point the installer at Bazarr:

```bash
python3 subtitledb-bazarr-<version>/bazarr/install.py /opt/bazarr
```

From a checkout, run `python3 install.py /opt/bazarr` in this directory. It copies the
client to `custom_libs/subtitledb/` and the provider to
`custom_libs/subliminal_patch/providers/subtitledb.py`.

Bazarr's settings page has a fixed list of providers, so enable this one in
`config/config.yaml` and restart Bazarr:

```yaml
general:
  enabled_providers:
    - subtitledb
```

To remove it, run `python3 install.py /opt/bazarr --uninstall`.

## Settings

Set these in Bazarr's environment, for Docker with `-e`:

| Variable | Default |
|---|---|
| `SUBTITLEDB_PER_LANGUAGE` | 500 subtitles per language, from 100 to 2000, 100 per request |
| `SUBTITLEDB_API_BASE` | `https://api.thesubtitledb.org` |

## Search

Each language is searched on its own. The provider looks a film up by its IMDb id, and
an episode by the series' IMDb id or name, drilled to the season and episode, keeping
only that episode's subtitles. The episode title chooses between episodes, and a
subtitle recorded against the file's release ranks first.

Bazarr scores only the matches a provider claims, and drops an episode's subtitle
unless the series, season and episode are among them. This provider claims only what it
checked: the title the lookup found (by IMDb id when both sides have one, else by name
and year), the season and episode, and what Bazarr's parser reads off the subtitle's
release name.

Languages map to the API's codes the same way in every SubtitleDB plugin. Brazilian
Portuguese is `pb`, and `pt` is European Portuguese.

## When the API is busy or down

A 429, or no answer after the client's retries, reaches Bazarr as TooManyRequests or
ServiceUnavailable. After five of those in two minutes Bazarr pauses the provider, for
an hour after a 429 and 20 minutes otherwise. A subtitle that is gone (404) is skipped
for the next best.

## Build and test

```bash
python3 build.py      # the release zip, into dist/
python3 -m pytest
```

Bazarr is an application rather than a package, so `tests/conftest.py` stands in for
the parts the provider touches. Ranking is tested in `plugins/python/tests`, and
[plugins/hosts](../hosts/README.md) runs the provider inside a real Bazarr.

## License

MIT, in [plugins/LICENSE](../LICENSE). `install.py` copies it beside the client in
Bazarr's tree, and `provider.py` says so in its first two lines.
