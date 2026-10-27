/**
 * DASH manifests: the audio adaptation set, its cheapest representation, and the
 * segment list that representation addresses, whether by SegmentTemplate (with or
 * without a timeline), SegmentList, or SegmentBase with an index.
 *
 * Static manifests only. A live MPD has no end and no fixed segment list to read.
 */
import { find, findAll, parseXml, type XmlNode } from './xml.js';

export interface DashSegment {
  uri: string;
  byteRange: [number, number] | null;
  start: number;
  duration: number;
}

export interface DashAudio {
  language: string | null;
  codecs: string | null;
  init: { uri: string; byteRange: [number, number] | null } | null;
  /** Segments, or null when they must be read from the file's own index (`sidx`). */
  segments: DashSegment[] | null;
  /** For SegmentBase: the media file and the byte range of its index. */
  indexed: { uri: string; indexRange: [number, number] | null } | null;
  duration: number;
}

/** ISO 8601 durations as an MPD writes them: PT1H2M3.5S. */
export function isoDuration(s: string | undefined): number {
  if (!s) return 0;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?$/.exec(s);
  if (!m) return 0;
  return (
    Number(m[1] ?? 0) * 86400 +
    Number(m[2] ?? 0) * 3600 +
    Number(m[3] ?? 0) * 60 +
    Number(m[4] ?? 0)
  );
}

function resolve(uri: string, base: string): string {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

function range(v: string | undefined): [number, number] | null {
  const m = v && /^(\d+)-(\d+)$/.exec(v);
  return m ? [Number(m[1]), Number(m[2]) + 1] : null;
}

/** `$RepresentationID$`, `$Number%05d$`, `$Time$`, `$Bandwidth$` and `$$`. */
export function fillTemplate(
  t: string,
  v: { id: string; number?: number; time?: number; bandwidth?: number },
): string {
  return t.replace(
    /\$\$|\$(RepresentationID|Number|Time|Bandwidth)(%0(\d+)d)?\$/g,
    (m, name: string | undefined, _f, width) => {
      if (m === '$$' || !name) return '$';
      const value =
        name === 'RepresentationID'
          ? v.id
          : name === 'Number'
            ? v.number
            : name === 'Time'
              ? v.time
              : v.bandwidth;
      const s = String(value ?? '');
      return width ? s.padStart(Number(width), '0') : s;
    },
  );
}

function baseUrlOf(node: XmlNode, parent: string): string {
  const b = find(node, 'BaseURL');
  return b ? resolve(b.text.trim(), parent) : parent;
}

export function parseMpd(text: string, mpdUrl: string, language?: string): DashAudio | null {
  const doc = parseXml(text);
  const mpd = find(doc, 'MPD');
  if (!mpd) return null;
  const mpdBase = baseUrlOf(mpd, mpdUrl);
  const total = isoDuration(mpd.attrs.mediaPresentationDuration);
  const period = findAll(mpd, 'Period')[0];
  if (!period) return null;
  const periodBase = baseUrlOf(period, mpdBase);
  const periodDuration = isoDuration(period.attrs.duration) || total;

  const sets = findAll(period, 'AdaptationSet').filter((s) => {
    const mime = s.attrs.mimeType ?? find(s, 'Representation')?.attrs.mimeType ?? '';
    return s.attrs.contentType === 'audio' || mime.startsWith('audio/');
  });
  if (sets.length === 0) return null;
  let set = sets[0] as XmlNode;
  if (language) {
    const want = sets.find((s) =>
      (s.attrs.lang ?? '').toLowerCase().startsWith(language.slice(0, 2)),
    );
    if (want) set = want;
  }
  const reps = findAll(set, 'Representation').sort(
    (a, b) => Number(a.attrs.bandwidth ?? 0) - Number(b.attrs.bandwidth ?? 0),
  );
  const rep = reps[0];
  if (!rep) return null;
  const setBase = baseUrlOf(set, periodBase);
  const repBase = baseUrlOf(rep, setBase);
  const id = rep.attrs.id ?? '';
  const bandwidth = Number(rep.attrs.bandwidth ?? 0);
  const codecs = rep.attrs.codecs ?? set.attrs.codecs ?? null;
  const lang = set.attrs.lang ?? null;

  const out: DashAudio = {
    language: lang,
    codecs,
    init: null,
    segments: null,
    indexed: null,
    duration: periodDuration,
  };

  // Inherited: a template on the adaptation set is overridden field by field by one
  // on the representation.
  const tmplAttrs = {
    ...(find(period, 'SegmentTemplate')?.attrs ?? {}),
    ...(find(set, 'SegmentTemplate')?.attrs ?? {}),
    ...(find(rep, 'SegmentTemplate')?.attrs ?? {}),
  };
  const timeline =
    find(rep, 'SegmentTemplate') && find(find(rep, 'SegmentTemplate') as XmlNode, 'SegmentTimeline')
      ? find(find(rep, 'SegmentTemplate') as XmlNode, 'SegmentTimeline')
      : find(set, 'SegmentTemplate') &&
          find(find(set, 'SegmentTemplate') as XmlNode, 'SegmentTimeline')
        ? find(find(set, 'SegmentTemplate') as XmlNode, 'SegmentTimeline')
        : undefined;

  if (tmplAttrs.media) {
    const timescale = Number(tmplAttrs.timescale ?? 1);
    const pto = Number(tmplAttrs.presentationTimeOffset ?? 0) / timescale;
    const startNumber = Number(tmplAttrs.startNumber ?? 1);
    if (tmplAttrs.initialization) {
      out.init = {
        uri: resolve(fillTemplate(tmplAttrs.initialization, { id, bandwidth }), repBase),
        byteRange: null,
      };
    }
    const segments: DashSegment[] = [];
    if (timeline) {
      let t = 0;
      let n = startNumber;
      for (const s of findAll(timeline, 'S')) {
        if (s.attrs.t !== undefined) t = Number(s.attrs.t);
        const d = Number(s.attrs.d ?? 0);
        const r = Number(s.attrs.r ?? 0);
        const repeats = r < 0 ? Math.ceil((periodDuration * timescale - t) / d) - 1 : r;
        for (let i = 0; i <= repeats; i++) {
          segments.push({
            uri: resolve(
              fillTemplate(tmplAttrs.media, { id, bandwidth, number: n, time: t }),
              repBase,
            ),
            byteRange: null,
            start: t / timescale - pto,
            duration: d / timescale,
          });
          t += d;
          n++;
        }
      }
    } else {
      const d = Number(tmplAttrs.duration ?? 0) / timescale;
      if (d <= 0) return null;
      const count = Math.ceil(periodDuration / d);
      for (let i = 0; i < count; i++) {
        segments.push({
          uri: resolve(
            fillTemplate(tmplAttrs.media, {
              id,
              bandwidth,
              number: startNumber + i,
              time: Math.round(i * d * timescale),
            }),
            repBase,
          ),
          byteRange: null,
          start: i * d,
          duration: Math.min(d, periodDuration - i * d),
        });
      }
    }
    out.segments = segments;
    return out;
  }

  const list = find(rep, 'SegmentList') ?? find(set, 'SegmentList');
  if (list) {
    const timescale = Number(list.attrs.timescale ?? 1);
    const d = Number(list.attrs.duration ?? 0) / timescale;
    const init = find(list, 'Initialization');
    if (init?.attrs.sourceURL)
      out.init = {
        uri: resolve(init.attrs.sourceURL, repBase),
        byteRange: range(init.attrs.range),
      };
    out.segments = findAll(list, 'SegmentURL').map((s, i) => ({
      uri: resolve(s.attrs.media ?? '', repBase),
      byteRange: range(s.attrs.mediaRange),
      start: i * d,
      duration: d,
    }));
    return out;
  }

  const base = find(rep, 'SegmentBase') ?? find(set, 'SegmentBase');
  const init = base && find(base, 'Initialization');
  out.init = init?.attrs.range ? { uri: repBase, byteRange: range(init.attrs.range) } : null;
  out.indexed = { uri: repBase, indexRange: range(base?.attrs.indexRange) };
  return out;
}
