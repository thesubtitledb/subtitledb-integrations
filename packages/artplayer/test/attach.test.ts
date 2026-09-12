import { SubtitleDbClient } from '@subtitledb/core';
import { describe, expect, it, vi } from 'vitest';
import { bundleSubtitle, movieBundle, stubFetch } from '../../core/test/fixtures.js';
import { type ArtplayerLike, attachSubtitleDb, UnknownPlayerError } from '../src/index.js';

type Handler = (...args: unknown[]) => void;

interface FakeArt {
  art: ArtplayerLike;
  emit(event: string): void;
  settings: Record<string, unknown>[];
  switched: Array<{ url: string; opts?: { name?: string; type?: string } }>;
}

function fakeArtplayer(src = 'https://cdn.test/The.Matrix.1999.1080p.mkv'): FakeArt {
  const handlers = new Map<string, Handler[]>();
  const settings: Record<string, unknown>[] = [];
  const switched: Array<{ url: string; opts?: { name?: string; type?: string } }> = [];

  const art: ArtplayerLike = {
    on(event, fn) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
    },
    off(event, fn) {
      const list = handlers.get(event) ?? [];
      handlers.set(
        event,
        list.filter((f) => f !== fn),
      );
    },
    subtitle: {
      switch(url, opts) {
        switched.push({ url, ...(opts ? { opts } : {}) });
      },
      show: false,
    },
    setting: {
      add(item) {
        settings.push(item);
      },
    },
    video: { currentSrc: src, src } as unknown as HTMLVideoElement,
    url: src,
  };

  return {
    art,
    emit(event) {
      for (const fn of handlers.get(event) ?? []) fn();
    },
    settings,
    switched,
  };
}

const SUBS = [
  bundleSubtitle({ id: 1, language: 'en', format: 'srt' }),
  bundleSubtitle({ id: 2, language: 'pb', format: 'srt' }),
  bundleSubtitle({ id: 3, language: 'ja', format: 'ass' }),
];

function wire(routes: Parameters<typeof stubFetch>[0]) {
  const { fetch, calls } = stubFetch(routes);
  return { client: new SubtitleDbClient({ fetch, retries: 0 }), calls };
}

const RESOLVE_TITLE = [{ match: /by-title/, body: movieBundle(SUBS) }];

describe('ArtPlayer adapter', () => {
  it('resolves eagerly on ready, with no user interaction', async () => {
    // The whole point of the adapter: a configured player calls the API when it
    // loads, not when somebody opens the subtitle menu.
    const { art, emit, settings } = fakeArtplayer();
    const { client, calls } = wire(RESOLVE_TITLE);

    const handle = attachSubtitleDb(art, { client, languages: ['en'] });
    expect(calls).toHaveLength(0);

    emit('ready');
    await vi.waitFor(() => expect(settings.length).toBeGreaterThan(0));

    expect(calls.length).toBeGreaterThan(0);
    expect(handle.current()?.candidates.length).toBeGreaterThan(0);
    handle.destroy();
  });

  it('offers the same tracks() as every other adapter, capped by maxTracks', async () => {
    // ArtPlayer is a different package with its own menu, and it still has to answer
    // the same options and the same handle: one integration, not three dialects.
    const { art, emit, settings } = fakeArtplayer();
    const { client } = wire(RESOLVE_TITLE);

    const handle = attachSubtitleDb(art, { client, maxTracks: 1 });
    expect(handle.tracks()).toEqual([]);

    emit('ready');
    await vi.waitFor(() => expect(settings.length).toBe(1));

    expect(handle.tracks()).toHaveLength(1);
    expect((settings[0]?.selector ?? []) as unknown[]).toHaveLength(1);
    expect(handle.tracks()[0]).toBe(handle.current()?.candidates?.[0]);
    handle.destroy();
  });

  it('builds a menu with readable language names, including non-ISO codes', async () => {
    const { art, emit, settings } = fakeArtplayer();
    const { client } = wire(RESOLVE_TITLE);

    const handle = attachSubtitleDb(art, { client });
    emit('ready');
    await vi.waitFor(() => expect(settings.length).toBe(1));

    const selector = settings[0]?.selector as Array<{ html: string }>;
    const labels = selector.map((s) => s.html).join(' | ');
    expect(labels).toContain('English');
    // pb is an OpenSubtitles code with no ISO name; it must not render as "PB".
    expect(labels).toContain('Portuguese (Brazil)');
    handle.destroy();
  });

  it('downloads nothing until a track is actually selected', async () => {
    const { art, emit, settings, switched } = fakeArtplayer();
    const { client, calls } = wire([
      ...RESOLVE_TITLE,
      { match: /\/get\/1$/, text: '1\n00:00:01,000 --> 00:00:02,000\nhello\n' },
    ]);

    const handle = attachSubtitleDb(art, { client, languages: ['en'] });
    emit('ready');
    await vi.waitFor(() => expect(settings.length).toBe(1));

    expect(calls.some((c) => c.url.includes('/get/'))).toBe(false);
    expect(switched).toHaveLength(0);

    const setting = settings[0] as {
      selector: Array<{ candidate: unknown; html: string }>;
      onSelect: (item: unknown) => string;
    };
    setting.onSelect(setting.selector[0]);

    await vi.waitFor(() => expect(switched).toHaveLength(1));
    expect(calls.some((c) => c.url.includes('/get/'))).toBe(true);
    // Handed a blob, not the API URL: the text is already fetched and cached, and a
    // blob is same-origin so it cannot fail the cross-origin track rules.
    expect(switched[0]?.url.startsWith('blob:')).toBe(true);
    expect(switched[0]?.opts?.type).toBe('srt');
    expect(art.subtitle.show).toBe(true);
    handle.destroy();
  });

  it('autoSelect loads one track during the eager resolve', async () => {
    const { art, emit, switched } = fakeArtplayer();
    const { client } = wire([
      ...RESOLVE_TITLE,
      { match: /\/get\/1$/, text: '1\n00:00:01,000 --> 00:00:02,000\nhi\n' },
    ]);

    const handle = attachSubtitleDb(art, { client, languages: ['en'], autoSelect: 'en' });
    emit('ready');

    await vi.waitFor(() => expect(switched).toHaveLength(1));
    expect(switched[0]?.opts?.name).toContain('English');
    handle.destroy();
  });

  it('leaves ass alone with convert on by default, styling and all', async () => {
    // `convert` is on by default here now, the same as every other adapter. It used to
    // be inverted, because the session converted every non-VTT file regardless of what
    // the player said it renders, and running ArtPlayer's ass through a WebVTT
    // converter throws away the styling it was going to render itself.
    //
    // The session now converts only a format `formats` does not name, and ArtPlayer's
    // default names ass. So the bytes must arrive untouched and typed as ass. If this
    // ever reports vtt, the option means two different things in two packages again.
    const { art, emit, switched } = fakeArtplayer();
    const ass = '[Script Info]\nTitle: styled\n';
    const { client } = wire([
      {
        match: /by-title/,
        body: movieBundle([bundleSubtitle({ id: 9, language: 'en', format: 'ass' })]),
      },
      { match: /\/get\/9$/, text: ass },
    ]);

    const seen: string[] = [];
    const handle = attachSubtitleDb(art, {
      client,
      autoSelect: true,
      onSelected: (l) => seen.push(l.format),
    });
    emit('ready');

    await vi.waitFor(() => expect(switched).toHaveLength(1));
    expect(switched[0]?.opts?.type).toBe('ass');
    expect(seen).toEqual(['ass']);
    handle.destroy();
  });

  it('maps ssa onto the ass type ArtPlayer expects', async () => {
    const { art, emit, switched } = fakeArtplayer();
    const { client } = wire([
      {
        match: /by-title/,
        body: movieBundle([bundleSubtitle({ id: 7, language: 'en', format: 'ssa' })]),
      },
      { match: /\/get\/7$/, text: '[Script Info]\n' },
    ]);

    const handle = attachSubtitleDb(art, { client, autoSelect: true });
    emit('ready');

    await vi.waitFor(() => expect(switched).toHaveLength(1));
    expect(switched[0]?.opts?.type).toBe('ass');
    handle.destroy();
  });

  it('explains an empty menu instead of showing a blank one', async () => {
    const { art, emit, settings } = fakeArtplayer();
    // Everything the title has is in a format this player was told it cannot render.
    const { client } = wire([
      { match: /by-title/, body: movieBundle([bundleSubtitle({ format: 'sub' })]) },
    ]);

    const handle = attachSubtitleDb(art, { client, formats: ['srt'] });
    emit('ready');
    await vi.waitFor(() => expect(settings.length).toBe(1));

    expect(settings[0]?.tooltip).toContain('unsupported formats');
    handle.destroy();
  });

  it('re-resolves on a source change but reuses the cache for the same media', async () => {
    const { art, emit, settings } = fakeArtplayer();
    const { client, calls } = wire(RESOLVE_TITLE);

    const handle = attachSubtitleDb(art, { client });
    emit('ready');
    await vi.waitFor(() => expect(settings.length).toBe(1));
    const after = calls.length;

    // A duplicate event must not cost another round trip. The session caches by
    // identity, which is why the adapter needs no debouncing of its own.
    emit('restart');
    await vi.waitFor(() => expect(settings.length).toBe(2));
    expect(calls.length).toBe(after);
    handle.destroy();
  });

  it('destroy detaches handlers and disposes the session', async () => {
    const { art, emit, settings } = fakeArtplayer();
    const { client } = wire(RESOLVE_TITLE);

    const handle = attachSubtitleDb(art, { client });
    emit('ready');
    await vi.waitFor(() => expect(settings.length).toBe(1));

    handle.destroy();
    emit('ready');
    await new Promise((r) => setTimeout(r, 20));
    expect(settings).toHaveLength(1);
  });

  it('never throws when the API is unreachable', async () => {
    const onError = vi.fn();
    const { art, emit, settings } = fakeArtplayer();
    const { client } = wire([{ match: /./, throws: true }]);

    const handle = attachSubtitleDb(art, { client, onError });
    emit('ready');

    await vi.waitFor(() => expect(settings.length).toBe(1));
    expect(settings[0]?.tooltip).toBe('no subtitles found');
    handle.destroy();
  });

  it('returns the first handle when the same player is attached twice', async () => {
    const { art, emit, settings } = fakeArtplayer();
    const { client, calls } = wire(RESOLVE_TITLE);

    const first = attachSubtitleDb(art, { client });
    const second = attachSubtitleDb(art, { client });
    emit('ready');
    await vi.waitFor(() => expect(settings.length).toBe(1));

    // A plugin listed twice, a component that mounts twice. Two sessions on one
    // player meant two entries in its settings menu and two downloads on select.
    expect(second).toBe(first);
    expect(settings).toHaveLength(1);
    const searches = calls.length;

    first.destroy();
    const third = attachSubtitleDb(art, { client });
    expect(third).not.toBe(first);
    expect(calls).toHaveLength(searches);
    third.destroy();
  });

  it('answers the same handle superset every adapter here answers', async () => {
    // This package returned `session` and no `player`, while @subtitledb/players
    // returned `player` and no `session`. One interface now, declared in core.
    const { art, emit, settings } = fakeArtplayer();
    const { client } = wire(RESOLVE_TITLE);

    const handle = attachSubtitleDb(art, { client });
    expect(handle.player).toEqual({
      name: 'artplayer',
      label: 'ArtPlayer',
      untested: false,
      // Always the truth here: this entry point takes an ArtPlayer and nothing else,
      // so there is no wrapper to unwrap and no element to climb from.
      via: 'instance',
    });
    expect(handle.degraded).toBeNull();
    expect(handle.media()).toBe(art.video);

    emit('ready');
    await vi.waitFor(() => expect(settings.length).toBe(1));
    expect(handle.session.requestCount).toBeGreaterThan(0);
    handle.destroy();
  });

  it('reads the element live, so a source switch does not leave it stale', () => {
    // ArtPlayer replaces template.$video on a source switch. media() captured at
    // attach would keep pointing at a detached element with no symptom other than the
    // wrong answer, which is the same failure the forward hooks would inherit.
    const { art } = fakeArtplayer();
    const { client } = wire(RESOLVE_TITLE);
    const handle = attachSubtitleDb(art, { client });

    const swapped = { currentSrc: 'https://cdn.test/other.mkv' } as HTMLVideoElement;
    (art as { template?: { $video?: HTMLVideoElement } }).template = { $video: swapped };

    expect(handle.media()).toBe(swapped);
    handle.destroy();
  });

  it('says what it wanted when handed something that is not an ArtPlayer', () => {
    // A container, a <video>, or the options object. All of them used to die on a
    // TypeError from the first line that reached into the argument.
    for (const junk of [null, undefined, 'art', { subtitle: {} }]) {
      expect(() => attachSubtitleDb(junk as unknown as ArtplayerLike)).toThrow(UnknownPlayerError);
    }
    expect(() => attachSubtitleDb(null as unknown as ArtplayerLike)).toThrow(
      /expects an ArtPlayer instance/,
    );
  });
});
