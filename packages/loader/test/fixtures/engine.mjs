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
