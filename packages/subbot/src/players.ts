/**
 * Where the bytes come from for a given element and player.
 *
 * Players that fetch segments themselves (hls.js, dash.js, Shaka) know the
 * manifest URL, and the manifest is the random-access index the backfill needs,
 * so it is read directly. Should that read fail (a request filter adds a header, a
 * custom scheme), the player's own loaded segments are forwarded instead, which
 * covers what the player buffers and no more. A plain element is read from its
 * source: a blob, or a URL with Range support.
 */
import type { SourceSpec } from './asr/protocol.js';
import { SubbotError } from './errors.js';

export interface Plan {
  spec: SourceSpec;
  /** Start forwarding the player's segments. Returns the unhook. */
  hook?: (feed: (bytes: Uint8Array, init: boolean, start: number | null) => void) => () => void;
  /** The plan to try if this one cannot be opened. */
  fallback?: Plan;
}

interface HlsLike {
  url?: string;
  on: (event: string, fn: (event: string, data: unknown) => void) => void;
  off: (event: string, fn: (event: string, data: unknown) => void) => void;
  levels?: unknown[];
}

interface DashLike {
  getSource: () => string | undefined;
  on: (event: string, fn: (e: unknown) => void) => void;
  off: (event: string, fn: (e: unknown) => void) => void;
}

interface ShakaLike {
  getAssetUri: () => string | null;
  getNetworkingEngine: () => {
    registerResponseFilter: (
      fn: (type: number, response: { data: ArrayBuffer | ArrayBufferView }) => void,
    ) => void;
    unregisterResponseFilter: (fn: unknown) => void;
  } | null;
}

function isHls(p: unknown): p is HlsLike {
  const o = p as Partial<HlsLike> | null;
  return Boolean(o && typeof o.on === 'function' && Array.isArray(o.levels) && 'url' in o);
}

function isDash(p: unknown): p is DashLike {
  const o = p as Partial<DashLike> | null;
  return Boolean(o && typeof o.getSource === 'function' && typeof o.on === 'function');
}

function isShaka(p: unknown): p is ShakaLike {
  const o = p as Partial<ShakaLike> | null;
  return Boolean(
    o && typeof o.getAssetUri === 'function' && typeof o.getNetworkingEngine === 'function',
  );
}

function manifestSpec(url: string): SourceSpec {
  const path = url.split(/[?#]/)[0] ?? url;
  if (/\.mpd$/i.test(path)) return { kind: 'dash', url };
  if (/\.m3u8$/i.test(path)) return { kind: 'hls', url };
  return { kind: 'url', url };
}

function bytesOf(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** Work out how to read the audio of `media` played by `player`. */
export function planFor(media: HTMLMediaElement, player: unknown, override?: string): Plan {
  if (override) return { spec: manifestSpec(override) };

  if (isHls(player)) {
    const feedPlan: Plan = {
      spec: { kind: 'feed', container: 'mp4' },
      hook: (feed) => {
        // hls.js remuxes everything to fMP4 before appending, TS sources included, so
        // what it appends is one container whatever the stream was.
        const fn = (_: string, data: unknown) => {
          const d = data as { type?: string; data?: Uint8Array; frag?: { start?: number } };
          if ((d.type === 'audio' || d.type === 'audiovideo') && d.data)
            feed(d.data, false, d.frag?.start ?? null);
        };
        player.on('hlsBufferAppending', fn);
        return () => player.off('hlsBufferAppending', fn);
      },
    };
    return player.url ? { spec: { kind: 'hls', url: player.url }, fallback: feedPlan } : feedPlan;
  }

  if (isDash(player)) {
    const feedPlan: Plan = {
      spec: { kind: 'feed', container: 'mp4' },
      hook: (feed) => {
        const fn = (e: unknown) => {
          const ev = e as {
            request?: { mediaType?: string; type?: string; startTime?: number };
            response?: ArrayBuffer;
          };
          if (ev.request?.mediaType !== 'audio' || !ev.response) return;
          feed(
            new Uint8Array(ev.response),
            ev.request.type === 'InitializationSegment',
            ev.request.startTime ?? null,
          );
        };
        player.on('fragmentLoadingCompleted', fn);
        return () => player.off('fragmentLoadingCompleted', fn);
      },
    };
    const url = player.getSource();
    return url ? { spec: manifestSpec(url), fallback: feedPlan } : feedPlan;
  }

  if (isShaka(player)) {
    const feedPlan: Plan = {
      spec: { kind: 'feed', container: 'mp4' },
      hook: (feed) => {
        const ne = player.getNetworkingEngine();
        if (!ne) return () => {};
        // Request type 1 is SEGMENT. Init and media segments are told apart by content.
        const fn = (type: number, response: { data: ArrayBuffer | ArrayBufferView }) => {
          if (type === 1 && response.data) feed(bytesOf(response.data), false, null);
        };
        ne.registerResponseFilter(fn);
        return () => ne.unregisterResponseFilter(fn);
      },
    };
    const url = player.getAssetUri();
    return url ? { spec: manifestSpec(url), fallback: feedPlan } : feedPlan;
  }

  const src = media.currentSrc || media.src;
  if (!src)
    throw new SubbotError('the media element has no source to read audio from', 'no_source');
  if (src.startsWith('blob:')) {
    // A blob URL is either a File the page chose (readable) or a MediaSource (not).
    return { spec: { kind: 'url', url: src } };
  }
  return { spec: manifestSpec(src) };
}
