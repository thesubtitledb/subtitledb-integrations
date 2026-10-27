// The whisper.cpp binding behind packages/subbot: one model, one VAD, no threads, no
// file system. Everything arrives as a typed array and leaves as a JSON string, so
// the worker on the JavaScript side stays a thin message pump.
//
// Why a binding of our own rather than examples/whisper.wasm: that one hides every
// decoding parameter behind full_default. The ones that make a short window cheap
// (audio_ctx, no fallback temperatures, greedy) and the ones that make a cue
// (token timestamps, max_len, no_speech probability) have to be reachable.
#include <emscripten.h>
#include <emscripten/bind.h>
#include <emscripten/val.h>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

#include "json.hpp"
#include "ggml.h"
#include "whisper.h"

using json = nlohmann::json;

static whisper_context *g_ctx = nullptr;
static whisper_vad_context *g_vad = nullptr;
static bool g_verbose = false;

// whisper and ggml log every model load and every VAD pass to stderr. On a host page
// that is the console, so they are off unless the worker asks for them.
static void quiet_log(ggml_log_level, const char *text, void *) {
  if (g_verbose) EM_ASM({ if (Module['onLog']) Module['onLog'](UTF8ToString($0)); }, text);
}
static void set_verbose(bool v) { g_verbose = v; }
static void quiet_once() {
  static bool done = false;
  if (done) return;
  done = true;
  whisper_log_set(quiet_log, nullptr);
  ggml_log_set(quiet_log, nullptr);
}

// A model loader straight off the JS typed array. Tensors are copied into place one
// at a time, so the file is never staged whole in the heap on top of the model, and
// the header's thousands of small reads come through a chunk, not a JS call each.
struct JsLoader {
  emscripten::val arr;
  size_t size;
  size_t pos;
  std::vector<uint8_t> chunk;
  size_t chunk_at;
  size_t chunk_len;
};

static void js_copy(const emscripten::val &arr, size_t at, void *out, size_t n) {
  emscripten::val view(emscripten::typed_memory_view(n, static_cast<uint8_t *>(out)));
  view.call<void>("set", arr.call<emscripten::val>("subarray", at, at + n));
}

static size_t js_read(void *ctx, void *out, size_t n) {
  auto *m = static_cast<JsLoader *>(ctx);
  size_t left = m->size - m->pos;
  if (n > left) n = left;
  if (n >= m->chunk.size()) {
    js_copy(m->arr, m->pos, out, n);
  } else {
    if (m->pos < m->chunk_at || m->pos + n > m->chunk_at + m->chunk_len) {
      m->chunk_at = m->pos;
      m->chunk_len = std::min(m->chunk.size(), m->size - m->pos);
      js_copy(m->arr, m->pos, m->chunk.data(), m->chunk_len);
    }
    std::memcpy(out, m->chunk.data() + (m->pos - m->chunk_at), n);
  }
  m->pos += n;
  return n;
}
static bool js_eof(void *ctx) {
  auto *m = static_cast<JsLoader *>(ctx);
  return m->pos >= m->size;
}
static void js_close(void *) {}

static JsLoader js_loader(const emscripten::val &bytes) {
  return JsLoader{bytes, bytes["length"].as<size_t>(), 0, std::vector<uint8_t>(1 << 20), 0, 0};
}

// Grow the heap once, ahead of a load, instead of step by step under it. Every
// growth remaps the memory, and the steps of a model load add up to more than the
// load itself. malloc and free: the memory stays grown, the block goes back to the
// allocator.
static bool reserve(double bytes) {
  void *p = std::malloc(static_cast<size_t>(bytes));
  if (!p) return false;
  std::free(p);
  return true;
}

static bool load_model(const emscripten::val &bytes, bool flash_attn) {
  quiet_once();
  if (g_ctx) {
    whisper_free(g_ctx);
    g_ctx = nullptr;
  }
  JsLoader m = js_loader(bytes);
  whisper_model_loader loader{&m, js_read, js_eof, js_close};
  whisper_context_params cp = whisper_context_default_params();
  cp.use_gpu = false;
  cp.flash_attn = flash_attn;
  g_ctx = whisper_init_with_params(&loader, cp);
  return g_ctx != nullptr;
}

static bool load_vad(const emscripten::val &bytes) {
  quiet_once();
  if (g_vad) {
    whisper_vad_free(g_vad);
    g_vad = nullptr;
  }
  JsLoader m = js_loader(bytes);
  whisper_model_loader loader{&m, js_read, js_eof, js_close};
  whisper_vad_context_params vp = whisper_vad_default_context_params();
  vp.n_threads = 1;
  vp.use_gpu = false;
  g_vad = whisper_vad_init_with_params(&loader, vp);
  return g_vad != nullptr;
}

static bool is_multilingual() { return g_ctx && whisper_is_multilingual(g_ctx); }

// Speech spans in seconds for a stretch of 16 kHz mono PCM.
static std::string vad(const emscripten::val &audio, const std::string &opts_json) {
  if (!g_vad) return "{\"error\":\"no vad model\"}";
  std::vector<float> pcm = emscripten::convertJSArrayToNumberVector<float>(audio);
  json o = json::parse(opts_json, nullptr, false);
  if (o.is_discarded()) o = json::object();
  whisper_vad_params p = whisper_vad_default_params();
  p.threshold = o.value("threshold", 0.5f);
  p.min_speech_duration_ms = o.value("min_speech_ms", 250);
  p.min_silence_duration_ms = o.value("min_silence_ms", 100);
  p.max_speech_duration_s = o.value("max_speech_s", 30.0f);
  p.speech_pad_ms = o.value("pad_ms", 30);
  whisper_vad_segments *segs = whisper_vad_segments_from_samples(g_vad, p, pcm.data(), pcm.size());
  json out = json::array();
  if (segs) {
    int n = whisper_vad_segments_n_segments(segs);
    for (int i = 0; i < n; i++) {
      out.push_back({whisper_vad_segments_get_segment_t0(segs, i) / 100.0f,
                     whisper_vad_segments_get_segment_t1(segs, i) / 100.0f});
    }
    whisper_vad_free_segments(segs);
  }
  return out.dump();
}

static std::string g_pending_lang;

static void on_segment(whisper_context *ctx, whisper_state *, int n_new, void *) {
  int n = whisper_full_n_segments(ctx);
  for (int i = n - n_new; i < n; i++) {
    json s = {{"t0", whisper_full_get_segment_t0(ctx, i) / 100.0},
              {"t1", whisper_full_get_segment_t1(ctx, i) / 100.0},
              {"text", whisper_full_get_segment_text(ctx, i)},
              {"nsp", whisper_full_get_segment_no_speech_prob(ctx, i)}};
    std::string js = s.dump();
    EM_ASM({ if (Module['onSegment']) Module['onSegment'](UTF8ToString($0)); }, js.c_str());
  }
}

static void on_progress(whisper_context *, whisper_state *, int progress, void *) {
  EM_ASM({ if (Module['onProgress']) Module['onProgress']($0); }, progress);
}

// Transcribe one stretch of 16 kHz mono PCM. Options, all optional:
//   language        "en", "auto" (default auto on a multilingual model)
//   translate       bool, to English
//   audio_ctx       encoder context, 0 = the full 1500 (30 s). 1500 * seconds / 30
//                   makes a short window cost what it is worth.
//   max_len         max characters per segment, 0 = whisper's own segmentation
//   token_timestamps bool
//   single_segment  bool
//   no_context      bool, default true: every window stands alone
//   temperature     float, default 0
//   fallback        bool, default false: no temperature fallbacks, one pass
//   beam            int, 0 = greedy
//   best_of         int, greedy candidates, default 1
//   prompt          string, initial prompt
//   no_speech_thold float, default 0.6
//   max_tokens      int, 0 = no limit
//   time_offset     seconds added to every timestamp in the result
static std::string transcribe(const emscripten::val &audio, const std::string &opts_json) {
  if (!g_ctx) return "{\"error\":\"no model\"}";
  std::vector<float> pcm = emscripten::convertJSArrayToNumberVector<float>(audio);
  json o = json::parse(opts_json, nullptr, false);
  if (o.is_discarded()) o = json::object();

  int beam = o.value("beam", 0);
  whisper_full_params p = whisper_full_default_params(
      beam > 1 ? WHISPER_SAMPLING_BEAM_SEARCH : WHISPER_SAMPLING_GREEDY);
  p.n_threads = 1;
  p.print_realtime = false;
  p.print_progress = false;
  p.print_timestamps = false;
  p.print_special = false;
  p.translate = o.value("translate", false);
  p.no_context = o.value("no_context", true);
  p.single_segment = o.value("single_segment", false);
  p.token_timestamps = o.value("token_timestamps", false);
  p.max_len = o.value("max_len", 0);
  p.split_on_word = o.value("split_on_word", true);
  p.max_tokens = o.value("max_tokens", 0);
  p.audio_ctx = o.value("audio_ctx", 0);
  p.temperature = o.value("temperature", 0.0f);
  p.temperature_inc = o.value("fallback", false) ? 0.2f : 0.0f;
  p.no_speech_thold = o.value("no_speech_thold", 0.6f);
  p.suppress_nst = o.value("suppress_nst", true);
  p.greedy.best_of = o.value("best_of", 1);
  p.beam_search.beam_size = beam > 1 ? beam : 1;
  p.new_segment_callback = on_segment;
  p.progress_callback = on_progress;

  g_pending_lang = o.value("language", std::string("auto"));
  if (!is_multilingual()) g_pending_lang = "en";
  p.language = g_pending_lang.c_str();
  p.detect_language = false;

  std::string prompt = o.value("prompt", std::string());
  if (!prompt.empty()) p.initial_prompt = prompt.c_str();

  double off = o.value("time_offset", 0.0);

  int rc = whisper_full(g_ctx, p, pcm.data(), pcm.size());
  json out;
  if (rc != 0) {
    out["error"] = "whisper_full failed";
    out["rc"] = rc;
    return out.dump();
  }
  int lang_id = whisper_full_lang_id(g_ctx);
  out["lang"] = lang_id >= 0 ? whisper_lang_str(lang_id) : "";
  json segs = json::array();
  int n = whisper_full_n_segments(g_ctx);
  for (int i = 0; i < n; i++) {
    json s = {{"t0", whisper_full_get_segment_t0(g_ctx, i) / 100.0 + off},
              {"t1", whisper_full_get_segment_t1(g_ctx, i) / 100.0 + off},
              {"text", whisper_full_get_segment_text(g_ctx, i)},
              {"nsp", whisper_full_get_segment_no_speech_prob(g_ctx, i)}};
    int nt = whisper_full_n_tokens(g_ctx, i);
    double psum = 0;
    int pc = 0;
    json toks = json::array();
    for (int t = 0; t < nt; t++) {
      whisper_token_data d = whisper_full_get_token_data(g_ctx, i, t);
      if (d.id >= whisper_token_eot(g_ctx)) continue;  // special and timestamp tokens
      psum += d.p;
      pc++;
      if (p.token_timestamps) {
        toks.push_back({{"text", whisper_full_get_token_text(g_ctx, i, t)},
                        {"t0", d.t0 / 100.0 + off},
                        {"t1", d.t1 / 100.0 + off},
                        {"p", d.p}});
      }
    }
    s["p"] = pc ? psum / pc : 0.0;
    if (p.token_timestamps) s["tokens"] = toks;
    segs.push_back(s);
  }
  out["segments"] = segs;
  return out.dump();
}

// Encoder context for a stretch of 16 kHz audio: the model's 30 s is 1500 frames.
static int audio_ctx_for(size_t samples) {
  double frames = 1500.0 * samples / 16000.0 / 30.0;
  int n = static_cast<int>((frames + 7.0) / 8.0) * 8;
  return n < 64 ? 64 : n;
}

// Language of a stretch, with the context trimmed to it. The detection step's
// logits are still in the state afterwards, so the language probabilities are a
// softmax over them, as whisper.cpp computes them for itself.
static std::string detect_language(const emscripten::val &audio) {
  if (!g_ctx) return "{\"error\":\"no model\"}";
  if (!is_multilingual()) return "{\"lang\":\"en\",\"p\":1}";
  std::vector<float> pcm = emscripten::convertJSArrayToNumberVector<float>(audio);
  whisper_full_params p = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
  p.n_threads = 1;
  p.print_realtime = false;
  p.print_progress = false;
  p.print_timestamps = false;
  p.print_special = false;
  p.language = "auto";
  p.detect_language = true;
  p.audio_ctx = audio_ctx_for(pcm.size());
  if (whisper_full(g_ctx, p, pcm.data(), pcm.size()) != 0) return "{\"error\":\"detect failed\"}";
  int id = whisper_full_lang_id(g_ctx);
  if (id < 0) return "{\"error\":\"detect failed\"}";
  const float *logits = whisper_get_logits(g_ctx);
  int n = whisper_lang_max_id() + 1;
  std::vector<float> probs(n);
  float mx = -INFINITY;
  for (int i = 0; i < n; i++) {
    probs[i] = logits[whisper_token_lang(g_ctx, i)];
    if (probs[i] > mx) mx = probs[i];
  }
  double sum = 0;
  for (int i = 0; i < n; i++) {
    probs[i] = std::exp(probs[i] - mx);
    sum += probs[i];
  }
  for (int i = 0; i < n; i++) probs[i] = static_cast<float>(probs[i] / sum);
  json out = {{"lang", whisper_lang_str(id)}, {"p", probs[id]}};
  json top = json::array();
  for (int k = 0; k < 5; k++) {
    int best = -1;
    for (int i = 0; i < n; i++) {
      if (probs[i] >= 0 && (best < 0 || probs[i] > probs[best])) best = i;
    }
    if (best < 0) break;
    top.push_back({{"lang", whisper_lang_str(best)}, {"p", probs[best]}});
    probs[best] = -1;
  }
  out["top"] = top;
  return out.dump();
}

static std::string info() {
  json o = {{"version", whisper_version()},
            {"loaded", g_ctx != nullptr},
            {"vad", g_vad != nullptr},
            {"multilingual", is_multilingual()},
            {"n_audio_ctx", g_ctx ? whisper_n_audio_ctx(g_ctx) : 0},
            {"system", whisper_print_system_info()}};
  return o.dump();
}

static void free_all() {
  if (g_ctx) whisper_free(g_ctx);
  if (g_vad) whisper_vad_free(g_vad);
  g_ctx = nullptr;
  g_vad = nullptr;
}

EMSCRIPTEN_BINDINGS(subbot) {
  emscripten::function("reserve", &reserve);
  emscripten::function("load_model", &load_model);
  emscripten::function("load_vad", &load_vad);
  emscripten::function("vad", &vad);
  emscripten::function("transcribe", &transcribe);
  emscripten::function("detect_language", &detect_language);
  emscripten::function("info", &info);
  emscripten::function("free_all", &free_all);
  emscripten::function("set_verbose", &set_verbose);
}
