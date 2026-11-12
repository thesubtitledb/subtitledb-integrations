/**
 * Hearing-impaired text out of a cue: sounds in brackets or parentheses, speaker
 * labels at the start of a line, and lines left with nothing but a dash or a music
 * note. Lyrics between notes stay. Pure.
 */
export function withoutHearingImpaired(text: string): string {
  const lines = text
    .replace(/\r/g, '')
    .replace(/\[[^\]\n]*\]|\([^)\n]*\)/g, '')
    .split('\n')
    .map((l) =>
      l
        // "JOHN:", "MAN 2:", "<i>NARRATOR:</i>" and the same after a dialogue dash.
        .replace(/^(\s*(?:<[^>]+>)*\s*-?\s*)[A-Z][A-Z0-9 .'&-]{1,30}:\s*/, '$1')
        .replace(/<([biu])>\s*<\/\1>/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim(),
    )
    .filter((l) => {
      const bare = l.replace(/<[^>]+>/g, '').trim();
      return bare !== '' && !/^[-♪♫#\s]+$/.test(bare);
    });
  // A dialogue dash left on a single line is not dialogue any more.
  if (lines.length === 1) lines[0] = (lines[0] as string).replace(/^(\s*(?:<[^>]+>)*)-\s*/, '$1');
  return lines.join('\n');
}
