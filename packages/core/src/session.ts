import { SingleFlightCache } from './cache.js';
import { type ClientOptions, createClient, type SubtitleDbClient } from './client.js';
import { CONVERTIBLE, toVtt } from './convert.js';
import { SubtitleDbAbort, SubtitleDbError } from './errors.js';
import { type IdentifyOptions, identify, isResolvable, type MediaHint } from './identify.js';
import { baseLanguage, localeLanguages } from './languages.js';
import { type Candidate, findSubtitles, type MatchResult } from './match.js';
import {
  type LoadContext,
  type ResolvedTranscribe,
  resolveTranscribe,
  syntheticCandidate,
  type TranscribeOptions,
  type Transcriber,
} from './transcribe.js';

export interface SessionOptions {
  /** Supply a client, or let the session build one from apiBase. */
  client?: SubtitleDbClient;
  apiBase?: string;
  clientName?: string;
  fetch?: ClientOptions['fetch'];

  /**
   * Formats the host player can render itself. Required, and deliberately so: an
   * adapter that does not declare this honestly will hand its player bytes it
   * cannot parse, which shows up as a silent empty caption track rather than an
   * error, and that is the most confusing failure a subtitle plugin has.
   */
  formats: string[];

  /**
   * Convert on the client, so a player that only speaks WebVTT can still reach the
   * corpus. WebVTT is 0.036% of what we hold; srt, ass and ssa together are 94%.
   *
   * Conversion happens in load(), never in resolve(), so it costs nothing until a
   * track is chosen, and the API keeps serving exactly what is stored. Setting this
   * widens the candidate filter to every convertible format on top of `formats`.
   */
  convertTo?: 'vtt';

  /** Preference order for languages, best first. */
  languages?: string[];
  hearingImpaired?: boolean;

  /**
   * When set, the session fetches one subtitle immediately after resolving. Left off
   * by default: the eager step should stay one cacheable JSON request per player.
   *
   *   true        the top-ranked candidate.
   *   'locale'    the viewer's own languages (navigator.languages), best first. When
   *               `languages` is not also set, these are what gets fetched as well, so
   *               the candidates actually contain them. Falls back to the top
   *               candidate if the corpus has none of them.
   *   'en-US'     a pinned language, matched on the base subtag ('en-US' selects the
   *               corpus 'en', which stores no region). Pinning means that language or
   *               nothing, so there is no fallback.
   */
  autoSelect?: boolean | string;

  /**
   * Opt-in, on-device speech-to-text for a title the corpus has nothing for. Off by
   * default; `true` means every default (transformers.js, whisper-tiny.en, offered
   * only on no-match). Offering it is free: a synthetic candidate appears in the
   * picker and nothing downloads until a viewer selects it. Only offered when a
   * {@link transcriber} is also wired, so a row that cannot run is never shown.
   */
  transcribe?: boolean | TranscribeOptions;

  /**
   * The engine behind {@link transcribe}, injected so core stays free of it. The CDN
   * CDN loader wires this to a lazily loaded engine; a page bundling the
   * packages passes one built from that package. Not part of the declarative surface:
   * `transcribe` decides whether to offer, this decides what actually runs.
   */
  transcriber?: Transcriber;

  limit?: number;
  cacheTtlMs?: number;

  /**
   * Hard ceiling on API requests for the lifetime of this session. Eager loading
   * multiplies traffic by every player on every page, against an API that currently
   * has no rate limiting of its own, so the client side carries the budget.
   */
  maxRequests?: number;

  /** Called for every non-abort failure. Errors never propagate out of resolve(). */
  onError?: (err: unknown) => void;
}

export interface ResolveResult extends MatchResult {
  hint: MediaHint;
  /** Populated only when autoSelect chose and fetched something. */
  selected?: LoadedSubtitle;
}

export interface LoadedSubtitle {
  candidate: Candidate;
  /** Already converted when `convertTo` is set. */
  text: string;
  /** The format of `text`, which is not the subtitle's stored format after a conversion. */
  format: string;
  /** Set when the bytes were converted, naming what they were stored as. */
  convertedFrom?: string;
}

const DEFAULT_MAX_REQUESTS = 12;

function hintKey(hint: MediaHint, langs: string[] | undefined): string {
  return JSON.stringify([
    hint.imdbId ?? '',
    hint.tmdbId ?? '',
    hint.seriesImdbId ?? '',
    hint.title ?? '',
    hint.year ?? '',
    hint.season ?? '',
    hint.episode ?? '',
    (langs ?? []).join(','),
  ]);
}

/**
 * A resolution session bound to one player.
 *
 * Split deliberately into two phases:
 *
 *   resolve()  eager, runs on player ready and on every source change. Search only.
 *   load()     lazy, runs when a track is actually selected. Fetches bytes.
 *
 * Without that split a page with the plugin configured would pull hundreds of
 * kilobytes of subtitle text nobody asked for on every load. With it, the eager step
 * is a single JSON request that the edge can cache.
 */
export class SubtitleSession {
  readonly client: SubtitleDbClient;
  private readonly opts: SessionOptions;
  private readonly cache: SingleFlightCache<MatchResult>;
  private readonly textCache: SingleFlightCache<{ text: string; format: string }>;
  private requests = 0;
  private aborter: AbortController | null = null;
  private inflightKey: string | null = null;
  private disposed = false;
  // A session-lifetime signal, distinct from the per-resolve aborter. Transcription
  // runs on select, outlives the resolve that offered it, and can take tens of
  // seconds, so it is cancelled when the session is disposed rather than when the
  // next resolve supersedes the last.
  private readonly live = new AbortController();

  constructor(opts: SessionOptions) {
    this.opts = opts;
    this.client =
      opts.client ??
      createClient({
        ...(opts.apiBase !== undefined ? { apiBase: opts.apiBase } : {}),
        ...(opts.clientName !== undefined ? { client: opts.clientName } : {}),
        ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      });
    const ttl = opts.cacheTtlMs ?? 5 * 60_000;
    this.cache = new SingleFlightCache<MatchResult>({ ttlMs: ttl });
    this.textCache = new SingleFlightCache<{ text: string; format: string }>({ ttlMs: ttl });
  }

  /** Requests spent so far. Exposed so adapters and tests can assert the budget. */
  get requestCount(): number {
    return this.requests;
  }

  /**
   * Formats worth ranking. With conversion on this is the player's own list plus
   * everything the converter can reach, so the hard filter in match() stays a single
   * honest statement of what this session can actually render.
   */
  private renderable(): string[] {
    if (!this.opts.convertTo) return this.opts.formats;
    return [...new Set([...this.opts.formats, ...CONVERTIBLE])];
  }

  /**
   * Does the player parse this format itself?
   *
   * Case-folded on both sides: `formats` is written by hand in each adapter and the
   * API returns whatever the corpus stored, so `SRT` and `srt` reach here from
   * opposite directions and must agree.
   */
  private renders(format: string): boolean {
    const want = format.toLowerCase();
    return this.opts.formats.some((f) => f.toLowerCase() === want);
  }

  private budget(n: number): boolean {
    const max = this.opts.maxRequests ?? DEFAULT_MAX_REQUESTS;
    if (this.requests + n > max) return false;
    this.requests += n;
    return true;
  }

  private report(err: unknown): void {
    if (err instanceof SubtitleDbAbort) return;
    this.opts.onError?.(err);
  }

  /**
   * Resolve what is playing and return ranked candidates. Never throws: a failure
   * here must not break the host player, so it is reported and an empty result is
   * returned instead.
   *
   * Calling this again cancels any resolve still in flight, which is what makes it
   * safe to wire straight to a source-change event.
   */
  async resolve(input: IdentifyOptions | MediaHint = {}): Promise<ResolveResult> {
    if (this.disposed) throw new SubtitleDbError({ message: 'session disposed' });

    const hint = isIdentifyOptions(input) ? identify(input) : input;
    const empty: ResolveResult = {
      hint,
      title: null,
      candidates: [],
      tier: 'manual',
      unrenderable: 0,
      wrongEpisode: 0,
    };

    if (!isResolvable(hint)) return empty;

    const langs = this.effectiveLanguages();
    const key = hintKey(hint, langs);

    // Cancel the previous resolve only when the media actually changed. Players fire
    // ready, restart and loadedmetadata in combinations that vary by version and by
    // source, so a duplicate trigger for the same media is normal. Aborting there
    // would kill an in-flight request and report "not found" for a title that was
    // about to resolve, which is exactly the bug this guard exists to prevent.
    if (this.inflightKey !== key) {
      this.aborter?.abort();
      this.aborter = new AbortController();
      this.inflightKey = key;
    }
    const ac = this.aborter ?? new AbortController();
    this.aborter = ac;

    try {
      // Charge the budget only when this will actually hit the network. The ladder
      // costs a search plus one title fetch per preferred language, because the API
      // filters on a single language code per request and silently ignores a list.
      const cost = 1 + Math.max(1, langs?.length ?? 0);
      // A cached hit is free, and so is a duplicate that arrives while the first is
      // still in the air: single-flight collapses it into the same call. Players fire
      // ready and loadstart and loadedmetadata within a few milliseconds of each
      // other, so charging each one would exhaust the budget before a single byte of
      // subtitle had been fetched, on a page that made exactly one search.
      const willFetch = this.cache.get(key) === undefined && !this.cache.pending(key);
      if (willFetch && !this.budget(cost)) {
        this.report(
          new SubtitleDbError({ message: 'request budget exhausted', code: 'budget_exhausted' }),
        );
        return empty;
      }

      const match = await this.cache.resolve(key, () =>
        findSubtitles({
          client: this.client,
          hint,
          formats: this.renderable(),
          ...(langs !== undefined ? { languages: langs } : {}),
          ...(this.opts.hearingImpaired !== undefined
            ? { hearingImpaired: this.opts.hearingImpaired }
            : {}),
          ...(this.opts.limit !== undefined ? { limit: this.opts.limit } : {}),
          signal: ac.signal,
        }),
      );

      const result: ResolveResult = { ...match, hint };

      // Offer on-device transcription as one more row when it is configured, an engine
      // is wired to run it, and the trigger fires. It is appended last so it never
      // outranks a real subtitle, and it carries no bytes, so this stays a single
      // cacheable request: nothing downloads until the row is selected.
      const syn = this.syntheticFor(match.candidates);
      if (syn) result.candidates = [...match.candidates, syn];

      // autoSelect only ever considers real corpus candidates, never the synthetic
      // one: transcription is opt-in per click, not something to start unbidden.
      const pick = this.pickAuto(match.candidates);
      if (pick) {
        const loaded = await this.load(pick);
        if (loaded) result.selected = loaded;
      }
      return result;
    } catch (err) {
      this.report(err);
      return empty;
    } finally {
      // Release the key so a later resolve builds a fresh controller rather than
      // reusing this one, which may already be aborted.
      if (this.inflightKey === key) this.inflightKey = null;
    }
  }

  /**
   * The languages to actually fetch and rank by. The explicit list wins; otherwise
   * `autoSelect: 'locale'` fetches the viewer's own languages, because without a
   * `lang` filter the API returns the alphabetically earliest codes and the locale
   * pick would have nothing of the viewer's to choose. Undefined means no filter.
   */
  private effectiveLanguages(): string[] | undefined {
    if (this.opts.languages !== undefined) return this.opts.languages;
    if (this.opts.autoSelect === 'locale') {
      const locale = localeLanguages();
      return locale.length ? locale : undefined;
    }
    return undefined;
  }

  private pickAuto(candidates: Candidate[]): Candidate | null {
    const auto = this.opts.autoSelect;
    if (!auto || candidates.length === 0) return null;
    if (auto === true) return candidates[0] ?? null;

    // The viewer's languages, in their own order of preference. The first candidate
    // whose base language they asked for wins; if the corpus has none of them, take
    // the top candidate so autoSelect still selects rather than showing nothing.
    if (auto === 'locale') {
      for (const want of localeLanguages()) {
        const hit = candidates.find((c) => baseLanguage(c.subtitle.language) === want);
        if (hit) return hit;
      }
      return candidates[0] ?? null;
    }

    // A pinned code. Matched on the base subtag so 'en-US' selects the corpus 'en'.
    // No fallback: a pinned language means that language or nothing.
    const want = baseLanguage(auto);
    return candidates.find((c) => baseLanguage(c.subtitle.language) === want) ?? null;
  }

  /** The normalised transcription config, or null when transcription is off. */
  private transcribeConfig(): ResolvedTranscribe | null {
    return resolveTranscribe(this.opts.transcribe);
  }

  /**
   * The synthetic transcription candidate to append to this resolve, or null.
   *
   * Gated on a wired {@link SessionOptions.transcriber} as well as the config, so a
   * page that asked for transcription but never wired an engine is not shown a row
   * that would fail on click. `no-match` fires only when the corpus returned nothing
   * renderable, which is the case the fallback exists for.
   */
  private syntheticFor(candidates: Candidate[]): Candidate | null {
    if (!this.opts.transcriber) return null;
    const cfg = this.transcribeConfig();
    if (!cfg) return null;
    if (cfg.when === 'no-match' && candidates.length > 0) return null;
    return syntheticCandidate(cfg.language);
  }

  /**
   * Fetch the bytes for one candidate. This is the only call that transfers subtitle
   * text, and it happens on selection, never on load.
   *
   * A synthetic candidate has no bytes to fetch: it is transcribed instead, on the
   * device, from the media element passed in `ctx`. Everything else about the return
   * is identical, so the WebVTT it produces rides the same blob-URL path a download
   * would.
   *
   * Returns null rather than throwing so a failed download or transcription degrades
   * to "that track did not load" instead of taking the player down.
   */
  async load(candidate: Candidate, ctx?: LoadContext): Promise<LoadedSubtitle | null> {
    if (this.disposed) return null;
    if (candidate.synthetic) return this.transcribe(candidate, ctx);
    const sub = candidate.subtitle;
    const key = String(sub.id);
    // Charge only for a download that will happen. resolve() already does this for
    // itself; without the same check here an autoSelect that resolve() fetched was
    // charged a second time on the adapter's select(), and a small maxRequests
    // reported a budget it had not spent.
    const cached = this.textCache.get(key) !== undefined || this.textCache.pending(key);
    try {
      if (!cached && !this.budget(1)) {
        this.report(
          new SubtitleDbError({ message: 'request budget exhausted', code: 'budget_exhausted' }),
        );
        return null;
      }
      const got = await this.textCache.resolve(key, () => this.client.fetchSubtitleText(sub));

      // Convert after the cache, so one cached download can serve both a converting
      // and a non-converting reader of the same session.
      //
      // The test is what the player declared it renders, not whether the bytes are
      // already WebVTT. Converting everything non-VTT is not what `convert` says: it
      // rewrites ass and ssa for a player that parses them natively and throws the
      // styling away, so ArtPlayer had to ship `convert` inverted to avoid it. With
      // the test written this way `convert` means one thing for every adapter,
      // "convert what this player cannot render", and a player whose `formats`
      // already covers the file is handed the file.
      if (this.opts.convertTo === 'vtt' && !this.renders(got.format)) {
        return {
          candidate,
          text: toVtt(got.text, got.format),
          format: 'vtt',
          convertedFrom: got.format,
        };
      }
      return { candidate, text: got.text, format: got.format };
    } catch (err) {
      this.report(err);
      return null;
    }
  }

  /**
   * Run the media's own audio through the wired transcription engine and return the
   * WebVTT it produces. Cached in the text cache the same as a download, keyed by the
   * engine and model, so re-selecting the row is instant within a session and the
   * expensive part happens exactly once.
   *
   * Charges nothing against the request budget: transcription touches the engine CDN
   * and the device, never the SubtitleDB API the budget protects.
   */
  private async transcribe(
    candidate: Candidate,
    ctx?: LoadContext,
  ): Promise<LoadedSubtitle | null> {
    const cfg = this.transcribeConfig();
    const run = this.opts.transcriber;
    if (!cfg || !run) return null;

    const media = ctx?.media;
    if (!media) {
      this.report(
        new SubtitleDbError({
          message: 'transcription needs the media element, and none was provided',
          code: 'transcribe_no_media',
        }),
      );
      return null;
    }

    const onProgress =
      typeof this.opts.transcribe === 'object' ? this.opts.transcribe.onProgress : undefined;
    const key = `transcribe:${cfg.engine}:${cfg.model}`;
    try {
      const got = await this.textCache.resolve(key, () =>
        run({
          media,
          config: cfg,
          signal: this.live.signal,
          ...(onProgress ? { onProgress } : {}),
        }),
      );
      return { candidate, text: got.text, format: got.format };
    } catch (err) {
      this.report(err);
      return null;
    }
  }

  /** Cancel in-flight work and drop caches. Adapters call this on player destroy. */
  dispose(): void {
    this.disposed = true;
    this.aborter?.abort();
    this.aborter = null;
    this.live.abort();
    this.cache.clear();
    this.textCache.clear();
  }
}

function isIdentifyOptions(v: IdentifyOptions | MediaHint): v is IdentifyOptions {
  return (
    'element' in v ||
    'doc' in v ||
    'src' in v ||
    ('config' in v && !('title' in v || 'imdbId' in v))
  );
}

export function createSession(opts: SessionOptions): SubtitleSession {
  return new SubtitleSession(opts);
}
