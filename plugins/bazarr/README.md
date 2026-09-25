# SubtitleDB for Bazarr

A subliminal provider that fills subtitles from `api.thesubtitledb.org`. No key, no
account, no quota, and nothing added to Bazarr's dependency tree: the client under
`plugins/python` is standard library only.

## Install

Download `subtitledb-bazarr-<version>.zip` from the newest `bazarr-v` [release](https://github.com/thesubtitledb/subtitledb-integrations/releases),
unzip it, and point its installer at Bazarr:

```bash
python3 subtitledb-bazarr-<version>/bazarr/install.py /opt/bazarr
```

From a checkout of this repository it is `python3 install.py /opt/bazarr` in this
directory. `python3 build.py` writes the same zip into `dist/`.

That copies two things into the install:

| Copied to | What it is |
|---|---|
| `custom_libs/subtitledb/` | the shared client, on Bazarr's import path |
| `custom_libs/subliminal_patch/providers/subtitledb.py` | the provider |

Bazarr registers providers by listing that directory when it starts, and the file
name becomes the provider name, so there is no registry to edit.

Then turn it on in `config/config.yaml`:

```yaml
general:
  enabled_providers:
    - subtitledb
```

and restart. It is enabled in the file rather than on the settings page because
Bazarr builds that page's provider list into its frontend bundle, so a provider it
did not ship with cannot appear there.

To remove it: `python3 install.py /opt/bazarr --uninstall`.

It offers up to 500 subtitles per language. The API sends 100 a request, so a title
with 147 English subtitles takes two. To change it, set `SUBTITLEDB_PER_LANGUAGE`
(100 to 2000) in Bazarr's environment, for Docker with `-e
SUBTITLEDB_PER_LANGUAGE=200`.

## What it does with what Bazarr knows

Sonarr and Radarr give Bazarr more than most subtitle sources are told, and the
provider uses all of it:

| Bazarr has | The provider does |
|---|---|
| an IMDb id | asks for that title directly, one request |
| a series, a season and an episode number | searches the series, then keeps only rows for that episode |
| the episode title | uses it to choose between episodes of the same series |
| the file's release name | prefers a subtitle recorded against the same release |
| a language list | one request per language, a fan-out this provider chooses |

Bazarr scores a subtitle only on the matches its provider claims, and throws away an
episode's subtitle unless series, season and episode are all among them. The
provider claims what was checked: the title the lookup resolved to (by IMDb id when
both sides have one, by name and year when not), the season and episode the lookup
was drilled to, and whatever Bazarr's own parser reads off the subtitle's release
name. A provider that claims more gets its subtitles chosen over better ones from
elsewhere.

## Languages

Bazarr speaks babelfish, the API speaks two-letter codes with four OpenSubtitles
additions. The mapping is in the shared client and is the same one every plugin
here uses. The one that matters: Brazilian Portuguese is `pb`, not `pt`. Asking for
`pt` returns European Portuguese, which is not what the user configured.

## Tests

```bash
python3 -m pytest
```

Bazarr is an application rather than a package, so there is nothing to install as a
dependency. `tests/conftest.py` stands in for the parts of Bazarr the provider
touches, with the behaviour it relies on. The ranking rules are covered once, for
all the plugins, in `plugins/python/tests`.

The Live hosts workflow installs the provider into Bazarr itself, fed by Radarr and
Sonarr, and downloads a subtitle through it: see [`plugins/hosts`](../hosts/README.md).

## License

MIT. The text is in [`plugins/LICENSE`](../LICENSE); `install.py` puts a copy beside
the client in Bazarr's tree, and `provider.py` says so in its first two lines.
