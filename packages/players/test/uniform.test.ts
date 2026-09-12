import { attachSubtitleDb as attachToVideo } from '@subtitledb/html5';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachedTo, attachSubtitleDb, BINDINGS } from '../src/index.js';
import {
  blobs,
  clearDom,
  client,
  FAKES,
  installDom,
  ownsTracks,
  published,
  resetFakes,
  SRT,
} from './fakes.js';

/**
 * One configuration surface, sixteen bindings.
 *
 * The point of this package is that a host page writes `attachSubtitleDb(player,
 * options)` once and never learns which player it got. That only holds if every
 * binding honours the same options, so this drives all of them through one frozen
 * object and asserts the same observable behaviour rather than trusting that two
 * code paths which look alike stay alike.
 *
 * The element path and the api path are separate implementations, and this is what
 * keeps them from drifting: it caught the api path resolving against an empty hint,
 * which left Video.js, Shaka, Vidstack and Bitmovin identifying nothing at all
 * unless the host page named the title.
 */

beforeEach(resetFakes);
afterEach(clearDom);

/** The same object for every player. Frozen so no binding can quietly mutate it. */
const OPTIONS = Object.freeze({
  languages: ['en', 'fr'],
  maxTracks: 2,
  hint: { imdbId: 'tt0133093' },
  convert: true,
});

describe('every binding honours the same options', () => {
  it('covers every registered binding', () => {
    // A new binding without a fake would silently skip every assertion below.
    expect(Object.keys(FAKES).sort()).toEqual(BINDINGS.map((b) => b.name).sort());
  });

  for (const name of Object.keys(FAKES)) {
    it(`${name}: languages, maxTracks, convert and the callbacks`, async () => {
      installDom();
      const { client: api, calls } = client();
      const resolved: number[] = [];
      const selected: string[] = [];

      const target = FAKES[name]?.();
      const handle = attachSubtitleDb(target, {
        ...OPTIONS,
        client: api,
        onResolved: (r) => resolved.push(r.candidates.length),
        onSelected: (l) => selected.push(l.format),
      });

      expect(handle.player.name).toBe(name);

      // A player that owns its text tracks resolves on attach: it has no media element
      // to wait on, and three of the five have no ready event either, so anything less
      // means it never resolves at all unless the host page asks. An element player
      // waits for the media event this fake never fires, so ask for it.
      const owns = ownsTracks(name);
      if (owns) await vi.waitFor(() => expect(resolved).toHaveLength(1));
      else await handle.refresh();

      // languages: one search per configured language, and nothing else. This is the
      // eager half, and it must cost the same on every player.
      expect(calls.filter((c) => c.url.includes('by-imdb'))).toHaveLength(2);
      expect(calls.filter((c) => c.url.includes('/get/'))).toHaveLength(0);
      expect(resolved).toHaveLength(1);

      // maxTracks caps what is offered, whatever the player calls a track.
      expect(handle.tracks().length).toBeLessThanOrEqual(2);
      expect(handle.tracks().length).toBeGreaterThan(0);
      expect(handle.current()?.hint.imdbId).toBe('tt0133093');

      // convert: one fetch, and the file arrives in a format this player renders.
      //
      // That last word is what `convert` means, and it is why the answer here is not
      // the same string on every binding. Fifteen of them declare WebVTT and nothing
      // else, so the srt is rewritten. ArtPlayer declares srt, so the same file is
      // handed over untouched, because converting it would be work that can only
      // lose information. The assertion is the rule, not either outcome.
      const renders = BINDINGS.find((x) => x.name === name)?.formats ?? ['vtt'];
      const want = renders.includes('srt') ? 'srt' : 'vtt';

      const first = handle.tracks()[0];
      if (!first) throw new Error('no candidate to select');
      await handle.select(first);

      expect(calls.filter((c) => c.url.includes('/get/'))).toHaveLength(1);
      expect([name, selected]).toEqual([name, [want]]);
      if (want === 'vtt') {
        expect(blobs.at(-1)).toContain('WEBVTT');
        expect(blobs.at(-1)).not.toContain(',000');
      } else {
        // Untouched, comma decimal separator and all, which is the whole point of a
        // binding declaring a format its player can already read.
        expect(blobs.at(-1)).toBe(SRT);
      }

      // The player itself is holding a track, read from the player rather than from
      // the adapter's own call log. Without this a binding whose add() returns early
      // passes everything above while the viewer sees nothing, which is what the
      // THEOplayer fake was doing: no source, so no publish, and a green suite.
      //
      // How many depends on the path, and that difference is deliberate: an element
      // player is handed the whole offer as empty track elements and one of them is
      // given bytes on selection, while a player that owns its text tracks fetches
      // anything it is told about, so it is only ever told about the chosen one.
      expect([name, published(target).length]).toEqual([name, owns ? 1 : handle.tracks().length]);

      handle.destroy();
      // And destroy takes back exactly what it published. Shaka is the one binding
      // with nothing honest to do here: it has no public removal for a side-loaded
      // track and drops them when the manifest unloads.
      if (name !== 'shaka') expect([name, published(target).length]).toEqual([name, 0]);
    });
  }

  it('identifies the media the same way on every player when no hint is given', async () => {
    // Configuration is optional, and it has to be optional everywhere. Without this
    // the two paths disagree about what an unconfigured page means: the element path
    // read the file name off the element, the api path resolved against nothing.
    for (const name of Object.keys(FAKES)) {
      installDom();
      const { client: api, calls } = client();
      const handle = attachSubtitleDb(FAKES[name]?.(), { client: api, languages: ['en'] });
      const result = await handle.refresh();

      expect([name, result.hint.title?.toLowerCase()]).toEqual([name, 'the matrix']);
      expect([name, result.hint.year]).toEqual([name, 1999]);
      expect(calls.filter((c) => c.url.includes('/get/'))).toHaveLength(0);
      handle.destroy();
      clearDom();
    }
  });

  it('takes player: to skip detection, on any binding', () => {
    installDom();
    // A page that already knows what it mounted should not pay for a probe, and the
    // named binding has to be the one that runs.
    const handle = attachSubtitleDb(FAKES.native?.(), { ...OPTIONS, player: 'plyr' });
    expect(handle.player.name).toBe('plyr');
    handle.destroy();
  });

  it('hands back the same handle shape on every binding, with a live session and element', () => {
    // There were three handle interfaces and they had already drifted: two of them
    // carried `session` and no `player`, the third carried `player` and no `session`,
    // so "the same handle everywhere" was true of the three calls they shared and of
    // nothing else. This asserts the superset is real at runtime and not merely
    // satisfied by the type.
    for (const name of Object.keys(FAKES)) {
      installDom();
      const { client: api } = client();
      const handle = attachSubtitleDb(FAKES[name]?.(), { ...OPTIONS, client: api });

      // session is the object the adapter is actually using, not a placeholder. The
      // element path builds it before the element exists, which is the case that
      // would otherwise leave this null for up to fifteen seconds after attach.
      expect([name, typeof handle.session?.resolve]).toEqual([name, 'function']);
      expect([name, handle.degraded]).toEqual([name, null]);
      expect([name, typeof handle.player.via]).toEqual([name, 'string']);

      // media() is a method and not an element captured at attach, because players
      // swap the element on a source change and a captured reference then goes stale
      // with no symptom beyond the wrong answer.
      expect([name, typeof handle.media]).toEqual([name, 'function']);
      expect([name, handle.media()?.tagName]).toEqual([name, 'VIDEO']);

      handle.destroy();
      clearDom();
    }
  });

  it('answers with one handle whether asked by the player or by its element', async () => {
    // The registry used to be three private maps, one per package, so a <video>
    // reached through @subtitledb/players and then through @subtitledb/html5 got two
    // handles and two sessions on one element: the track list doubled and so did the
    // traffic. One map means one handle, whichever package you happen to ask.
    installDom();
    const { client: api } = client();
    const player = FAKES.plyr?.();
    const handle = attachSubtitleDb(player, { ...OPTIONS, client: api });
    const video = handle.media();
    if (!video) throw new Error('fake mounted no element');

    expect(attachedTo(player)).toBe(handle);
    expect(attachedTo(video)).toBe(handle);
    expect(attachToVideo(video, { client: api })).toBe(handle);
    expect(attachSubtitleDb(player, { client: api })).toBe(handle);

    // And destroy releases both, so the page can attach again rather than being
    // handed a dead handle for the life of the tab.
    handle.destroy();
    expect(attachedTo(player)).toBeUndefined();
    expect(attachedTo(video)).toBeUndefined();
  });
});
