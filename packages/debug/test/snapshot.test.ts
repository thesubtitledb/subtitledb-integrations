/**
 * The body on the wire. The receiving side refuses a post with a name it does not
 * know, a number out of range or a body over 8 KB, and a refused post is a play the
 * owner never sees, so each of those limits is held here as well as there.
 */
import { describe, expect, it } from 'vitest';
import {
  bucket,
  EVENT_KINDS,
  encode,
  MAX_BODY,
  type Snapshot,
  type TraceEvent,
} from '../src/snapshot.js';
import { KEY, LOAD } from './fakes.js';

/** Every name the receiving side accepts. */
const ACCEPTED = new Set(
  (
    'v k l p s ps u pa im tm se ep du li st wa un mp cv sk pu sn sm er mh qd ql dr fr fl ' +
    'pl ss sl sb sw si al ev'
  ).split(' '),
);

const base: Snapshot = { v: 1, k: KEY, l: LOAD, p: 1, s: 0, ps: 1_790_000_000 };

/** A long film, watched most of the way, with a SubtitleDB subtitle on. */
const full: Snapshot = {
  ...base,
  u: 'CAFEBABE0000FEED',
  pa: '/watch/the-matrix-1999?list=weekend&t=1',
  im: 133093,
  tm: 603,
  du: 8160,
  st: 812,
  wa: 5_400_000,
  un: 5400,
  mp: 8160,
  cv: 'ffffffffffffffff',
  sk: 4,
  pu: 2,
  sn: 3,
  sm: 4200,
  mh: 1080,
  qd: 3,
  ql: 95_000,
  dr: 12,
  fr: 324_000,
  fl: 1 | 4 | 32 | 256,
  pl: 'videojs',
  ss: 'sdb',
  sl: 'en',
  sb: 5_000_000,
  sw: 1,
  si: 9_123_456,
  al: 'en',
};

const size = (body: string) => new TextEncoder().encode(body).length;

function trace(n: number, detail = 120): TraceEvent[] {
  return Array.from({ length: n }, (_, i) => ({
    k: i === 0 ? 'attach' : i === n - 1 ? 'ended' : 'seek',
    t: i * 1000,
    d: `${i} `.padEnd(detail, 'x'),
  }));
}

describe('encode', () => {
  it('sends only names the receiving side accepts, each number whole and in range', () => {
    const body = JSON.parse(encode({ ...full, st: 812.7, wa: -5, sk: 70_000, p: 300, er: 9.9 }));
    for (const name of Object.keys(body)) expect(ACCEPTED.has(name), name).toBe(true);
    for (const [name, value] of Object.entries(body)) {
      if (typeof value === 'number') expect(Number.isInteger(value), name).toBe(true);
    }
    expect(body.st).toBe(812);
    expect(body.sk).toBe(65_535);
    expect(body.p).toBe(255);
    expect(body.er).toBe(9);
    // Below zero is out of range, so it becomes 0, and 0 is not sent.
    expect(body).not.toHaveProperty('wa');
  });

  it('sends a number a page gave as a string as the number, and leaves out anything else', () => {
    // A resolve hands on the page's hint as the page wrote it: "603" for 603.
    const given = { tm: '603', se: ' 2 ', ep: 'two', du: true, st: null, sk: '-1' };
    const body = JSON.parse(encode({ ...base, ...given } as unknown as Snapshot));
    expect([body.tm, body.se]).toEqual([603, 2]);
    for (const name of ['ep', 'du', 'st', 'sk']) expect(body, name).not.toHaveProperty(name);
  });

  it('leaves out what is zero or empty, but never the six fields every snapshot has', () => {
    expect(JSON.parse(encode(base))).toEqual({
      v: 1,
      k: KEY,
      l: LOAD,
      p: 1,
      s: 0,
      ps: 1_790_000_000,
    });
    expect(encode({ ...base, sk: 0, pl: '', ev: [], du: Number.NaN })).toBe(encode(base));
  });

  it('cuts each string to the length the receiving side accepts', () => {
    const body = JSON.parse(
      encode({ ...base, pa: `/${'a'.repeat(600)}`, pl: 'p'.repeat(40), sl: 'x'.repeat(20) }),
    );
    expect(body.pa).toHaveLength(512);
    expect(body.pl).toHaveLength(32);
    expect(body.sl).toHaveLength(16);
    expect(JSON.parse(encode({ ...base, cv: 'f'.repeat(20) })).cv).toHaveLength(16);
  });

  it('names only trace kinds the receiving side knows, since one it does not refuses the report', () => {
    // The receiving side's list, in its order. A kind goes there, and is deployed, first.
    expect([...EVENT_KINDS]).toEqual([
      'attach',
      'source',
      'manifest',
      'offered',
      'first_frame',
      'playing',
      'pause',
      'seek',
      'stall_start',
      'stall_end',
      'track',
      'level',
      'error',
      'ended',
      'blocked',
      'rate',
      'volume',
      'audio',
      'fullscreen',
      'pip',
      'cast',
      'frames',
    ]);
  });

  it('keeps a snapshot without a trace under 1 KB, even with the longest path', () => {
    expect(size(encode(full))).toBeLessThan(512);
    expect(size(encode({ ...full, pa: `/${'a'.repeat(600)}` }))).toBeLessThanOrEqual(1024);
  });

  it('sends a trace whole when it fits', () => {
    const ev = trace(30, 40);
    expect(JSON.parse(encode({ ...full, ev })).ev).toEqual(ev);
  });

  it('cuts a long trace from the middle, keeping how the play began and how it ended', () => {
    const ev = trace(150);
    const body = encode({ ...full, ev });
    expect(size(body)).toBeLessThanOrEqual(MAX_BODY);
    const sent: TraceEvent[] = JSON.parse(body).ev;
    expect(sent.length).toBeGreaterThan(20);
    expect(sent.length).toBeLessThan(150);
    expect(sent.slice(0, 20)).toEqual(ev.slice(0, 20));
    expect(sent.slice(-5)).toEqual(ev.slice(-5));
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i]?.t ?? 0).toBeGreaterThan(sent[i - 1]?.t ?? 0);
    }
  });

  it('drops the trace rather than the record when even a cut one will not fit', () => {
    const ev = trace(20, 400);
    const body = JSON.parse(encode({ ...full, ev }));
    expect(body).not.toHaveProperty('ev');
    expect(body.wa).toBe(full.wa);
    expect(body.sn).toBe(full.sn);
  });
});

describe('bucket', () => {
  it('agrees with the receiving side on every vector both pin', () => {
    expect(bucket('0A1B2C3D4E5F6071:1')).toBe(42);
    expect(bucket('0A1B2C3D4E5F6071:2')).toBe(23);
    expect(bucket('0A1B2C3D4E5F6071:3')).toBe(4);
    expect(bucket('FFFFFFFFFFFFFFFF:255')).toBe(95);
    expect(bucket('0000000000000001:1')).toBe(71);
  });

  it('spreads plays evenly enough that a percentage means that percentage', () => {
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < 20_000; i++) {
      const b = bucket(`${i.toString(16).toUpperCase().padStart(16, '0')}:1`);
      counts[Math.floor(b / 10)] = (counts[Math.floor(b / 10)] ?? 0) + 1;
    }
    for (const c of counts) expect(c).toBeGreaterThan(1600);
  });
});
