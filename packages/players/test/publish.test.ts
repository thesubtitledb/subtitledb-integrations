import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachSubtitleDb } from '../src/index.js';
import { clearDom, client, fakeVideo, installDom, resetFakes } from './fakes.js';

/**
 * What the player is holding at the moment a viewer would see the subtitle.
 *
 * The rest of the suite proves the adapter published something. These are the
 * players that then do something of their own to it: Clappr wipes the selection on
 * play, Plyr counts captions in its own list, Video.js hands out the page's tracks
 * alongside ours. Every one of them was found in a browser, and every one of them
 * was invisible to a test that stopped at "a track was added".
 */

beforeEach(resetFakes);
afterEach(clearDom);

/** A media element whose textTracks list follows its track children, as a real one does. */
function trackingVideo() {
  const video = fakeVideo() as unknown as {
    append(child: unknown): void;
    children: unknown[];
    textTracks: { kind?: string; mode: string }[];
  };
  const append = video.append.bind(video);
  video.append = (child: unknown) => {
    append(child);
    const el = child as { kind?: string; track?: { kind?: string; mode: string } };
    if (el.track) {
      el.track.kind = el.kind;
      video.textTracks.push(el.track);
    }
  };
  return video;
}

/**
 * Clappr's caption handling, copied from its html5 playback.
 *
 * Two behaviours are the point: ids are positions in the media element's own list,
 * and the setter refuses a track that is already showing. Together they mean the
 * player never learns about a track this adapter shows by itself, and hides it on
 * the first play.
 */
function clapprPlayer() {
  const media = trackingVideo();
  const playback = {
    el: media,
    _ccTrackId: -1,
    get closedCaptionsTracks(): { id: number; name: string; track: { mode: string } }[] {
      let id = 0;
      return media.textTracks
        .filter((t) => t.kind === 'subtitles' || t.kind === 'captions')
        .map((track) => ({ id: id++, name: '', track }));
    },
    get closedCaptionsTrackId(): number {
      return this._ccTrackId;
    },
    set closedCaptionsTrackId(trackId: number) {
      if (typeof trackId !== 'number') return;
      const tracks = this.closedCaptionsTracks;
      let shown: { id: number; track: { mode: string } } | undefined;
      if (trackId !== -1) {
        shown = tracks.find((t) => t.id === trackId);
        if (!shown) return;
        if (shown.track.mode === 'showing') return;
      }
      for (const t of tracks) if (t.track.mode !== 'hidden') t.track.mode = 'hidden';
      if (shown) shown.track.mode = 'showing';
      this._ccTrackId = trackId;
    },
  };
  const container = {
    playback,
    get closedCaptionsTracks() {
      return playback.closedCaptionsTracks;
    },
    get closedCaptionsTrackId() {
      return playback.closedCaptionsTrackId;
    },
    set closedCaptionsTrackId(id: number) {
      playback.closedCaptionsTrackId = id;
    },
  };
  return {
    core: { activeContainer: container, activePlayback: playback },
    getPlugin: () => {},
    play: () => {},
    media,
    /** What Clappr does on the first play: re-apply the id it holds, which is -1. */
    firstPlay() {
      const held = playback.closedCaptionsTrackId;
      playback.closedCaptionsTrackId = held;
    },
  };
}

const showingCount = (video: { textTracks: { mode: string }[] }): number =>
  video.textTracks.filter((t) => t.mode === 'showing').length;

async function chooseFirst(handle: {
  refresh(): Promise<unknown>;
  tracks(): { subtitle: { id: number } }[];
  select(c: unknown): Promise<void>;
}): Promise<void> {
  await handle.refresh();
  // Only one subtitle in the fixtures has bytes behind it.
  const candidate = handle.tracks().find((c) => c.subtitle.id === 1);
  if (!candidate) throw new Error('no downloadable candidate');
  await handle.select(candidate);
}

describe('what the player ends up holding', () => {
  it('clappr: the caption survives the selection reset Clappr runs on play', async () => {
    installDom();
    const { client: api } = client();
    const player = clapprPlayer();

    const handle = attachSubtitleDb(player, {
      client: api,
      languages: ['en'],
      hint: { imdbId: 'tt0133093' },
    });
    await chooseFirst(handle);
    expect(showingCount(player.media)).toBe(1);

    player.firstPlay();
    expect(showingCount(player.media)).toBe(1);
    // And Clappr agrees, so its own menu shows the right entry ticked.
    expect(player.core.activePlayback.closedCaptionsTrackId).toBe(0);
    handle.destroy();
  });

  it('clappr: a track shown without telling Clappr is the failure this guards', () => {
    // The control. Without the binding's shown hook this is what the viewer got: the
    // subtitle appears, playback starts, and Clappr hides it again.
    const player = clapprPlayer();
    const track = { kind: 'subtitles', mode: 'showing' };
    player.media.textTracks.push(track);

    player.firstPlay();
    expect(track.mode).toBe('hidden');
  });

  it('plyr: selects by position in the player list, not in ours', async () => {
    installDom();
    const { client: api } = client();
    const media = trackingVideo();
    // A subtitle the host page declared in markup, before this adapter ran.
    media.textTracks.push({ kind: 'subtitles', mode: 'disabled' });
    const player = { media, toggleCaptions: () => {}, currentTrack: -1 };

    const handle = attachSubtitleDb(player, {
      client: api,
      languages: ['en'],
      hint: { imdbId: 'tt0133093' },
    });
    await chooseFirst(handle);

    // Ours is the second caption in Plyr's list. Counting our own added tracks
    // would have said 0, which is the page's subtitle.
    expect(player.currentTrack).toBe(1);
    handle.destroy();
  });

  it('videojs: destroy takes back its own tracks and leaves the page its own', async () => {
    installDom();
    const { client: api } = client();
    const page = { label: 'page markup', track: { mode: 'disabled' } };
    const remote: unknown[] = [page];
    const media = fakeVideo();
    const player = {
      addRemoteTextTrack: (opts: unknown) => {
        const entry = { ...(opts as object), track: { mode: 'disabled' } };
        remote.push(entry);
        return entry;
      },
      removeRemoteTextTrack: (t: unknown) => {
        const at = remote.indexOf(t);
        if (at >= 0) remote.splice(at, 1);
      },
      remoteTextTracks: () => remote,
      textTracks: () => remote.map((r) => (r as { track: unknown }).track),
      el: () => ({ querySelector: () => media }),
      on: () => {},
      off: () => {},
    };

    const handle = attachSubtitleDb(player, {
      client: api,
      languages: ['en'],
      hint: { imdbId: 'tt0133093' },
    });
    await chooseFirst(handle);
    expect(remote.length).toBeGreaterThan(1);

    handle.destroy();
    expect(remote).toEqual([page]);
  });

  it('shaka: side-loads the track as a subtitle, not as whatever it defaults to', async () => {
    installDom();
    const { client: api } = client();
    const got: unknown[][] = [];
    const media = fakeVideo();
    const player = {
      addTextTrackAsync: async (...args: unknown[]) => {
        got.push(args);
        return { id: got.length };
      },
      selectTextTrack: () => {},
      setTextVisibility: () => {},
      getTextTracks: () => [],
      getMediaElement: () => media,
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const handle = attachSubtitleDb(player, {
      client: api,
      languages: ['en'],
      hint: { imdbId: 'tt0133093' },
    });
    await chooseFirst(handle);

    // Shaka takes the kind as a string and renders nothing for one it does not know.
    // 'subtitle' is not one of them, and it is one letter from the one that is.
    expect(got[0]?.[2]).toBe('subtitles');
    expect(got[0]?.[3]).toBe('text/vtt');
    handle.destroy();
  });

  it('a player that throws on add reports it instead of rejecting the select', async () => {
    installDom();
    const { client: api } = client();
    const errors: unknown[] = [];
    const media = fakeVideo();
    const player = {
      // Bitmovin's shape. Its subtitles module throws for a source it will not take,
      // and the throw came back out of select() into whatever the host page was doing.
      subtitles: {
        add: () => {
          throw new Error('unsupported subtitle format');
        },
        enable: () => {},
        remove: () => {},
        list: () => [],
      },
      getVideoElement: () => media,
    };

    const handle = attachSubtitleDb(player, {
      client: api,
      languages: ['en'],
      hint: { imdbId: 'tt0133093' },
      onError: (e) => errors.push(e),
    });
    await expect(chooseFirst(handle)).resolves.toBeUndefined();
    expect(errors.map(String)).toEqual(['Error: unsupported subtitle format']);
    handle.destroy();
  });

  it('a player hook that throws is reported, not raised at the host page', async () => {
    installDom();
    const { client: api } = client();
    const errors: unknown[] = [];
    const player = clapprPlayer();
    Object.defineProperty(player.core.activeContainer, 'closedCaptionsTrackId', {
      get: () => -1,
      set: () => {
        throw new Error('playback is gone');
      },
    });

    const handle = attachSubtitleDb(player, {
      client: api,
      languages: ['en'],
      hint: { imdbId: 'tt0133093' },
      onError: (e) => errors.push(e),
    });
    // The track is already published and showing by the time the hook runs, so the
    // subtitle is on screen either way. What the page must not get is the throw.
    await expect(chooseFirst(handle)).resolves.toBeUndefined();
    expect(errors.map(String)).toEqual(['Error: playback is gone']);
    expect(showingCount(player.media)).toBe(1);
    handle.destroy();
  });
});
