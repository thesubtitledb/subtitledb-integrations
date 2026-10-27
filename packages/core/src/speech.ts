/**
 * From words SubBot heard to a subtitle file from the corpus, lined up.
 *
 * The API names the file in the spoken language that holds those words and the shift
 * that puts it on the video (POST /v1/subbot/identify). When the viewer reads another
 * language, that language's file of the same title is lined up against the spoken one
 * by cue times ({@link lineUp}) and shown instead. Either way the viewer gets a file a
 * person wrote, on time, in place of the transcription.
 */
import { lineUp } from './align.js';
import type { SubtitleDbClient } from './client.js';
import { CONVERTIBLE, toVtt } from './convert.js';
import { languageFamily } from './languages.js';
import type { Identified, IdentifiedText } from './transcribe.js';
import { type Cue, parseVtt, serialize, shift } from './transform.js';
import type { BundleSubtitle, SpeechCue } from './types.js';

export interface SpeechDeps {
  client: SubtitleDbClient;
  /** The viewer's languages, best first. Empty: show the spoken language. */
  languages: readonly string[];
  /** Charges the session's request budget; false means spent. */
  budget: (n: number) => boolean;
  signal: AbortSignal;
}

async function cuesOf(d: SpeechDeps, sub: BundleSubtitle): Promise<Cue[] | null> {
  if (!CONVERTIBLE.has(sub.format.toLowerCase()) || !d.budget(1)) return null;
  const got = await d.client.fetchSubtitleText(sub, { signal: d.signal });
  const cues = parseVtt(toVtt(got.text, got.format));
  return cues.length ? cues : null;
}

/** The spoken-language file the API matched, by its id. */
async function matched(d: SpeechDeps, subId: number): Promise<BundleSubtitle | null> {
  if (!d.budget(1)) return null;
  const bundle = await d.client.bySubid(subId, { limit: 1, signal: d.signal });
  return bundle.subtitle ?? null;
}

/** The first file of the same title, season and episode in the viewer's language. */
async function inLanguage(
  d: SpeechDeps,
  m: { imdb_id: string; season: number; episode: number },
  want: string,
): Promise<BundleSubtitle | null> {
  if (!d.budget(1)) return null;
  const drill = m.season || m.episode ? { season: m.season, episode: m.episode } : {};
  const bundle = await d.client.byImdb(m.imdb_id, {
    ...drill,
    languages: [want],
    limit: 10,
    signal: d.signal,
  });
  const fam = languageFamily(want);
  return (
    bundle.subtitles.items.find(
      (s) => languageFamily(s.language) === fam && CONVERTIBLE.has(s.format.toLowerCase()),
    ) ?? null
  );
}

/**
 * Ask the API which file holds `cues`, fetch it, shift it, and, when the viewer reads
 * another language, swap in that language's file lined up against it. Null when there
 * is no match or the spoken file cannot be read. Errors are the caller's to report.
 */
export async function identifySpeech(
  d: SpeechDeps,
  lang: string,
  cues: SpeechCue[],
): Promise<IdentifiedText | null> {
  if (!d.budget(1)) return null;
  const r = await d.client.identifySpeech({ lang, cues }, { signal: d.signal });
  const m = r.match;
  if (!m) return null;
  const spokenSub = await matched(d, m.sub_id);
  const spoken = spokenSub && (await cuesOf(d, spokenSub));
  if (!spokenSub || !spoken) return null;

  const ref = shift(spoken, m.shift_ms);
  const base: Identified = {
    sub_id: m.sub_id,
    imdb_id: m.imdb_id,
    season: m.season,
    episode: m.episode,
    lang: spokenSub.language,
    shift_ms: m.shift_ms,
    matched_sub_id: m.sub_id,
  };
  const reference = ref.map((c) => ({ start_ms: c.start, text: c.text }));
  const want = d.languages[0];
  if (want && languageFamily(want) !== languageFamily(m.lang)) {
    const sub = await inLanguage(d, m, want);
    const other = sub && (await cuesOf(d, sub));
    const fit = other && lineUp(ref, other);
    if (sub && other && fit) {
      return {
        text: serialize(shift(other, fit.ms)),
        format: 'vtt',
        identified: { ...base, sub_id: sub.id, lang: sub.language, shift_ms: fit.ms },
        reference,
      };
    }
  }
  return { text: serialize(ref), format: 'vtt', identified: base, reference };
}
