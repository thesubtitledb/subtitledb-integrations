import type { Candidate } from './match.js';
import type { ResolveResult, SubtitleSession } from './session.js';

/**
 * Which binding was used, and how the target was recognised.
 *
 * `via` exists because after the fact "the resolver found nothing" and "the resolver
 * was never reached" produce the identical symptom: no subtitles and no error. That
 * ambiguity is what let a framework wrapper silently resolve to the native binding
 * for as long as it did, so the answer is recorded on the handle rather than
 * reconstructed later.
 */
export interface PlayerInfo {
  /** Stable binding name, the same string accepted as `player: '...'`. */
  name: string;
  label: string;
  /** True when the binding is written to a published API we cannot exercise here. */
  untested: boolean;
  /** Which resolution step answered. See resolvePlayer() in @subtitledb/players. */
  via: PlayerVia;
}

/**
 * How the player was reached.
 *
 * `named`     the host page passed `player: '...'`
 * `instance`  the target is the player itself
 * `element`   the target is the media element
 * `ref`       unwrapped one framework ref, then detected
 * `descend`   found the player inside the target
 * `ascend`    found the media element, then climbed to its player
 * `native`    no player recognised; driving the element directly
 */
export type PlayerVia = 'named' | 'instance' | 'element' | 'ref' | 'descend' | 'ascend' | 'native';

/**
 * A player we can see but could not reach, where reaching it was not required.
 *
 * Only ever set for players whose subtitles are real DOM children, so the track
 * renders and it is the player's own captions menu that will not list it. Players
 * that own their text-track engine cannot degrade this way: they render nothing, so
 * they throw instead.
 */
export interface DegradedInfo {
  /** Binding name of the player we could see. */
  player: string;
  reason: 'menu';
}

/**
 * The element currently playing.
 *
 * A method rather than a captured element, deliberately. Players swap the element on
 * a source change, and a reference taken at attach time then goes stale with no
 * symptom beyond the wrong answer, which is the same class of failure as everything
 * else this handle exists to make visible.
 *
 * This is also the seam the media-observation hooks need: waveform capture,
 * requestVideoFrameCallback and frame sampling all want the live element and nothing
 * else, so shipping it now means that work needs no API change later.
 */
export type MediaRef = () => HTMLVideoElement | null;

/**
 * What every adapter in this repo hands back.
 *
 * Declared here and imported by all four, because it was three separate interfaces
 * that had already drifted: two of them carried `session` and no `player`, the third
 * carried `player` and no `session`, so "the same handle everywhere" was true of the
 * three calls they shared and of nothing else.
 */
export interface SubtitleDbHandle {
  player: PlayerInfo;
  /** Set when a player was recognised but only partially reachable. Null otherwise. */
  degraded: DegradedInfo | null;
  session: SubtitleSession;
  media: MediaRef;
  /** Force a fresh resolve. Adapters also call this on ready and on source change. */
  refresh(): Promise<ResolveResult>;
  /** Fetch one candidate, convert it if the player cannot render it, and show it. */
  select(candidate: Candidate): Promise<void>;
  /** Candidates currently offered, in menu order. */
  tracks(): Candidate[];
  /** Latest resolve result, or null before the first one completes. */
  current(): ResolveResult | null;
  destroy(): void;
}

/**
 * What a handle answers with when there is nothing to resolve against: no media, a
 * destroyed handle, or an event that arrived during teardown.
 *
 * One copy rather than the three the adapters each kept. They had already drifted
 * once: `wrongEpisode` was added to `ResolveResult` and every private copy had to be
 * found and updated, which is exactly the kind of edit that gets two of three.
 */
export const EMPTY_RESULT: ResolveResult = Object.freeze({
  hint: {},
  title: null,
  candidates: [],
  tier: 'manual',
  unrenderable: 0,
  wrongEpisode: 0,
}) as ResolveResult;
