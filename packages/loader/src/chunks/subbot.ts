/**
 * Chunk entry: SubBot, the on-device transcription engine.
 *
 * Fetched only when a viewer selects the synthetic transcription row, never on attach
 * and never on resolve. The heavy parts are not in here: the worker is its own chunk
 * (`subbot-worker`), the whisper.cpp build sits next to it as `subbot.wasm`, and the
 * models come from wherever `models` points.
 */
export { runTranscription } from '@subtitledb/subbot';
