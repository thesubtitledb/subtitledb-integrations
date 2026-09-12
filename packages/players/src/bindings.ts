import { findVideo, hasFn, hasKey, isVideoElement } from './probe.js';
import type { PlayerBinding, TrackSpec } from './types.js';

/**
 * One binding per player. Order matters: `detect` runs in registration order and
 * the first match wins, so specific shapes come before general ones and `native`
 * is last.
 *
 * No binding imports its player. Everything is structural, so this package stays
 * dependency free and keeps working across player versions that keep the surface.
 */

type Any = Record<string, unknown>;

/** Prefix on labels we own, for the players whose only handle on a track is its label. */
const SUBTITLEDB = 'SubtitleDB: ';

/**
 * The real <video> inside a custom element player.
 *
 * findVideo() duck-types on a textTracks property, and a custom element player has
 * one of its own, so it answered with the host element. Identity is then read off
 * the wrong node: the data-* hints and currentSrc a host page sets live on the
 * <video> underneath.
 */
function innerVideo(t: unknown): HTMLVideoElement | null {
  const host = t as { querySelector?: (s: string) => unknown };
  const inner = typeof host?.querySelector === 'function' ? host.querySelector('video') : null;
  return isVideoElement(inner) ? inner : findVideo(t);
}

/**
 * What this adapter published to a player that cannot tell us apart from the page.
 *
 * clear() must take back what it added and nothing else. Video.js and Vidstack both
 * hand out their whole track list, which includes the tracks the page declared in
 * markup, so removing by walking the list deleted the host page's own subtitles.
 */
const PUBLISHED = new WeakMap<object, Set<unknown>>();

function remember(target: unknown, track: unknown): unknown {
  if (!target || typeof target !== 'object' || track === undefined || track === null) return track;
  const own = PUBLISHED.get(target) ?? new Set<unknown>();
  own.add(track);
  PUBLISHED.set(target, own);
  return track;
}

function published(target: unknown): unknown[] {
  if (!target || typeof target !== 'object') return [];
  return [...(PUBLISHED.get(target) ?? [])];
}

function forget(target: unknown): void {
  if (target && typeof target === 'object') PUBLISHED.delete(target);
}

/**
 * Where one track sits in the player's own captions list.
 *
 * The index handed to `shown` counts the tracks this adapter added. Plyr and JW
 * index their own list, which also holds whatever the page declared, so on a page
 * with its own <track> the two disagree and the player selects the wrong subtitle.
 */
function captionIndex(media: unknown, track: unknown, fallback: number): number {
  const list = (media as { textTracks?: { length?: number; [i: number]: unknown } } | null)
    ?.textTracks;
  const wanted = (track as { track?: unknown } | undefined)?.track;
  if (!list || !wanted) return fallback;
  const n = list.length ?? 0;
  let seen = 0;
  for (let i = 0; i < n; i++) {
    const t = list[i] as { kind?: string } | undefined;
    if (!t) continue;
    if (t.kind !== 'subtitles' && t.kind !== 'captions') continue;
    if (t === wanted) return seen;
    seen++;
  }
  return fallback;
}
const call = (t: unknown, fn: string, ...args: unknown[]): unknown => {
  const f = (t as Any)?.[fn];
  return typeof f === 'function' ? (f as (...a: unknown[]) => unknown).call(t, ...args) : undefined;
};

// Players with their own text-track engine ----------------------------------

const videojs: PlayerBinding = {
  name: 'videojs',
  label: 'Video.js',
  // Covers everything built on Video.js: Brightcove, Cloudinary, PeerTube, Afterglow.
  detect: (t) => hasFn(t, 'addRemoteTextTrack', 'remoteTextTracks', 'textTracks'),
  // Not used to publish, only to identify what is playing when the page gives no hint.
  media: (t) => findVideo(call(t, 'el')) ?? findVideo(t),
  api: {
    add(target, spec) {
      // manualCleanup false so Video.js drops the track on a source change, which is
      // exactly when this adapter re-resolves and publishes a fresh set.
      return remember(
        target,
        call(
          target,
          'addRemoteTextTrack',
          { kind: 'subtitles', src: spec.url, srclang: spec.language, label: spec.label },
          false,
        ),
      );
    },
    show(target, added) {
      const own = (added as { track?: { mode?: string } })?.track;
      const list = call(target, 'textTracks') as { length?: number; [i: number]: Any } | undefined;
      const n = list?.length ?? 0;
      for (let i = 0; i < n; i++) {
        const track = list?.[i];
        if (!track) continue;
        if (track === own) track.mode = 'showing';
        else if (track.mode === 'showing') track.mode = 'disabled';
      }
      if (own) own.mode = 'showing';
    },
    clear(target) {
      // Only ours. remoteTextTracks() also holds the tracks Video.js registered from
      // the page's own <track> children and from options.tracks, and walking the list
      // deleted those too.
      for (const track of published(target)) call(target, 'removeRemoteTextTrack', track);
      forget(target);
    },
    events(target, onChange) {
      call(target, 'on', 'loadedmetadata', onChange);
      call(target, 'on', 'loadstart', onChange);
      return () => {
        call(target, 'off', 'loadedmetadata', onChange);
        call(target, 'off', 'loadstart', onChange);
      };
    },
  },
};

const shaka: PlayerBinding = {
  name: 'shaka',
  label: 'Shaka Player',
  // Detection rests on the three calls that survived Shaka 5, which dropped
  // setTextTrackVisibility entirely and made selecting a text track what shows it.
  detect: (t) => hasFn(t, 'addTextTrackAsync', 'selectTextTrack', 'getTextTracks'),
  media: (t) => findVideo(call(t, 'getMediaElement')) ?? findVideo(t),
  api: {
    add(target, spec) {
      return call(
        target,
        'addTextTrackAsync',
        spec.url,
        spec.language,
        'subtitles',
        'text/vtt',
        undefined,
        spec.label,
      );
    },
    show(target, added) {
      // Shaka 4 gates text behind a visibility flag under two different names across
      // its own releases. Shaka 5 has neither, so the selection is what shows it.
      if (hasFn(target, 'setTextVisibility')) call(target, 'setTextVisibility', true);
      else if (hasFn(target, 'setTextTrackVisibility'))
        call(target, 'setTextTrackVisibility', true);
      if (added) call(target, 'selectTextTrack', added);
    },
    clear() {
      // Shaka has no public removal for a side-loaded track. It drops them when the
      // manifest is unloaded, which is the only time this adapter would want them
      // gone, so there is nothing honest to do here rather than nothing useful.
    },
    events(target, onChange) {
      call(target, 'addEventListener', 'loaded', onChange);
      return () => {
        call(target, 'removeEventListener', 'loaded', onChange);
      };
    },
  },
};

const vidstack: PlayerBinding = {
  name: 'vidstack',
  label: 'Vidstack',
  detect: (t) => {
    const tracks = (t as Any)?.textTracks as Any | undefined;
    return Boolean(tracks && typeof tracks.add === 'function' && hasFn(t, 'startLoading'));
  },
  media: (t) => innerVideo(t),
  api: {
    add(target, spec) {
      const tracks = (target as Any).textTracks as Any;
      call(tracks, 'add', {
        src: spec.url,
        label: spec.label,
        language: spec.language,
        kind: 'subtitles',
        type: 'vtt',
      });
      // add() returns the list, not the track, so take the one just appended.
      const n = (tracks.length as number) ?? 0;
      return remember(target, (tracks as unknown as Record<number, unknown>)[n - 1]);
    },
    show(target, added) {
      const tracks = (target as Any).textTracks as unknown as {
        length?: number;
        [i: number]: { mode?: string };
      };
      const n = tracks.length ?? 0;
      for (let i = 0; i < n; i++) {
        const track = tracks[i];
        if (track) track.mode = track === added ? 'showing' : 'disabled';
      }
    },
    clear(target) {
      // Only ours: the list is the player's, and the page may have declared tracks of
      // its own before this adapter ever ran.
      const tracks = (target as Any).textTracks as Any;
      for (const track of published(target)) call(tracks, 'remove', track);
      forget(target);
    },
  },
};

const bitmovin: PlayerBinding = {
  name: 'bitmovin',
  label: 'Bitmovin Player',
  detect: (t) => {
    const subs = (t as Any)?.subtitles as Any | undefined;
    return Boolean(subs && typeof subs.add === 'function' && typeof subs.enable === 'function');
  },
  media: (t) => findVideo(call(t, 'getVideoElement')) ?? findVideo(t),
  api: {
    add(target, spec) {
      const id = `subtitledb-${spec.candidate.subtitle.id}`;
      call((target as Any).subtitles, 'add', {
        id,
        lang: spec.language,
        label: spec.label,
        url: spec.url,
        kind: 'subtitle',
      });
      return id;
    },
    show(target, added) {
      call((target as Any).subtitles, 'enable', added, true);
    },
    clear(target) {
      const subs = (target as Any).subtitles as Any;
      const list = (call(subs, 'list') as { id?: string }[] | undefined) ?? [];
      for (const track of list) {
        if (track.id?.startsWith('subtitledb-')) call(subs, 'remove', track.id);
      }
    },
  },
};

// Players that are a <video> plus a user interface ---------------------------

const plyr: PlayerBinding = {
  name: 'plyr',
  label: 'Plyr',
  detect: (t) => hasFn(t, 'toggleCaptions') && hasKey(t, 'media'),
  media: (t) => findVideo((t as Any).media) ?? findVideo(t),
  shown(target, index, track) {
    const apply = (): void => {
      (target as Any).currentTrack = captionIndex((target as Any).media, track, index);
      call(target, 'toggleCaptions', true);
    };
    try {
      apply();
    } catch {
      // Plyr only knows about a track once the element has dispatched addtrack, and
      // that is a task later than the append. Until then its own list is empty and
      // setting currentTrack throws inside Plyr, so retry on the other side of it.
      setTimeout(() => {
        try {
          apply();
        } catch {
          // Two failures means Plyr is not going to take this track. The element
          // path has already set the mode, so the subtitle still renders.
        }
      }, 0);
    }
  },
};

const dplayer: PlayerBinding = {
  name: 'dplayer',
  label: 'DPlayer',
  detect: (t) => hasKey(t, 'video') && hasFn(t, 'seek', 'notice'),
  media: (t) => findVideo((t as Any).video),
};

/**
 * The object that owns a Clappr player's caption list.
 *
 * A Player delegates through core.activeContainer to the playback, and only the
 * playback holds the ids. Asking whichever of the three answers keeps this working
 * when a page hands over a container instead of a player, and when Clappr moves the
 * getter again.
 */
function clapprCaptions(target: unknown): Any | null {
  const core = (target as Any | null)?.core as Any | undefined;
  for (const owner of [target as Any, core?.activeContainer as Any, core?.activePlayback as Any]) {
    try {
      if (owner && Array.isArray(owner.closedCaptionsTracks)) return owner;
    } catch {
      // A getter that reaches through a playback this player does not have yet.
    }
  }
  return null;
}

const clappr: PlayerBinding = {
  name: 'clappr',
  label: 'Clappr',
  detect: (t) => hasKey(t, 'core') && hasFn(t, 'getPlugin', 'play'),
  media: (t) => findVideo((t as Any).core) ?? findVideo(t),
  shown(target, _index, track) {
    // Clappr keeps its own record of which caption is on, and on the first play it
    // hides every track that does not match it. Nothing but its own setter writes
    // that record, so a track this adapter sets to showing is hidden a moment later
    // and the viewer sees the subtitle appear and vanish. Two details make the
    // setter cooperate: it identifies a track by position in the media element's
    // list, not by anything we can pass it, and it refuses a track that is already
    // showing, so it has to be handed one that is not.
    const owner = clapprCaptions(target);
    const wanted = (track as { track?: unknown }).track;
    const tracks = owner?.closedCaptionsTracks as { id: number; track: { mode: string } }[];
    const entry = tracks?.find((t) => t.track === wanted);
    if (!owner || !entry) return;
    entry.track.mode = 'hidden';
    try {
      owner.closedCaptionsTrackId = entry.id;
    } finally {
      // Whatever Clappr made of that, the track this adapter just showed does not get
      // left hidden by the attempt.
      if (entry.track.mode !== 'showing') entry.track.mode = 'showing';
    }
  },
};

const xgplayer: PlayerBinding = {
  name: 'xgplayer',
  label: 'xgplayer',
  detect: (t) => hasKey(t, 'video', 'root') && hasFn(t, 'play'),
  media: (t) => findVideo((t as Any).video),
};

const mediaelement: PlayerBinding = {
  name: 'mediaelement',
  label: 'MediaElement.js',
  detect: (t) => hasKey(t, 'media') && hasFn(t, 'setPlayerSize'),
  media: (t) => findVideo((t as Any).media) ?? findVideo(t),
};

const openplayerjs: PlayerBinding = {
  name: 'openplayerjs',
  label: 'OpenPlayerJS',
  detect: (t) => hasFn(t, 'getMedia', 'getElement'),
  media: (t) => findVideo(call(t, 'getElement')) ?? findVideo(call(t, 'getMedia')) ?? findVideo(t),
};

// Fluid Player has no binding on purpose. The object fluidPlayer() returns is
// { play, pause, skipTo, setPlaybackSpeed, setVolume, setHtmlOnPauseBlock,
//   toggleControlBar, toggleFullScreen, toggleMiniPlayer, destroy, dashInstance,
//   hlsInstance, on, setDebug } and holds no reference to its media element, so
// nothing can be reached from it. The binding that used to be here looked for
// domRef, which exists only on the internal object. Fluid Player renders native
// tracks, so pass it the <video> the host page already has and the native binding
// does the rest.

/** The elements Media Chrome actually hosts a player in. */
const MEDIA_CHROME_TAGS = new Set(['MEDIA-CONTROLLER', 'MEDIA-THEME', 'MEDIA-CONTAINER']);

const mediachrome: PlayerBinding = {
  name: 'mediachrome',
  label: 'Media Chrome / Mux Player',
  detect: (t) => {
    const tag = (t as Any)?.tagName;
    if (typeof tag !== 'string') return false;
    return MEDIA_CHROME_TAGS.has(tag.toUpperCase());
  },
  media: (t) => innerVideo(t),
};

const jwplayer: PlayerBinding = {
  name: 'jwplayer',
  label: 'JW Player',
  // JW publishes no library that can be fetched without an account, so unlike the
  // other three commercial players there is nothing here to run against at all.
  untested: true,
  detect: (t) => hasFn(t, 'getCaptionsList', 'setCurrentCaptions'),
  media: (t) => findVideo(call(t, 'getContainer')) ?? findVideo(t),
  shown(target, index, track) {
    // JW's caption list keeps "Off" at index 0, so its captions are offset by one.
    // Counting in the media element's own list rather than in ours keeps that offset
    // right on a page that declared tracks before this adapter ran. Still never run
    // against a real JW build.
    const media = findVideo(call(target, 'getContainer')) ?? findVideo(target);
    call(target, 'setCurrentCaptions', captionIndex(media, track, index) + 1);
  },
};

const theoplayer: PlayerBinding = {
  name: 'theoplayer',
  label: 'THEOplayer',
  // The library loads and this binding is detected against it, but THEOplayer
  // refuses every source without a licence, so publishing a track is unproven.
  untested: true,
  detect: (t) => hasKey(t, 'textTracks') && hasFn(t, 'play') && hasKey(t, 'element'),
  media: (t) => findVideo((t as Any).element),
  api: {
    // THEOplayer has no "add a track now" call. Side-loaded text is part of the
    // source description, so publishing one means re-assigning the source with the
    // track appended. Appending a <track> to its video element instead does not
    // work: THEOplayer replaces that element when the source changes, taking the
    // track with it, which is what a run against the real player showed.
    add(target, spec) {
      const player = target as Any;
      const source = player.source as { textTracks?: unknown[] } | undefined;
      if (!source) return null;

      const track = {
        src: spec.url,
        srclang: spec.language,
        label: spec.label,
        kind: 'subtitles',
        format: 'webvtt',
        default: true,
      };
      const kept = (source.textTracks ?? []).filter(
        (t) => !String((t as { label?: string }).label ?? '').startsWith(SUBTITLEDB),
      );
      const at = player.currentTime as number | undefined;

      player.source = {
        ...source,
        textTracks: [...kept, { ...track, label: SUBTITLEDB + spec.label }],
      };
      // Re-assigning the source restarts the stream, so put the viewer back.
      if (typeof at === 'number' && at > 0) player.currentTime = at;
      return track;
    },
    show(target) {
      // `default: true` on the description is what enables it. Nothing else to do,
      // and nothing to guess: THEOplayer picks the default track when it loads one.
      const list = (target as Any).textTracks as { length?: number; [i: number]: Any } | undefined;
      const n = list?.length ?? 0;
      for (let i = 0; i < n; i++) {
        const track = list?.[i];
        if (!track) continue;
        const ours = String(track.label ?? '').startsWith(SUBTITLEDB);
        track.mode = ours ? 'showing' : 'disabled';
      }
    },
    clear(target) {
      const player = target as Any;
      const source = player.source as { textTracks?: unknown[] } | undefined;
      if (!source?.textTracks) return;
      player.source = {
        ...source,
        textTracks: source.textTracks.filter(
          (t) => !String((t as { label?: string }).label ?? '').startsWith(SUBTITLEDB),
        ),
      };
    },
  },
};

/**
 * ArtPlayer, which renders subtitles itself rather than through the browser.
 *
 * The standalone `@subtitledb/artplayer` package is still the richer form: it adds
 * an entry to ArtPlayer's own settings menu, and it is what `plugins: [...]` takes.
 * This binding exists so an ArtPlayer handed to the general entry point stops
 * resolving to `native`, which was the sixteenth gap: a native <track> renders
 * through the browser's own caption layer, on top of and unstyled by the player.
 *
 * Everything below is read off the shipped build, not the docs. ArtPlayer keeps
 * exactly one subtitle, in `template.$track`, and `subtitle.url` is that element's
 * src. `switch('')` is a no-op, so there is no published removal call and clear()
 * takes back the element instead.
 */
const artplayer: PlayerBinding = {
  name: 'artplayer',
  label: 'ArtPlayer',
  // ArtPlayer parses srt and ass/ssa on its own, so it gets the file untouched.
  // Converting ASS here would hand it a WebVTT with the styling already thrown away,
  // which is worse output from more work. Same list as the standalone package.
  formats: ['srt', 'ass', 'ssa', 'vtt'],
  detect: (t) => {
    const sub = (t as Any)?.subtitle as Any | undefined;
    return typeof sub?.switch === 'function' && hasFn(t, 'on') && hasKey(t, 'template');
  },
  media: (t) => {
    const inner = ((t as Any).template as Any | undefined)?.$video ?? (t as Any).video;
    return isVideoElement(inner) ? inner : findVideo(t);
  },
  api: {
    // No way to register a track without displaying it: switch() is both calls at
    // once. So add() carries the spec through and show() does the work, which is
    // also why nothing is fetched until a subtitle is chosen.
    add: (_target, spec) => spec,
    show(target, _added, spec) {
      const sub = (target as Any).subtitle as Any | undefined;
      if (!sub) return;
      remember(target, spec);
      // `type` is not optional in practice. ArtPlayer picks its parser from
      // `type || extname(url)`, and a blob URL has no extension, so leaving it out
      // sends every file down the branch that treats the URL as WebVTT already.
      const format = spec.format.toLowerCase();
      void call(sub, 'switch', spec.url, {
        name: spec.label,
        type: format === 'ssa' ? 'ass' : format,
      });
      sub.show = true;
    },
    clear(target) {
      // Guarded on having published, because the element being removed is the one
      // ArtPlayer builds for whatever subtitle is current. On a player we never gave
      // a subtitle to, that is the page's own, and taking it away is the one thing a
      // clear() must not do.
      if (published(target).length === 0) return;
      const template = (target as Any).template as Any | undefined;
      call(template?.$track, 'remove');
      // The <track> was the only thing feeding cuechange, so without this the last
      // line ArtPlayer painted stays on screen with nothing left to clear it.
      const box = template?.$subtitle as { innerHTML?: string } | undefined;
      if (box) box.innerHTML = '';
      forget(target);
    },
    events(target, onChange) {
      const fn = () => {
        onChange();
      };
      call(target, 'on', 'restart', fn);
      return () => {
        call(target, 'off', 'restart', fn);
      };
    },
  },
};

const flowplayer: PlayerBinding = {
  name: 'flowplayer',
  label: 'Flowplayer',
  detect: (t) => hasFn(t, 'setOpts', 'togglePlay') || hasFn(t, 'toggleCaptions', 'setSrc'),
  media: (t) => findVideo(t),
};

const native: PlayerBinding = {
  name: 'native',
  label: 'HTML5 video',
  // Last resort and floor: anything with a video element anywhere inside it. This is
  // what covers hls.js, dash.js, Video-React, jPlayer, Griffith, Kaltura, Jellyfin
  // and every player nobody has written a binding for yet.
  detect: (t) => isVideoElement(t) || findVideo(t) !== null,
  media: (t) => (isVideoElement(t) ? t : findVideo(t)),
};

/** Registration order is detection order. Specific first, `native` last. */
export const BINDINGS: PlayerBinding[] = [
  videojs,
  shaka,
  vidstack,
  bitmovin,
  jwplayer,
  theoplayer,
  plyr,
  dplayer,
  clappr,
  xgplayer,
  mediaelement,
  openplayerjs,
  mediachrome,
  artplayer,
  flowplayer,
  native,
];

export function bindingByName(name: string): PlayerBinding | undefined {
  return BINDINGS.find((b) => b.name === name);
}

export function detectBinding(target: unknown): PlayerBinding | undefined {
  return BINDINGS.find((b) => {
    try {
      return b.detect(target);
    } catch {
      // A getter that throws during detection must not stop the search.
      return false;
    }
  });
}

export type { TrackSpec };
export {
  artplayer,
  bitmovin,
  clappr,
  dplayer,
  flowplayer,
  jwplayer,
  mediachrome,
  mediaelement,
  native,
  openplayerjs,
  plyr,
  shaka,
  theoplayer,
  videojs,
  vidstack,
  xgplayer,
};
