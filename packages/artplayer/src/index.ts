import {
  type Candidate,
  candidateLabel,
  createSession,
  type DegradedInfo,
  handleFor,
  type LoadedSubtitle,
  type MediaHint,
  type MediaRef,
  type PlayerInfo,
  type PlayerVia,
  type ResolveResult,
  registerHandle,
  type SessionOptions,
  type SubtitleDbHandle,
  type SubtitleSession,
  subtitleMime,
  UnknownPlayerError,
} from '@subtitledb/core';

// Re-exported so a page catching this does not have to know which package raised it.
export { UnknownPlayerError };

/**
 * Structural type for the bits of ArtPlayer this adapter touches.
 *
 * Deliberately not `import Artplayer from 'artplayer'`: a structural type keeps the
 * adapter free of a build-time dependency on a specific ArtPlayer version, and the
 * surface we use is four methods wide.
 */
export interface ArtplayerLike {
  on(event: string, fn: (...args: unknown[]) => void): void;
  off?(event: string, fn: (...args: unknown[]) => void): void;
  subtitle: {
    switch(url: string, opts?: { name?: string; type?: string }): void | Promise<void>;
    show: boolean;
  };
  setting: {
    add(item: Record<string, unknown>): void;
    update?(item: Record<string, unknown>): void;
  };
  notice?: { show: string };
  video?: HTMLVideoElement;
  template?: { $video?: HTMLVideoElement };
  url?: string;
}

export interface SubtitleDbPluginOptions extends Partial<Omit<SessionOptions, 'formats'>> {
  /**
   * Formats ArtPlayer can render on its own. ArtPlayer parses srt, ass/ssa and vtt,
   * which covers roughly 94% of the corpus, so this adapter needs no conversion.
   * A format outside this list is filtered out rather than handed over broken.
   */
  formats?: string[];
  /** Explicit identity, when the host page knows it. Skips all the guessing. */
  hint?: MediaHint;
  /**
   * Convert anything this player cannot render to WebVTT in the browser. On by
   * default, the same as every other adapter here.
   *
   * It changes nothing for ArtPlayer today: `formats` above already lists srt, ass,
   * ssa and vtt, and the session only converts a format that list does not name, so
   * every file ArtPlayer can parse is handed over untouched. The option is on rather
   * than off so that one options object means one thing across the whole repo; it
   * used to be inverted here, and the reason was a session that converted every
   * non-VTT file regardless of what the player declared.
   */
  convert?: boolean;
  /** Cap on how many subtitles are offered. Same name and default as every adapter. */
  maxTracks?: number;
  /** Called after every eager resolve. Useful for custom UI. */
  onResolved?: (result: ResolveResult) => void;
  /** Called whenever a subtitle track is actually loaded and handed to the player. */
  onSelected?: (loaded: LoadedSubtitle) => void;
}

const DEFAULT_FORMATS = ['srt', 'ass', 'ssa', 'vtt'];
const SETTING_NAME = 'subtitledb';

/**
 * What this adapter reports as the player.
 *
 * `via: 'instance'` is always the truth here: this entry point takes an ArtPlayer and
 * nothing else, so there is no wrapper to unwrap and no element to climb from.
 */
const ARTPLAYER: PlayerInfo = Object.freeze({
  name: 'artplayer',
  label: 'ArtPlayer',
  untested: false,
  via: 'instance',
});

/**
 * ArtPlayer renders subtitles from a URL, so hand it a blob rather than the API URL.
 *
 * Two reasons. The session already fetched and cached the text, so pointing ArtPlayer
 * at the network would fetch it a second time and put the request outside our budget.
 * And a blob URL is same-origin by construction, which sidesteps the whole class of
 * cross-origin track failures that show up as a silently empty subtitle track.
 */
function blobUrlFor(text: string, format: string): string {
  return URL.createObjectURL(new Blob([text], { type: `${subtitleMime(format)};charset=utf-8` }));
}

/** ArtPlayer wants ass/ssa spelled "ass", and treats everything else by extension. */
function artType(format: string): string {
  return format === 'ssa' ? 'ass' : format;
}

/**
 * Attach SubtitleDB to an existing ArtPlayer instance.
 *
 * Resolution is eager: it runs when the player is ready and again on every source
 * change, not when somebody opens the subtitle menu. Subtitle bytes stay lazy and are
 * fetched only when a track is chosen, or immediately for one track when autoSelect
 * is set. That split is what keeps eager loading affordable.
 */
export function attachSubtitleDb(
  art: ArtplayerLike,
  options: SubtitleDbPluginOptions = {},
): SubtitleDbHandle {
  // Naming what was expected beats a TypeError from the first line that reaches into
  // the argument, which is what a page passing a container or a <video> used to get.
  if (!art || typeof art !== 'object' || typeof (art as ArtplayerLike).on !== 'function') {
    throw new UnknownPlayerError(
      'attachSubtitleDb expects an ArtPlayer instance. ' +
        `Received ${art === null ? 'null' : typeof art}. ` +
        'For any other player use attachSubtitleDb from @subtitledb/players.',
    );
  }

  // Every adapter here answers the second attach with the first handle, out of one
  // shared registry. Without it an ArtPlayer attached twice ran two sessions: two
  // entries in its settings menu, two resolves, two downloads on select.
  const already = handleFor(art);
  if (already) return already;

  const formats = options.formats ?? DEFAULT_FORMATS;
  const session = createSession({
    ...options,
    formats,
    ...(options.convert !== false ? { convertTo: 'vtt' as const } : {}),
  } as SessionOptions);
  const objectUrls: string[] = [];
  let latest: ResolveResult | null = null;
  let offered: Candidate[] = [];
  let destroyed = false;

  const videoEl = () => art.template?.$video ?? art.video ?? null;

  const currentSrc = (): string | undefined => {
    const el = videoEl();
    return el?.currentSrc || el?.src || art.url || undefined;
  };

  async function selectCandidate(c: Candidate): Promise<void> {
    // Read the element live for a synthetic candidate: transcription reads its audio,
    // and ArtPlayer replaces template.$video on a source switch.
    const loaded = await session.load(c, { media: videoEl() });
    if (!loaded || destroyed) return;
    const url = blobUrlFor(loaded.text, loaded.format);
    objectUrls.push(url);
    await art.subtitle.switch(url, {
      name: candidateLabel(c),
      type: artType(loaded.format),
    });
    art.subtitle.show = true;
    options.onSelected?.(loaded);
  }

  function buildMenu(result: ResolveResult): void {
    const max = options.maxTracks ?? 30;
    offered = result.candidates.slice(0, max);
    const selector = offered.map((c, i) => ({
      html: candidateLabel(c),
      default: i === 0 && Boolean(options.autoSelect),
      candidate: c,
    }));

    if (selector.length === 0) {
      // Say why there is nothing rather than showing an empty menu. The two real
      // reasons are a title we could not identify, and a title whose subtitles are
      // all in formats this player cannot render.
      const why =
        result.unrenderable > 0
          ? `no renderable subtitles (${result.unrenderable} in unsupported formats)`
          : 'no subtitles found';
      art.setting.add({ name: SETTING_NAME, html: 'SubtitleDB', tooltip: why, selector: [] });
      return;
    }

    art.setting.add({
      name: SETTING_NAME,
      html: 'SubtitleDB',
      tooltip: result.title?.name ?? 'Subtitles',
      selector,
      onSelect(item: { candidate: Candidate; html: string }) {
        void selectCandidate(item.candidate);
        return item.html;
      },
    });
  }

  async function resolveNow(): Promise<ResolveResult> {
    const result = await session.resolve(
      options.hint ?? {
        ...(videoEl() ? { element: videoEl() } : {}),
        ...(currentSrc() ? { src: currentSrc() } : {}),
      },
    );
    if (destroyed) return result;

    latest = result;
    buildMenu(result);
    if (result.selected) {
      const url = blobUrlFor(result.selected.text, result.selected.format);
      objectUrls.push(url);
      await art.subtitle.switch(url, {
        name: candidateLabel(result.selected.candidate),
        type: artType(result.selected.format),
      });
      art.subtitle.show = true;
      options.onSelected?.(result.selected);
    }
    options.onResolved?.(result);
    return result;
  }

  const onReady = () => {
    void resolveNow();
  };
  // ArtPlayer fires `restart` when the source is switched. The session caches by
  // identity, so a duplicate event costs nothing and needs no debouncing here.
  const onRestart = () => {
    void resolveNow();
  };

  art.on('ready', onReady);
  art.on('restart', onRestart);

  const handle: SubtitleDbHandle = {
    player: ARTPLAYER,
    // ArtPlayer is reached directly by this entry point, so there is no partial
    // reachability to report. The field is here so every handle has the same shape.
    degraded: null,
    session,
    // Read live rather than captured: ArtPlayer replaces `template.$video` on a
    // source switch, and a reference taken at attach time then points at a detached
    // element with no symptom other than the wrong answer.
    media: videoEl,
    tracks: () => offered,
    current: () => latest,
    refresh: resolveNow,
    select: selectCandidate,
    destroy() {
      destroyed = true;
      art.off?.('ready', onReady);
      art.off?.('restart', onRestart);
      for (const u of objectUrls) URL.revokeObjectURL(u);
      objectUrls.length = 0;
      session.dispose();
    },
  };
  // Registered under the player and under its element, so an element handed to
  // @subtitledb/html5 later finds this handle instead of starting a second session
  // on the same video.
  return registerHandle(handle, [art, videoEl()]);
}

/**
 * ArtPlayer plugin form, for `new Artplayer({ plugins: [subtitleDbPlugin(opts)] })`.
 * ArtPlayer names a plugin by the function name, hence the explicit assignment.
 */
export function subtitleDbPlugin(options: SubtitleDbPluginOptions = {}) {
  const plugin = (art: ArtplayerLike) => {
    const handle = attachSubtitleDb(art, options);
    return { name: 'subtitledb', ...handle };
  };
  Object.defineProperty(plugin, 'name', { value: 'subtitledb' });
  return plugin;
}

export type {
  Candidate,
  DegradedInfo,
  LoadedSubtitle,
  MediaHint,
  MediaRef,
  PlayerInfo,
  PlayerVia,
  ResolveResult,
  SessionOptions,
  SubtitleDbHandle,
  SubtitleSession,
};
