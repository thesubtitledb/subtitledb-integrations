/**
 * Stands in for the element chunk. Real module, real file, really imported: the
 * loader builds its specifier at runtime and nothing in vitest can intercept a
 * dynamic import of a URL it never sees, so the way to test the import is to make it
 * succeed.
 */
export const calls = [];

export function attachSubtitleDb(target, options) {
  calls.push({ target, options });
  return handle('native');
}

/** Every query() the loader made, with the options it passed. */
export const queries = [];

/** What the next query() answers with. A test replaces `results` to change it. */
export const answer = { results: [] };

export async function query(options) {
  queries.push(options);
  return { hint: options.hint ?? {}, title: null, tier: 'explicit-imdb', results: answer.results };
}

/** One result the way core's query() shapes it, loading to the text and format given. */
export function result(text = 'WEBVTT\n\n00:00.000 --> 00:01.000\nHi\n', format = 'vtt') {
  const loaded = { text, format, language: 'en', label: 'English - 1 lines' };
  return {
    subtitle: { id: 5 },
    id: 5,
    language: 'en',
    format,
    label: loaded.label,
    release: '',
    hearingImpaired: false,
    url: 'https://api.example.test/get/5',
    load: async () => loaded,
  };
}

export function handle(name) {
  let destroyed = 0;
  return {
    player: { name, label: name, untested: false, via: 'element' },
    degraded: null,
    session: { requestCount: 0 },
    media: () => null,
    refresh: async () => ({ candidates: [] }),
    select: async () => {},
    tracks: () => [{ subtitle: { id: 1 } }],
    current: () => ({ candidates: [] }),
    destroy() {
      destroyed++;
    },
    get destroyed() {
      return destroyed;
    },
  };
}
