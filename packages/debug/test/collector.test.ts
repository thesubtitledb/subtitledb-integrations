/**
 * What a play is, and what it counts, driven through the event sequences a
 * browser produces. Each case here is one of the ways a playback report goes
 * wrong: startup read as a stall, a seek paid for as watched, a replay folded
 * into the play before it, a pause invented by the end of the media.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetPlays } from '../src/collector.js';
import { MAX_EVENTS } from '../src/play.js';
import { bucket, FLAGS, type Snapshot } from '../src/snapshot.js';
import {
  end,
  hide,
  LOAD,
  last,
  load,
  pause,
  play,
  playFor,
  resume,
  rig,
  seek,
  stall,
} from './fakes.js';

beforeEach(() => resetPlays());

/** Every field that must never go down between two snapshots of one play. */
const MONOTONIC = [
  's',
  'st',
  'wa',
  'un',
  'mp',
  'sk',
  'pu',
  'sn',
  'sm',
  'er',
  'mh',
  'dr',
  'fr',
  'fl',
  'sb',
  'sw',
] as const;

function assertMonotonic(snaps: Snapshot[]): void {
  for (let i = 1; i < snaps.length; i++) {
    const a = snaps[i - 1] as Record<string, unknown>;
    const b = snaps[i] as Record<string, unknown>;
    if (a.p !== b.p) continue;
    for (const f of MONOTONIC) {
      const x = Number(a[f] ?? 0);
      const y = Number(b[f] ?? 0);
      expect(y, `${f} went from ${x} to ${y} at snapshot ${i}`).toBeGreaterThanOrEqual(x);
    }
    // A flag, once set, stays set.
    expect(Number(b.fl ?? 0) & Number(a.fl ?? 0)).toBe(Number(a.fl ?? 0));
  }
}

describe('a play', () => {
  it('counts waiting before the first frame as startup, not as a stall', () => {
    const r = rig();
    load(r);
    r.video.paused = false;
    r.video.emit('play');
    r.video.emit('waiting');
    r.advance(800);
    r.video.emit('playing');
    playFor(r, 5);
    stall(r, 2000);
    playFor(r, 5);
    pause(r);
    const s = last(r);
    expect(s.st).toBe(800);
    expect(s.sn).toBe(1);
    expect(s.sm).toBe(2000);
  });

  it('counts watch time as time actually playing: not paused, stalled or seeking', () => {
    const r = rig();
    load(r);
    play(r);
    playFor(r, 10);
    pause(r);
    r.advance(30_000);
    resume(r);
    playFor(r, 5);
    stall(r, 4000);
    playFor(r, 5);
    pause(r);
    expect(last(r).wa).toBe(20_000);
  });

  it('counts a scene watched twice once, and never the seconds a seek jumps over', () => {
    const r = rig();
    load(r, 600);
    play(r);
    playFor(r, 10);
    seek(r, 0);
    playFor(r, 10);
    seek(r, 100);
    playFor(r, 5);
    pause(r);
    const s = last(r);
    expect(s.un).toBe(15);
    expect(s.mp).toBe(105);
    expect(s.sk).toBe(2);
  });

  it('files waiting during a seek under the seek', () => {
    const r = rig();
    load(r);
    play(r);
    playFor(r, 5);
    seek(r, 300, 1500);
    playFor(r, 5);
    pause(r);
    const s = last(r);
    expect(s.sn ?? 0).toBe(0);
    expect(s.sk).toBe(1);
  });

  it('says a live stream has no length, so it is judged on watch time', () => {
    const r = rig();
    load(r, Number.POSITIVE_INFINITY);
    play(r);
    playFor(r, 40);
    pause(r);
    const s = last(r);
    expect(s.du).toBeUndefined();
    expect(s.li).toBe(1);
    expect(s.wa).toBe(40_000);
  });

  it('starts a replay after the end as a new play with fresh counters', () => {
    const r = rig();
    load(r, 20);
    play(r);
    playFor(r, 20);
    end(r);
    const first = last(r);
    r.video.currentTime = 0;
    play(r, 100);
    playFor(r, 5);
    pause(r);
    const second = last(r);
    expect(first.p).toBe(1);
    expect(second.p).toBe(2);
    expect(second.wa).toBe(5000);
    expect(second.st).toBe(100);
    expect(r.sent.filter((s) => s.p === 2)[0]?.s).toBe(0);
  });

  it('does not count the pause the end of the media causes', () => {
    const r = rig();
    load(r, 10);
    play(r);
    playFor(r, 10);
    end(r);
    const s = last(r);
    expect(s.pu ?? 0).toBe(0);
    expect((s.fl ?? 0) & FLAGS.ended).toBe(FLAGS.ended);
  });

  it('opens a play for an error that came before anyone pressed play', () => {
    const r = rig();
    r.video.error = { code: 4, message: 'MEDIA_ELEMENT_ERROR: Format error' };
    r.video.emit('error');
    const s = last(r);
    expect(s.p).toBe(1);
    expect(s.er).toBe(4);
    expect((s.fl ?? 0) & FLAGS.started).toBe(0);
    expect(s.ev?.map((e) => e.k)).toContain('error');
  });

  it('takes a play watched mid-way as real, with its startup unknown', () => {
    const r = rig((v) => {
      v.paused = false;
      v.readyState = 4;
      v.duration = 60;
      v.currentTime = 12;
    });
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.st).toBeUndefined();
    expect((r.sent[0]?.fl ?? 0) & FLAGS.started).toBe(FLAGS.started);
  });

  it('numbers plays across every element on the page, not per element', () => {
    const a = rig();
    const b = rig();
    load(a);
    load(b);
    play(a);
    play(b);
    expect(a.sent[0]?.p).toBe(1);
    expect(b.sent[0]?.p).toBe(2);
  });

  it('sets each flag the first time it happens and never clears it', () => {
    const r = rig();
    load(r);
    play(r);
    r.video.muted = true;
    r.video.emit('volumechange');
    r.video.muted = false;
    r.video.emit('volumechange');
    r.doc.fullscreenElement = r.video;
    r.doc.dispatchEvent(new Event('fullscreenchange'));
    r.doc.fullscreenElement = null;
    r.doc.dispatchEvent(new Event('fullscreenchange'));
    r.video.emit('enterpictureinpicture');
    playFor(r, 3);
    pause(r);
    const fl = last(r).fl ?? 0;
    expect(fl & FLAGS.started).toBeTruthy();
    expect(fl & FLAGS.muted).toBeTruthy();
    expect(fl & FLAGS.fullscreen).toBeTruthy();
    expect(fl & FLAGS.pip).toBeTruthy();
    expect(fl & FLAGS.ended).toBe(0);
  });

  it('keeps the tallest frame and the frames dropped during this play only', () => {
    const r = rig();
    r.video.quality = { droppedVideoFrames: 40, totalVideoFrames: 9000 };
    load(r, 600, 480);
    play(r);
    r.video.videoHeight = 1080;
    r.video.emit('resize');
    r.video.quality = { droppedVideoFrames: 52, totalVideoFrames: 9600 };
    playFor(r, 3);
    pause(r);
    const s = last(r);
    expect(s.mh).toBe(1080);
    expect(s.dr).toBe(12);
    expect(s.fr).toBe(600);
  });
});

describe('snapshots', () => {
  it('go at the first frame, on pause, every ten minutes, and when the tab is hidden', () => {
    const r = rig();
    load(r, 7200);
    play(r);
    expect(r.sent).toHaveLength(1);
    playFor(r, 60);
    pause(r);
    expect(r.sent).toHaveLength(2);
    resume(r);
    playFor(r, 10 * 60);
    expect(r.sent).toHaveLength(3);
    hide(r);
    expect(r.sent).toHaveLength(4);
    expect(r.sent.map((s) => s.s)).toEqual([0, 1, 2, 3]);
  });

  it('and when the page goes away, from pagehide', () => {
    const r = rig();
    load(r);
    play(r);
    playFor(r, 5);
    r.win.dispatchEvent(new Event('pagehide'));
    expect(r.sent).toHaveLength(2);
    expect(last(r).wa).toBe(5000);
  });

  it('a pause right after another snapshot waits for the next one', () => {
    const r = rig();
    load(r);
    play(r);
    r.advance(500);
    pause(r);
    resume(r);
    r.advance(500);
    pause(r);
    expect(r.sent).toHaveLength(1);
  });

  it('never lets a counter go down across a play', () => {
    const r = rig();
    load(r, 3600);
    play(r);
    for (let i = 0; i < 6; i++) {
      playFor(r, 30);
      stall(r, 700);
      seek(r, r.video.currentTime + 60);
      playFor(r, 10);
      pause(r);
      r.advance(3000);
      resume(r);
    }
    hide(r);
    end(r);
    expect(r.sent.length).toBeGreaterThan(5);
    assertMonotonic(r.sent);
  });

  it('never carries the media URL past its path: no query, no fragment', () => {
    const r = rig();
    load(r);
    play(r);
    r.video.emit('waiting');
    r.advance(100);
    end(r);
    const body = JSON.stringify(r.sent);
    expect(body).not.toContain('s3cret');
    expect(body).not.toContain('token');
    expect(last(r).ev?.find((e) => e.k === 'source')?.d).toBe(
      'media.example.test/films/matrix.mp4',
    );
  });
});

describe('traces', () => {
  it('are not sent for a clean play under the default rule', () => {
    const r = rig();
    load(r, 30);
    play(r);
    playFor(r, 30);
    hide(r);
    end(r);
    expect(r.sent.every((s) => s.ev === undefined)).toBe(true);
  });

  it('are sent whole for a play that stalled, in order, timed from the attach', () => {
    const r = rig();
    r.advance(250);
    load(r, 60);
    play(r, 400);
    playFor(r, 5);
    stall(r, 1200);
    playFor(r, 5);
    end(r);
    const ev = last(r).ev ?? [];
    expect(ev.map((e) => e.k)).toEqual([
      'attach',
      'source',
      'manifest',
      'first_frame',
      'stall_start',
      'stall_end',
      'ended',
    ]);
    expect(ev[0]?.t).toBe(0);
    for (let i = 1; i < ev.length; i++) {
      expect(ev[i]?.t ?? 0).toBeGreaterThanOrEqual(ev[i - 1]?.t ?? 0);
    }
    expect(ev.find((e) => e.k === 'first_frame')?.d).toBe('after 400 ms');
    expect(ev.find((e) => e.k === 'stall_end')?.d).toBe('after 1.2 s');
  });

  it('go only on a snapshot that could be the last: hidden, gone, ended, failed', () => {
    const r = rig();
    load(r, 60);
    play(r);
    stall(r, 500);
    playFor(r, 5);
    pause(r);
    expect(last(r).ev).toBeUndefined();
    hide(r);
    expect(last(r).ev?.length).toBeGreaterThan(0);
  });

  it('follow the rule the answer names: none sends nothing, all sends every play', async () => {
    const r = rig();
    r.answer.rule = 'none';
    load(r, 20);
    play(r);
    await r.settle();
    r.video.error = { code: 2, message: '' };
    r.video.emit('error');
    expect(last(r).ev).toBeUndefined();

    const all = rig();
    all.answer.rule = 'all';
    load(all, 20);
    play(all);
    await all.settle();
    playFor(all, 20);
    end(all);
    expect(last(all).ev?.length).toBeGreaterThan(0);
  });

  it('for a fraction, keep exactly the plays the receiving side keeps', async () => {
    // The receiving side's own tests pin these same vectors.
    expect(bucket('0A1B2C3D4E5F6071:1')).toBe(42);
    expect(bucket('0A1B2C3D4E5F6071:2')).toBe(23);
    expect(bucket('0A1B2C3D4E5F6071:3')).toBe(4);
    expect(bucket('FFFFFFFFFFFFFFFF:255')).toBe(95);
    expect(bucket('0000000000000001:1')).toBe(71);

    const r = rig();
    r.answer.rule = '30';
    load(r, 5);
    const traced: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      r.video.currentTime = 0;
      play(r);
      await r.settle();
      playFor(r, 5);
      end(r);
      traced.push(last(r).ev !== undefined);
    }
    // Plays 1, 2 and 3 of LOAD land in buckets 42, 23 and 4.
    expect(LOAD).toBe('0A1B2C3D4E5F6071');
    expect(traced).toEqual([false, true, true]);
  });

  it('stop growing past the cap, keeping how the play began', () => {
    const r = rig();
    load(r, 3600);
    play(r);
    for (let i = 0; i < 200; i++) {
      pause(r);
      r.advance(2500);
      resume(r);
    }
    stall(r, 100);
    end(r);
    const ev = last(r).ev ?? [];
    expect(ev.length).toBeLessThanOrEqual(MAX_EVENTS);
    expect(ev[0]?.k).toBe('attach');
    expect(ev[ev.length - 1]?.k).toBe('ended');
  });
});

describe('stopping', () => {
  it('sends a final snapshot and then hears nothing from the element', () => {
    const r = rig();
    load(r);
    play(r);
    playFor(r, 3);
    r.collector.stop();
    const n = r.sent.length;
    expect(last(r).wa).toBe(3000);
    pause(r);
    resume(r);
    r.video.emit('ended');
    expect(r.sent).toHaveLength(n);
  });
});
