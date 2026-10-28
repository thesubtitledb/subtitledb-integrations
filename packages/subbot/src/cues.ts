/**
 * Model segments to subtitle cues, and the store that holds them by tier.
 *
 * Whisper's segments are not subtitles: they run long, they repeat when the decoder
 * loops, and on silence they invent gratitude. This turns them into lines a viewer
 * can read, keyed so a better pass over the same seconds replaces a worse one.
 */
export type Tier = 'live' | 'quality';

export interface Segment {
  t0: number;
  t1: number;
  text: string;
  /** No-speech probability. */
  nsp: number;
  /** Mean token probability. */
  p: number;
  tokens?: Array<{ text: string; t0: number; t1: number; p: number }>;
}

export interface Cue {
  start: number;
  end: number;
  text: string;
  tier: Tier;
}

/** Lines the model produces on silence, music and credits. Dropped whole. */
const JUNK = [
  /^[\s.,!?♪♫\-_"'()[\]]*$/,
  // No letter or digit at all: "****", "...".
  /^[^\p{L}\p{N}]*$/u,
  /^\s*[[(（].*[\])）]\s*$/,
  /^\s*(thank you|thanks|thank you for watching|thanks for watching)[.!\s]*$/i,
  /^\s*subtitles? by\b/i,
  /^\s*sub(s|titles)? (made )?by\b/i,
  /^\s*transcribed by\b/i,
  /^\s*(please )?(like|subscribe)\b/i,
  /^\s*www\./i,
  /^\s*you\s*$/i,
];

export const MAX_CHARS = 84;
export const MIN_DUR = 0.6;
export const MAX_DUR = 7;

export function isJunk(text: string): boolean {
  return JUNK.some((re) => re.test(text));
}

/**
 * Collapse a text the decoder looped on: a phrase said twice or more in a row to
 * once, a single word three times or more to once ("no no" is speech).
 */
function unloop(text: string): string {
  // Words end at whitespace or punctuation, not at \b: "****" has no word boundary.
  return (
    text
      .replace(/(?<![^\s,.!?])(\S+(?:\s+\S+){1,6}?)(?:[,.\s]+\1(?![^\s,.!?]))+/gi, '$1')
      .replace(/(?<![^\s,.!?])(\S+)(?:[,.\s]+\1(?![^\s,.!?])){2,}/gi, '$1')
      // Inside a word, five times or more: "s-s-s-s-s-see" to "s-s-s-see". Not digits.
      .replace(/([^\s\d]{1,6}?)\1{4,}/g, '$1$1$1')
  );
}

/**
 * A segment the decoder looped on: twelve words or more made of a few word triples
 * said over and over ("**** of **** of ..."), or one word stuck ("s-s-s-s-..."). Collapsed, it is still not what was
 * said, so it is dropped whole.
 */
export function looped(text: string): boolean {
  // One word the decoder stuck in: "s-s-s-s-s-s-s-s-s-s-...".
  if (/([^\s\d]{1,6}?)\1{7,}/.test(text)) return true;
  const w = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (w.length < 12) return false;
  const tri = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) tri.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return tri.size / (w.length - 2) < 0.4;
}

/**
 * Segments of one window to cues. Drops silence and junk, collapses repeats, splits
 * long lines at token boundaries when the model gave token times, and clamps every
 * cue to the window.
 */
export function segmentsToCues(segments: Segment[], tier: Tier, t0: number, t1: number): Cue[] {
  const out: Cue[] = [];
  let last = '';
  for (const s of segments) {
    if (s.nsp > 0.6 && s.p < 0.5) continue;
    const raw = s.text.trim().replace(/\s+/g, ' ');
    if (looped(raw)) continue;
    const text = unloop(raw);
    if (!text || isJunk(text)) continue;
    // The same line twice in a row is the decoder repeating itself across windows.
    if (text.toLowerCase() === last.toLowerCase()) continue;
    last = text;
    const start = Math.max(t0, s.t0);
    const end = Math.min(t1, Math.max(s.t1, start + MIN_DUR));
    if (end - start <= 0.05) continue;
    for (const piece of split(text, start, end, s.tokens)) out.push({ ...piece, tier });
  }
  // Cues must not overlap in time: a cue's end is clipped to the next cue's start.
  for (let i = 0; i + 1 < out.length; i++) {
    const a = out[i] as Cue;
    const b = out[i + 1] as Cue;
    if (a.end > b.start) a.end = Math.max(a.start + 0.2, b.start);
  }
  return out;
}

function split(
  text: string,
  start: number,
  end: number,
  tokens: Segment['tokens'],
): Array<Pick<Cue, 'start' | 'end' | 'text'>> {
  if (text.length <= MAX_CHARS && end - start <= MAX_DUR) return [{ start, end, text }];
  const words = text.split(' ');
  const pieces: string[] = [];
  let cur = '';
  const target = Math.ceil(text.length / Math.ceil(text.length / MAX_CHARS));
  for (const w of words) {
    if (cur && cur.length + 1 + w.length > target) {
      pieces.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) pieces.push(cur);
  // Boundaries between pieces: from the tokens that make each piece up, or by
  // character share without them. Then two passes keep every piece at least 0.3 s
  // long without any boundary leaving the segment.
  const k = pieces.length;
  const bounds: number[] = [start];
  let consumed = 0;
  for (let i = 0; i < k - 1; i++) {
    consumed += (pieces[i] as string).length + 1;
    let b = start + ((end - start) * consumed) / (text.length + 1);
    if (tokens && tokens.length > 0) {
      let chars = 0;
      for (const tok of tokens) {
        chars += tok.text.length;
        if (chars >= consumed) {
          b = tok.t1;
          break;
        }
      }
    }
    bounds.push(b);
  }
  bounds.push(end);
  const min = Math.min(0.3, (end - start) / k);
  for (let i = 1; i < k; i++)
    bounds[i] = Math.max(bounds[i] as number, (bounds[i - 1] as number) + min);
  for (let i = k - 1; i >= 1; i--)
    bounds[i] = Math.min(bounds[i] as number, (bounds[i + 1] as number) - min);
  return pieces.map((piece, i) => ({
    start: bounds[i] as number,
    end: bounds[i + 1] as number,
    text: piece,
  }));
}

/**
 * Pull a cue off silence. Whisper places a segment a second or two early or late
 * when the encoder context is trimmed; the VAD knows where the voice is. A start in
 * a gap moves forward to the next speech inside the cue, an end in a gap back to the
 * previous. Nothing is merged and nothing is widened.
 */
export function trimToSpeech(cues: Cue[], spans: Array<[number, number]>): Cue[] {
  if (spans.length === 0) return cues;
  // An edge on the far side of a span is off it: a start where the voice stops, or an end
  // where it begins, belongs to the other line.
  const startOn = (t: number) => spans.some(([a, b]) => a - 0.15 <= t && t < b - 0.1);
  const endOn = (t: number) => spans.some(([a, b]) => a + 0.1 < t && t <= b + 0.15);
  return cues.map((c) => {
    let { start, end } = c;
    if (!startOn(start)) {
      const next = spans.find(([a]) => a > start && a < end);
      if (next) start = next[0];
    }
    if (!endOn(end)) {
      const prev = spans.filter(([, b]) => b < end && b > start).at(-1);
      if (prev) end = prev[1];
    }
    return end - start >= MIN_DUR ? { ...c, start, end } : c;
  });
}

/** Reading speed, the shortest time on screen, and the gap the screen does not blink for. */
export const READ_CPS = 17;
export const MIN_HOLD = 1.2;
export const BRIDGE = 1;

/**
 * The cues as they are shown. A cue ends where the voice stops, so a short line said
 * fast flashes, and the screen blinks between two lines said close together. On
 * screen a line stays up for its reading time (at least MIN_HOLD), a gap to the next
 * line under BRIDGE is closed, and no line runs into the next. The heard times are
 * kept for everything else. `cues` sorted by start.
 */
export function held(cues: readonly Cue[]): Cue[] {
  return cues.map((c, i) => {
    const next = cues[i + 1]?.start ?? Number.POSITIVE_INFINITY;
    const read = Math.min(MAX_DUR, Math.max(MIN_HOLD, c.text.length / READ_CPS));
    let end = Math.max(c.end, c.start + read);
    if (next - end < BRIDGE) end = next;
    end = Math.min(end, next);
    return end > c.start ? { ...c, end } : c;
  });
}

export type CueListener = (added: Cue[], removed: Cue[]) => void;

/** Cues by time, replaceable per span, with one listener for the renderer. */
export class CueStore {
  cues: Cue[] = [];
  private listeners = new Set<CueListener>();

  listen(fn: CueListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Put the cues of one window in, removing what was there. A live window never
   * removes quality cues: the better tier wins whichever order they arrive in.
   */
  replace(t0: number, t1: number, cues: Cue[], tier: Tier): void {
    const removed: Cue[] = [];
    const kept: Cue[] = [];
    for (const c of this.cues) {
      const overlaps = c.start < t1 && c.end > t0;
      if (overlaps && (tier === 'quality' || c.tier === 'live')) removed.push(c);
      else kept.push(c);
    }
    // Live cues landing on a quality span are dropped rather than doubled.
    const added =
      tier === 'live'
        ? cues.filter(
            (c) => !kept.some((k) => k.tier === 'quality' && k.start < c.end && k.end > c.start),
          )
        : cues;
    this.cues = kept.concat(added).sort((a, b) => a.start - b.start);
    if (added.length || removed.length) for (const fn of this.listeners) fn(added, removed);
  }

  clear(): void {
    const removed = this.cues;
    this.cues = [];
    if (removed.length) for (const fn of this.listeners) fn([], removed);
  }
}
