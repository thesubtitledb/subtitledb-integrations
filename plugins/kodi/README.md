# SubtitleDB for Kodi

`service.subtitles.subtitledb`, a subtitle module for Kodi 19 and later.

## Install

Download `service.subtitles.subtitledb-<version>.zip` from the newest `kodi-v`
[release](https://github.com/thesubtitledb/subtitledb-integrations/releases), then in
Kodi: Settings -> Add-ons -> Install from zip file. `python3 build.py` builds the same
zip into `dist/`.

Enable it under Settings -> Player -> Language -> Subtitle services -> Default TV show
service / Default movie service.

`python3 build.py --repo` also writes `addons.xml` and `addons.xml.md5`, the two files
a Kodi repository is. Serve them beside the zip and Kodi can install and update from it.

## What it uses

| Kodi knows | The addon |
|---|---|
| `VideoPlayer.IMDBNumber`, or the IMDb id by name | asks for that title |
| the show's IMDb id, in a library | asks by it, drilled to the season and episode, before the name |
| `VideoPlayer.TVshowtitle`, `Season`, `Episode` | searches the series, keeps only that episode |
| `VideoPlayer.Title` on an episode | chooses between episodes |
| the file that is playing | prefers a subtitle recorded against the same release |
| the languages configured for subtitles | one request per language |

The list shows the language on the left and, on the right, the release name, or the
line count when there is none. The star rating marks a subtitle recorded against the
file being played.

## When a video starts

The addon also runs as a service. As a video starts, it takes the languages under
Settings -> Player -> Language -> Languages to download subtitles for, and loads the
best match in the first that has one, without opening the dialog. A notification names
the language. It asks for the next language only when one has nothing, and not at all
when there is nothing to load.

It skips:

- a video with subtitles in one of those languages, or with a subtitle stream with no
  language (usually a file beside the video)
- anything Kodi knows is under five minutes, such as a trailer
- live TV
- a stream with no id
- a file whose name gives neither a year nor a season and episode

## Settings

Settings -> Add-ons -> My add-ons -> Subtitles -> SubtitleDB -> Configure.

| Setting | Default |
|---|---|
| Load subtitles when a video starts | on |
| Subtitles per language (the most listed for each) | 500, from 100 to 2000 |
| API address | ours; change it only to point at your own copy of the API |

## Kodi quirks

- A stack plays several files as one; the first file's name is the one used.
- A file inside an archive has its real name url-encoded in the path.
- `IMDBNumber` is the item's default id, which Kodi's TMDB and TVDB scrapers make
  their own, so only `tt` followed by digits is taken from it. The IMDb id read by name
  is taken even as a bare number.
- Info labels keep their last value: a show title left over does not make a film an
  episode without a season and episode number too.
- A file played from outside the library has no id or year, and its file name as
  title. The addon reads the title and year, or the show, season and episode, off the
  name instead.
- Kodi picks the parser by extension, so a subtitle is saved with the extension of its
  stored format.

## Tests

```bash
python3 -m pytest
```

Only the entry points `service.py` and `on_play.py`, and `resources/lib/kodi_side.py`
and `kodi_play.py`, import Kodi's modules. They decide nothing that
`resources/lib/logic.py` does not, so the decisions are tested here. Ranking is tested
in `plugins/python/tests`. In a real Kodi: [`plugins/hosts`](../hosts/README.md).

## License

MIT, as `addon.xml` declares. The text is in [`plugins/LICENSE`](../LICENSE); `build.py`
puts it in the zip as `LICENSE.txt`.
