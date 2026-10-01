# SubtitleDB for Jellyfin and Emby

Two plugins over one library.

```
src/SubtitleDb.Core       the client, the ladder and the ranking. netstandard2.0
src/SubtitleDb.Jellyfin   ISubtitleProvider for Jellyfin 10.10 and later. net8.0
src/SubtitleDb.Emby       ISubtitleProvider for Emby 4.8 and later. netstandard2.0
```

Jellyfin and Emby each ship a different assembly called `MediaBrowser.Controller`, so
every decision lives in Core, which knows neither host, and each adapter only translates
its host's request.

## Install

- Jellyfin: under Dashboard -> Plugins -> Repositories add
  `https://cdn.thesubtitledb.org/plugins/jellyfin/manifest.json`, install SubtitleDB from
  the catalog and restart. Updates come through the repository, which serves the
  `jellyfin-v` release zips. Enable it under Dashboard -> Playback -> Subtitles.
- Emby: unzip [subtitledb-emby.zip](https://cdn.thesubtitledb.org/plugins/emby/subtitledb-emby.zip),
  always the newest `emby-v` [release](https://github.com/thesubtitledb/subtitledb-integrations/releases),
  into Emby's `plugins` directory, which puts `SubtitleDb.Emby.dll` there, and restart.
  Enable it under Settings -> Subtitles.

Tick SubtitleDB on that page and set your languages there. The plugin has no language
list: the host asks one language at a time.

## Settings

| Setting | Default |
|---|---|
| Get latest subtitles on play, see [On play](#on-play) | on |
| Subtitles per language, the most offered for each, 100 to 2000 | 500 |

Both are on the plugin's page: Dashboard -> Plugins -> SubtitleDB in Jellyfin, Settings
-> Plugins -> SubtitleDB in Emby.

## On play

When a film or an episode starts, the plugin asks SubtitleDB for it and saves the best
match beside it, also when the video has subtitles already. The library's subtitle
download settings decide the rest:

- Download languages: asked in order, and the first with a match is saved. With none
  set, nothing is asked.
- "Only download subtitles that are a perfect match", on by default: only a subtitle
  recorded against that release is saved. Untick it to get the best match.
- SubtitleDB unticked as a subtitle downloader: nothing is asked.

A video is asked for once in 10 minutes, and a subtitle already beside it is not saved
again. Players read the subtitle list as playback starts, so the new one is listed from
the next play. It uses only the host's own calls: the playback event, its subtitle search
and save, and the library refresh its subtitle dialog runs after a save.

## What it uses

| The host knows | The plugin |
|---|---|
| an IMDb id | asks for that title; episodes have their own ids in the corpus |
| a TMDB id, for a film | asks by it, falling through when the map has no row |
| the series' IMDb id (Jellyfin: found in its library) | asks by it, drilled to the season and episode, before the name |
| series name, season, episode | searches the series, keeps only that episode |
| the episode's own title | chooses between episodes of the series |
| the file that is playing | prefers a subtitle recorded against the same release |
| "this must be a perfect match" | returns only same-release subtitles |

A subtitle filed under another episode, or in a format the host cannot render, is
dropped rather than ranked low.

Both hosts show the label, the language and a "matches your file" mark, set when the
subtitle carries the playing file's release name. Without a release name, the label
carries the line count. Everything else, including why it ranked there, is in the
comment.

The bytes reach the host as the API stores them, typed by the row's format, not the file
name. The host converts the character set; the plugin does not.

Each request waits 15 seconds. One that times out, cannot connect or gets a server error
is tried twice more; then the search lists nothing from SubtitleDB and the host logs one
warning. A download that is empty or a web page is refused, not saved.

## Build

```bash
python3 tools/build-plugins.py
```

Needs the .NET 8 SDK. `--host jellyfin` or `--host emby` builds one. Writes `dist/`:

| | |
|---|---|
| `dist/jellyfin/SubtitleDB_<version>/` | copy into Jellyfin's `plugins` directory |
| `dist/subtitledb-jellyfin-<version>.zip` | that folder's files, with no folder around them |
| `dist/emby/SubtitleDb.Emby.dll` | copy into Emby's `plugins` directory |
| `dist/subtitledb-emby-<version>.zip` | the same, zipped |

`--repo <url>` also writes `dist/repo/`, a Jellyfin repository: the zip and a
`manifest.json` naming it at `<url>/<zip>` with its MD5. `--history <manifest>` keeps
every version an earlier manifest lists. A release builds it with its own download
folder as the URL and the previous release's manifest as the history;
cdn.thesubtitledb.org serves the newest release's manifest.

Only our own assemblies ship: a bundled copy of a host assembly shadows the server's.
Jellyfin gets Core and the adapter in the plugin's folder. Emby resolves a plugin's
references only against its own assemblies, so it would never find a
`SubtitleDb.Core.dll`: it gets one DLL with Core compiled in, and the build fails if a
second DLL appears in `dist/emby`.

## Tests

```bash
dotnet test SubtitleDb.sln     # 158 tests
python3 -m pytest              # the packaging rules, no compiler needed
```

`tests/SubtitleDb.Tests` runs `plugins/shared/match-cases.json`.
`tests/SubtitleDb.Jellyfin.Tests` and `tests/SubtitleDb.Emby.Tests` are separate
projects because one process cannot load both hosts' assemblies. They test each host's
translation: which id is safe to send, which name is the series and which the episode,
and which language spelling arrived. In the real servers:
[`plugins/hosts`](../hosts/README.md).

## License

MIT. The text is in [`plugins/LICENSE`](../LICENSE) and ships in the Jellyfin folder.
Emby's zip unpacks into a directory other plugins share, so there the assemblies carry
the copyright instead, from `Directory.Build.props`.
