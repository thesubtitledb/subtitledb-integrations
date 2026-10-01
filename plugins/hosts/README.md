# Live hosts

Installs each plugin into its real application on a GitHub runner and does what a user
does with each [sample](#samples): search, download the first subtitle SubtitleDB offers,
and check the file arrived. The unit suites test each plugin against stubs; this tests it
against its host, and the API against the samples.

It builds the servers from scratch and depends on the live API and a few package mirrors,
so it runs only on request: Actions > Live hosts > Run workflow, for one host or all.

## Jobs

| Job | Versions | Installed from | What it checks |
|---|---|---|---|
| api | none | | `baseline.py`: for each sample, route and language, that the API answers with the right title by the rung meant for that route |
| jellyfin | 10.10.7, 10.11.11, 12.1 | official container | the plugin installed from a repository built the way a release builds it (or any repository URL given to the run); the server's subtitle search and download in each language, offering only rows for the sample's own film or episode; the plugin's settings page in Chromium; then, against `mediaserver_edge.py`'s fake API, every way the API or a download can fail, and the lookup on play |
| emby | 4.8.11.0, 4.9.5.0, 4.10.0.40 | official container | the same, on Emby |
| kodi | 19 from Ubuntu 22.04, 21 from Flathub | apt, flatpak, under Xvfb | the subtitle the add-on loads by itself as each video starts, and that Kodi shows it; the subtitle dialog's search and download over JSON-RPC, for files played by path and from the library; a refused download logged; then, against `kodi_edge.py`'s fake API, every way the API can fail, the videos the add-on must leave alone, and quitting mid-lookup |
| bazarr | Bazarr 1.6.1, Radarr 6.4.4, Sonarr 4.0.20 | linuxserver containers, then `install.py` | Bazarr's manual search and download after it syncs films from Radarr and shows from Sonarr, the title claimed for every row, and every language of the profile offered |
| vlc | VLC 3 from Ubuntu | apt | the extension's buttons pressed by an interface script, the title on its status line, each row's language, and VLC's subtitle track list |
| vlc-windows | VLC 3 from Chocolatey | choco | the same on Windows, where a file's URI has a drive letter and its name goes through the system code page |

Every host job runs `baseline.py` first, so a host that finds nothing can be told apart
from an index that has nothing. Only the api job fails on it.

## Samples

`media.py` writes black 480p videos with a silent audio track, named the way releases
are, with the NFO files Jellyfin, Emby and Kodi read. Each is searched in English:

- a film and an episode, also in Spanish and Brazilian Portuguese
- the first episode of six free-to-air shows: Doctor Who, Sherlock, Downton Abbey,
  Peaky Blinders, Friends and The Simpsons
- Amélie, whose folder, file and title carry a character outside ASCII
- a title that exists nowhere, where the right answer is nothing

The NFO files make the scraper's own id the default, as Kodi's TMDB and TVDB scrapers
do, with the IMDb id beside it. The Friends episode has no IMDb id of its own, so a
library host has to find it through its show's.

Each sample is searched by every route the hosts take: the ids Jellyfin, Emby and a Kodi
library keep, the series' id alone for an episode (often all Sonarr gives Bazarr), and
the name read off the file by Kodi without a library and by VLC. Where the index holds a
subtitle for the sample's exact release, it has to rank first. Bazarr never sees the
title that exists nowhere, because Radarr only holds what TMDB knows.

## Count per language

Every host is set to 120 subtitles per language through its own settings, so the
English list for the film has to pass the API's first page of 100 and stop at 120,
which only the setting does. `baseline.py` checks that the index still holds more than
120 where `media.py` expects it, so a changed index fails there and not in a host.

## Files

| File | What it does |
|---|---|
| `media.py` | the sample library: videos, ids, languages and NFO files |
| `baseline.py` | what the API answers for each sample, route and language |
| `mediaserver.py` | drives Jellyfin or Emby over HTTP, from the setup wizard to the download |
| `mediaserver_edge.py` | the Jellyfin and Emby plugins against the fake API: the subtitle dialog under each failure, and the lookup on play under each library rule |
| `settings_page.py` | opens the plugin's settings page in Jellyfin's or Emby's web app in Chromium and saves a setting off and on |
| `kodi.py` | drives Kodi over JSON-RPC, sets up its library and prints the add-on's log lines |
| `kodi_edge.py` | the edge-case videos, and a fake API that can be down, hang, rate limit, send an error page, malformed JSON or a broken download |
| `bazarr.py` | drives Radarr, Sonarr and Bazarr over HTTP |
| `vlc/sdb_live.lua` | a VLC interface script that loads the extension and presses its buttons |
| `vlc/run.sh` | one VLC per sample video, on Linux or Windows (`VLC=/path/to/vlc.exe`) |
| `kodi/*.xml` | Kodi settings written before it starts: the web server and debug logging |
| `kodi/script.subtitledb.set/` | an add-on `kodi_edge.py` uses to change a setting while Kodi runs |
| `bazarr/*` | Radarr, Sonarr and Bazarr settings written before they start |

Each driver takes a URL or a media path, so it also works against a server started some
other way, or real files laid out the same way.
