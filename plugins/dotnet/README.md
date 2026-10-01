# SubtitleDB for Jellyfin and Emby

Two subtitle providers built on one shared library.

```
src/SubtitleDb.Core       the API client and the ranking, netstandard2.0
src/SubtitleDb.Jellyfin   the provider for Jellyfin 10.10 and later, net8.0
src/SubtitleDb.Emby       the provider for Emby 4.8 and later, netstandard2.0
```

## Install

Jellyfin: in Dashboard > Plugins > Repositories, add
`https://cdn.thesubtitledb.org/plugins/jellyfin/manifest.json`, install SubtitleDB from
the catalog and restart. Updates come through the same repository.

Emby: unzip [subtitledb-emby.zip](https://cdn.thesubtitledb.org/plugins/emby/subtitledb-emby.zip)
into Emby's `plugins` directory and restart.

Then tick SubtitleDB and pick the download languages in each library's settings:

- Jellyfin: Dashboard > Libraries > Manage library > Subtitle Downloads
- Emby: Settings > Library, edit the library with "Show advanced settings" on

## Settings

On the plugin's page, under Dashboard > Plugins in Jellyfin or Settings > Plugins in
Emby:

| Setting | Default |
|---|---|
| Get latest subtitles on play | on |
| Subtitles per language, 100 to 2000 | 500 |
| API address | `https://api.thesubtitledb.org` |

## Search

The host's subtitle search asks for one language at a time. The plugin looks the video
up by the first of these that finds it:

- the IMDb id
- the TMDB id, for a film
- the series' IMDb id, with the season and episode
- the series name, season and episode, with the episode title to choose between episodes

A subtitle recorded against the playing file's release ranks first. Subtitles filed
under another episode, or in a format the host cannot show, are left out. Each result
shows the release name (or the line count when there is none) and its language, and a
same-release subtitle is marked as matching your file. The result's comment says why it
ranked where it did. The file reaches the host in UTF-8, typed by its stored format.

## On play

When a film or an episode starts, the plugin saves the best match beside it, also when
it has subtitles already. The library's subtitle settings decide what it asks for:

- The download languages are tried in order, and the first with a match is saved.
  Nothing is asked when none are set.
- "Only download subtitles that are a perfect match" (Emby: "Require a hash match"),
  on by default, saves only a subtitle recorded against that release.
- "Skip if the default audio track matches the download language" skips a language the
  default audio track (or the first one) is already in.
- With SubtitleDB unticked for the library, nothing is asked.

Each video is asked for at most once in 10 minutes, and a subtitle already beside it is
not saved again. Players read the subtitle list as playback starts, so a new subtitle is
listed from the next play.

## When the API fails

Each request waits up to 15 seconds. A timeout, a failed connection or a server error is
retried twice. After that the search lists nothing from SubtitleDB and the host logs one
warning. A download that is empty or a web page is refused.

## Build

```bash
python3 tools/build-plugins.py                    # both; --host jellyfin or --host emby for one
python3 tools/build-plugins.py --repo <url>       # also dist/repo/, a Jellyfin repository
```

Needs the .NET 8 SDK.

| Output | Use |
|---|---|
| `dist/jellyfin/SubtitleDB_<version>/` | copy into Jellyfin's `plugins` directory |
| `dist/subtitledb-jellyfin-<version>.zip` | the same files, zipped |
| `dist/emby/SubtitleDb.Emby.dll` | copy into Emby's `plugins` directory |
| `dist/subtitledb-emby-<version>.zip` | the same file, zipped |
| `dist/repo/` | with `--repo`: the zip and a `manifest.json` naming it at `<url>/<zip>` |

`--history <manifest>` keeps every version an earlier manifest lists. No host assembly
ships, since a bundled copy would shadow the server's own. Emby resolves a plugin's
references only against its own assemblies, so its build is one DLL with Core compiled
in, and the build fails if a second DLL appears in `dist/emby`.

## Tests

```bash
dotnet test SubtitleDb.sln
python3 -m pytest              # the packaging rules, no compiler needed
```

`tests/SubtitleDb.Tests` runs the shared cases in `plugins/shared/match-cases.json`. The
Jellyfin and Emby test projects check each host's translation and are separate because
one process cannot load both hosts' assemblies. [plugins/hosts](../hosts/README.md)
tests the plugins inside the real servers.

## License

MIT, in [plugins/LICENSE](../LICENSE), which ships in the Jellyfin folder. Emby's
plugins share one directory, so there the assemblies carry the copyright instead.
