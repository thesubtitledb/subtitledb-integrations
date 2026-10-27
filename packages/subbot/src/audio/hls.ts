/**
 * HLS playlists. A master playlist names variants and audio renditions; a media
 * playlist lists segments with durations. Both are line formats, so this is a
 * tokeniser and not much else. URIs come back absolute.
 */
export interface HlsRendition {
  groupId: string;
  name: string;
  language: string | null;
  isDefault: boolean;
  uri: string | null;
}

export interface HlsVariant {
  uri: string;
  bandwidth: number;
  codecs: string | null;
  audioGroup: string | null;
}

export interface HlsSegment {
  uri: string;
  start: number;
  duration: number;
  byteRange: [number, number] | null;
  /** The init segment (fMP4), or null for TS. */
  map: { uri: string; byteRange: [number, number] | null } | null;
}

export type HlsPlaylist =
  | { kind: 'master'; variants: HlsVariant[]; audio: HlsRendition[] }
  | { kind: 'media'; segments: HlsSegment[]; endlist: boolean; targetDuration: number };

function attrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    out[m[1] as string] = m[3] ?? (m[2] as string);
  }
  return out;
}

function resolve(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

/** `n@o` byte ranges; an omitted offset continues from the previous segment. */
function byteRange(v: string | undefined, prevEnd: number): [number, number] | null {
  if (!v) return null;
  const m = /^(\d+)(?:@(\d+))?$/.exec(v.trim());
  if (!m) return null;
  const n = Number(m[1]);
  const o = m[2] !== undefined ? Number(m[2]) : prevEnd;
  return [o, o + n];
}

export function parseM3u8(text: string, baseUrl: string): HlsPlaylist {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants: HlsVariant[] = [];
    const audio: HlsRendition[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = attrs(line.slice(13));
        if (a.TYPE !== 'AUDIO') continue;
        audio.push({
          groupId: a['GROUP-ID'] ?? '',
          name: a.NAME ?? '',
          language: a.LANGUAGE ?? null,
          isDefault: a.DEFAULT === 'YES',
          uri: a.URI ? resolve(a.URI, baseUrl) : null,
        });
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
        const a = attrs(line.slice(18));
        const next = lines[i + 1];
        if (!next || next.startsWith('#')) continue;
        variants.push({
          uri: resolve(next, baseUrl),
          bandwidth: Number(a.BANDWIDTH ?? 0),
          codecs: a.CODECS ?? null,
          audioGroup: a.AUDIO ?? null,
        });
        i++;
      }
    }
    return { kind: 'master', variants, audio };
  }

  const segments: HlsSegment[] = [];
  let start = 0;
  let duration = 0;
  let map: HlsSegment['map'] = null;
  let range: string | undefined;
  let prevEnd = 0;
  let endlist = false;
  let targetDuration = 0;
  for (const line of lines) {
    if (line.startsWith('#EXTINF:')) {
      duration = Number.parseFloat(line.slice(8));
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      range = line.slice(17);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrs(line.slice(11));
      map = a.URI ? { uri: resolve(a.URI, baseUrl), byteRange: byteRange(a.BYTERANGE, 0) } : null;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.slice(22));
    } else if (line === '#EXT-X-ENDLIST') {
      endlist = true;
    } else if (!line.startsWith('#')) {
      const br = byteRange(range, prevEnd);
      segments.push({ uri: resolve(line, baseUrl), start, duration, byteRange: br, map });
      if (br) prevEnd = br[1];
      start += duration;
      duration = 0;
      range = undefined;
    }
  }
  return { kind: 'media', segments, endlist, targetDuration };
}

/**
 * Which audio playlist to read from a master: the rendition for the first variant's
 * audio group (by language if asked, else the default), or the variant itself when
 * its audio is muxed in.
 */
export function pickHlsAudio(
  master: Extract<HlsPlaylist, { kind: 'master' }>,
  language?: string,
): string | null {
  const variant = [...master.variants].sort((a, b) => a.bandwidth - b.bandwidth)[0];
  if (!variant) return master.audio.find((a) => a.uri)?.uri ?? null;
  const group = master.audio.filter((a) => a.groupId === variant.audioGroup && a.uri);
  if (group.length === 0) return variant.uri;
  const byLang =
    language && group.find((a) => a.language?.toLowerCase().startsWith(language.slice(0, 2)));
  return (byLang || group.find((a) => a.isDefault) || group[0])?.uri ?? variant.uri;
}
