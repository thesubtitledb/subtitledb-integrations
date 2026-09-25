/** Stands in for the transcription chunk. See engine.mjs. */
export const calls = [];

export async function runTranscription(req) {
  calls.push(req);
  return { text: 'WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nstub\n', format: 'vtt' };
}
