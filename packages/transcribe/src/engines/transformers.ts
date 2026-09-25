/**
 * The default engine: transformers.js running Whisper as ONNX.
 *
 * The whole engine is a module-worker program, a string, that imports
 * `@huggingface/transformers` straight from jsDelivr and lets its
 * `automatic-speech-recognition` pipeline do the feature extraction, chunking and
 * timestamped decoding. WebGPU when the browser has it, WASM otherwise. The model,
 * `whisper-tiny.en` by default, streams from the HuggingFace hub and the browser
 * caches it, so the second run is offline-fast.
 *
 * No template literals inside the program: the whole thing is one outer template and a
 * `${}` in the body would interpolate here instead of running in the worker.
 */

/**
 * Pinned to the 3.x line; jsDelivr resolves the range to the latest patch. The `/+esm`
 * endpoint is required, not optional: the package's default file is a UMD bundle with
 * no named exports, so `import { pipeline, env }` only resolves against the ESM build
 * jsDelivr transpiles behind `/+esm`.
 */
export const TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3/+esm';

export function transformersProgram(): string {
  return `
import { pipeline, env } from '${TRANSFORMERS_CDN}';

env.allowLocalModels = false;
env.useBrowserCache = true;

let asr = null;
let loadedModel = null;

self.onmessage = async (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'run') return;
  const model = msg.model;
  const task = msg.task;
  const language = msg.language;
  let device = msg.device;
  if (device === 'auto') device = (self.navigator && self.navigator.gpu) ? 'webgpu' : 'wasm';

  try {
    if (!asr || loadedModel !== model) {
      asr = await pipeline('automatic-speech-recognition', model, {
        device: device,
        dtype: device === 'webgpu' ? 'fp16' : 'q8',
        progress_callback: (p) => {
          if (p && p.status === 'progress') {
            self.postMessage({ type: 'progress', phase: 'model', loaded: p.loaded || 0, total: p.total || 0 });
          }
        },
      });
      loadedModel = model;
    }

    self.postMessage({ type: 'progress', phase: 'transcribe', loaded: 0, total: 1 });

    // English-only checkpoints reject a language or a translate task, so only pass
    // those for a multilingual model. The name carries the marker: whisper-tiny.en.
    const englishOnly = /(?:\\.|-)en(?:$|\\b)/i.test(model);
    const opts = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true };
    if (!englishOnly) {
      opts.task = task;
      if (language && language !== 'auto') opts.language = language;
    }

    const out = await asr(msg.audio, opts);
    const raw = (out && out.chunks) || [];
    const cues = [];
    for (const c of raw) {
      if (!c || !c.timestamp) continue;
      const start = c.timestamp[0] == null ? 0 : c.timestamp[0];
      const end = c.timestamp[1] == null ? start + 2 : c.timestamp[1];
      const text = (c.text == null ? '' : String(c.text)).trim();
      if (text) cues.push({ start: start, end: end, text: text });
    }

    self.postMessage({ type: 'progress', phase: 'transcribe', loaded: 1, total: 1 });
    self.postMessage({ type: 'result', cues: cues });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) ? err.message : String(err) });
  }
};
`;
}
