# SubtitleDB for VLC

One Lua file.

## Install

Copy `subtitledb.lua`, from the newest `vlc-v` [release](https://github.com/thesubtitledb/subtitledb-integrations/releases) or from this
directory, into VLC's extensions directory (create it if missing), then restart VLC.

| | |
|---|---|
| Windows | `%APPDATA%\vlc\lua\extensions\` |
| macOS | `~/Library/Application Support/org.videolan.vlc/lua/extensions/` |
| Linux | `~/.local/share/vlc/lua/extensions/` |

For every user on the machine, use the same path under VLC's own install directory.

Open it from View -> SubtitleDB while something is playing.

## The window

The layout is vlsub's: the title and the numbers at the top, three language choices,
the results, then the actions. vlsub is GPL-3.0, so none of its code is used.

- Search this file uses the file name: `Breaking.Bad.S05E14.1080p.BluRay.x264-DEMAND.mkv`
  is a series, season and episode; `Anatomy.of.a.Fall.2023.mkv` a film and year. An IMDb
  id typed into the form is asked first.
- Search by name ignores the id and searches the title as typed, for a file named
  `video1.mkv` or a wrong id.
- Up to three languages, asked for in order.
- Download saves the file beside the video the search was for, as
  `<video>.<language>.<format>`, which VLC loads by itself next time, and loads it if that
  video is still playing. It downloads only from SubtitleDB's own addresses, and refuses
  a web page or an empty file sent in place of a subtitle.
- When the playlist moves on, the form is filled in again for the new item and the old
  results are cleared.
- The status line names the title the results are for. With no answer, it asks once
  more for a title that always answers, and says whether the API is down or no title
  matched.

It prefers a subtitle recorded against the release being played, earlier languages over
later ones, and a file with cues over one without. A season and episode that disagree
with the file, or a format VLC cannot parse, are dropped, not ranked low.

## Settings

View -> SubtitleDB -> Settings, or the button, saved to `subtitledb.conf` in VLC's data
directory: languages; whether to save beside the video; whether to overwrite a file
already there (off: the existing one is kept and the new one gets `.subtitledb` before its extension);
subtitles per language (500, from 100 to 2000); and the API address, for running your
own.

## Tests

```bash
tests/get-lua.sh && tests/.lua/bin/lua tests/run.lua
```

`get-lua.sh` builds Lua 5.4 from source into `tests/.lua`. VLC embeds Lua 5.1 or 5.2,
depending on the build (Ubuntu's VLC 3.0.20 is 5.2), and 5.4 has integers, `goto` and a
`utf8` library that 5.1 does not, so `run.lua` fails on 5.4-only spellings in the
source.

The tests load the extension with `vlc` absent: everything that decides anything works
without a player. Inside VLC 3: [`plugins/hosts`](../hosts/README.md).

## License

MIT. The text is in [`plugins/LICENSE`](../LICENSE). The extension travels as one file,
so `subtitledb.lua` also says so in its first two lines.
