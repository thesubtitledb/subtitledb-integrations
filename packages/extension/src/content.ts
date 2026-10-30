/**
 * Injected into every frame of the tab when the popup opens, and only then. It finds
 * the videos, says what is playing, and draws the subtitle the popup hands it. The
 * popup reaches it through scripting.executeScript calling `globalThis.__tsdb`, which
 * lives in the extension's isolated world: the page cannot see or call it.
 *
 * Injecting twice is harmless: the second run finds the first instance and stops.
 */
import { unreadable } from './ai-check.js';
import { type Found, pageHint } from './hint.js';
import { Overlay } from './overlay.js';
import {
  DEFAULT_STYLE,
  type FrameScan,
  KEY_STYLE,
  type Loaded,
  type LoadRequest,
  readStyle,
  type Style,
  type VideoInfo,
} from './shared.js';

export interface ContentApi {
  scan(): FrameScan;
  load(req: LoadRequest): Loaded | null;
  offset(ms: number): Loaded | null;
  hide(hidden: boolean): Loaded | null;
  clear(): void;
  /** The video behind an id, for the AI script injected beside this one. */
  element(vid: number): HTMLVideoElement | null;
  flash(vid: number): void;
  /** The text on screen now. For tests. */
  showing(): string;
}

declare global {
  var __tsdb: ContentApi | undefined;
}

if (!globalThis.__tsdb) globalThis.__tsdb = create();

function create(): ContentApi {
  const ids = new WeakMap<HTMLVideoElement, number>();
  const byId = new Map<number, WeakRef<HTMLVideoElement>>();
  let next = 1;
  let style: Style = DEFAULT_STYLE;
  let overlay: Overlay | null = null;
  let loaded: Loaded | null = null;

  chrome.storage.sync
    .get(KEY_STYLE)
    .then((got) => {
      style = readStyle(got[KEY_STYLE]);
      overlay?.setStyle(style);
    })
    .catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes[KEY_STYLE]) return;
    style = readStyle(changes[KEY_STYLE].newValue);
    overlay?.setStyle(style);
  });

  const idOf = (v: HTMLVideoElement) => {
    let id = ids.get(v);
    if (id === undefined) {
      id = next++;
      ids.set(v, id);
      byId.set(id, new WeakRef(v));
    }
    return id;
  };

  const clear = () => {
    overlay?.destroy();
    overlay = null;
    loaded = null;
  };

  const state = (): Loaded | null => (loaded && overlay ? { ...loaded } : null);

  return {
    scan() {
      const videos = findVideos(document)
        .map((v) => ({ v, r: v.getBoundingClientRect() }))
        // Hidden, tiny and ad-slot videos are not what anybody wants subtitled.
        .filter(({ r }) => r.width >= 120 && r.height >= 68)
        .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height);
      const info: VideoInfo[] = videos.map(({ v, r }) => ({
        vid: idOf(v),
        width: Math.round(r.width),
        height: Math.round(r.height),
        duration: Number.isFinite(v.duration) ? v.duration : 0,
        currentTime: v.currentTime,
        paused: v.paused,
        aiBlocked: unreadable(v),
      }));
      let found: Found = { hint: {}, strength: 0 };
      try {
        found = pageHint(document, videos[0]?.v ?? null, location.hostname);
      } catch {
        // A page that breaks the guess still gets its videos listed.
      }
      return {
        url: location.href,
        top: window === window.top,
        videos: info,
        hint: found.hint,
        strength: found.strength,
        ...(found.site ? { site: found.site } : {}),
        loaded: state(),
      };
    },

    load(req) {
      const video = byId.get(req.vid)?.deref();
      if (!video?.isConnected) return null;
      globalThis.__tsdbAi?.stop();
      clear();
      loaded = {
        vid: req.vid,
        label: req.label,
        language: req.language,
        id: req.id,
        count: req.cues.length,
        offsetMs: 0,
        hidden: false,
      };
      overlay = new Overlay(video, req.cues, style, 0, false, req.language, clear);
      return state();
    },

    offset(ms) {
      if (!loaded || !overlay) return null;
      loaded.offsetMs = Math.round(ms);
      overlay.setOffset(loaded.offsetMs);
      return state();
    },

    hide(hidden) {
      if (!loaded || !overlay) return null;
      loaded.hidden = hidden;
      overlay.setHidden(hidden);
      return state();
    },

    clear,

    element(vid) {
      const v = byId.get(vid)?.deref();
      return v?.isConnected ? v : null;
    },

    flash(vid) {
      const v = byId.get(vid)?.deref();
      if (!v) return;
      const before = v.style.outline;
      v.style.outline = '4px solid #35b7ab';
      setTimeout(() => {
        v.style.outline = before;
      }, 900);
    },

    showing() {
      return overlay?.text() ?? '';
    },
  };
}

/** Every <video> in the document, including inside open shadow roots. */
function findVideos(root: Document | ShadowRoot): HTMLVideoElement[] {
  const out = Array.from(root.querySelectorAll('video'));
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const sr = (n as Element).shadowRoot;
    if (sr) out.push(...findVideos(sr));
  }
  return out;
}
