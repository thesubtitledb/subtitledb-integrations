/** Pick the worker program for an engine, and say whether it runs as a module worker. */
import type { ResolvedTranscribe } from '@subtitledb/core';
import { TranscribeError } from '../errors.js';
import { transformersProgram } from './transformers.js';
import { whisperCppProgram } from './whisper-cpp.js';

export interface EngineProgram {
  /** The worker source. */
  program: string;
  /**
   * True for a module worker (transformers.js imports its engine as ESM), false for a
   * classic worker (whisper.cpp uses importScripts on non-ESM Emscripten glue).
   */
  module: boolean;
}

export function engineProgram(config: ResolvedTranscribe): EngineProgram {
  switch (config.engine) {
    case 'transformers':
      return { program: transformersProgram(), module: true };
    case 'whisper-cpp':
      return { program: whisperCppProgram(), module: false };
    default:
      throw new TranscribeError(
        `unknown transcription engine: ${config.engine}`,
        'unsupported_engine',
      );
  }
}
