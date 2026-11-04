# TSDb for Jellyfin

TSDb adds SubtitleDB to Jellyfin 10.10 and later as a subtitle provider. The install
steps are also on the [developer portal](https://thesubtitledb.org/developer/integrations#jellyfin).

## Install

1. In Dashboard > Plugins > Repositories, add
   `https://cdn.thesubtitledb.org/plugins/jellyfin/manifest.json`.
2. In Dashboard > Plugins > Catalog, install TSDb and restart Jellyfin.
3. In Dashboard > Libraries, choose Manage library on each library. Under Subtitle
   Downloads, pick your languages and tick TSDb.

## Settings

The settings are on the plugin's page, under Dashboard > Plugins > TSDb.

| Setting | Default | What it does |
|---|---|---|
| Get latest subtitles on play | On | When a film or episode starts, saves the best TSDb match beside it, even when it has subtitles already. It follows the library's subtitle download settings. A new subtitle is listed from the next play. |
| Sync subtitles with other subtitle tracks | Off | Each TSDb download also gets a copy named SYNCED - TSDb, lined up against the first 50 lines of a text subtitle inside the video. |
| Sync subtitles with audio (uses CPU/GPU) | Off | The same copy, lined up against the speech in four two-minute stretches of the video's audio. This is used when the video has no text subtitle to line up against, or it does not match. |
| Subtitles per language | 500 | The most results to offer for each language, from 100 to 2000. Past 100, each further 100 is one more request. |
| API address | `https://api.thesubtitledb.org` | Leave this alone unless you run your own mirror of the API. |

## The SYNCED copy

While a copy is being lined up, every line starts with "(syncing)". When the match is
good, the copy is rewritten with the corrected times. When it isn't, the copy is
deleted and the original subtitle stays as it was. Lining up against a subtitle track
takes a few seconds, and against the audio up to about 25.

It all runs on your server, with the ffmpeg that comes with Jellyfin. Nothing is sent
to us.

## License

MIT, in [plugins/LICENSE](../../../LICENSE).
