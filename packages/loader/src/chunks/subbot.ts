/**
 * Chunk entry: SubBot, the on-device transcription engine.
 *
 * Fetched when the synthetic transcription row is offered, never on attach, so the
 * engine can be warm before the click. The heavy parts are not in here: the worker is
 * its own chunk (`subbot-worker`), the whisper.cpp build sits next to it as
 * `subbot.wasm`, and the models come from wherever `models` points, on the select.
 */
export { runTranscription, warmTranscription } from '@subtitledb/subbot';
