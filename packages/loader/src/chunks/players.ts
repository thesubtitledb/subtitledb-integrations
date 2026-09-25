/**
 * Chunk entry: the sixteen bindings, the resolver and the ownership evidence.
 *
 * Fetched when the target is a player object, a wrapper around one, a named binding,
 * or an element some player has visibly mounted. It imports the element engine too,
 * so nothing here is a second copy of it.
 */
export { attachedTo, attachSubtitleDb, observeSubtitleDb } from '@subtitledb/players';
