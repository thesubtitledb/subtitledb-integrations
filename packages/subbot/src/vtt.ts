import type { Cue } from './cues.js';

/** `HH:MM:SS.mmm`, the WebVTT form. */
export function formatTimestamp(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(h)}:${two(m)}:${two(sec)}.${String(ms).padStart(3, '0')}`;
}

/** The cues as a WebVTT file. Text is escaped so a line with `<` cannot become markup. */
export function cuesToVtt(cues: readonly Cue[]): string {
  const lines = ['WEBVTT', ''];
  for (const c of cues) {
    if (c.end <= c.start) continue;
    const text = c.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    lines.push(`${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}`, text, '');
  }
  return `${lines.join('\n')}\n`;
}
