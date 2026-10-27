#!/usr/bin/env bash
# Builds packages/subbot/wasm/dist/subbot.{js,wasm} from whisper.cpp at a pinned commit.
#
# Needs emsdk on PATH (emcc, emcmake) and cmake. Single thread on purpose: a pthread
# build needs SharedArrayBuffer, which needs COOP and COEP on the host page, and the
# helper runs on pages we do not control. WASM SIMD is on; every browser that runs
# ES2022 has it.
#
#   WHISPER_SRC   an existing whisper.cpp checkout to use instead of cloning
#   BUILD_DIR     where to configure (default: ../../../.build/whisper under the repo)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
PIN="231638a"
src="${WHISPER_SRC:-$repo/.build/whisper.cpp}"
bld="${BUILD_DIR:-$repo/.build/whisper-wasm}"
out="$here/dist"

if [ ! -d "$src/.git" ]; then
  git clone -q https://github.com/ggml-org/whisper.cpp.git "$src"
fi
git -C "$src" checkout -q "$PIN"

# Language detection runs before whisper_full applies audio_ctx, so with a trimmed
# window it still encodes the full thirty seconds: nine seconds of the first cue on
# a single WASM thread. Apply the context first. One line, re-applied on every build.
if ! grep -q "subbot: audio_ctx before detection" "$src/src/whisper.cpp"; then
  perl -pi -e 'print "    state->exp_n_audio_ctx = params.audio_ctx; // subbot: audio_ctx before detection\n" if m{^    // auto-detect language if not specified$}' "$src/src/whisper.cpp"
  grep -q "subbot: audio_ctx before detection" "$src/src/whisper.cpp" || { echo "whisper.cpp patch did not apply"; exit 1; }
fi

# The detection pass encodes the window, then whisper_full encodes it again before
# the decode: the first window costs two encoder passes. Remember what detection
# encoded and skip the repeat. The decoder's cache is cleared before use either way.
if ! grep -q "subbot: detection encoded" "$src/src/whisper.cpp"; then
  perl -pi -e '
    print "    int subbot_encoded_seek = -1; // subbot: detection encoded this seek\n" if m{^    // auto-detect language if not specified$};
    $d ||= s{^(        state->lang_id = lang_id;)$}{$1\n        subbot_encoded_seek = 0; // subbot: detection encoded seek 0};
    s{^        if \(!whisper_encode_internal\(\*ctx, \*state, seek, params\.n_threads, params\.abort_callback, params\.abort_callback_user_data\)\) \{$}~        if (seek != subbot_encoded_seek && !whisper_encode_internal(*ctx, *state, seek, params.n_threads, params.abort_callback, params.abort_callback_user_data)) { // subbot: detection encoded it~;
  ' "$src/src/whisper.cpp"
  [ "$(grep -c "subbot: detection encoded" "$src/src/whisper.cpp")" = 3 ] || { echo "whisper.cpp detection patch did not apply"; exit 1; }
fi

emcmake cmake -S "$src" -B "$bld" -DCMAKE_BUILD_TYPE=Release \
  -DBUILD_SHARED_LIBS=OFF -DWHISPER_BUILD_EXAMPLES=OFF -DWHISPER_BUILD_TESTS=OFF \
  -DWHISPER_BUILD_SERVER=OFF -DGGML_OPENMP=OFF -DGGML_NATIVE=OFF -DWHISPER_WASM_SINGLE_FILE=OFF \
  -DGGML_WASM_SINGLE_FILE=OFF >/dev/null
cmake --build "$bld" --target whisper -j"$(nproc)" >/dev/null

libs=$(find "$bld" -name '*.a' | sort)
mkdir -p "$out"
emcc -O3 -msimd128 -std=c++17 \
  "$here/subbot.cpp" -I"$src/include" -I"$src/ggml/include" -I"$src/examples" \
  $libs \
  --bind \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createSubbot -sENVIRONMENT=worker \
  -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=2048MB -sALLOW_MEMORY_GROWTH=1 -sSTACK_SIZE=1MB \
  -sFILESYSTEM=0 -sWASM_BIGINT=1 -sASSERTIONS=0 \
  -sEXPORTED_RUNTIME_METHODS='["UTF8ToString"]' \
  -o "$out/subbot.js"
ls -la "$out"
