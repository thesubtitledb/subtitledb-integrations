/**
 * Client side conversion to WebVTT.
 *
 * The corpus is 6,205,000 srt, 130,913 ssa and 98,454 ass against 2,487 vtt, so a
 * player whose subtitle support is a bare `<track src>` can otherwise be handed
 * 0.036% of what we hold. Converting in the browser rather than in the API keeps the
 * API serving exactly what is stored, keeps the bytes edge cacheable under one URL
 * per subtitle, and costs nothing until a track is actually selected.
 *
 * Deliberately small: this is a format shim, not a subtitle engine. It carries cue
 * timing and text, keeps the inline tags WebVTT shares with SubRip, drops the styling
 * markup it cannot express rather than showing it, and escapes the rest. A player that renders ASS
 * properly should keep taking the ASS and never call this.
 */

/** Formats this module can turn into WebVTT. */
export const CONVERTIBLE = new Set(['srt', 'vtt', 'ass', 'ssa']);

/** Thrown when input does not parse. Callers treat it as "this track did not load". */
export class ConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConvertError';
  }
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

function normaliseNewlines(s: string): string {
  return stripBom(s).replace(/\r\n?/g, '\n');
}

/** Tags WebVTT understands, kept as they are. */
const VTT_TAGS = /^\/?(?:[biu]|ruby|rt|v(?:\s[^>]*)?|c(?:\.[^>]*)?|lang(?:\s[^>]*)?)$/i;

/**
 * Styling markup WebVTT has no equivalent for, dropped with its text kept.
 *
 * <font color> is everywhere in the SubRip corpus. Escaping it is safe but wrong to
 * look at: the viewer reads a line of markup instead of the dialogue. Removing the
 * tag is just as safe, because nothing angle-bracketed reaches the document either
 * way, and it leaves the words behind.
 */
const DROP_TAGS = /^\/?font(?:\s[^>]*)?$/i;

/**
 * Everything in neither list is escaped, because a subtitle is untrusted third party
 * text being injected into a document.
 */
function escapeCueText(s: string): string {
  // Only a bare ampersand. WebVTT decodes character references, so escaping one that
  // is already a reference shows the viewer "&amp;" where the writer wrote "&", and
  // SubRip in this corpus is full of "&amp;" and "&#39;" already.
  return s
    .replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
    .replace(/<([^<>]*)>/g, (whole, inner: string) => {
      if (VTT_TAGS.test(inner)) return whole;
      if (DROP_TAGS.test(inner)) return '';
      return `&lt;${inner}&gt;`;
    });
}

/**
 * One cue's text, ready for a WebVTT parser.
 *
 * Two jobs beyond escaping. SubRip in this corpus routinely carries ASS override
 * blocks such as {\an8}, which a viewer would otherwise read as dialogue. And a
 * literal "-->" inside the payload ends the cue as far as the parser is concerned,
 * truncating this cue and inventing the next one.
 */
function cueText(s: string): string {
  return escapeCueText(stripAssOverrides(s)).replace(/-->/g, '--&gt;');
}

/** `1:2:3,40` and `01:02:03.400` both become `01:02:03.400`. */
function vttTime(h: string, m: string, s: string, frac: string): string {
  const ms = `${frac}000`.slice(0, 3);
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}:${s.padStart(2, '0')}.${ms}`;
}

const SRT_CUE =
  /(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})\s*-->\s*(\d{1,3}):(\d{1,2}):(\d{1,2})[,.](\d{1,3})([^\n]*)/;

/**
 * SubRip to WebVTT.
 *
 * Sequence numbers are dropped rather than kept as cue identifiers: they are an
 * artefact of the format, they are frequently wrong or duplicated in this corpus, and
 * WebVTT does not need them.
 */
export function srtToVtt(input: string): string {
  const text = normaliseNewlines(input);
  const blocks = text.split(/\n{2,}/);
  const out: string[] = ['WEBVTT', ''];
  let cues = 0;

  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) continue;

    const idx = lines.findIndex((l) => SRT_CUE.test(l));
    if (idx === -1) continue;

    const m = SRT_CUE.exec(lines[idx] as string);
    if (!m) continue;
    const [, h1, m1, s1, f1, h2, m2, s2, f2] = m as unknown as string[];

    // Anything before the timing line is a sequence number; anything after is text.
    const body = lines.slice(idx + 1).filter((l) => !/^X1:\d/.test(l));
    if (body.length === 0) continue;

    out.push(
      `${vttTime(h1 as string, m1 as string, s1 as string, f1 as string)} --> ${vttTime(h2 as string, m2 as string, s2 as string, f2 as string)}`,
    );
    out.push(cueText(body.join('\n')));
    out.push('');
    cues++;
  }

  if (cues === 0) throw new ConvertError('no cues found in srt input');
  return out.join('\n');
}

/** `{\an8}`, `{\i1}` and friends. Styling we cannot express, so it is removed. */
function stripAssOverrides(s: string): string {
  return s
    .replace(/\{[^}]*\}/g, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(/\\h/g, ' ');
}

const ASS_TIME = /^(\d{1,3}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/;

/**
 * SubStation Alpha (v4 and v4+) to WebVTT.
 *
 * Reads the `[Events]` Format line rather than assuming field order, because ASS
 * permits any order and files in this corpus use several. Comment and non-Dialogue
 * events are skipped.
 */
export function assToVtt(input: string): string {
  const lines = normaliseNewlines(input).split('\n');
  let fields: string[] | null = null;
  let inEvents = false;
  const cues: { start: string; end: string; text: string }[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (/^\[.*\]$/.test(line)) {
      inEvents = /^\[events\]$/i.test(line);
      fields = null;
      continue;
    }
    if (!inEvents) continue;

    if (/^Format\s*:/i.test(line)) {
      fields = line
        .slice(line.indexOf(':') + 1)
        .split(',')
        .map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue\s*:/i.test(line) || !fields) continue;

    const iStart = fields.indexOf('start');
    const iEnd = fields.indexOf('end');
    const iText = fields.indexOf('text');
    if (iStart < 0 || iEnd < 0 || iText < 0) continue;

    // Text is last by definition and may itself contain commas, so split only as far
    // as the field count and keep the remainder whole.
    const values = line.slice(line.indexOf(':') + 1).split(',');
    const head = values.slice(0, fields.length - 1).map((v) => v.trim());
    const tail = values.slice(fields.length - 1).join(',');
    const row = [...head, tail];

    const a = ASS_TIME.exec((row[iStart] ?? '').trim());
    const b = ASS_TIME.exec((row[iEnd] ?? '').trim());
    if (!a || !b) continue;

    const text = stripAssOverrides(row[iText] ?? '').trim();
    if (!text) continue;

    cues.push({
      start: vttTime(a[1] as string, a[2] as string, a[3] as string, a[4] as string),
      end: vttTime(b[1] as string, b[2] as string, b[3] as string, b[4] as string),
      text,
    });
  }

  if (cues.length === 0) throw new ConvertError('no dialogue events found in ass input');

  // ASS does not require chronological order; WebVTT does.
  cues.sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : 0));

  const out: string[] = ['WEBVTT', ''];
  for (const c of cues) {
    out.push(`${c.start} --> ${c.end}`);
    out.push(cueText(c.text));
    out.push('');
  }
  return out.join('\n');
}

/**
 * Convert one subtitle to WebVTT. Already-VTT input is returned with only its BOM and
 * line endings normalised, because re-parsing correct VTT can only lose information.
 */
export function toVtt(text: string, format: string): string {
  const f = format.toLowerCase();
  if (f === 'vtt') {
    const s = normaliseNewlines(text);
    return /^WEBVTT/.test(s) ? s : `WEBVTT\n\n${s}`;
  }
  if (f === 'srt') return srtToVtt(text);
  if (f === 'ass' || f === 'ssa') return assToVtt(text);
  throw new ConvertError(`cannot convert ${format} to vtt`);
}

/**
 * The MIME type a subtitle of this format should be served as.
 *
 * Every adapter here hands its player a blob rather than the API URL, and the type
 * on that blob is not decoration: a player that sniffs the response, and ArtPlayer
 * does when no explicit type is given, picks its parser from it. Declared once
 * because it was written out twice and the two copies were already free to drift.
 */
export function subtitleMime(format: string): string {
  const f = format.toLowerCase();
  if (f === 'vtt') return 'text/vtt';
  if (f === 'ass' || f === 'ssa') return 'text/x-ssa';
  return 'text/plain';
}
