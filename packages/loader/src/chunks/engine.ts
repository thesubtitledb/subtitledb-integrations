/**
 * Chunk entry: the element engine and, through it, the API client.
 *
 * What a bare `<video>` needs and no more. Everything under it is shared with the
 * bindings chunk, so esbuild's splitting puts core in a third file that both import
 * and neither duplicates.
 */
export { attachSubtitleDb } from '@subtitledb/html5';
