# SubtitleDB for Jellyfin and Emby

Two subtitle providers built on one shared library.

```
src/SubtitleDb.Core       the API client and the ranking, netstandard2.0
src/SubtitleDb.Jellyfin   the provider for Jellyfin 10.10 and later, net8.0
src/SubtitleDb.Emby       the provider for Emby 4.8 and later, netstandard2.0
```

## Install

Jellyfin: in Dashboard > Plugins > Repositories, add
`https://cdn.thesubtitledb.org/plugins/jellyfin/manifest.json`, install TSDb from
the catalog and restart. Updates come through the same repository.

Emby: unzip [subtitledb-emby.zip](https://cdn.thesubtitledb.org/plugins/emby/subtitledb-emby.zip)
into Emby's `plugins` directory and restart.

Then tick TSDb (Jellyfin) or SubtitleDB (Emby) and pick the download languages in each library's settings:

- Jellyfin: Dashboard > Libraries > Manage library > Subtitle Downloads
- Emby: Settings > Library, edit the library with "Show advanced settings" on

## Settings

On the plugin's page, under Dashboard > Plugins in Jellyfin or Settings > Plugins in
Emby:

| Setting | Default |
|---|---|
| Get latest subtitles on play | on |
| Sync subtitles with other subtitle tracks (Jellyfin) | off |
| Sync subtitles with audio (uses CPU/GPU) (Jellyfin) | off |
| Subtitles per language, 100 to 2000 | 500 |
| API address | `https://api.thesubtitledb.org` |

[src/SubtitleDb.Jellyfin](src/SubtitleDb.Jellyfin/README.md) says what each Jellyfin
setting does.

## SYNCED track (Jellyfin)

With either sync setting on, every TSDb download also writes
`<video>.SYNCED - TSDb.<lang>.<ext>` where Jellyfin saves subtitles, with `(syncing) ` at
the start of every cue, and refreshes the video so it is listed. One job at a time then
lines it up with Jellyfin's own ffmpeg:

- Other subtitle tracks: against the first 50 cues of a text subtitle inside the video
  (not forced, the same language first), read from the start and never past its first
  15 minutes, so a large file costs no more than a small one. At least 20 cues are
  needed. A track titled "Forced" counts as forced, and when the first track has too
  few cues the next one is read.
- Audio: against the speech in four 2-minute samples of the default audio track, found
  with Silero VAD v5 run in C# (no ONNX Runtime). From 5 channels up only the centre
  channel is read.

The match is a shift and a speed (framerate) correction, as in
[subtitledb-sync](https://github.com/thesubtitledb/subtitledb-sync). At confidence 0.5 and
over the file is rewritten with the new times and without the mark; otherwise, or after
15 minutes, it is deleted. Each outcome is one Information line in Jellyfin's log. A
file already synced is not done again when the same subtitle is downloaded again. Nothing
is sent anywhere: it all runs in Jellyfin.

Checked on a home Jellyfin 12.2: a 103-minute film synced against its audio in 8 s
(confidence 0.79, already in sync); a film whose TSDb subtitle ran 24.2 s early was
lined up against its own English track (confidence 1.00, 0.1 s from that track).
Jellyfin lists the result as "SYNCED - TSDb - English - SUBRIP - External".

## Search

The host's subtitle search asks for one language at a time. The plugin looks the video
up by the first of these that finds it:

- the IMDb id
- the TMDB id, for a film
- the series' IMDb id, with the season and episode
- the series name, season and episode, with the episode title to choose between episodes

A subtitle recorded against the playing file's release ranks first. A file named only
for its title, year or episode, such as `The Matrix (1999).mkv`, names no release, so
nothing is matched to it by release name. Subtitles filed
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
not saved again.

Jellyfin: the lookup runs when the player asks for the video's tracks (PlaybackInfo),
before Jellyfin answers, and the player waits up to 4 seconds for it. A subtitle found
in time is in the list the player starts with, and so is its SYNCED copy, which is
rewritten in place once synced. A player picks tracks by number, and Jellyfin numbers
files beside a video before the tracks inside it, so while a video plays the plugin adds
and removes no file: one found late, or a SYNCED copy that could not be synced and is
removed, waits until the video stops. Emby: players read the subtitle list as playback
starts, so a new subtitle is listed from the next play.

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
| `dist/jellyfin/TSDb_<version>/` | copy into Jellyfin's `plugins` directory |
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
