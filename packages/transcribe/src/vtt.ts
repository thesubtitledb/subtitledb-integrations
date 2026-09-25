/**
 * WebVTT from timestamped cues.
 *
 * The engines return the same shape whichever one ran: a start, an end and a line of
 * text, in seconds. This assembles those into a WebVTT file the existing blob-URL
 * path can hand to any player, so a transcription is injected exactly like a fetched
 * subtitle and nothing downstream needs to know it was generated.
 */
export interface Cue {
  /** Seconds from the start of the media. */
  start: number;
  end: number;
  text: string;
}

/** `SS.mmm` -> `HH:MM:SS.mmm`, the timestamp form WebVTT requires. */
export function formatTimestamp(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const ms = Math.round(s * 1000);
  const hh = Math.floor(ms / 3_600_000);
  const mm = Math.floor((ms % 3_600_000) / 60_000);
  const ss = Math.floor((ms % 60_000) / 1000);
  const rest = ms % 1000;
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}.${pad(rest, 3)}`;
}

/**
 * Build the file. Drops empty cues and any whose end is not after its start once
 * clamped, because a zero-length or reversed cue renders as a flicker or not at all
 * and a model occasionally emits one at a chunk boundary.
 */
export function cuesToVtt(cues: Cue[]): string {
  const lines = ['WEBVTT', ''];
  for (const cue of cues) {
    const text = cue.text.trim();
    if (!text) continue;
    const start = Number.isFinite(cue.start) && cue.start > 0 ? cue.start : 0;
    // A missing or reversed end gets a short default so the cue is at least shown.
    const end = Number.isFinite(cue.end) && cue.end > start ? cue.end : start + 2;
    lines.push(`${formatTimestamp(start)} --> ${formatTimestamp(end)}`);
    lines.push(text);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
