/**
 * Chunk entry: the on-device transcription engine.
 *
 * Fetched only when a viewer selects the synthetic transcription row, never on attach
 * and never on resolve. It shares no runtime code with the engine and bindings chunks,
 * so splitting leaves it a standalone file that is downloaded once and cached, and the
 * heavy `@huggingface/transformers` code it uses is imported by its worker from a CDN,
 * not bundled here.
 */
export { runTranscription } from '@subtitledb/transcribe';
