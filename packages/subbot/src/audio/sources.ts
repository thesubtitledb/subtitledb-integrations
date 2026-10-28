/**
 * Where the audio frames come from, by container and by how the bytes arrive.
 *
 * A source answers the frames for a span of time. Random-access sources (a file, a
 * URL with Range support, a playlist of segments) answer any span; a feed source
 * answers only what a player has handed it. Each one reads the least it can: a
 * window of a flat MP4 is a few Range requests, a window of HLS is one or two
 * segments.
 */
import { SubbotError } from '../errors.js';
import { type ByteSource, be, concat, fromBlob, fromUrl, Reader, readRanges } from './bytes.js';
import type { AudioCodec, EncodedChunk } from './codec.js';
import { type DashAudio, parseMpd } from './dash.js';
import * as ebml from './ebml.js';
import { type HlsSegment, parseM3u8, pickHlsAudio } from './hls.js';
import * as mp4 from './mp4.js';
import { TsDemuxer } from './ts.js';

export interface Source {
  duration: number;
  codec: AudioCodec;
  container: string;
  /** Any span on demand, as against only what was fed. */
  random: boolean;
  chunks(t0: number, t1: number): Promise<EncodedChunk[]>;
  /** The spans this source can answer right now. For a random source, the whole file. */
  coverage(): Array<[number, number]>;
  feed?(bytes: Uint8Array, init: boolean, start: number | null): void;
  trim?(keep: Array<[number, number]>): void;
}

export function sniff(head: Uint8Array): 'mp4' | 'mkv' | 'ts' | 'm3u8' | 'mpd' | null {
  if (head.length >= 8 && be.fourcc(head, 4) === 'ftyp') return 'mp4';
  if (
    head.length >= 8 &&
    ['moov', 'moof', 'styp', 'sidx', 'free', 'mdat'].includes(be.fourcc(head, 4))
  )
    return 'mp4';
  if (head.length >= 4 && be.u32(head, 0) === 0x1a45dfa3) return 'mkv';
  if (head.length >= 376 && head[0] === 0x47 && head[188] === 0x47) return 'ts';
  const text = new TextDecoder().decode(head.subarray(0, 512));
  if (text.startsWith('#EXTM3U')) return 'm3u8';
  if (/^\s*(<\?xml[^>]*>)?\s*<MPD/.test(text)) return 'mpd';
  return null;
}

// ---- flat and fragmented MP4 files ------------------------------------------------

export class Mp4Source implements Source {
  duration = 0;
  codec!: AudioCodec;
  container = 'mp4';
  random = true;
  private track!: mp4.Mp4Track;
  private tracks = new Map<number, mp4.Mp4Track>();
  /** For a fragmented file: every moof's byte extent, in order, with its first time. */
  private frags: Array<{ start: number; end: number; t: number }> | null = null;

  constructor(private readonly r: Reader) {}

  async open(language?: string): Promise<this> {
    // Walk the top-level boxes by header alone. The moov may sit after a multi-GB
    // mdat, and only its header has to be read to skip it.
    let p = 0;
    let moovBox: mp4.Box | null = null;
    let sidx: mp4.Sidx | null = null;
    let sidxEnd = 0;
    const mdats: Array<[number, number]> = [];
    for (let guard = 0; guard < 64; guard++) {
      const head = await this.r.read(p, p + 16);
      if (head.length < 8) break;
      const [b] = mp4.boxes(head, 0, head.length);
      if (!b) break;
      const box: mp4.Box = { ...b, start: p, end: p + b.size };
      if (box.type === 'moov') moovBox = box;
      if (box.type === 'sidx' && !sidx) {
        const bytes = await this.r.read(box.start, box.end);
        sidx = mp4.parseSidx(bytes, { ...box, start: 0, end: bytes.length });
        sidxEnd = box.end;
      }
      if (box.type === 'mdat' || box.type === 'moof') mdats.push([box.start, box.end]);
      if (box.size === 0 || box.size < box.head) break;
      p = box.end;
      if (this.r.size !== null && p >= this.r.size) break;
    }
    if (!moovBox) throw new SubbotError('no moov box in the MP4', 'unsupported_container');
    const bytes = await this.r.read(moovBox.start, moovBox.end);
    const movie = mp4.parseMoov(bytes, { ...moovBox, start: 0, end: bytes.length });
    const track = mp4.pickAudio(movie, language);
    if (!track) throw new SubbotError('the MP4 has no audio track', 'no_audio_track');
    this.track = track;
    this.codec = track.codec as AudioCodec;
    for (const t of movie.tracks) this.tracks.set(t.id, t);
    this.duration = track.duration
      ? track.duration / track.timescale
      : movie.duration / movie.timescale;

    if (track.samples.length === 0) {
      // Fragmented. Index the moofs from the sidx when there is one, else by walking.
      const frags: Array<{ start: number; end: number; t: number }> = [];
      if (sidx) {
        let off = sidxEnd + sidx.firstOffset;
        let t = sidx.earliest / sidx.timescale;
        for (const ref of sidx.refs) {
          frags.push({ start: off, end: off + ref.size, t });
          off += ref.size;
          t += ref.dur / sidx.timescale;
        }
      } else {
        let q = moovBox.end;
        const size = this.r.size ?? Number.POSITIVE_INFINITY;
        while (q + 8 <= size) {
          const head = await this.r.read(q, q + 16);
          const [b] = mp4.boxes(head, 0, head.length);
          if (!b || b.size < 8) break;
          if (b.type === 'moof') {
            const moof = await this.r.read(q, q + b.size);
            const run = mp4
              .parseMoof(moof, { ...b, start: 0, end: moof.length }, this.tracks)
              .find((x) => x.trackId === track.id);
            const t = run?.samples[0]
              ? run.samples[0].dts / track.timescale
              : (frags[frags.length - 1]?.t ?? 0);
            // The fragment's data is the mdat that follows the moof.
            const next = await this.r.read(q + b.size, q + b.size + 16);
            const [m] = mp4.boxes(next, 0, next.length);
            const end = m && m.type === 'mdat' ? q + b.size + m.size : q + b.size;
            frags.push({ start: q, end, t });
            q = end;
          } else q += b.size;
        }
      }
      this.frags = frags;
      if (!this.duration && frags.length) this.duration = (frags[frags.length - 1]?.t ?? 0) + 10;
    }
    return this;
  }

  async chunks(t0: number, t1: number): Promise<EncodedChunk[]> {
    const track = this.track;
    if (!this.frags) {
      const samples = mp4.samplesBetween(track, t0, t1);
      const ranges = mp4.extents(samples);
      const parts = await readRanges(this.r.src, ranges);
      const out: EncodedChunk[] = [];
      for (const [i, [a, b]] of ranges.entries()) {
        const bytes = parts[i] as Uint8Array;
        out.push(
          ...mp4.chunksOf(
            samples.filter((s) => s.offset >= a && s.offset + s.size <= b),
            track,
            bytes,
            a,
          ),
        );
      }
      return out;
    }
    const out: EncodedChunk[] = [];
    for (let i = 0; i < this.frags.length; i++) {
      const f = this.frags[i] as { start: number; end: number; t: number };
      const next = this.frags[i + 1]?.t ?? Number.POSITIVE_INFINITY;
      if (next <= t0 || f.t >= t1) continue;
      const bytes = await this.r.src.read(f.start, f.end);
      for (const moof of mp4.boxes(bytes).filter((b) => b.type === 'moof')) {
        for (const run of mp4.parseMoof(bytes, moof, this.tracks)) {
          if (run.trackId !== track.id) continue;
          for (const c of mp4.chunksOf(run.samples, track, bytes))
            if (c.ts < t1 && c.ts + c.dur > t0) out.push(c);
        }
      }
    }
    return out;
  }

  coverage(): Array<[number, number]> {
    return [[0, this.duration]];
  }
}

// ---- Matroska and WebM ---------------------------------------------------------------

export class MkvSource implements Source {
  duration = 0;
  codec!: AudioCodec;
  container = 'mkv';
  random = true;
  private h!: ebml.MkvHeader;
  private track!: ebml.MkvTrack;

  constructor(private readonly r: Reader) {}

  async open(language?: string): Promise<this> {
    const h = await ebml.readHeader(this.r);
    if (!h) throw new SubbotError('not a Matroska file', 'unsupported_container');
    const track = ebml.pickAudio(h, language);
    if (!track) throw new SubbotError('the file has no audio track', 'no_audio_track');
    this.h = h;
    this.track = track;
    this.codec = track.codec as AudioCodec;
    this.duration = h.duration;
    return this;
  }

  async chunks(t0: number, t1: number): Promise<EncodedChunk[]> {
    const out: EncodedChunk[] = [];
    let p = ebml.clusterFor(this.h, t0);
    const end = this.h.segmentEnd ?? this.r.size ?? Number.POSITIVE_INFINITY;
    for (let guard = 0; guard < 100000 && p < end; guard++) {
      const head = await this.r.read(p, p + 16);
      const e = ebml.element(head, 0);
      if (!e) break;
      if (e.id !== ebml.EBML_ID.Cluster) {
        if (e.size === ebml.EBML_UNKNOWN) break;
        p += e.start + e.size;
        continue;
      }
      // A cluster is read whole: its audio blocks sit between video frames, and one
      // read of the lot costs less than a read per block.
      const size = e.size === ebml.EBML_UNKNOWN ? 4 * 1024 * 1024 : e.size;
      const bytes = await this.r.src.read(p, p + e.start + size);
      const cluster = ebml.parseCluster(bytes, {
        ...e,
        start: e.start,
        size: e.size === ebml.EBML_UNKNOWN ? ebml.EBML_UNKNOWN : e.size,
      });
      const chunks = ebml.chunksOfCluster(this.h, this.track, cluster);
      for (const c of chunks) if (c.ts < t1 && c.ts >= t0 - 0.5) out.push(c);
      const first = chunks[0]?.ts;
      if (first !== undefined && first >= t1) break;
      p += e.size === ebml.EBML_UNKNOWN ? cluster.end : e.start + e.size;
    }
    return out;
  }

  coverage(): Array<[number, number]> {
    return [[0, this.duration]];
  }
}

// ---- MPEG-TS files ---------------------------------------------------------------------

/**
 * A whole TS file has no index, so a time is found by bitrate: guess the byte
 * offset, read there, see what time it is, correct once or twice.
 */
export class TsFileSource implements Source {
  duration = 0;
  codec!: AudioCodec;
  container = 'ts';
  random = true;
  private firstPts = 0;
  private bytesPerSecond = 0;

  constructor(private readonly r: Reader) {}

  private async probe(at: number): Promise<{ pts: number; at: number } | null> {
    const bytes = await this.r.src.read(at, at + 512 * 1024);
    const d = new TsDemuxer();
    const chunks = d.push(bytes).concat(d.end());
    if (!this.codec && d.codec) this.codec = d.codec;
    const first = chunks[0];
    return first ? { pts: first.ts, at } : null;
  }

  async open(): Promise<this> {
    const head = await this.probe(0);
    if (!head || !this.codec)
      throw new SubbotError('no audio stream in the TS file', 'no_audio_track');
    this.firstPts = head.pts;
    const size = this.r.size;
    if (size === null) throw new SubbotError('the TS file has no known length', 'audio_unreadable');
    const tail = await this.probe(Math.max(0, size - 1024 * 1024));
    const lastPts = tail?.pts ?? head.pts;
    const span = Math.max(1, lastPts - head.pts);
    this.bytesPerSecond = Math.max(1, (size - (tail?.at ?? 0)) / span);
    this.duration = span + 2;
    return this;
  }

  async chunks(t0: number, t1: number): Promise<EncodedChunk[]> {
    const size = this.r.size ?? 0;
    let at = Math.max(0, Math.floor(((t0 - 1) * this.bytesPerSecond) / 188) * 188);
    // Two corrections: the bitrate is an average and a scene can be far from it.
    for (let i = 0; i < 2; i++) {
      const p = await this.probe(at);
      if (!p) break;
      const off = p.pts - this.firstPts - (t0 - 1);
      if (Math.abs(off) < 0.5) break;
      at = Math.max(
        0,
        Math.min(size - 188, Math.floor((at - off * this.bytesPerSecond) / 188) * 188),
      );
    }
    const d = new TsDemuxer();
    const out: EncodedChunk[] = [];
    let p = at;
    for (let guard = 0; guard < 64 && p < size; guard++) {
      const bytes = await this.r.src.read(p, p + 512 * 1024);
      p += bytes.length;
      for (const c of d.push(bytes)) {
        const ts = c.ts - this.firstPts;
        if (ts >= t1 + 1) return out.map((x) => ({ ...x, ts: x.ts - this.firstPts }));
        if (ts >= t0 - 0.5) out.push(c);
      }
      if (bytes.length < 512 * 1024) break;
    }
    for (const c of d.end()) if (c.ts - this.firstPts >= t0 - 0.5) out.push(c);
    return out.map((x) => ({ ...x, ts: x.ts - this.firstPts }));
  }

  coverage(): Array<[number, number]> {
    return [[0, this.duration]];
  }
}

// ---- segmented streams: HLS and DASH ---------------------------------------------------

interface Segment {
  uri: string;
  byteRange: [number, number] | null;
  start: number;
  duration: number;
  init: { uri: string; byteRange: [number, number] | null } | null;
}

async function fetchRange(
  url: string,
  range: [number, number] | null,
  fetchFn: typeof fetch,
): Promise<Uint8Array> {
  const res = await fetchFn(
    url,
    range ? { headers: { range: `bytes=${range[0]}-${range[1] - 1}` } } : {},
  );
  if (!res.ok) throw new SubbotError(`${url} answered ${res.status}`, 'audio_unreadable');
  const bytes = new Uint8Array(await res.arrayBuffer());
  // A server that ignored the Range answers the whole file with 200.
  return range && res.status === 200 ? bytes.subarray(range[0], range[1]) : bytes;
}

/**
 * Segments demuxed one at a time, each kept until trimmed. TS segments go through
 * the stateful demuxer in order; fMP4 segments carry their own times.
 */
export class SegmentedSource implements Source {
  duration = 0;
  codec!: AudioCodec;
  random = true;
  private segments: Segment[] = [];
  private inits = new Map<
    string,
    { movie: mp4.Movie; tracks: Map<number, mp4.Mp4Track>; track: mp4.Mp4Track }
  >();
  private cache = new Map<number, EncodedChunk[]>();
  /** PTS of the first frame, which TS streams start anywhere but zero. */
  private tsBase: number | null = null;

  constructor(
    readonly container: 'hls' | 'dash',
    private readonly fetchFn: typeof fetch,
    private readonly language?: string,
  ) {}

  async openHls(url: string): Promise<this> {
    const text = await (await this.fetchFn(url)).text();
    let playlist = parseM3u8(text, url);
    if (playlist.kind === 'master') {
      const audioUrl = pickHlsAudio(playlist, this.language);
      if (!audioUrl)
        throw new SubbotError('the HLS master names no playable rendition', 'no_audio_track');
      playlist = parseM3u8(await (await this.fetchFn(audioUrl)).text(), audioUrl);
    }
    if (playlist.kind !== 'media')
      throw new SubbotError('the HLS playlist has no segments', 'no_audio_track');
    if (!playlist.endlist)
      throw new SubbotError(
        'live HLS streams cannot be transcribed ahead',
        'unsupported_container',
      );
    this.segments = playlist.segments.map((s: HlsSegment) => ({ ...s, init: s.map }));
    return this.finish();
  }

  async openDash(url: string): Promise<this> {
    const text = await (await this.fetchFn(url)).text();
    const audio: DashAudio | null = parseMpd(text, url, this.language);
    if (!audio) throw new SubbotError('the MPD has no audio adaptation set', 'no_audio_track');
    if (audio.segments) {
      this.segments = audio.segments.map((s) => ({ ...s, init: audio.init }));
    } else if (audio.indexed) {
      // One file with a sidx: the index says where each subsegment is.
      const { uri, indexRange } = audio.indexed;
      const head = await fetchRange(uri, indexRange ?? [0, 64 * 1024], this.fetchFn);
      const box = mp4.boxes(head).find((b) => b.type === 'sidx');
      if (!box)
        throw new SubbotError('the MPD points at a file with no sidx', 'unsupported_container');
      const sidx = mp4.parseSidx(head, box);
      let off = (indexRange?.[0] ?? 0) + box.end + sidx.firstOffset;
      let t = sidx.earliest / sidx.timescale;
      for (const ref of sidx.refs) {
        this.segments.push({
          uri,
          byteRange: [off, off + ref.size],
          start: t,
          duration: ref.dur / sidx.timescale,
          init: audio.init,
        });
        off += ref.size;
        t += ref.dur / sidx.timescale;
      }
    }
    if (this.segments.length === 0)
      throw new SubbotError('the MPD lists no audio segments', 'no_audio_track');
    return this.finish();
  }

  private async finish(): Promise<this> {
    const last = this.segments[this.segments.length - 1] as Segment;
    this.duration = last.start + last.duration;
    // Read the first segment now: it is what names the codec.
    await this.segment(0);
    if (!this.codec) throw new SubbotError('the first segment carried no audio', 'no_audio_track');
    return this;
  }

  private async init(
    seg: Segment,
  ): Promise<{ tracks: Map<number, mp4.Mp4Track>; track: mp4.Mp4Track } | null> {
    if (!seg.init) return null;
    const key = `${seg.init.uri}#${seg.init.byteRange?.join('-') ?? ''}`;
    const held = this.inits.get(key);
    if (held) return held;
    const bytes = await fetchRange(seg.init.uri, seg.init.byteRange, this.fetchFn);
    const moov = mp4.boxes(bytes).find((b) => b.type === 'moov');
    if (!moov) throw new SubbotError('the init segment has no moov', 'unsupported_container');
    const movie = mp4.parseMoov(bytes, moov);
    const track = mp4.pickAudio(movie, this.language);
    if (!track) throw new SubbotError('the init segment has no audio track', 'no_audio_track');
    const entry = { movie, tracks: new Map(movie.tracks.map((t) => [t.id, t])), track };
    this.inits.set(key, entry);
    if (!this.codec) this.codec = track.codec as AudioCodec;
    return entry;
  }

  private async segment(i: number): Promise<EncodedChunk[]> {
    const held = this.cache.get(i);
    if (held) return held;
    const seg = this.segments[i] as Segment;
    const bytes = await fetchRange(seg.uri, seg.byteRange, this.fetchFn);
    let chunks: EncodedChunk[];
    if (seg.init || mp4.boxes(bytes).some((b) => b.type === 'moof')) {
      const init = await this.init(seg);
      if (!init)
        throw new SubbotError(
          'an fMP4 segment arrived with no init segment',
          'unsupported_container',
        );
      chunks = [];
      for (const moof of mp4.boxes(bytes).filter((b) => b.type === 'moof')) {
        for (const run of mp4.parseMoof(bytes, moof, init.tracks)) {
          if (run.trackId === init.track.id)
            chunks.push(...mp4.chunksOf(run.samples, init.track, bytes));
        }
      }
    } else {
      // TS: each HLS segment is self-contained, so a fresh demuxer per segment is
      // right, and the stream's own PTS is rebased to the playlist's clock.
      const d = new TsDemuxer();
      chunks = d.push(bytes).concat(d.end());
      if (!this.codec && d.codec) this.codec = d.codec;
      if (this.tsBase === null && chunks[0]) this.tsBase = chunks[0].ts - seg.start;
      const base = this.tsBase ?? 0;
      chunks = chunks.map((c) => ({ ...c, ts: c.ts - base }));
    }
    this.cache.set(i, chunks);
    return chunks;
  }

  async chunks(t0: number, t1: number): Promise<EncodedChunk[]> {
    const out: EncodedChunk[] = [];
    for (let i = 0; i < this.segments.length; i++) {
      const s = this.segments[i] as Segment;
      if (s.start + s.duration <= t0 - 0.5 || s.start >= t1 + 0.5) continue;
      for (const c of await this.segment(i)) if (c.ts < t1 && c.ts >= t0 - 0.5) out.push(c);
    }
    return out;
  }

  coverage(): Array<[number, number]> {
    return [[0, this.duration]];
  }

  trim(keep: Array<[number, number]>): void {
    for (const i of [...this.cache.keys()]) {
      const s = this.segments[i] as Segment;
      if (!keep.some(([a, b]) => s.start < b && s.start + s.duration > a)) this.cache.delete(i);
    }
  }
}

// ---- bytes handed over by a player ----------------------------------------------------

/**
 * Segments a player fetched for itself, forwarded as it appends them. Nothing can be
 * asked for that the player did not load, so coverage is whatever has arrived.
 */
export class FeedSource implements Source {
  duration = 0;
  codec!: AudioCodec;
  random = false;
  private held: EncodedChunk[] = [];
  private tracks = new Map<number, mp4.Mp4Track>();
  private track: mp4.Mp4Track | null = null;
  private ts = new TsDemuxer();

  constructor(
    readonly container: 'mp4' | 'ts',
    private readonly language?: string,
  ) {}

  feed(bytes: Uint8Array, init: boolean, _start: number | null): void {
    if (this.container === 'ts') {
      const chunks = this.ts.push(bytes);
      if (!this.codec && this.ts.codec) this.codec = this.ts.codec;
      this.add(chunks);
      return;
    }
    const boxes = mp4.boxes(bytes);
    const moov = boxes.find((b) => b.type === 'moov');
    if (init || moov) {
      if (!moov) return;
      const movie = mp4.parseMoov(bytes, moov);
      for (const t of movie.tracks) this.tracks.set(t.id, t);
      const track = mp4.pickAudio(movie, this.language);
      if (track) {
        this.track = track;
        this.codec = track.codec as AudioCodec;
      }
      return;
    }
    if (!this.track) return;
    const chunks: EncodedChunk[] = [];
    for (const moof of boxes.filter((b) => b.type === 'moof')) {
      for (const run of mp4.parseMoof(bytes, moof, this.tracks)) {
        if (run.trackId === this.track.id)
          chunks.push(...mp4.chunksOf(run.samples, this.track, bytes.slice(0)));
      }
    }
    this.add(chunks);
  }

  private add(chunks: EncodedChunk[]): void {
    if (chunks.length === 0) return;
    // Keep an owned copy: the player reuses its buffers.
    const copies = chunks.map((c) => ({ ...c, data: c.data.slice(0) }));
    this.held.push(...copies);
    this.held.sort((a, b) => a.ts - b.ts);
  }

  async chunks(t0: number, t1: number): Promise<EncodedChunk[]> {
    return this.held.filter((c) => c.ts < t1 && c.ts >= t0 - 0.5);
  }

  coverage(): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (const c of this.held) {
      const end = c.ts + (c.dur || 0.03);
      const last = out[out.length - 1];
      if (last && c.ts <= last[1] + 0.1) last[1] = Math.max(last[1], end);
      else out.push([c.ts, end]);
    }
    return out;
  }

  trim(keep: Array<[number, number]>): void {
    this.held = this.held.filter((c) => keep.some(([a, b]) => c.ts < b && c.ts >= a));
  }
}

// ---- opening -----------------------------------------------------------------------------

export async function openBytes(
  src: ByteSource,
  language: string | undefined,
  fetchFn: typeof fetch,
): Promise<Source> {
  const head = await src.read(0, 1024);
  const kind = sniff(head);
  if (kind === 'mp4') return new Mp4Source(new Reader(src)).open(language);
  if (kind === 'mkv') return new MkvSource(new Reader(src, 1024 * 1024)).open(language);
  if (kind === 'ts') return new TsFileSource(new Reader(src)).open();
  if (kind === 'm3u8' || kind === 'mpd') {
    throw new SubbotError('a playlist has to be opened by URL', 'unsupported_container');
  }
  void fetchFn;
  throw new SubbotError(
    'the media is not MP4, Matroska, WebM or MPEG-TS, which are the containers that can be read',
    'unsupported_container',
  );
}

export async function openUrl(
  url: string,
  language: string | undefined,
  fetchFn: typeof fetch,
): Promise<Source> {
  // A blob URL is a file the page chose. The Blob behind it slices without reading, so
  // it is read as one rather than through Range requests the URL may not answer.
  if (url.startsWith('blob:')) {
    const res = await fetchFn(url);
    if (!res.ok) throw new SubbotError(`could not read ${url}`, 'audio_unreadable');
    return openBlob(await res.blob(), language, fetchFn);
  }
  const path = url.split(/[?#]/)[0] ?? url;
  if (/\.m3u8$/i.test(path)) return new SegmentedSource('hls', fetchFn, language).openHls(url);
  if (/\.mpd$/i.test(path)) return new SegmentedSource('dash', fetchFn, language).openDash(url);
  const src = fromUrl(url, fetchFn);
  const head = await src.read(0, 1024);
  const kind = sniff(head);
  if (kind === 'm3u8') return new SegmentedSource('hls', fetchFn, language).openHls(url);
  if (kind === 'mpd') return new SegmentedSource('dash', fetchFn, language).openDash(url);
  return openBytes(src, language, fetchFn);
}

export function openBlob(
  blob: Blob,
  language: string | undefined,
  fetchFn: typeof fetch,
): Promise<Source> {
  return openBytes(fromBlob(blob), language, fetchFn);
}

export { concat };
