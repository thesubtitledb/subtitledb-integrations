/**
 * The second engine: whisper.cpp compiled to WASM. Experimental.
 *
 * Unlike transformers.js, whisper.cpp ships no ESM anyone can import from a CDN and no
 * one canonical browser build, so this runs a *classic* worker that `importScripts()`
 * the Emscripten glue from `WHISPER_CPP_CDN` and drives the documented whisper.wasm
 * surface (`FS_createDataFile`, `init`, `full_default`). It is single-thread on
 * purpose: the multi-thread build needs `SharedArrayBuffer`, which needs COOP+COEP
 * headers this CDN does not set and which would collide with the cross-origin engine
 * load. The GGML model streams from the HuggingFace mirror, which is stable; the glue
 * URL is the integration point and may need a compatible self-hosted build, which is
 * why this engine is opt-in and documented as experimental. On any failure it posts a
 * clear error and the caller degrades to "that track did not load" rather than break.
 *
 * whisper.wasm reports its transcript through the print callback as
 * `[HH:MM:SS.mmm --> HH:MM:SS.mmm]   text`, which is where the timestamped cues come
 * from. No template literals inside the program string.
 */

/** The Emscripten glue for a single-thread whisper.wasm build. Override by self-hosting. */
export const WHISPER_CPP_CDN = 'https://cdn.jsdelivr.net/npm/@subtitledb/whisper-cpp-wasm@1/';

/** Where the GGML weights come from. The HuggingFace mirror is the canonical host. */
export const WHISPER_CPP_MODELS = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/';

export function whisperCppProgram(): string {
  return `
var GLUE = '${WHISPER_CPP_CDN}';
var MODELS = '${WHISPER_CPP_MODELS}';
var transcriptCues = [];
var timeRe = /\\[(\\d\\d):(\\d\\d):(\\d\\d)\\.(\\d\\d\\d)\\s*-->\\s*(\\d\\d):(\\d\\d):(\\d\\d)\\.(\\d\\d\\d)\\]\\s*(.*)/;

function toSeconds(h, m, s, ms) {
  return (+h) * 3600 + (+m) * 60 + (+s) + (+ms) / 1000;
}
function onLine(text) {
  var m = timeRe.exec(text);
  if (!m) return;
  var body = (m[9] || '').trim();
  if (!body) return;
  transcriptCues.push({
    start: toSeconds(m[1], m[2], m[3], m[4]),
    end: toSeconds(m[5], m[6], m[7], m[8]),
    text: body,
  });
}

var Module = {
  print: onLine,
  printErr: function () {},
  locateFile: function (path) { return GLUE + path; },
};

self.onmessage = async (e) => {
  var msg = e.data;
  if (!msg || msg.type !== 'run') return;
  try {
    importScripts(GLUE + 'whisper.js');
    if (typeof Module.onRuntimeInitialized === 'function' || !Module.calledRun) {
      await new Promise(function (res) {
        var prev = Module.onRuntimeInitialized;
        Module.onRuntimeInitialized = function () { if (prev) prev(); res(); };
        if (Module.calledRun) res();
      });
    }

    var modelFile = 'ggml-' + msg.model + '.bin';
    self.postMessage({ type: 'progress', phase: 'model', loaded: 0, total: 1 });
    var res = await fetch(MODELS + modelFile);
    if (!res.ok) throw new Error('model download failed with ' + res.status);
    var bytes = new Uint8Array(await res.arrayBuffer());
    self.postMessage({ type: 'progress', phase: 'model', loaded: bytes.length, total: bytes.length });
    try { Module.FS_unlink('whisper.bin'); } catch (ignore) {}
    Module.FS_createDataFile('/', 'whisper.bin', bytes, true, true);

    var instance = Module.init('whisper.bin');
    if (!instance) throw new Error('whisper.cpp failed to initialise the model');

    self.postMessage({ type: 'progress', phase: 'transcribe', loaded: 0, total: 1 });
    transcriptCues = [];
    var translate = msg.task === 'translate';
    var lang = (msg.language && msg.language !== 'auto') ? msg.language : 'auto';
    Module.full_default(instance, msg.audio, lang, navigator.hardwareConcurrency || 4, translate);

    self.postMessage({ type: 'progress', phase: 'transcribe', loaded: 1, total: 1 });
    self.postMessage({ type: 'result', cues: transcriptCues });
  } catch (err) {
    self.postMessage({ type: 'error', message: (err && err.message) ? err.message : String(err) });
  }
};
`;
}
