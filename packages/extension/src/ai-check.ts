/**
 * Kept apart from ai.ts so content.js can say which videos SubBot can read without
 * carrying SubBot.
 */

/** Why SubBot cannot read this video's audio, before anything is downloaded. */
export function unreadable(video: HTMLVideoElement): string | null {
  const src = video.currentSrc || video.src;
  if (!src) return 'This video has not started loading yet. Press play, then try again.';
  if (/^blob:|^mediasource:/i.test(src)) {
    return 'This site streams video through its own player, so SubBot cannot read the audio. It works on videos that play from a file or a stream address.';
  }
  if (!/^https?:/i.test(src)) return 'SubBot can only read videos served over http or https.';
  return null;
}
