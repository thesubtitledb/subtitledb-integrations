/**
 * The real debugger chunk, driven as the loader drives it.
 *
 * debug.test.ts stands a fixture in for the chunk to see what the loader asks of it.
 * This is what the chunk makes of what SubtitleDB resolved and picked, read off the
 * report that goes out, with fetch and localStorage replaced.
 */
import { type ResolveResult, syntheticCandidate } from '@subtitledb/core';
import { resetDebug, type Snapshot } from '@subtitledb/debug';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeVideo, KEY, LOAD, memoryStorage } from '../../debug/test/fakes.js';
import { type Attached, watchAttached } from '../src/chunks/debug.js';

let posts: Snapshot[];

beforeEach(() => {
  resetDebug();
  posts = [];
  vi.stubGlobal('localStorage', memoryStorage());
  // Every answer asks for every trace, so the last report of a play carries one.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      posts.push(JSON.parse(String(init.body)));
      return { ok: true, status: 204, headers: new Headers({ 'x-sdb-trace': 'all' }) } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Watch a video as an attach does, let `before` happen, play it, and let it go. */
async function played(before: (w: Attached) => void): Promise<Snapshot> {
  const v = new FakeVideo();
  const w = watchAttached(v as unknown as HTMLVideoElement, KEY, LOAD, 'videojs');
  before(w);
  v.duration = 60;
  v.readyState = 4;
  v.emit('loadedmetadata');
  v.paused = false;
  v.emit('play');
  v.emit('playing');
  await settle();
  w.stop();
  const s = posts.at(-1);
  if (!s) throw new Error('nothing sent');
  return s;
}

describe('the debugger chunk', () => {
  it('files a play under the title resolved, names the player, and traces the offer', async () => {
    const s = await played((w) =>
      w.resolved({
        hint: { imdbId: 'tt0133093' },
        title: { imdb: 'tt0133093', tmdb_id: 603, name: 'The Matrix', year: 1999 },
        tier: 'explicit-imdb',
        candidates: [{}, {}],
      } as unknown as ResolveResult),
    );
    expect(s).toMatchObject({ im: 133093, tm: 603, pl: 'videojs' });
    expect(s.ev?.find((e) => e.k === 'offered')?.d).toBe(
      '2 subtitles for The Matrix (1999), by explicit-imdb',
    );
  });

  it('reports an AI pick by where it came from and its language, having no id to give', async () => {
    const s = await played((w) =>
      w.selected({ candidate: syntheticCandidate('en'), text: '', format: 'vtt' }),
    );
    expect([s.ss, s.sl, s.si]).toEqual(['ai', 'en', undefined]);
    expect(s.ev?.find((e) => e.k === 'track')?.d).toBe('SubtitleDB en #-1 (AI)');
  });
});
