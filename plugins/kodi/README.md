# SubtitleDB for Kodi

`service.subtitles.subtitledb`. A subtitle module for Kodi 19 and later, on the
SubtitleDB open index. No account, no key, no quota.

## Install

Download `service.subtitles.subtitledb-<version>.zip` from the newest `kodi-v`
[release](https://github.com/thesubtitledb/subtitledb-integrations/releases), then in Kodi: Settings -> Add-ons -> Install from zip file
-> pick it. `python3 build.py` builds the same zip into `dist/`.

Then turn it on where subtitles are chosen: Settings -> Player -> Language ->
Subtitle services -> Default TV show service / Default movie service.

`python3 build.py --repo` also writes `addons.xml` and `addons.xml.md5`, which are
the two files a Kodi repository is. Serve those beside the zip and Kodi can install
and update from it.

## What it uses

| Kodi knows | The addon does |
|---|---|
| `VideoPlayer.IMDBNumber` | asks for that title directly |
| `VideoPlayer.TVshowtitle`, `Season`, `Episode` | searches the series, keeps only that episode |
| `VideoPlayer.Title` on an episode | uses it to choose between episodes |
| the file that is playing | prefers a subtitle recorded against the same release |
| the languages configured for subtitles | one request per language |

The list shows the language on the left and, on the right, the release name where
there is one and the line count where there is not. Most of the corpus has no
release name, so thirty English candidates would otherwise read "English" thirty
times over and picking one would be a lottery.

The star rating is the only other thing Kodi draws. It carries whether the subtitle
was recorded against the file being played, rather than a number invented to fill it.

## Settings

Settings -> Add-ons -> My add-ons -> Subtitles -> SubtitleDB -> Configure.

**Subtitles per language** is the most listed for each language: 500 unless changed,
anything from 100 to 2000. The API sends 100 a request, so a title with 147 English
subtitles takes two.

## Kodi's own quirks, handled

- **A stack** is several files playing as one. The first one is the one whose name
  means anything.
- **A file inside an archive** has its real name url-encoded in the path.
- **`IMDBNumber` on a TV episode** is sometimes a TVDB id. Sent as an IMDb id it
  would resolve to somebody else's film, so anything that is not `tt` followed by
  digits is dropped.
- **The info labels keep their last value.** A show title left over from the last
  thing played does not turn a film into an episode: that needs a season and an
  episode number too.
- **A file played from outside the library** has no id and no year, and its title is
  the file's own name, which matches no title. The addon reads the title and year, or
  the show, season and episode, off the name instead.
- **The extension decides the parser.** A subtitle saved as `.srt` that is really
  ASS renders as a screen of tag soup, so the stored format is what it is saved as.

## Tests

```bash
python3 -m pytest
```

Only `service.py` (the entry point, a few lines) and `resources/lib/kodi_side.py`
import Kodi's modules, and they do nothing `resources/lib/logic.py` does not, so the
decisions are tested here and Kodi's own API is left to Kodi. The ranking rules are covered once, for every plugin, in
`plugins/python/tests`.

The Live hosts workflow installs the addon into Kodi 19 and the current Kodi, plays
the samples and searches through it: see [`plugins/hosts`](../hosts/README.md).

## License

MIT, as `addon.xml` declares. The text is in [`plugins/LICENSE`](../LICENSE), and
`build.py` puts it in the zip as `LICENSE.txt`.
