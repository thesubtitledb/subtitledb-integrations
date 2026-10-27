/**
 * What the decoder needs to know about an audio track, whichever container it came
 * from. `codec` is the WebCodecs string; `description` is the codec's own config
 * record (AudioSpecificConfig, OpusHead, the FLAC STREAMINFO block) where one exists.
 */
export type CodecKind =
  | 'aac'
  | 'opus'
  | 'flac'
  | 'mp3'
  | 'vorbis'
  | 'ac3'
  | 'eac3'
  | 'alac'
  | 'pcm'
  | 'dts'
  | 'unknown';

export interface AudioCodec {
  kind: CodecKind;
  codec: string;
  sampleRate: number;
  channels: number;
  description?: Uint8Array;
}

/** One compressed frame, or a run of them, with its presentation time in seconds. */
export interface EncodedChunk {
  ts: number;
  dur: number;
  data: Uint8Array;
}

/** AudioSpecificConfig, the two bytes most AAC streams are described by. */
export function aacConfig(
  objectType: number,
  freqIndex: number,
  channelConfig: number,
): Uint8Array {
  const v = ((objectType & 0x1f) << 11) | ((freqIndex & 0x0f) << 7) | ((channelConfig & 0x0f) << 3);
  return new Uint8Array([v >> 8, v & 0xff]);
}

export const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

/** Read an AudioSpecificConfig back: sample rate, channels and the WebCodecs codec string. */
export function parseAacConfig(d: Uint8Array): {
  codec: string;
  sampleRate: number;
  channels: number;
} {
  let objectType = (d[0] ?? 0) >> 3;
  let pos = 5;
  const bit = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++, pos++) {
      v = (v << 1) | (((d[pos >> 3] ?? 0) >> (7 - (pos & 7))) & 1);
    }
    return v;
  };
  if (objectType === 31) objectType = 32 + bit(6);
  let freqIndex = bit(4);
  let sampleRate = freqIndex === 15 ? bit(24) : (AAC_RATES[freqIndex] ?? 0);
  const channels = bit(4);
  // Explicit SBR signalling: the extension rate is what comes out of the decoder.
  if (objectType === 5 || objectType === 29) {
    freqIndex = bit(4);
    sampleRate = freqIndex === 15 ? bit(24) : (AAC_RATES[freqIndex] ?? sampleRate);
  }
  return { codec: `mp4a.40.${objectType}`, sampleRate, channels: channels === 7 ? 8 : channels };
}
