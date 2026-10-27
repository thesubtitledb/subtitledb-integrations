/**
 * Matroska and WebM: the EBML tree, read far enough to find the audio track, the cue
 * index and the clusters, then each cluster's blocks for that track.
 *
 * Random access by time goes through Cues when the file has them (every muxer writes
 * them for a seekable file; ffmpeg puts them at the end and points the SeekHead at
 * them). Without Cues the clusters are indexed by walking their headers once.
 */
import { be, type Reader } from './bytes.js';
import { type AudioCodec, type EncodedChunk, parseAacConfig } from './codec.js';

const ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Seek: 0x4dbb,
  SeekID: 0x53ab,
  SeekPosition: 0x53ac,
  Info: 0x1549a966,
  TimestampScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  TrackType: 0x83,
  CodecID: 0x86,
  CodecPrivate: 0x63a2,
  CodecDelay: 0x56aa,
  Language: 0x22b59c,
  LanguageBCP47: 0x22b59d,
  FlagDefault: 0x88,
  Audio: 0xe1,
  SamplingFrequency: 0xb5,
  OutputSamplingFrequency: 0x78b5,
  Channels: 0x9f,
  Cues: 0x1c53bb6b,
  CuePoint: 0xbb,
  CueTime: 0xb3,
  CueTrackPositions: 0xb7,
  CueTrack: 0xf7,
  CueClusterPosition: 0xf1,
  Cluster: 0x1f43b675,
  Timestamp: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  Void: 0xec,
} as const;

const UNKNOWN = -1;

/** An EBML variable-length integer. IDs keep their marker bit; sizes drop it. */
export function vint(
  u8: Uint8Array,
  p: number,
  keepMarker: boolean,
): { value: number; length: number } {
  const first = u8[p];
  if (first === undefined) return { value: UNKNOWN, length: 0 };
  let length = 1;
  let mask = 0x80;
  while (length <= 8 && !(first & mask)) {
    length++;
    mask >>= 1;
  }
  if (length > 8) return { value: UNKNOWN, length: 0 };
  let value = keepMarker ? first : first & (mask - 1);
  let allOnes = !keepMarker && value === mask - 1;
  for (let i = 1; i < length; i++) {
    const b = u8[p + i] ?? 0;
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  return { value: allOnes ? UNKNOWN : value, length };
}

export interface Element {
  id: number;
  /** Where the data starts. */
  start: number;
  /** Data length, or -1 for an unknown-sized element (live WebM clusters). */
  size: number;
  /** Where the element header starts. */
  head: number;
}

export function element(u8: Uint8Array, p: number): Element | null {
  const id = vint(u8, p, true);
  if (!id.length) return null;
  const size = vint(u8, p + id.length, false);
  if (!size.length) return null;
  return { id: id.value, start: p + id.length + size.length, size: size.value, head: p };
}

/** The child elements of a buffer holding one parent's data. */
export function elements(u8: Uint8Array, start = 0, end = u8.length): Element[] {
  const out: Element[] = [];
  let p = start;
  while (p < end) {
    const e = element(u8, p);
    if (!e || e.size === UNKNOWN) break;
    out.push(e);
    p = e.start + e.size;
  }
  return out;
}

function uint(u8: Uint8Array, e: Element): number {
  let v = 0;
  for (let i = 0; i < e.size; i++) v = v * 256 + (u8[e.start + i] ?? 0);
  return v;
}

function float(u8: Uint8Array, e: Element): number {
  const dv = new DataView(u8.buffer, u8.byteOffset + e.start, e.size);
  return e.size === 4 ? dv.getFloat32(0) : e.size === 8 ? dv.getFloat64(0) : 0;
}

function text(u8: Uint8Array, e: Element): string {
  return new TextDecoder().decode(u8.subarray(e.start, e.start + e.size)).replace(/\0+$/, '');
}

export interface MkvTrack {
  number: number;
  type: number;
  codecId: string;
  codecPrivate: Uint8Array | null;
  sampleRate: number;
  channels: number;
  language: string;
  isDefault: boolean;
  /** Nanoseconds the decoder output leads the timestamps by (Opus pre-skip). */
  codecDelay: number;
  codec: AudioCodec | null;
}

export interface MkvHeader {
  /** Nanoseconds per timestamp unit. */
  timestampScale: number;
  /** Seconds, or 0 when the file does not say. */
  duration: number;
  tracks: MkvTrack[];
  /** Cluster positions by time, from Cues or from a walk. */
  cues: Array<{ time: number; position: number }>;
  /** Absolute offset of the Segment data, which cue positions are relative to. */
  segmentStart: number;
  /** Where the first Cluster begins. */
  firstCluster: number;
  /** End of the segment data, or null when the size is unknown. */
  segmentEnd: number | null;
}

/** Read the segment header: Info, Tracks, Cues (via SeekHead) and the first cluster. */
export async function readHeader(r: Reader): Promise<MkvHeader | null> {
  const head = await r.read(0, 4);
  if (be.u32(head, 0) !== ID.EBML) return null;
  let p = 0;
  const ebml = element(await r.read(0, 16), 0);
  if (!ebml) return null;
  p = ebml.start + ebml.size;
  const seg = element(await r.read(p, p + 16), 0);
  if (!seg || seg.id !== ID.Segment) return null;
  const segmentStart = p + seg.start;
  const segmentEnd = seg.size === UNKNOWN ? null : segmentStart + seg.size;

  const out: MkvHeader = {
    timestampScale: 1_000_000,
    duration: 0,
    tracks: [],
    cues: [],
    segmentStart,
    firstCluster: -1,
    segmentEnd,
  };
  let cuesAt = -1;
  p = segmentStart;
  // Walk the top level until the first cluster. Everything before it is small.
  for (let guard = 0; guard < 64; guard++) {
    const hdr = await r.read(p, p + 16);
    if (hdr.length < 2) break;
    const e = element(hdr, 0);
    if (!e) break;
    const dataStart = p + e.start;
    if (e.id === ID.Cluster) {
      out.firstCluster = p;
      break;
    }
    if (e.size === UNKNOWN) break;
    const data = await r.read(dataStart, dataStart + e.size);
    if (e.id === ID.SeekHead) {
      for (const seek of elements(data).filter((c) => c.id === ID.Seek)) {
        let id = 0;
        let pos = -1;
        for (const c of elements(data, seek.start, seek.start + seek.size)) {
          if (c.id === ID.SeekID) id = uint(data, c);
          if (c.id === ID.SeekPosition) pos = uint(data, c);
        }
        if (id === ID.Cues && pos >= 0) cuesAt = segmentStart + pos;
      }
    } else if (e.id === ID.Info) {
      let dur = 0;
      for (const c of elements(data)) {
        if (c.id === ID.TimestampScale) out.timestampScale = uint(data, c);
        if (c.id === ID.Duration) dur = float(data, c);
      }
      out.duration = (dur * out.timestampScale) / 1e9;
    } else if (e.id === ID.Tracks) {
      for (const te of elements(data).filter((c) => c.id === ID.TrackEntry)) {
        out.tracks.push(parseTrack(data, te));
      }
    } else if (e.id === ID.Cues) {
      out.cues = parseCues(data);
    }
    p = dataStart + e.size;
  }
  if (out.cues.length === 0 && cuesAt >= 0) {
    const hdr = await r.read(cuesAt, cuesAt + 16);
    const e = element(hdr, 0);
    if (e && e.id === ID.Cues && e.size !== UNKNOWN) {
      const data = await r.read(cuesAt + e.start, cuesAt + e.start + e.size);
      out.cues = parseCues(data);
    }
  }
  return out;
}

function parseTrack(u8: Uint8Array, te: Element): MkvTrack {
  const t: MkvTrack = {
    number: 0,
    type: 0,
    codecId: '',
    codecPrivate: null,
    sampleRate: 48000,
    channels: 2,
    language: 'und',
    isDefault: true,
    codecDelay: 0,
    codec: null,
  };
  let outputRate = 0;
  for (const c of elements(u8, te.start, te.start + te.size)) {
    switch (c.id) {
      case ID.TrackNumber:
        t.number = uint(u8, c);
        break;
      case ID.TrackType:
        t.type = uint(u8, c);
        break;
      case ID.CodecID:
        t.codecId = text(u8, c);
        break;
      case ID.CodecPrivate:
        t.codecPrivate = u8.slice(c.start, c.start + c.size);
        break;
      case ID.CodecDelay:
        t.codecDelay = uint(u8, c);
        break;
      case ID.Language:
        t.language = text(u8, c);
        break;
      case ID.LanguageBCP47:
        t.language = text(u8, c);
        break;
      case ID.FlagDefault:
        t.isDefault = uint(u8, c) !== 0;
        break;
      case ID.Audio:
        for (const a of elements(u8, c.start, c.start + c.size)) {
          if (a.id === ID.SamplingFrequency) t.sampleRate = float(u8, a);
          if (a.id === ID.OutputSamplingFrequency) outputRate = float(u8, a);
          if (a.id === ID.Channels) t.channels = uint(u8, a);
        }
        break;
    }
  }
  if (t.type === 2) t.codec = codecOf(t, outputRate);
  return t;
}

function codecOf(t: MkvTrack, outputRate: number): AudioCodec {
  const base = { sampleRate: outputRate || t.sampleRate, channels: t.channels };
  const id = t.codecId;
  if (id.startsWith('A_AAC')) {
    if (t.codecPrivate && t.codecPrivate.length >= 2) {
      const cfg = parseAacConfig(t.codecPrivate);
      return {
        kind: 'aac',
        codec: cfg.codec,
        sampleRate: cfg.sampleRate || base.sampleRate,
        channels: cfg.channels || base.channels,
        description: t.codecPrivate,
      };
    }
    return { kind: 'aac', codec: 'mp4a.40.2', ...base };
  }
  if (id === 'A_OPUS') {
    return {
      kind: 'opus',
      codec: 'opus',
      sampleRate: 48000,
      channels: base.channels,
      ...(t.codecPrivate ? { description: t.codecPrivate } : {}),
    };
  }
  if (id === 'A_VORBIS') {
    return {
      kind: 'vorbis',
      codec: 'vorbis',
      ...base,
      ...(t.codecPrivate ? { description: t.codecPrivate } : {}),
    };
  }
  if (id === 'A_FLAC') {
    return {
      kind: 'flac',
      codec: 'flac',
      ...base,
      ...(t.codecPrivate ? { description: t.codecPrivate } : {}),
    };
  }
  if (id === 'A_MPEG/L3') return { kind: 'mp3', codec: 'mp3', ...base };
  if (id === 'A_AC3' || id === 'A_AC3/BSID9' || id === 'A_AC3/BSID10') {
    return { kind: 'ac3', codec: 'ac-3', ...base };
  }
  if (id === 'A_EAC3') return { kind: 'eac3', codec: 'ec-3', ...base };
  if (id.startsWith('A_DTS')) return { kind: 'dts', codec: 'dts', ...base };
  if (id === 'A_ALAC') return { kind: 'alac', codec: 'alac', ...base };
  if (id.startsWith('A_PCM')) return { kind: 'pcm', codec: id, ...base };
  return { kind: 'unknown', codec: id, ...base };
}

function parseCues(u8: Uint8Array): MkvHeader['cues'] {
  const out: MkvHeader['cues'] = [];
  for (const cp of elements(u8).filter((c) => c.id === ID.CuePoint)) {
    let time = 0;
    let position = -1;
    for (const c of elements(u8, cp.start, cp.start + cp.size)) {
      if (c.id === ID.CueTime) time = uint(u8, c);
      if (c.id === ID.CueTrackPositions) {
        for (const d of elements(u8, c.start, c.start + c.size)) {
          if (d.id === ID.CueClusterPosition && position < 0) position = uint(u8, d);
        }
      }
    }
    if (position >= 0) out.push({ time, position });
  }
  return out;
}

export interface MkvBlock {
  track: number;
  /** Absolute time in timestamp units (cluster time plus the block's offset). */
  time: number;
  frames: Uint8Array[];
}

/**
 * The blocks of one cluster whose data starts at `start` in `u8`. For an
 * unknown-sized cluster, reads until the next top-level element or the end.
 */
export function parseCluster(
  u8: Uint8Array,
  cluster: Element,
): { time: number; blocks: MkvBlock[]; end: number } {
  const end =
    cluster.size === UNKNOWN ? u8.length : Math.min(u8.length, cluster.start + cluster.size);
  const blocks: MkvBlock[] = [];
  let time = 0;
  let p = cluster.start;
  while (p < end) {
    const e = element(u8, p);
    if (!e) break;
    if (cluster.size === UNKNOWN && (e.id === ID.Cluster || e.id === ID.Cues)) break;
    if (e.size === UNKNOWN) break;
    if (e.id === ID.Timestamp) time = uint(u8, e);
    else if (e.id === ID.SimpleBlock) {
      const b = parseBlock(u8, e, time);
      if (b) blocks.push(b);
    } else if (e.id === ID.BlockGroup) {
      for (const c of elements(u8, e.start, e.start + e.size)) {
        if (c.id === ID.Block) {
          const b = parseBlock(u8, c, time);
          if (b) blocks.push(b);
        }
      }
    }
    p = e.start + e.size;
  }
  return { time, blocks, end: p };
}

function parseBlock(u8: Uint8Array, e: Element, clusterTime: number): MkvBlock | null {
  const tn = vint(u8, e.start, false);
  if (!tn.length) return null;
  let p = e.start + tn.length;
  const rel = ((u8[p] ?? 0) << 8) | (u8[p + 1] ?? 0);
  const offset = rel >= 0x8000 ? rel - 0x10000 : rel;
  const flags = u8[p + 2] ?? 0;
  p += 3;
  const end = e.start + e.size;
  const lacing = (flags >> 1) & 3;
  const frames: Uint8Array[] = [];
  if (lacing === 0) frames.push(u8.subarray(p, end));
  else {
    const count = (u8[p] ?? 0) + 1;
    p++;
    const sizes: number[] = [];
    if (lacing === 2) {
      const each = Math.floor((end - p) / count);
      for (let i = 0; i < count; i++) sizes.push(each);
    } else if (lacing === 1) {
      let total = 0;
      for (let i = 0; i < count - 1; i++) {
        let s = 0;
        let b: number;
        do {
          b = u8[p++] ?? 0;
          s += b;
        } while (b === 0xff);
        sizes.push(s);
        total += s;
      }
      sizes.push(end - p - total);
    } else {
      const first = vint(u8, p, false);
      p += first.length;
      let last = first.value;
      sizes.push(last);
      let total = last;
      for (let i = 1; i < count - 1; i++) {
        const v = vint(u8, p, false);
        p += v.length;
        // Signed: the raw value minus the midpoint of its range.
        const bias = 2 ** (7 * v.length - 1) - 1;
        last += v.value - bias;
        sizes.push(last);
        total += last;
      }
      sizes.push(end - p - total);
    }
    for (const s of sizes) {
      frames.push(u8.subarray(p, p + s));
      p += s;
    }
  }
  return { track: tn.value, time: clusterTime + offset, frames };
}

/** The cluster whose cue time is the last at or before `t` seconds. */
export function clusterFor(h: MkvHeader, t: number): number {
  const units = (t * 1e9) / h.timestampScale;
  let pos = h.firstCluster;
  for (const c of h.cues) {
    if (c.time <= units) pos = h.segmentStart + c.position;
    else break;
  }
  return pos;
}

/** Blocks of `track` from a cluster, as decoder chunks with times in seconds. */
export function chunksOfCluster(
  h: MkvHeader,
  track: MkvTrack,
  cluster: ReturnType<typeof parseCluster>,
): EncodedChunk[] {
  const out: EncodedChunk[] = [];
  const scale = h.timestampScale / 1e9;
  for (const b of cluster.blocks) {
    if (b.track !== track.number) continue;
    // Laced frames share one timestamp; the decoder takes them in order.
    const ts = b.time * scale - track.codecDelay / 1e9;
    for (const f of b.frames) out.push({ ts, dur: 0, data: f });
  }
  return out;
}

/** The audio track to transcribe. The default-flagged one, by language if asked. */
export function pickAudio(h: MkvHeader, language?: string): MkvTrack | null {
  const audio = h.tracks.filter((t) => t.type === 2 && t.codec);
  if (language) {
    const want = audio.find((t) => t.language.toLowerCase().startsWith(language.slice(0, 2)));
    if (want) return want;
  }
  return audio.find((t) => t.isDefault) ?? audio[0] ?? null;
}

export { ID as EBML_ID, UNKNOWN as EBML_UNKNOWN };
