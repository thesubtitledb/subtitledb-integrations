/**
 * Chunk entry: the element engine and, through it, the API client.
 *
 * What a bare `<video>` needs and no more. Everything under it is shared with the
 * bindings chunk, so esbuild's splitting puts core in a third file that both import
 * and neither duplicates.
 *
 * `query` rides this chunk too: it is the same session, client and converter the engine
 * already pulls in, so answering a query needs no bytes beyond what a video attach does.
 */

export { query } from '@subtitledb/core';
export { attachSubtitleDb } from '@subtitledb/html5';
