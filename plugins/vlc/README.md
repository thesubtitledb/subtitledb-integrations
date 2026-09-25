# SubtitleDB for VLC

One Lua file. Subtitles from the SubtitleDB open index, inside VLC. No account, no
key, no quota, so there is no login in this extension and nothing to paste into it.

## Install

Copy `subtitledb.lua`, from the newest `vlc-v` [release](https://github.com/thesubtitledb/subtitledb-integrations/releases) or from this
directory, into VLC's extensions directory, then restart VLC.

| | |
|---|---|
| Windows | `%APPDATA%\vlc\lua\extensions\` |
| macOS | `~/Library/Application Support/org.videolan.vlc/lua/extensions/` |
| Linux | `~/.local/share/vlc/lua/extensions/` |

The directory usually does not exist yet; make it. For every user on the machine
rather than one, the same path under VLC's own install directory works too.

Open it from **View -> SubtitleDB** while something is playing.

## The window

The layout is vlsub's, because that is the one a VLC user already knows: the title
and the numbers at the top, three language choices, the results in the middle,
the actions along the bottom. vlsub is GPL-3.0, so the arrangement is reproduced
and none of its code is.

- **Search this file** uses what the file name says. A name like
  `Breaking.Bad.S05E14.1080p.BluRay.x264-DEMAND.mkv` is a series, a season and an
  episode; `Anatomy.of.a.Fall.2023.mkv` is a film and a year. An IMDb id, if VLC knows
  one, is used ahead of both.
- **Search by name** ignores the id and searches the title as typed, for when the
  file name is `video1.mkv` or the id is wrong.
- Up to three languages, asked for in order. The first one you set is the one
  ranked highest, not just the one asked first.
- **Download** saves the file beside the video, named `<video>.<language>.srt`, so
  VLC loads it by itself next time, and loads it into what is playing now.

## What decides the order

The same rules as every other SubtitleDB plugin, covered by the same cases in
`plugins/shared/match-cases.json`:

| Beats | Because |
|---|---|
| a subtitle recorded against the release you are playing | it is the one that is actually in sync |
| your first language over your third | you asked in that order |
| a file with cues over a file with none | an empty track is worse than no track |
| the right episode | a season and episode that disagree with the file are dropped, not ranked low |

A format VLC cannot parse is dropped for the same reason: handed one, the player
shows an empty track, which is the most confusing way a subtitle plugin can fail.

## Settings

**View -> SubtitleDB -> Settings**, or the button. Languages, whether to save
beside the video, whether to overwrite a file that is already there (off, so an
existing subtitle is kept and the new one gets `.subtitledb.srt`), how many
subtitles to list per language (500, anything from 100 to 2000; the API sends 100 a
request, so each further 100 is one more), and the API address for anyone running
their own. Saved to `subtitledb.conf` in VLC's data directory.

## Tests

```bash
tests/get-lua.sh && tests/.lua/bin/lua tests/run.lua
```

`get-lua.sh` builds Lua from source into `tests/.lua`, because the runner has no
sudo and a suite that only runs where someone remembered to install a package
stops being run.

VLC embeds Lua **5.1** or **5.2**, depending on the build (Ubuntu's VLC 3.0.20 is
5.2), and the tests build 5.4. That is a real difference: 5.4 has integers, `goto`
and a `utf8` library that 5.1 does not, so a file that passes here can still fail in
VLC. `run.lua` reads the source and fails on the 5.4-only spellings rather than
trusting this paragraph.

The extension is loaded with `vlc` absent, which is the point. Everything that
decides anything works without a media player; what is left is VLC's own to get
right, and the Live hosts workflow checks that part inside VLC 3 itself: see
[`plugins/hosts`](../hosts/README.md).

## License

MIT. The text is in [`plugins/LICENSE`](../LICENSE). The extension travels as one
file, so `subtitledb.lua` also says so in its first two lines.
