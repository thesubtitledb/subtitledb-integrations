# Live hosts

Installs each plugin into its application on a GitHub-hosted runner and does what a user
does with each [sample](#samples): searches for subtitles, downloads the first one
SubtitleDB offers and checks the file landed. The unit suites test each plugin's logic
against stubs; this tests the plugin against its host, and the API against the samples.

It pulls the servers from nothing and depends on the live API and a few package
mirrors, so it runs only when asked: Actions > Live hosts > Run workflow, for one host
or all.

## Jobs

| Job | Host | Installed from | The check |
|---|---|---|---|
| api | none | | `baseline.py`: for every sample, route a host takes and language asked, that the API answers with the right title, by the rung meant for that route |
| jellyfin | 10.10.7, 10.11.11, 12.1 | the official container | the plugin installed from the server's catalog, out of a repository built as a release's is and served from the runner, or any repository URL given to the run; then the server's subtitle search and download calls, once per language, and that every row offered is one the index holds for the sample's own film or episode |
| emby | 4.8.11.0, 4.9.5.0, 4.10.0.40 | the official container | the same calls and checks, Emby's side |
| kodi | Ubuntu 22.04's Kodi 19, Flathub's (21.x) | apt, flatpak, under Xvfb | the subtitle the addon loads by itself as each video starts (that setting at its default) and that Kodi shows it; then, over JSON-RPC, the plugin:// search and download URLs Kodi's subtitle dialog opens, for each file played by path alone and then from the library, and the title and rung the addon logs; and that a download the API refuses ends the listing with the failure logged; then, restarted against `kodi_edge.py`'s fake API, each way the API can fail, the videos the addon must leave alone, and quitting mid-lookup |
| bazarr | Bazarr 1.6.1 with Radarr 6.4.4 and Sonarr 4.0.20 | the linuxserver containers, then `install.py` | Bazarr's manual search and download after it syncs films from Radarr and shows from Sonarr, and that the provider claimed the title for every row and offered every language of the profile |
| vlc | VLC 3 from Ubuntu | apt | the extension's buttons, pressed by an interface script; the title its status line names; each row's language; then VLC's subtitle track list |
| vlc-windows | VLC 3 from Chocolatey, on a Windows runner | choco | the same script, where a file's URI carries a drive letter and its name goes through the system code page |

Every host job also runs `baseline.py` first, so a host that finds nothing can be told
from an index that has nothing. Only the api job fails on it.

## Samples

`media.py` writes black twenty-minute 480p videos with a silent audio track, named the
way releases are, with the NFO files Jellyfin, Emby and Kodi read. Each is asked for in
English:

- the film and the episode the API's own live tests use, the two asked for in Spanish
  and Brazilian Portuguese too
- the first episode of six free-to-air shows, each as a 480p release, the lowest quality
  that gets rips: Doctor Who, Sherlock, Downton Abbey, Peaky Blinders, Friends and The
  Simpsons
- Amélie, whose folder, file and title carry a character outside ASCII that every host
  has to get through a path, a URL and a file name
- a title that exists nowhere, where the right answer is nothing, said as such

The NFO files make the scraper's own id the default, as Kodi's TMDB and TVDB scrapers
do, with the IMDb id beside it. The Friends episode has no IMDb id of its own, so a
library host has to find it by its show's; Jellyfin and Emby fetch nothing online that
would fill it in.

Each sample is asked for by every route the hosts take: the ids Jellyfin, Emby and a
Kodi library keep; the series' id alone for an episode, which is often all Sonarr gives
Bazarr; and the name Kodi without a library and VLC read off the file. Where the index
holds a subtitle for the sample's very release (three of the shows are named after
one), the ranking must put one first. Bazarr never sees the title that exists nowhere:
Radarr holds nothing TMDB does not know.

## Count per language

Every host is set to 120 subtitles per language through its own settings: the addon's
settings file for Kodi, the plugin configuration API for Jellyfin and Emby, the
environment for Bazarr, the settings window for VLC. The index holds 147 English
subtitles for The Matrix, so that list must pass 100, more than the API's first page
gives, and stop at 120, which only the setting does. Every other list must be 120 or
shorter. `baseline.py` checks that the index still holds more than 120 where `media.py`
says so and no more anywhere else, so a changed index fails there, not in a host.

## Files

| File | What it is |
|---|---|
| `media.py` | the sample library: the videos, their ids and languages, and the NFO files that carry the ids |
| `baseline.py` | what the API answers for each sample by each route and language, and whether it is the right title |
| `mediaserver.py` | drives Jellyfin or Emby over its HTTP API, from the setup wizard to the download |
| `kodi.py` | drives Kodi over JSON-RPC, sets the library up in its database, and prints the addon's lines from `kodi.log` |
| `kodi_edge.py` | the edge videos, and a fake API that answers each request however a case needs: down, hanging, rate limited, an error page, malformed JSON, a broken download |
| `bazarr.py` | drives Radarr, Sonarr and Bazarr over their HTTP APIs |
| `vlc/sdb_live.lua` | a VLC interface script that loads the extension, stands in for its window, and presses its buttons |
| `vlc/run.sh` | one VLC per sample video with that script, on Linux or Windows |
| `kodi/*.xml` | Kodi settings written before it starts: the web server on, debug logging |
| `kodi/script.subtitledb.set/` | an addon `kodi_edge.py` runs to change a setting while Kodi runs |
| `bazarr/*` | Radarr, Sonarr and Bazarr settings written before they start, with the API keys `bazarr.py` sends |

Each driver takes a URL or a media path, so it can be pointed at a server started some
other way, or at real files laid out the same way. `run.sh` takes
`VLC=/path/to/vlc.exe` for a VLC installed on Windows.

## Known failure

The API resolves the name "Friends" to Matlock (2024), and "Amelie" without its accent,
with the year 2001, to a film of 1961, so the name routes (Kodi without a library, VLC)
get the wrong title's subtitles. Until the API is fixed, the api job and the name routes
in the kodi, vlc and vlc-windows jobs fail on the Friends sample.
