# Live hosts

Each plugin installed into the application it is for, on a GitHub-hosted runner, and
made to do what a user does: search for subtitles for a film, an episode, six
free-to-air shows, a film with an accent in its name and a title that does not
exist, in English and for two of them in Spanish and Brazilian Portuguese too,
download the first one SubtitleDB offers, and check the file landed. The unit suites
beside each plugin test the logic against stubs; this tests the plugin against the
host, and the API against the samples.

It runs when asked, not on every push, because it pulls the servers from nothing and
depends on the live API and a few package mirrors:

Actions > Live hosts > Run workflow, and pick one host or all of them.

## What runs

| Job | Host | Installed from | The check |
|---|---|---|---|
| api | none | | `baseline.py`: what the API answers for every sample by every route a host takes, whether it is the right title and came by the rung meant for that route, in every language asked |
| jellyfin | 10.10.7, 10.11.11, 12.1 | the official container | the plugin installed from the server's catalog, out of a repository built as a release's is and served from the runner, or out of any repository URL given to the run; then the server's own subtitle search and download calls, once per language, and that every row offered is one the index holds for the sample's own film or episode |
| emby | 4.8.11.0, 4.9.5.0, 4.10.0.40 | the official container | the same calls and checks, Emby's side |
| kodi | Ubuntu 22.04's Kodi 19, Flathub's (21.x) | apt, flatpak, under Xvfb | the plugin:// search and download URLs Kodi's subtitle dialog opens, over JSON-RPC, for each file played by its path alone and then from Kodi's library, and the title and rung the addon logs |
| bazarr | Bazarr 1.6.1 with Radarr 6.4.4 and Sonarr 4.0.20 | the linuxserver containers, then `install.py` | Bazarr's manual search and download, after it syncs the films from Radarr and the shows from Sonarr, and that the provider claimed the title for every row and offered every language of the profile |
| vlc | VLC 3 from Ubuntu | apt | the extension's own buttons, pressed by an interface script, the title its status line names, the language of every row, then VLC's subtitle track list |
| vlc-windows | VLC 3 from Chocolatey, on a Windows runner | choco | the same script, where a file's URI carries a drive letter and a file's name goes through the system code page |

Every host job prints `baseline.py` first as well, so a host that finds nothing can
be told apart from an index that has nothing. Only the api job fails on what it says.

## The samples

`media.py` writes them: black twenty-minute 480p videos with a silent audio track,
named the way releases are named, with the NFO files Jellyfin, Emby and Kodi read.
The film and the episode are the two titles the API's own live tests use, and the
two asked for in Spanish and Brazilian Portuguese as well as English. The shows are
popular free-to-air ones, the first episode of each as a 480p release, the lowest
quality that gets rips: Doctor Who, Sherlock, Downton Abbey, Peaky Blinders, Friends
and The Simpsons. Then Amélie, whose folder, file and title carry a character
outside ASCII that every host has to get through a path, a URL and a file name, and
a title that exists nowhere, for which the right answer is nothing, said as such.
The plugins read a file's name, its ids and its release tags and never its picture,
so a black file walks the same path a real one would.

The NFO files make the scraper's own id the default, as Kodi's TMDB and TVDB
scrapers do, with the IMDb id beside it. The Friends episode has no IMDb id of its
own, as a TVDB-scraped episode often has none, so a library host has to find it by
its show's. Jellyfin and Emby fetch nothing online, which would fill that id in.

Each sample is asked for by the routes the hosts take: the ids Jellyfin, Emby and a
Kodi library keep, the series' id alone for an episode, which is all Sonarr gives
Bazarr, and the name Kodi without a library and VLC read off the file. Where the
index holds a subtitle for the sample's very release (three of the shows are named
after one), the ranking must put one first. Bazarr never sees the title that exists
nowhere: Radarr holds nothing TMDB does not know.

## The count per language

Every host is set to 120 subtitles per language through its own settings: the
addon's settings file for Kodi, the plugin configuration API for Jellyfin and Emby,
the environment for Bazarr, and the settings window for VLC. The index holds 147
English subtitles for The Matrix, so its English list has to be longer than 100,
which the API's first page cannot give, and no longer than 120, which only the
setting can stop. Every other list has to be 120 or shorter. `baseline.py` checks
that the index still holds more than 120 where `media.py` says so and no more
anywhere else, so a changed index fails there and not as a mystery in a host.

## Files

| File | What it is |
|---|---|
| `media.py` | the sample library: the videos, their ids and languages, and the NFO files that carry the ids |
| `baseline.py` | what the API answers for each sample by each route and language, and whether it is the right title |
| `mediaserver.py` | drives Jellyfin or Emby over its HTTP API, from the setup wizard to the download |
| `kodi.py` | drives Kodi over JSON-RPC, sets the library up in its database, and prints the addon's lines from `kodi.log` |
| `bazarr.py` | drives Radarr, Sonarr and Bazarr over their HTTP APIs |
| `vlc/sdb_live.lua` | a VLC interface script that loads the extension, stands in for its window, and presses its buttons |
| `vlc/run.sh` | one VLC per sample video with that script, on Linux or Windows |
| `kodi/*.xml` | Kodi settings written before it starts: the web server on, debug logging |
| `bazarr/*` | Radarr, Sonarr and Bazarr settings written before they start, with the API keys `bazarr.py` sends |

The drivers take a URL or a media path, so each can be pointed at a server started
some other way, or at a library of real files laid out the same way. `run.sh` takes
`VLC=/path/to/vlc.exe` to run against a VLC installed on a Windows machine.

## What it has caught

The first runs failed every host. Each of these passed its unit tests:

- Jellyfin loaded the plugin and never asked it for anything. Jellyfin takes subtitle
  providers from its service container, and the provider was not registered there.
- Emby could not load the plugin. It resolves a plugin's references only against its
  own assemblies, so `SubtitleDb.Core.dll` beside `SubtitleDb.Emby.dll` was never
  found. Core is now compiled into the one Emby DLL.
- Emby 4.8 loaded the plugin and every search failed. It runs on .NET 6, whose
  System.Text.Json is 6.0.0.0, and the DLL was built against the 8.0 package. It is
  built against 6.0 now; 4.9 and later bind that to their newer copy.
- VLC 3 searched for an episode as "Game of Thrones S01E01", the title its own file
  name reader writes, which matches nothing.
- VLC 3 saved the download and said it was loaded, but only VLC 4 has the call the
  extension used.
- VLC on Windows could not save beside the video. A file's URI there is
  `file:///C:/...`, and the extension took the scheme off and wrote to `/C:/...`.
  With that fixed it wrote the file and said it was loaded, and VLC had not loaded
  it: it will not take a Windows path written with forward slashes, and says
  nothing. The path is built with backslashes now.
- VLC on Windows filed a download for Amélie under another name. Lua's own file
  opener takes the name in the system code page, so the UTF-8 name came out as
  `AmÃ©lie`. The extension uses VLC's own opener, which takes UTF-8.
- VLC reported a title the index has nothing for as no answer from the API. VLC's
  HTTP stream comes back empty for a 404 and for a dead host alike. The extension
  now asks once more for something that always answers, and says which it was.
- Kodi listed nothing for a file played from outside its library. Kodi reports no id
  and no year for one, and the file's name as its title, and the addon searched for
  that name. It now reads the title and year, or the show and episode, off the name.
- Kodi's addon raised when playback had stopped by the time its search ran.
- Bazarr scored every SubtitleDB subtitle 0 and dropped all 97 for the episode. It
  scores only the matches a provider claims, and keeps an episode's subtitle only
  when series, season and episode are among them. The provider looked for those on
  the subtitle row, which carries none of them. It now claims what the lookup
  established.
- Bazarr with a profile of English, Spanish and Brazilian Portuguese got a hundred
  English rows for The Matrix and not one Spanish, though the index holds 65. The
  provider asked for all three languages in one lookup, whose ranking keeps the top
  hundred, and English filled them. It asks once per language now.
- Bazarr found nothing for Friends. Sonarr gives it a series' IMDb id and never an
  episode's, and the lookup ignored the series' id and went by the name. The same
  holds for a Kodi library scraped from TVDB, and Jellyfin's search request carries
  none of the series' ids. Every port now asks by the series' id, drilled to the
  season and episode, before the name, and the Jellyfin plugin finds the series in
  the library.
- The Kodi addon took the default id for the IMDb id. Kodi's TMDB and TVDB scrapers
  make their own id the default, so Friends' TVDB episode id 303821 went to the API
  as tt0303821. It reads the IMDb id by name now, and a bare number only when Kodi
  says it is one.
- The API resolves the name "Friends" to Matlock (2024), and "Amelie" without its
  accent, with the year 2001 beside it, to a film of 1961. Every host that goes by
  the name (Kodi without a library, VLC) is handed the wrong title's subtitles, and
  nothing in the list said so. The Kodi addon now logs the title a search was
  answered for and VLC's status line names it, so the harness and the user can see
  it. The resolution itself is the API's to fix; until it is, the api job and the
  name routes in the kodi, vlc and vlc-windows jobs fail on the Friends sample.
