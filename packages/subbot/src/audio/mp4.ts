/**
 * ISO BMFF: enough of it to find the audio track and hand its frames to a decoder.
 *
 * Two shapes. A flat file (`moov` with a full sample table, one `mdat`) is read by
 * byte range: the table says where every frame is, so a window of audio is one or two
 * Range requests. A fragmented file (`moof` + `mdat` segments, which is every HLS and
 * DASH stream) is read a segment at a time, with the `moov` init segment giving the
 * codec and the `moof` giving each segment's frame offsets and times.
 *
 * Nothing here decodes. The output is codec config and encoded frames with times.
 */
import { be } from './bytes.js';
import { type AudioCodec, type EncodedChunk, parseAacConfig } from './codec.js';

export interface Box {
  type: string;
  start: number;
  size: number;
  /** Header length: 8, or 16 with a 64-bit size. */
  head: number;
  end: number;
}

/** The boxes laid end to end in `[start, end)`. */
export function boxes(u8: Uint8Array, start = 0, end = u8.length): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = be.u32(u8, p);
    const type = be.fourcc(u8, p + 4);
    let head = 8;
    if (size === 1) {
      size = be.u64(u8, p + 8);
      head = 16;
    } else if (size === 0) size = end - p;
    if (size < head) break;
    out.push({ type, start: p, size, head, end: Math.min(p + size, end) });
    p += size;
  }
  return out;
}

export function children(u8: Uint8Array, b: Box, skip = 0): Box[] {
  return boxes(u8, b.start + b.head + skip, b.end);
}

export function child(u8: Uint8Array, b: Box, type: string, skip = 0): Box | undefined {
  return children(u8, b, skip).find((c) => c.type === type);
}

/** The header of a full box: version, flags and where the body starts. */
function full(u8: Uint8Array, b: Box): { version: number; flags: number; body: number } {
  const p = b.start + b.head;
  return { version: u8[p] ?? 0, flags: be.u24(u8, p + 1), body: p + 4 };
}

export interface Mp4Sample {
  offset: number;
  size: number;
  /** Decode time in the track's timescale. */
  dts: number;
  dur: number;
}

export interface Mp4Track {
  id: number;
  handler: string;
  timescale: number;
  /** In the track timescale; 0 when unknown (fragmented files often say so). */
  duration: number;
  language: string;
  codec: AudioCodec | null;
  samples: Mp4Sample[];
  /** Media time the presentation starts at, from the edit list. AAC priming, usually. */
  editOffset: number;
  trex?: { dur: number; size: number; flags: number };
}

export interface Movie {
  timescale: number;
  duration: number;
  tracks: Mp4Track[];
}

/** Parse a `moov` box. `u8` must hold the whole box at `moov.start`. */
export function parseMoov(u8: Uint8Array, moov: Box): Movie {
  const movie: Movie = { timescale: 1000, duration: 0, tracks: [] };
  const mvhd = child(u8, moov, 'mvhd');
  if (mvhd) {
    const { version, body } = full(u8, mvhd);
    movie.timescale = version === 1 ? be.u32(u8, body + 16) : be.u32(u8, body + 8);
    movie.duration = version === 1 ? be.u64(u8, body + 20) : be.u32(u8, body + 12);
  }
  const trexes = new Map<number, Mp4Track['trex']>();
  const mvex = child(u8, moov, 'mvex');
  if (mvex) {
    for (const trex of children(u8, mvex).filter((c) => c.type === 'trex')) {
      const { body } = full(u8, trex);
      trexes.set(be.u32(u8, body), {
        dur: be.u32(u8, body + 8),
        size: be.u32(u8, body + 12),
        flags: be.u32(u8, body + 16),
      });
    }
  }
  for (const trak of children(u8, moov).filter((c) => c.type === 'trak')) {
    const t = parseTrak(u8, trak);
    if (!t) continue;
    const trex = trexes.get(t.id);
    if (trex) t.trex = trex;
    movie.tracks.push(t);
  }
  return movie;
}

function parseTrak(u8: Uint8Array, trak: Box): Mp4Track | null {
  const tkhd = child(u8, trak, 'tkhd');
  const mdia = child(u8, trak, 'mdia');
  if (!tkhd || !mdia) return null;
  const tk = full(u8, tkhd);
  const id = tk.version === 1 ? be.u32(u8, tk.body + 16) : be.u32(u8, tk.body + 8);

  const mdhd = child(u8, mdia, 'mdhd');
  const hdlr = child(u8, mdia, 'hdlr');
  const minf = child(u8, mdia, 'minf');
  if (!mdhd || !hdlr || !minf) return null;
  const mh = full(u8, mdhd);
  const timescale = mh.version === 1 ? be.u32(u8, mh.body + 16) : be.u32(u8, mh.body + 8);
  const duration = mh.version === 1 ? be.u64(u8, mh.body + 20) : be.u32(u8, mh.body + 12);
  const langBits = be.u16(u8, mh.body + (mh.version === 1 ? 28 : 20));
  const language =
    langBits === 0 || langBits === 0x7fff
      ? 'und'
      : String.fromCharCode(
          0x60 + ((langBits >> 10) & 0x1f),
          0x60 + ((langBits >> 5) & 0x1f),
          0x60 + (langBits & 0x1f),
        );
  const handler = be.fourcc(u8, full(u8, hdlr).body + 4);

  const stbl = child(u8, minf, 'stbl');
  if (!stbl) return null;
  const stsd = child(u8, stbl, 'stsd');
  const codec = handler === 'soun' && stsd ? parseStsd(u8, stsd) : null;

  let editOffset = 0;
  const edts = child(u8, trak, 'edts');
  const elst = edts && child(u8, edts, 'elst');
  if (elst) {
    const { version, body } = full(u8, elst);
    const n = be.u32(u8, body);
    let p = body + 4;
    for (let i = 0; i < n; i++) {
      const mediaTime = version === 1 ? be.u64(u8, p + 8) : be.i32(u8, p + 4);
      p += version === 1 ? 20 : 12;
      // An empty edit (-1) is a delay before the media; the first real entry's media
      // time is where the presentation starts inside it.
      if (mediaTime >= 0) {
        editOffset = mediaTime;
        break;
      }
    }
  }

  return {
    id,
    handler,
    timescale,
    duration,
    language,
    codec,
    samples: sampleTable(u8, stbl),
    editOffset,
  };
}

/** The first sample entry of an `stsd`, read as audio. */
function parseStsd(u8: Uint8Array, stsd: Box): AudioCodec | null {
  const { body } = full(u8, stsd);
  const entry = boxes(u8, body + 4, stsd.end)[0];
  if (!entry) return null;
  // SampleEntry (8 bytes of reserved and data_reference_index), then the
  // AudioSampleEntry: version, revision, vendor, channelcount, samplesize,
  // compression id, packet size, samplerate as 16.16. Version 1 appends four more
  // 32-bit fields before the child boxes.
  const a = entry.start + entry.head + 8;
  const version = be.u16(u8, a);
  const channels = be.u16(u8, a + 8);
  const sampleRate = be.u16(u8, a + 16);
  const kids = boxes(u8, a + 20 + (version === 1 ? 16 : version === 2 ? 56 : 0), entry.end);
  const kid = (type: string) => kids.find((k) => k.type === type);
  const base = { sampleRate: sampleRate || 48000, channels: channels || 2 };

  switch (entry.type) {
    case 'mp4a': {
      const esds = kid('esds');
      const es = esds ? parseEsds(u8, esds) : null;
      if (es?.oti === 0x6b || es?.oti === 0x69) return { kind: 'mp3', codec: 'mp3', ...base };
      if (es?.config && es.config.length >= 2) {
        const cfg = parseAacConfig(es.config);
        return {
          kind: 'aac',
          codec: cfg.codec,
          sampleRate: cfg.sampleRate || base.sampleRate,
          channels: cfg.channels || base.channels,
          description: es.config,
        };
      }
      return { kind: 'aac', codec: 'mp4a.40.2', ...base };
    }
    case 'Opus': {
      const dops = kid('dOps');
      return {
        kind: 'opus',
        codec: 'opus',
        sampleRate: 48000,
        channels: base.channels,
        ...(dops ? { description: opusHead(u8, dops) } : {}),
      };
    }
    case 'fLaC': {
      const dfla = kid('dfLa');
      if (!dfla) return { kind: 'flac', codec: 'flac', ...base };
      const blocks = u8.subarray(full(u8, dfla).body, dfla.end);
      const description = new Uint8Array(4 + blocks.length);
      description.set([0x66, 0x4c, 0x61, 0x43]);
      description.set(blocks, 4);
      return { kind: 'flac', codec: 'flac', ...base, description };
    }
    case '.mp3':
    case 'mp3 ':
      return { kind: 'mp3', codec: 'mp3', ...base };
    case 'ac-3':
      return { kind: 'ac3', codec: 'ac-3', ...base };
    case 'ec-3':
      return { kind: 'eac3', codec: 'ec-3', ...base };
    case 'alac':
      return { kind: 'alac', codec: 'alac', ...base };
    case 'dtsc':
    case 'dtsh':
    case 'dtsl':
    case 'dtse':
      return { kind: 'dts', codec: entry.type, ...base };
    case 'lpcm':
    case 'sowt':
    case 'twos':
      return { kind: 'pcm', codec: entry.type, ...base };
    default:
      return { kind: 'unknown', codec: entry.type, ...base };
  }
}

/** MPEG-4 descriptors: expandable lengths, three nested tags, the config at the end. */
function parseEsds(u8: Uint8Array, esds: Box): { oti: number; config: Uint8Array | null } | null {
  let p = full(u8, esds).body;
  const end = esds.end;
  const tag = (want: number): number => {
    if (u8[p] !== want) return -1;
    p++;
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const b = u8[p++] ?? 0;
      len = (len << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return len;
  };
  if (tag(0x03) < 0) return null;
  const flags = u8[p + 2] ?? 0;
  p += 3;
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + (u8[p] ?? 0);
  if (flags & 0x20) p += 2;
  if (tag(0x04) < 0) return null;
  const oti = u8[p] ?? 0;
  p += 13;
  const len = tag(0x05);
  if (len < 0 || p + len > end) return { oti, config: null };
  return { oti, config: u8.slice(p, p + len) };
}

/** `dOps` is big-endian; the OpusHead a decoder wants is the same fields little-endian. */
function opusHead(u8: Uint8Array, dops: Box): Uint8Array {
  const p = dops.start + dops.head;
  const channels = u8[p + 1] ?? 2;
  const preSkip = be.u16(u8, p + 2);
  const rate = be.u32(u8, p + 4);
  const gain = be.u16(u8, p + 8);
  const family = u8[p + 10] ?? 0;
  const mapping = family === 0 ? new Uint8Array(0) : u8.subarray(p + 11, dops.end);
  const out = new Uint8Array(19 + mapping.length);
  out.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, channels]);
  out[10] = preSkip & 0xff;
  out[11] = preSkip >> 8;
  out[12] = rate & 0xff;
  out[13] = (rate >> 8) & 0xff;
  out[14] = (rate >> 16) & 0xff;
  out[15] = (rate >>> 24) & 0xff;
  out[16] = gain & 0xff;
  out[17] = gain >> 8;
  out[18] = family;
  out.set(mapping, 19);
  return out;
}

/** stts, stsc, stsz and stco/co64 folded into one flat list of samples. */
export function sampleTable(u8: Uint8Array, stbl: Box): Mp4Sample[] {
  const stts = child(u8, stbl, 'stts');
  const stsc = child(u8, stbl, 'stsc');
  const stsz = child(u8, stbl, 'stsz') ?? child(u8, stbl, 'stz2');
  const stco = child(u8, stbl, 'stco') ?? child(u8, stbl, 'co64');
  if (!stts || !stsc || !stsz || !stco) return [];

  const durations: number[] = [];
  {
    const { body } = full(u8, stts);
    const n = be.u32(u8, body);
    for (let i = 0, p = body + 4; i < n; i++, p += 8) {
      const count = be.u32(u8, p);
      const delta = be.u32(u8, p + 4);
      for (let k = 0; k < count; k++) durations.push(delta);
    }
  }
  const sizes: number[] = [];
  {
    const { body } = full(u8, stsz);
    const fixed = stsz.type === 'stsz' ? be.u32(u8, body) : 0;
    const n = be.u32(u8, body + 4);
    if (fixed) for (let i = 0; i < n; i++) sizes.push(fixed);
    else if (stsz.type === 'stsz')
      for (let i = 0; i < n; i++) sizes.push(be.u32(u8, body + 8 + i * 4));
    else {
      const bits = u8[body + 3] ?? 8;
      for (let i = 0; i < n; i++) {
        const p = body + 4 + Math.floor((i * bits) / 8);
        sizes.push(
          bits === 16
            ? be.u16(u8, p)
            : bits === 8
              ? (u8[p] ?? 0)
              : i % 2
                ? (u8[p] ?? 0) & 0x0f
                : (u8[p] ?? 0) >> 4,
        );
      }
    }
  }
  const offsets: number[] = [];
  {
    const { body } = full(u8, stco);
    const n = be.u32(u8, body);
    for (let i = 0; i < n; i++) {
      offsets.push(
        stco.type === 'co64' ? be.u64(u8, body + 4 + i * 8) : be.u32(u8, body + 4 + i * 4),
      );
    }
  }
  const runs: Array<{ first: number; per: number }> = [];
  {
    const { body } = full(u8, stsc);
    const n = be.u32(u8, body);
    for (let i = 0, p = body + 4; i < n; i++, p += 12) {
      runs.push({ first: be.u32(u8, p), per: be.u32(u8, p + 4) });
    }
  }

  const samples: Mp4Sample[] = [];
  let dts = 0;
  let s = 0;
  // stsc runs are in chunk order, so one pass steps through them. A scan per chunk
  // took ~40 s on a 74 min file with a run for every one of its 132k chunks.
  let run = 0;
  for (let c = 0; c < offsets.length && s < sizes.length; c++) {
    while ((runs[run + 1]?.first ?? Infinity) <= c + 1) run++;
    const r = runs[run];
    const per = r && r.first <= c + 1 ? r.per : 0;
    let offset = offsets[c] ?? 0;
    for (let k = 0; k < per && s < sizes.length; k++, s++) {
      const size = sizes[s] ?? 0;
      const dur = durations[s] ?? durations[durations.length - 1] ?? 0;
      samples.push({ offset, size, dts, dur });
      offset += size;
      dts += dur;
    }
  }
  return samples;
}

export interface FragmentRun {
  trackId: number;
  samples: Mp4Sample[];
}

/**
 * The sample runs of one `moof`. Offsets are into `u8`, which must hold the `moof` and
 * the `mdat` that follows it, as every segment file does.
 */
export function parseMoof(u8: Uint8Array, moof: Box, tracks: Map<number, Mp4Track>): FragmentRun[] {
  const out: FragmentRun[] = [];
  for (const traf of children(u8, moof).filter((c) => c.type === 'traf')) {
    const tfhd = child(u8, traf, 'tfhd');
    if (!tfhd) continue;
    const th = full(u8, tfhd);
    const trackId = be.u32(u8, th.body);
    const track = tracks.get(trackId);
    let p = th.body + 4;
    let base = moof.start;
    if (th.flags & 0x1) {
      base = be.u64(u8, p);
      p += 8;
    }
    if (th.flags & 0x2) p += 4;
    let defDur = track?.trex?.dur ?? 0;
    let defSize = track?.trex?.size ?? 0;
    if (th.flags & 0x8) {
      defDur = be.u32(u8, p);
      p += 4;
    }
    if (th.flags & 0x10) {
      defSize = be.u32(u8, p);
      p += 4;
    }

    let dts = 0;
    const tfdt = child(u8, traf, 'tfdt');
    if (tfdt) {
      const td = full(u8, tfdt);
      dts = td.version === 1 ? be.u64(u8, td.body) : be.u32(u8, td.body);
    }

    const samples: Mp4Sample[] = [];
    for (const trun of children(u8, traf).filter((c) => c.type === 'trun')) {
      const tr = full(u8, trun);
      const n = be.u32(u8, tr.body);
      let q = tr.body + 4;
      let offset = base;
      if (tr.flags & 0x1) {
        offset += be.i32(u8, q);
        q += 4;
      }
      if (tr.flags & 0x4) q += 4;
      for (let i = 0; i < n; i++) {
        let dur = defDur;
        let size = defSize;
        if (tr.flags & 0x100) {
          dur = be.u32(u8, q);
          q += 4;
        }
        if (tr.flags & 0x200) {
          size = be.u32(u8, q);
          q += 4;
        }
        if (tr.flags & 0x400) q += 4;
        if (tr.flags & 0x800) q += 4;
        samples.push({ offset, size, dts, dur });
        offset += size;
        dts += dur;
      }
    }
    out.push({ trackId, samples });
  }
  return out;
}

export interface Sidx {
  timescale: number;
  earliest: number;
  /** Byte offset of the first referenced segment, from the end of the sidx box. */
  firstOffset: number;
  refs: Array<{ size: number; dur: number }>;
}

export function parseSidx(u8: Uint8Array, sidx: Box): Sidx {
  const { version, body } = full(u8, sidx);
  const timescale = be.u32(u8, body + 4);
  let p = body + 8;
  let earliest: number;
  let firstOffset: number;
  if (version === 1) {
    earliest = be.u64(u8, p);
    firstOffset = be.u64(u8, p + 8);
    p += 16;
  } else {
    earliest = be.u32(u8, p);
    firstOffset = be.u32(u8, p + 4);
    p += 8;
  }
  const n = be.u16(u8, p + 2);
  p += 4;
  const refs: Sidx['refs'] = [];
  for (let i = 0; i < n; i++, p += 12) {
    refs.push({ size: be.u32(u8, p) & 0x7fffffff, dur: be.u32(u8, p + 4) });
  }
  return { timescale, earliest, firstOffset, refs };
}

/** The audio track to transcribe: the first `soun` track with a codec, by language if asked. */
export function pickAudio(movie: Movie, language?: string): Mp4Track | null {
  const audio = movie.tracks.filter((t) => t.handler === 'soun' && t.codec);
  if (language) {
    const want = audio.find((t) => t.language.toLowerCase().startsWith(language.slice(0, 2)));
    if (want) return want;
  }
  return audio[0] ?? null;
}

/** Samples of a track whose decode time falls in `[t0, t1)` seconds. */
export function samplesBetween(track: Mp4Track, t0: number, t1: number): Mp4Sample[] {
  const a = Math.floor(t0 * track.timescale) + track.editOffset;
  const b = Math.ceil(t1 * track.timescale) + track.editOffset;
  const s = track.samples;
  // Binary search for the first sample at or after a; the table is in decode order.
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((s[mid]?.dts ?? 0) + (s[mid]?.dur ?? 0) <= a) lo = mid + 1;
    else hi = mid;
  }
  const out: Mp4Sample[] = [];
  for (let i = lo; i < s.length; i++) {
    const x = s[i] as Mp4Sample;
    if (x.dts >= b) break;
    out.push(x);
  }
  return out;
}

/** Samples turned into decoder chunks, reading their bytes out of `u8` at `base`. */
export function chunksOf(
  samples: Mp4Sample[],
  track: Pick<Mp4Track, 'timescale' | 'editOffset'>,
  u8: Uint8Array,
  base = 0,
): EncodedChunk[] {
  const out: EncodedChunk[] = [];
  for (const s of samples) {
    const start = s.offset - base;
    if (start < 0 || start + s.size > u8.length) continue;
    out.push({
      ts: (s.dts - track.editOffset) / track.timescale,
      dur: s.dur / track.timescale,
      data: u8.subarray(start, start + s.size),
    });
  }
  return out;
}

/**
 * Contiguous byte extents covering the samples, merging gaps under `slack` bytes. Each
 * extent is a request, and a request to a host like archive.org is a second or more,
 * while 256 KB more of it is a fraction of that: in a 6 Mbps file the audio sits
 * between ~100 KB runs of video, and a 6 s window was 40 requests at 64 KB.
 */
export function extents(samples: Mp4Sample[], slack = 256 * 1024): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const s of samples) {
    const last = out[out.length - 1];
    if (last && s.offset - last[1] <= slack && s.offset >= last[0]) {
      last[1] = Math.max(last[1], s.offset + s.size);
    } else out.push([s.offset, s.offset + s.size]);
  }
  return out;
}
