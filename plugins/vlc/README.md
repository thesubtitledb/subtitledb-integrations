# SubtitleDB for VLC

A VLC 3 extension in one file, `subtitledb.lua`.

## Install

Copy `subtitledb.lua`, from the newest `vlc-v`
[release](https://github.com/thesubtitledb/subtitledb-integrations/releases) or from this
directory, into VLC's extensions directory (create it if it is missing) and restart VLC.

| System | Directory |
|---|---|
| Windows | `%APPDATA%\vlc\lua\extensions\` |
| macOS | `~/Library/Application Support/org.videolan.vlc/lua/extensions/` |
| Linux | `~/.local/share/vlc/lua/extensions/` |

To install it for every user, use `lua/extensions/` under VLC's own install directory.
Open it from View > SubtitleDB while something is playing.

## The window

- Search this file reads the file name, so
  `Breaking.Bad.S05E14.1080p.BluRay.x264-DEMAND.mkv` is a series, season and episode
  and `Anatomy.of.a.Fall.2023.mkv` is a film and its year. An IMDb id typed into the
  form is tried first.
- Search by name ignores the id and searches the title as typed, for a file called
  `video1.mkv` or a wrong id.
- Up to three languages, searched in order.
- Download saves the subtitle beside the video as `<video>.<language>.<format>`, which
  VLC also picks up by itself next time, and loads it if that video is still playing.
- When the playlist moves on, the form fills in for the new item and the old results
  are cleared.
- The status line names the title the results are for, or says whether the API is down
  or no title matched.

A subtitle recorded against the playing release ranks first, then earlier languages
before later ones, then files with cues before files without. Subtitles for another
episode, or in a format VLC cannot read, are left out. Downloads come only from
SubtitleDB's own addresses, and a web page or an empty file is refused.

## Settings

The Settings button (or View > SubtitleDB > Settings) saves to `subtitledb.conf` in
VLC's data directory:

| Setting | Default |
|---|---|
| Language, second and third language | English, none, none |
| Save beside the video | yes; no keeps it with VLC's settings |
| Overwrite an existing file | no: the new file gets `.subtitledb` before its extension |
| Subtitles per language, 100 to 2000 | 500 |
| API address | `https://api.thesubtitledb.org` |

## Tests

```bash
tests/get-lua.sh && tests/.lua/bin/lua tests/run.lua
```

`get-lua.sh` builds Lua 5.4 into `tests/.lua`. VLC embeds Lua 5.1 or 5.2, so `run.lua`
also fails on anything in the source that only 5.4 understands. The tests load the
extension without VLC, and [plugins/hosts](../hosts/README.md) runs it inside VLC 3.

## License

MIT, in [plugins/LICENSE](../LICENSE). The extension travels as one file, so its first
two lines say so too.
