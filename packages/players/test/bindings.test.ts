import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  attachSubtitleDb,
  BINDINGS,
  detectBinding,
  findVideo,
  isVideoElement,
  UnknownPlayerError,
} from '../src/index.js';
import {
  blobs,
  clearDom,
  client,
  FAKES,
  fakeVideo,
  installDom,
  resetFakes,
  revoked,
} from './fakes.js';

beforeEach(resetFakes);
afterEach(clearDom);

describe('detection', () => {
  for (const [name, make] of Object.entries(FAKES)) {
    it(`recognises ${name}`, () => {
      expect(detectBinding(make())?.name).toBe(name);
    });
  }

  it('falls back to native for a player nobody has bound', () => {
    // A wrapper this repo has never heard of, holding a video somewhere inside.
    const unknown = { widget: { surface: { screen: fakeVideo() } } };
    expect(detectBinding(unknown)?.name).toBe('native');
  });

  it('recognises nothing in an object with no video anywhere', () => {
    expect(detectBinding({ a: 1, b: { c: 2 } })).toBeUndefined();
  });

  it('recognises Shaka 4, which had a visibility setter Shaka 5 removed', () => {
    const four = {
      addTextTrackAsync: async () => ({ id: 1 }),
      selectTextTrack: () => {},
      getTextTracks: () => [],
      setTextTrackVisibility: () => {},
    };
    expect(detectBinding(four)?.name).toBe('shaka');
  });

  it('is not fooled by a plain object calling itself a video', () => {
    // Clappr gives its playback and container objects a tagName of 'video'. Treating
    // one as an element hands the adapter something with no addEventListener, which
    // fails on first use, and it stops Clappr being detected as Clappr at all.
    const playback = { tagName: 'video', el: fakeVideo() };
    expect(isVideoElement(playback)).toBe(false);
    expect(findVideo(playback)).toBe(playback.el);
    expect(detectBinding({ core: playback, getPlugin: () => {}, play: () => {} })?.name).toBe(
      'clappr',
    );
  });

  it('survives a property that throws while being read', () => {
    const hostile = {
      get media() {
        throw new Error('not ready');
      },
      video: fakeVideo(),
    };
    expect(() => detectBinding(hostile)).not.toThrow();
  });

  it('every binding declares a name, a label and a way to reach the media', () => {
    for (const b of BINDINGS) {
      expect(b.name).toMatch(/^[a-z0-9]+$/);
      expect(b.label.length).toBeGreaterThan(0);
      expect(Boolean(b.media) || Boolean(b.api)).toBe(true);
    }
    expect(new Set(BINDINGS.map((b) => b.name)).size).toBe(BINDINGS.length);
    expect(BINDINGS[BINDINGS.length - 1]?.name).toBe('native');
  });
});

describe('probe', () => {
  it('finds a video behind the property names players actually use', () => {
    const shapes = [
      { video: fakeVideo() },
      { media: fakeVideo() },
      { $video: fakeVideo() },
      { domRef: { player: fakeVideo() } },
      { core: { activePlayback: { el: fakeVideo() } } },
      { getMedia: () => fakeVideo() },
    ];
    for (const s of shapes) expect(findVideo(s)).not.toBeNull();
  });

  it('reaches the playback engines docs/players.md says it reaches', () => {
    // hls.js and dash.js are engines, not players: neither has a binding, and both
    // are documented as working because the probe finds their element. They reach it
    // by different names, so "same as hls.js" is not a claim the code supports.
    const hls = { media: fakeVideo(), levels: [], startLoad() {} };
    const dash = { getVideoElement: () => fakeVideo(), getDashMetrics() {} };
    expect(findVideo(hls)).toBe(hls.media);
    expect(findVideo(dash)).not.toBeNull();
  });

  it('does not recurse forever through a cycle', () => {
    const a: Record<string, unknown> = {};
    const b: Record<string, unknown> = { player: a };
    a.player = b;
    expect(findVideo(a)).toBeNull();
  });
});

describe('element bound players', () => {
  it('attaches through the binding and converts on select', async () => {
    const tracks = installDom();
    const { client: c, calls } = client();
    const player = FAKES.plyr?.() as { media: HTMLVideoElement; currentTrack: number };

    const handle = attachSubtitleDb(player, { client: c, hint: { imdbId: 'tt0133093' } });
    expect(handle.player.name).toBe('plyr');

    const r = await handle.refresh();
    // Five subtitles, one of them .sub, which no browser renders and the converter
    // does not reach, so four are offered and the fifth is counted, not published.
    expect(r.candidates).toHaveLength(4);
    expect(r.unrenderable).toBe(1);
    expect(calls).toHaveLength(1);
    expect(tracks.every((t) => t.src === '')).toBe(true);

    const en = r.candidates.find((x) => x.subtitle.language === 'en');
    if (!en) throw new Error('expected an english candidate');
    await handle.select(en);

    expect(blobs[0]?.startsWith('WEBVTT')).toBe(true);
    // The binding told Plyr which track to show, using its documented setter.
    expect(player.currentTrack).toBe(0);
    handle.destroy();
  });

  it('retries Plyr once when it has not seen the new track yet', async () => {
    // Plyr learns about a track from the element's addtrack event, a task after the
    // append. Setting currentTrack before that throws from inside Plyr, which took
    // the whole selection down with it until the binding retried.
    installDom();
    const { client: c } = client();
    let attempts = 0;
    const player = {
      media: fakeVideo(),
      toggleCaptions: () => {},
      set currentTrack(_v: number) {
        attempts++;
        if (attempts === 1) throw new TypeError("Cannot read properties of undefined ('language')");
      },
      get currentTrack() {
        return 0;
      },
    };

    const handle = attachSubtitleDb(player, { client: c, hint: { imdbId: 'tt0133093' } });
    const r = await handle.refresh();
    const en = r.candidates.find((x) => x.subtitle.language === 'en');
    if (!en) throw new Error('expected an english candidate');

    await expect(handle.select(en)).resolves.toBeUndefined();
    expect(attempts).toBe(1);

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(attempts).toBe(2);
    handle.destroy();
  });

  it('reports the binding used, and whether it has been run against the real player', () => {
    installDom();
    const { client: c } = client();
    const handle = attachSubtitleDb(FAKES.dplayer?.(), {
      client: c,
      hint: { imdbId: 'tt0133093' },
    });
    // `via` says how the target was reached. It is on the handle because after the
    // fact "we found no player" and "we never looked" are the same symptom, and that
    // ambiguity is what let framework wrappers resolve to the native binding unseen.
    expect(handle.player).toEqual({
      name: 'dplayer',
      label: 'DPlayer',
      untested: false,
      via: 'instance',
    });
    handle.destroy();

    const jw = attachSubtitleDb(FAKES.jwplayer?.(), { client: c, hint: { imdbId: 'tt0133093' } });
    expect(jw.player.untested).toBe(true);
    jw.destroy();

    // Naming a binding skips detection, and the handle says so rather than claiming
    // the player was recognised.
    const named = attachSubtitleDb(FAKES.dplayer?.(), {
      client: c,
      player: 'dplayer',
      hint: { imdbId: 'tt0133093' },
    });
    expect(named.player.via).toBe('named');
    named.destroy();
  });
});

describe('players that own their text tracks', () => {
  it('publishes nothing until a track is chosen, then exactly one', async () => {
    installDom();
    const { client: c, calls } = client();
    const added: { label: string; src: string }[] = [];

    const player = {
      addRemoteTextTrack: (opts: { label: string; src: string }) => {
        added.push(opts);
        return { track: { mode: 'disabled' } };
      },
      removeRemoteTextTrack: () => {},
      remoteTextTracks: () => ({ length: 0 }),
      textTracks: () => ({ length: 0 }),
      on: () => {},
      off: () => {},
    };

    const handle = attachSubtitleDb(player, { client: c, hint: { imdbId: 'tt0133093' } });
    expect(handle.player.name).toBe('videojs');

    const r = await handle.refresh();
    // The traffic contract holds on this path too: one search request, no bytes,
    // and nothing registered with the player that it could go and fetch.
    expect(r.candidates).toHaveLength(4);
    expect(calls).toHaveLength(1);
    expect(added).toHaveLength(0);

    const en = r.candidates.find((x) => x.subtitle.language === 'en');
    if (!en) throw new Error('expected an english candidate');
    await handle.select(en);

    expect(added).toHaveLength(1);
    expect(added[0]?.label).toContain('English');
    expect(blobs[0]?.startsWith('WEBVTT')).toBe(true);
    handle.destroy();
  });

  it('awaits an asynchronous add before showing, which Shaka needs', async () => {
    installDom();
    const { client: c } = client();
    const order: string[] = [];
    const player = {
      addTextTrackAsync: async () => {
        order.push('add');
        await new Promise((r) => setTimeout(r, 5));
        return { id: 7 };
      },
      selectTextTrack: (t: { id: number }) => order.push(`select:${t.id}`),
      getTextTracks: () => [],
      // Shaka 4 spelling, kept here so both spellings stay exercised.
      setTextTrackVisibility: () => order.push('visible'),
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    const handle = attachSubtitleDb(player, { client: c, hint: { imdbId: 'tt0133093' } });
    const r = await handle.refresh();
    const en = r.candidates.find((x) => x.subtitle.language === 'en');
    if (!en) throw new Error('expected an english candidate');
    await handle.select(en);

    expect(order).toEqual(['add', 'visible', 'select:7']);
    handle.destroy();
  });

  it('publishes to THEOplayer by rewriting its source, keeping the position', async () => {
    // THEOplayer has no call that adds a track to a loaded stream: side-loaded text is
    // part of the source description. It also replaces its video element when the
    // source changes, which is why appending a <track> to that element does not
    // survive, and why this is the only route. Untestable in a browser without a
    // licence, so the shape of the rewrite is pinned here instead.
    installDom();
    const { client: c } = client();
    const sources = [{ src: 'stream.m3u8' }];
    const player = {
      element: fakeVideo(),
      play: () => {},
      currentTime: 42,
      textTracks: [] as { label: string; mode: string }[],
      source: { sources, textTracks: [{ label: 'Director commentary', src: 'other.vtt' }] },
    };

    const handle = attachSubtitleDb(player, { client: c, hint: { imdbId: 'tt0133093' } });
    expect(handle.player.name).toBe('theoplayer');

    const r = await handle.refresh();
    const en = r.candidates.find((x) => x.subtitle.language === 'en');
    if (!en) throw new Error('expected an english candidate');
    await handle.select(en);

    const tracks = player.source.textTracks as { label: string; src: string; default?: boolean }[];
    // The stream's own track is kept, ours is appended and marked default, which is
    // what makes THEOplayer show it, and the source list itself is untouched.
    expect(tracks).toHaveLength(2);
    expect(tracks[0]?.label).toBe('Director commentary');
    expect(tracks[1]?.label).toContain('English');
    expect(tracks[1]?.default).toBe(true);
    expect(tracks[1]?.src.startsWith('blob:')).toBe(true);
    expect(player.source.sources).toBe(sources);
    // Re-assigning the source restarts the stream, so the viewer goes back.
    expect(player.currentTime).toBe(42);

    handle.destroy();
    expect(player.source.textTracks).toHaveLength(1);
  });

  it('treats a playback engine like hls.js as a plain video element', async () => {
    // hls.js is not a player, it is an engine bolted onto a <video>. A page holds the
    // Hls instance, so that is what gets passed in, and native has to reach through it.
    installDom();
    const { client: c } = client();
    const media = fakeVideo();
    const hls = { media, attachMedia: () => {}, loadSource: () => {}, levels: [] };

    const handle = attachSubtitleDb(hls, { client: c, hint: { imdbId: 'tt0133093' } });
    expect(handle.player.name).toBe('native');
    const r = await handle.refresh();
    expect(r.candidates.length).toBeGreaterThan(0);
    handle.destroy();
  });

  it('clears only its own tracks on destroy', async () => {
    installDom();
    const { client: c } = client();
    const removed: string[] = [];
    const player = {
      subtitles: {
        add: () => {},
        enable: () => {},
        remove: (id: string) => removed.push(id),
        list: () => [{ id: 'theirs' }, { id: 'subtitledb-1' }],
      },
    };

    const handle = attachSubtitleDb(player, { client: c, hint: { imdbId: 'tt0133093' } });
    const r = await handle.refresh();
    const first = r.candidates[0];
    if (!first) throw new Error('expected a candidate');
    await handle.select(first);
    handle.destroy();

    expect(removed).toEqual(['subtitledb-1']);
    expect(revoked).toHaveLength(1);
  });
});

describe('refusing to guess', () => {
  it('throws a named error rather than attaching to nothing', () => {
    installDom();
    const { client: c } = client();
    expect(() => attachSubtitleDb({ nothing: true }, { client: c })).toThrow(UnknownPlayerError);
    expect(() => attachSubtitleDb(fakeVideo(), { client: c, player: 'nosuchplayer' })).toThrow(
      /no binding named/,
    );
  });
});

describe('detection details found in a browser', () => {
  it('takes only the media chrome elements that wrap a player', () => {
    // Media Chrome ships a whole family of MEDIA-* custom elements, and the earlier
    // prefix match claimed every one of them. MEDIA-PROVIDER is Vidstack's, so a
    // Vidstack page was bound as Media Chrome and lost its api path.
    const el = (tagName: string) => ({ tagName, querySelector: () => fakeVideo() });
    expect(detectBinding(el('MEDIA-CONTROLLER'))?.name).toBe('mediachrome');
    expect(detectBinding(el('MEDIA-THEME'))?.name).toBe('mediachrome');
    expect(detectBinding(el('MEDIA-PROVIDER'))?.name).toBe('native');
  });

  it('reads identity off the video inside a custom element, not off the host', () => {
    installDom();
    const { client: api } = client();
    // A custom element player has a textTracks property of its own, so duck-typing
    // answered with the host and identification read a currentSrc that was not there.
    const inner = fakeVideo();
    const host = {
      tagName: 'MEDIA-PLAYER',
      textTracks: Object.assign([] as unknown[], { add: () => {} }),
      startLoading: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      querySelector: (s: string) => (s === 'video' ? inner : null),
    };

    const handle = attachSubtitleDb(host, { client: api, languages: ['en'] });
    expect(handle.player.name).toBe('vidstack');
    expect(findVideo(host)).toBe(host);
    expect(BINDINGS.find((b) => b.name === 'vidstack')?.media?.(host)).toBe(inner);
    handle.destroy();
  });
});
