# @subtitledb/subbot

On-device subtitles for a video that has none. Reads the audio the player is already
playing, transcribes it in the browser with whisper.cpp, shows the first line within
seconds of the click, transcribes the whole file behind the viewer and hands it over
as a complete WebVTT.

The public surface is `runTranscription(req, deps)`, the `Transcriber` contract from
`@subtitledb/core`. The CDN loader wires it; a page bundling its own engine passes it
to `createSession` as `transcriber`. The options are documented with the rest of
`transcribe` in [docs/documentation.md](../../docs/documentation.md#transcription).

## How it runs

Three kinds of worker, one script (`src/asr/worker.ts`), the role decided by the first
message.

The audio worker opens the source and answers windows of 16 kHz mono PCM. It demuxes
MP4 (flat and fragmented), Matroska and WebM, MPEG-TS, HLS and DASH itself, reads the
least it can (a window of a flat MP4 is a few Range requests), and decodes with the
browser's `AudioDecoder`. Nothing is decoded ahead of a request. HLS and DASH segments
are read as fragmented MP4 or MPEG-TS; WebM segments are not.

The live ASR worker runs the small model on short windows from the playhead: two
seconds first, then six, as far ahead as it gets. Its first window is what
sets the time to the first cue.

It is started before the click. When the session offers the transcription row it
calls the engine's `warm`, and `src/warm.ts` spawns the live worker then: the engine
is compiled and its heap grown, and the model loaded into it when a past run left it
in the Cache API. A model that is not there is not downloaded, that waits for the
select. The run that follows takes the worker over, so the click pays for the first
window alone. One warm worker per page, dropped after five minutes without a select.

The quality pool, up to three workers with the bigger model, re-does every window in
fifteen second pieces, nearest the playhead first and then from the start of the
file. Its cues replace the live ones. The pool starts after the first live window so
it never competes with it, and it is empty on a small machine.

The scheduler (`src/schedule.ts`) is a set of intervals per tier and two functions
that answer the next window. Windows are cut at the quietest point of their last
second so a line is not split. A seek drops a live window that is far away with most
of its cost ahead, by stopping that worker and starting another; there is no other
way to interrupt a decode.

Cues go to the element's own `TextTrack`, the one the html5 adapter's `<track>`
already stands for, so the browser renders them. A player that owns captions and
turns the native track off gets an overlay. When every second is covered the run
resolves with the file and the adapter sets it as the track's source.

When the session passes `identify` (it does unless `identify: false`, and never while
translating), the cues heard so far are sent to the corpus at 30, 60 and 120 words,
one lookup at a time. A match is shown only once the words heard from 30 s past the
first line sent agree with it (`VERIFY_*` in `subbot.ts`); one that does not is dropped
and its episode never taken again. Then the run stops every worker, replaces the track's cues
with the file the session fetched (already shifted, and in the viewer's language when
the corpus had one to line up), and resolves with that file. A run that covers a short
file while a lookup is out waits for the answer before it resolves.

## Models

q8_0 on purpose: on single-thread WebAssembly it is the fastest quantisation measured
(tiny 0.4x realtime, base 0.8x) and within a point of f16 on accuracy. By default the
models come from the whisper.cpp mirror on HuggingFace and are kept in the Cache API;
`models` points at a self-hosted copy. The Silero VAD model is fetched with them.

| quality | live | behind |
|---|---|---|
| `fast` | tiny-q8_0 (43 MB) | none |
| `balanced` | tiny-q8_0 | base-q8_0 (82 MB) |
| `best` | base-q8_0 | small-q8_0 (264 MB) |

## The WebAssembly build

`wasm/build.sh` builds `wasm/dist/subbot.{js,wasm}` from a pinned whisper.cpp with
Emscripten: single thread (no SharedArrayBuffer, so it runs on any page), SIMD, no
filesystem, embind. `wasm/subbot.cpp` is the binding: load a model, load the VAD,
transcribe a float buffer with the options that matter here (trimmed encoder context,
greedy, no fallbacks, a token cap, streaming segments), detect a language. The model
is read straight off the JavaScript array, and the heap is grown once before it, so a
cached model is in memory in under a hundred milliseconds rather than half a second.
The built files are committed because CI has no Emscripten.

Two one-line patches go on whisper.cpp at build time, both about the first window.
Language detection ran before `audio_ctx` was applied, so a four second window was
encoded as thirty seconds; and the window was encoded a second time for the decode
after the detection pass had encoded it. Together they were seven of the nine
seconds the first cue took on one WebAssembly thread.

## Tests

`npm test` runs the demuxers against the fixtures in `test/media` (Sintel, twenty
seconds, in every container), the scheduler, the cue rules, the worker client and
the orchestrator against fake workers. `e2e/subbot.spec.ts` selects the row on a real
element, with the real worker, build and model, under a plain `<video>`, hls.js,
dash.js and Shaka, and measures the time to the first cue.
