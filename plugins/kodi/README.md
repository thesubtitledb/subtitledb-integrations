# SubtitleDB for Kodi

`service.subtitles.subtitledb`, a subtitle add-on for Kodi 19 and later.

## Install

In Kodi, open Settings > Add-ons > Install from repository > Kodi Add-on repository >
Subtitles and install SubtitleDB. For the newest version, download
`service.subtitles.subtitledb-<version>.zip` from the newest `kodi-v`
[release](https://github.com/thesubtitledb/subtitledb-integrations/releases) and use
Settings > Add-ons > Install from zip file.

Then pick it under Settings > Player > Language > Subtitle services, as the default
movie service, TV show service or both.

## Search

The subtitle dialog lists one search per language you have set for subtitles. The
add-on looks the video up by the first of these that finds it:

- `VideoPlayer.IMDBNumber`, or the IMDb id read by name
- the show's IMDb id, from the library, with the season and episode
- `VideoPlayer.TVshowtitle`, `Season` and `Episode`, with `VideoPlayer.Title` to choose
  between episodes

A subtitle recorded against the playing file's release ranks first and gets the star
rating. Each row shows the language and the release name, or the line count when there
is none.

## When a video starts

The add-on also runs as a service. When a video starts, it loads the best match in the
first of your "Languages to download subtitles for" that has one, without opening the
dialog, and a notification names the language. It leaves alone:

- a video with subtitles in one of those languages, or with a subtitle stream that has
  no language (usually a file beside the video)
- anything Kodi knows is under five minutes, such as a trailer
- live TV, and a stream with no id
- a file whose name gives neither a year nor a season and episode

If the API is down or answers with something wrong, nothing is loaded, the video plays
on, and Kodi's log says why.

## Settings

Settings > Add-ons > My add-ons > Subtitles > SubtitleDB > Configure.

| Setting | Default |
|---|---|
| Load subtitles when a video starts | on |
| Subtitles per language, 100 to 2000 | 500 |
| API address | `https://api.thesubtitledb.org` |

## Kodi details it handles

- A stack plays several files as one, and the first file's name is used.
- A file inside an archive has its real name url-encoded in the path.
- `IMDBNumber` is the item's default id, which the TMDB and TVDB scrapers set to their
  own, so only `tt` followed by digits is taken from it.
- Info labels keep their last value, so a leftover show title alone does not make a film
  an episode.
- A file played from outside the library has no id or year, so the title and year, or
  the show, season and episode, are read off its name.
- Kodi picks a subtitle parser by extension, so each file is saved with the extension of
  its stored format.

## Build and test

```bash
python3 build.py            # the zip, into dist/
python3 build.py --repo     # also addons.xml and addons.xml.md5, for your own Kodi repository
python3 -m pytest
```

Only `service.py`, `on_play.py`, `resources/lib/kodi_side.py` and
`resources/lib/kodi_play.py` import Kodi's modules, and the decisions live in
`resources/lib/logic.py`, so the tests need no Kodi. Ranking is tested in
`plugins/python/tests`, and [plugins/hosts](../hosts/README.md) runs the add-on in a
real Kodi.

## License

MIT, as `addon.xml` declares. The text is in [plugins/LICENSE](../LICENSE), and
`build.py` puts it in the zip as `LICENSE.txt`.
