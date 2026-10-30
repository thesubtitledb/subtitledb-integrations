/**
 * AI subtitles: SubBot, run on this video from inside the extension. Injected into one
 * frame, on the first press of Start, after content.js.
 *
 * The run is the same one the site and the CDN loader use (a core session with the
 * synthetic candidate), with two differences that only an extension can make:
 *
 * - The workers run in a hidden extension frame (worker.html), not in the page. Their
 *   fetches carry the extension's host access, so a video served without CORS headers
 *   can still be read, and the models are cached once for every site.
 * - The page cannot use those workers. Each spawn carries a token handed to the frame
 *   through the extension's own messaging, which page scripts have no access to.
 */
import {
  CONVERTIBLE,
  createSession,
  localeLanguages,
  type SubtitleSession,
  syntheticCandidate,
  type TranscribeQuality,
} from '@subtitledb/core';
import {
  MODEL_BYTES,
  MODELS,
  runTranscription,
  type Spawn,
  type SubbotState,
  type WorkerLike,
} from '@subtitledb/subbot';
import { unreadable } from './ai-check.js';
// Plain fetch here: these requests leave from the page, where a User-Agent header would
// cost a CORS preflight. The client name still says who made them.
import { CLIENT } from './api.js';
import type { AiStart, AiStatus } from './shared.js';

export interface AiApi {
  start(req: AiStart): AiStatus;
  stop(): void;
  status(): AiStatus;
}

declare global {
  var __tsdbAi: AiApi | undefined;
}

if (!globalThis.__tsdbAi) globalThis.__tsdbAi = create();

function create(): AiApi {
  let session: SubtitleSession | null = null;
  let status: AiStatus = { phase: 'idle' };
  let run = 0;

  const set = (s: AiStatus) => {
    status = s;
  };

  const stop = () => {
    run++;
    session?.dispose();
    session = null;
    for (const t of Array.from(document.querySelectorAll('video'))) {
      for (const track of Array.from(t.textTracks)) {
        if (track.label.startsWith(LABEL)) track.mode = 'disabled';
      }
    }
    if (status.phase !== 'idle') set({ phase: 'idle' });
  };

  return {
    start(req) {
      stop();
      const video = globalThis.__tsdb?.element(req.vid);
      if (!video) {
        set({ phase: 'error', message: 'That video is gone. Open this again.' });
        return status;
      }
      const why = unreadable(video);
      if (why) {
        set({ phase: 'error', message: why });
        return status;
      }
      globalThis.__tsdb?.clear();

      const mine = ++run;
      const live = (s: AiStatus) => {
        if (mine === run) set(s);
      };
      const models = MODELS[req.quality];
      const total = MODEL_BYTES[models.live] ?? 0;
      live({ phase: 'loading', step: 'engine', loaded: 0, total, quality: req.quality });

      session = createSession({
        formats: [...CONVERTIBLE],
        convertTo: 'vtt',
        clientName: CLIENT,
        downloadClient: CLIENT,
        languages: req.languages.length ? req.languages : localeLanguages(),
        transcribe: {
          when: 'always',
          quality: req.quality as TranscribeQuality,
          language: req.spoken || 'auto',
          onState: (s: SubbotState) => live(fromState(s, req.quality)),
        },
        transcriber: (t) =>
          runTranscription(t, {
            workerUrl: chrome.runtime.getURL('subbot-worker.js'),
            wasmUrl: chrome.runtime.getURL('subbot.wasm'),
            spawn: bridge(),
            cacheName: 'tsdb-subbot',
          }),
        onError: (err) => live({ phase: 'error', message: explain(err) }),
      });
      session
        .load(syntheticCandidate(req.spoken || 'auto'), { media: video })
        .then((got) => {
          if (mine !== run) return;
          if (!got) {
            if (status.phase !== 'error') live({ phase: 'error', message: 'SubBot stopped.' });
            return;
          }
          if (got.identified) {
            live({ phase: 'identified', subId: got.identified.sub_id, lang: got.identified.lang });
          } else if (status.phase !== 'identified') {
            live({ phase: 'complete', lines: countCues(got.text) });
          }
        })
        .catch((err) => live({ phase: 'error', message: explain(err) }));
      return status;
    },
    stop,
    status: () => ({ ...status }),
  };
}

/** The label SubBot's track carries, as its renderer names it. */
const LABEL = 'AI subtitles';

function fromState(s: SubbotState, quality: AiStart['quality']): AiStatus {
  switch (s.state) {
    case 'warm':
      return { phase: 'loading', step: 'engine', loaded: 0, total: 0, quality };
    case 'loading':
      return { phase: 'loading', step: s.step, loaded: s.loaded, total: s.total, quality };
    case 'listening':
      return { phase: 'listening' };
    case 'live':
      return { phase: 'live', covered: s.covered, duration: s.duration, language: s.language };
    case 'paused':
      return { phase: 'paused' };
    case 'complete':
      return { phase: 'complete', lines: s.cues };
    case 'identified':
      return { phase: 'identified', subId: s.identified.sub_id, lang: s.identified.lang };
    case 'error':
      return { phase: 'error', message: explain(s.error) };
  }
}

function explain(err: unknown): string {
  const code = (err as { code?: string } | null)?.code;
  switch (code) {
    case 'no_source':
      return 'This video has no source SubBot can read.';
    case 'audio_unreadable':
      return 'The video server would not let SubBot read the audio.';
    case 'unsupported_container':
    case 'unsupported_codec':
      return 'SubBot cannot decode this video format yet.';
    case 'no_audio_track':
      return 'This video has no sound to transcribe.';
    case 'no_webcodecs':
      return 'This browser cannot decode audio for SubBot. Update it and try again.';
    case 'model_download':
      return 'The speech model did not download. Check the connection and try again.';
    case 'aborted':
      return 'Stopped.';
    default:
      return err instanceof Error && err.message ? err.message : 'SubBot stopped.';
  }
}

function countCues(vtt: string): number {
  return (vtt.match(/-->/g) ?? []).length;
}

/**
 * Workers in the hidden extension frame, posing as local ones. Each WorkerLike is one
 * MessageChannel to the frame; the frame starts a real worker per channel and pipes it.
 */
let host: Promise<{ win: Window; token: string }> | null = null;

function frameHost(): Promise<{ win: Window; token: string }> {
  host ??= new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.src = chrome.runtime.getURL('worker.html');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'display:none!important';
    const timer = setTimeout(
      () => reject(new Error('the SubBot worker frame did not load')),
      20_000,
    );
    frame.addEventListener('load', async () => {
      try {
        const token = crypto.randomUUID();
        const ok = await chrome.runtime.sendMessage({ type: 'tsdb-token', token });
        if (ok !== true) throw new Error('the SubBot worker frame did not answer');
        clearTimeout(timer);
        resolve({ win: frame.contentWindow as Window, token });
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
    (document.body ?? document.documentElement).append(frame);
  });
  host.catch(() => {
    host = null;
  });
  return host;
}

function bridge(): Spawn {
  const origin = new URL(chrome.runtime.getURL('')).origin;
  return () => {
    const ch = new MessageChannel();
    const w: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(m, transfer = []) {
        ch.port1.postMessage({ k: 'm', m, t: transfer }, transfer);
      },
      terminate() {
        ch.port1.postMessage({ k: 't' });
        ch.port1.close();
      },
    };
    ch.port1.onmessage = (e) => {
      const d = e.data as { k: string; m?: unknown; message?: string };
      if (d.k === 'm') w.onmessage?.({ data: d.m });
      else if (d.k === 'e') w.onerror?.({ message: d.message });
    };
    frameHost()
      .then(({ win, token }) => win.postMessage({ tsdb: 'spawn', token }, origin, [ch.port2]))
      .catch((err) => w.onerror?.({ message: String(err?.message ?? err) }));
    return w;
  };
}
