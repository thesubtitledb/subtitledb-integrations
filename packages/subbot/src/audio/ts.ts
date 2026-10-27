/**
 * MPEG-TS, as HLS ships it: 188-byte packets, a PAT, one PMT, and audio in PES
 * packets whose payload is a run of ADTS frames (AAC) or raw AC-3 syncframes.
 *
 * Stateful across calls so a PES packet cut at a segment boundary is finished by the
 * next segment. The output is codec config and frames with presentation times from
 * the PTS, which is what the decoder wants.
 */
import { AAC_RATES, type AudioCodec, aacConfig, type EncodedChunk } from './codec.js';

interface Pes {
  pts: number | null;
  parts: Uint8Array[];
}

export class TsDemuxer {
  codec: AudioCodec | null = null;
  private pmtPid = -1;
  private audioPid = -1;
  private streamType = 0;
  private pes: Pes | null = null;
  private tail: Uint8Array | null = null;

  /** Feed one segment (or any run of packets). Returns the audio frames it completed. */
  push(bytes: Uint8Array): EncodedChunk[] {
    let u8 = bytes;
    if (this.tail) {
      const joined = new Uint8Array(this.tail.length + bytes.length);
      joined.set(this.tail);
      joined.set(bytes, this.tail.length);
      u8 = joined;
      this.tail = null;
    }
    const out: EncodedChunk[] = [];
    let p = 0;
    // Resync on the first 0x47 that is followed by another one packet later.
    while (
      p + 188 <= u8.length &&
      !(u8[p] === 0x47 && (p + 188 >= u8.length || u8[p + 188] === 0x47))
    )
      p++;
    for (; p + 188 <= u8.length; p += 188) {
      if (u8[p] !== 0x47) continue;
      const pid = (((u8[p + 1] ?? 0) & 0x1f) << 8) | (u8[p + 2] ?? 0);
      const start = ((u8[p + 1] ?? 0) & 0x40) !== 0;
      const afc = ((u8[p + 3] ?? 0) >> 4) & 3;
      let q = p + 4;
      if (afc & 2) q += 1 + (u8[q] ?? 0);
      if (!(afc & 1) || q >= p + 188) continue;
      const payload = u8.subarray(q, p + 188);

      if (pid === 0) this.pat(payload, start);
      else if (pid === this.pmtPid) this.pmt(payload, start);
      else if (pid === this.audioPid) {
        if (start) {
          this.flush(out);
          this.pes = { pts: null, parts: [] };
          const pes = this.pesHeader(payload);
          if (pes) {
            this.pes.pts = pes.pts;
            this.pes.parts.push(payload.subarray(pes.body));
          }
        } else this.pes?.parts.push(payload);
      }
    }
    if (p < u8.length) this.tail = u8.slice(p);
    return out;
  }

  /** Finish whatever PES packet is open. Call at the end of the stream. */
  end(): EncodedChunk[] {
    const out: EncodedChunk[] = [];
    this.flush(out);
    return out;
  }

  private section(payload: Uint8Array, start: boolean): Uint8Array | null {
    if (!start) return null;
    const pointer = payload[0] ?? 0;
    return payload.subarray(1 + pointer);
  }

  private pat(payload: Uint8Array, start: boolean): void {
    const s = this.section(payload, start);
    if (s?.[0] !== 0x00) return;
    const len = (((s[1] ?? 0) & 0x0f) << 8) | (s[2] ?? 0);
    for (let p = 8; p + 4 <= 3 + len - 4; p += 4) {
      const program = ((s[p] ?? 0) << 8) | (s[p + 1] ?? 0);
      const pid = (((s[p + 2] ?? 0) & 0x1f) << 8) | (s[p + 3] ?? 0);
      if (program !== 0) {
        this.pmtPid = pid;
        return;
      }
    }
  }

  private pmt(payload: Uint8Array, start: boolean): void {
    const s = this.section(payload, start);
    if (s?.[0] !== 0x02 || this.audioPid >= 0) return;
    const len = (((s[1] ?? 0) & 0x0f) << 8) | (s[2] ?? 0);
    const end = 3 + len - 4;
    const infoLen = (((s[10] ?? 0) & 0x0f) << 8) | (s[11] ?? 0);
    let p = 12 + infoLen;
    let best: { pid: number; type: number; rank: number } | null = null;
    while (p + 5 <= end) {
      const type = s[p] ?? 0;
      const pid = (((s[p + 1] ?? 0) & 0x1f) << 8) | (s[p + 2] ?? 0);
      const esLen = (((s[p + 3] ?? 0) & 0x0f) << 8) | (s[p + 4] ?? 0);
      const desc = s.subarray(p + 5, p + 5 + esLen);
      p += 5 + esLen;
      // 0x0f ADTS AAC, 0x03/0x04 MPEG audio, 0x81 AC-3, 0x87 E-AC-3; 0x06 is private
      // data, which DVB uses for AC-3 with an AC-3 descriptor (tag 0x6a).
      let rank = 0;
      let kind = type;
      if (type === 0x0f) rank = 3;
      else if (type === 0x03 || type === 0x04) rank = 2;
      else if (type === 0x81 || type === 0x87) rank = 1;
      else if (type === 0x06 && hasDescriptor(desc, 0x6a)) {
        rank = 1;
        kind = 0x81;
      } else if (type === 0x06 && hasDescriptor(desc, 0x7a)) {
        rank = 1;
        kind = 0x87;
      }
      if (rank && (!best || rank > best.rank)) best = { pid, type: kind, rank };
    }
    if (best) {
      this.audioPid = best.pid;
      this.streamType = best.type;
    }
  }

  private pesHeader(payload: Uint8Array): { pts: number | null; body: number } | null {
    if (payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) return null;
    const flags = payload[7] ?? 0;
    const headerLen = payload[8] ?? 0;
    let pts: number | null = null;
    if (flags & 0x80) {
      const b = payload;
      pts =
        (((b[9] ?? 0) >> 1) & 7) * 0x40000000 +
        ((((b[10] ?? 0) << 7) | ((b[11] ?? 0) >> 1)) << 15) +
        (((b[12] ?? 0) << 7) | ((b[13] ?? 0) >> 1));
    }
    return { pts, body: 9 + headerLen };
  }

  private flush(out: EncodedChunk[]): void {
    const pes = this.pes;
    this.pes = null;
    if (!pes || pes.parts.length === 0) return;
    let total = 0;
    for (const part of pes.parts) total += part.length;
    const data = new Uint8Array(total);
    let o = 0;
    for (const part of pes.parts) {
      data.set(part, o);
      o += part.length;
    }
    const pts = (pes.pts ?? 0) / 90000;
    if (this.streamType === 0x0f) this.adts(data, pts, out);
    else if (this.streamType === 0x03 || this.streamType === 0x04) this.mpegAudio(data, pts, out);
    else this.ac3(data, pts, out, this.streamType === 0x87);
  }

  private adts(data: Uint8Array, pts: number, out: EncodedChunk[]): void {
    let p = 0;
    let n = 0;
    while (p + 7 <= data.length) {
      if (data[p] !== 0xff || ((data[p + 1] ?? 0) & 0xf6) !== 0xf0) {
        p++;
        continue;
      }
      const protectionAbsent = (data[p + 1] ?? 0) & 1;
      const profile = ((data[p + 2] ?? 0) >> 6) & 3;
      const freqIndex = ((data[p + 2] ?? 0) >> 2) & 0x0f;
      const channelConfig = (((data[p + 2] ?? 0) & 1) << 2) | ((data[p + 3] ?? 0) >> 6);
      const frameLen =
        (((data[p + 3] ?? 0) & 3) << 11) | ((data[p + 4] ?? 0) << 3) | ((data[p + 5] ?? 0) >> 5);
      const head = protectionAbsent ? 7 : 9;
      if (frameLen < head || p + frameLen > data.length) break;
      const sampleRate = AAC_RATES[freqIndex] ?? 48000;
      if (!this.codec) {
        this.codec = {
          kind: 'aac',
          codec: `mp4a.40.${profile + 1}`,
          sampleRate,
          channels: channelConfig === 7 ? 8 : channelConfig,
          description: aacConfig(profile + 1, freqIndex, channelConfig),
        };
      }
      out.push({
        ts: pts + (n * 1024) / sampleRate,
        dur: 1024 / sampleRate,
        data: data.subarray(p + head, p + frameLen),
      });
      n++;
      p += frameLen;
    }
  }

  private mpegAudio(data: Uint8Array, pts: number, out: EncodedChunk[]): void {
    // Hand the PES payload over whole: a WebCodecs mp3 decoder takes a run of frames.
    if (!this.codec) this.codec = { kind: 'mp3', codec: 'mp3', sampleRate: 44100, channels: 2 };
    out.push({ ts: pts, dur: 0, data });
  }

  private ac3(data: Uint8Array, pts: number, out: EncodedChunk[], eac3: boolean): void {
    if (!this.codec) {
      this.codec = {
        kind: eac3 ? 'eac3' : 'ac3',
        codec: eac3 ? 'ec-3' : 'ac-3',
        sampleRate: 48000,
        channels: 6,
      };
    }
    out.push({ ts: pts, dur: 0, data });
  }
}

function hasDescriptor(desc: Uint8Array, tag: number): boolean {
  for (let p = 0; p + 2 <= desc.length; p += 2 + (desc[p + 1] ?? 0)) {
    if (desc[p] === tag) return true;
  }
  return false;
}
