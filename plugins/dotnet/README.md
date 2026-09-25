# SubtitleDB for Jellyfin and Emby

Two plugins over one library. Subtitles from the SubtitleDB open index. No account,
no key, no quota, so neither plugin has a login and neither asks you for one.

```
src/SubtitleDb.Core       the client, the ladder and the ranking. netstandard2.0
src/SubtitleDb.Jellyfin   ISubtitleProvider for Jellyfin 10.10 and later. net8.0
src/SubtitleDb.Emby       ISubtitleProvider for Emby 4.8 and later. netstandard2.0
```

Jellyfin and Emby each ship an assembly called `MediaBrowser.Controller`, and the two
are not the same assembly. That is the whole reason for the split: everything that
decides anything lives in Core, which knows about neither, and each adapter is only
the translation between one host's request and ours.

## Install

**Jellyfin** 10.10 or later: add the repository
`https://cdn.thesubtitledb.org/plugins/jellyfin/manifest.json` under Dashboard ->
Plugins -> Repositories, install SubtitleDB from the catalog, and restart the server.
Updates come through the same repository.

**Emby** 4.8 or later: unzip
[subtitledb-emby.zip](https://cdn.thesubtitledb.org/plugins/emby/subtitledb-emby.zip)
into Emby's `plugins` directory, which puts `SubtitleDb.Emby.dll` there, and restart
the server. That link is always the newest `emby-v`
[release](https://github.com/thesubtitledb/subtitledb-integrations/releases); the
repository's zips are the `jellyfin-v` ones.

Then turn the provider on:

- **Jellyfin**: Dashboard -> Playback -> Subtitles -> tick SubtitleDB, and set your
  languages there.
- **Emby**: Settings -> Subtitles -> tick SubtitleDB, and set your languages there.

## Build

```bash
python3 tools/build-plugins.py
```

Needs the .NET 8 SDK. Writes `dist/`:

| | |
|---|---|
| `dist/jellyfin/SubtitleDB_<version>/` | copy into Jellyfin's `plugins` directory |
| `dist/subtitledb-jellyfin-<version>.zip` | that folder's files, with no folder around them |
| `dist/emby/SubtitleDb.Emby.dll` | copy into Emby's `plugins` directory |
| `dist/subtitledb-emby-<version>.zip` | the same, zipped |

`--repo <url>` also writes `dist/repo/`, a Jellyfin repository: `manifest.json`, naming
the zip at `<url>/<zip>` with its MD5, and the zip beside it. `--history <manifest>`
keeps every version an earlier manifest lists. A release builds it with its own
download folder as the URL and the previous release's manifest as the history, and
cdn.thesubtitledb.org serves the newest release's manifest.

Only our own assemblies are published. Both hosts already carry everything else,
and a plugin that ships its own copy of a host assembly shadows the server's own and
fails in ways that read like a server bug.

Jellyfin gets two, Core and the adapter, in the plugin's own folder. Emby gets one,
with Core compiled into it: Emby resolves a plugin's references only against its own
assemblies, so a `SubtitleDb.Core.dll` beside the adapter is never found and the
plugin does not load. The build fails if a second DLL turns up in `dist/emby`.

The languages are the server's, not the plugin's. Both hosts ask one language at a
time, from the settings the user already filled in, and a second list inside the
plugin could only disagree with it.

**Subtitles per language** is the most offered for each language: 500 unless
changed, anything from 100 to 2000. The API sends 100 a request, so a title with 147
English subtitles takes two. Jellyfin has it on the plugin's page, Dashboard ->
Plugins -> SubtitleDB. Emby has no page for it: stop the server, set `PerLanguage` in
`plugins/configurations/SubtitleDb.Emby.xml`, and start it again.

## What it uses

| The host knows | The plugin does |
|---|---|
| an IMDb id | asks for that title directly. Works for episodes: the corpus files each under its own id |
| a TMDB id, for a film | asks by that, and falls through when the map has no row |
| series name, season, episode | searches the series, then keeps only that episode |
| the episode's own title | uses it to choose between episodes of the series |
| the file that is playing | prefers a subtitle recorded against the same release |
| "this must be a perfect match" | answers with those, and nothing else |

A subtitle filed under another episode is dropped rather than ranked low. The wrong
episode is not a worse match, it is the wrong file, and that is how a viewer ends up
watching episode 14 with episode 15's lines.

A format the host cannot render is dropped for the same reason: handed one, the
player shows an empty track, which is the most confusing failure a subtitle plugin
has.

## What each host draws

Both show the label, the language and a "matches your file" mark. For a hash-matching
provider that mark means the file hashes agree; here it means the subtitle carries the
release name of the file being played, which is the same claim. Everything else in the
row, including the reason the subtitle ranked where it did, goes in the comment.

Most of the corpus carries no release name, so a label of just the language would read
"English" thirty times for one film. The line count fills that gap.

## Encoding

The bytes are handed over as the API stores them, with the format the row says it is
rather than the one the file name claims. Both hosts detect and convert the character
set themselves, and doing it twice is how a Cyrillic subtitle turns into question
marks.

## Tests

```bash
dotnet test SubtitleDb.sln     # 118 tests
python3 -m pytest              # the packaging rules, no compiler needed
```

`tests/SubtitleDb.Tests` runs `plugins/shared/match-cases.json`, the same file the
Python, Lua and TypeScript suites read, so a ranking rule changed in one language and
not the others fails here.

`tests/SubtitleDb.Jellyfin.Tests` and `tests/SubtitleDb.Emby.Tests` are separate
projects because one process cannot load both hosts' assemblies. They cover the
translation each host needs: which id is safe to send, which name is the series and
which is the episode, and which language spelling arrived.

The Live hosts workflow installs each plugin into three versions of its server, the
Jellyfin one from a repository built as a release's is, and searches and downloads
through them: see [`plugins/hosts`](../hosts/README.md).

## License

MIT. The text is in [`plugins/LICENSE`](../LICENSE) and ships in the Jellyfin
folder. Emby's zip unpacks into a directory other plugins share, so there the
assemblies carry the copyright instead, from `Directory.Build.props`.
