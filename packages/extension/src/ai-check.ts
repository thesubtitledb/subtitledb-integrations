/**
 * Kept apart from ai.ts so content.js can say which videos SubBot can read without
 * carrying SubBot.
 */

/** Why SubBot cannot read this video's audio, before anything is downloaded, as a message key. */
export function unreadable(video: HTMLVideoElement): string | null {
  const src = video.currentSrc || video.src;
  if (!src) return 'ai.why.notStarted';
  if (/^blob:|^mediasource:/i.test(src)) {
    return 'ai.why.ownPlayer';
  }
  if (!/^https?:/i.test(src)) return 'ai.why.http';
  return null;
}
