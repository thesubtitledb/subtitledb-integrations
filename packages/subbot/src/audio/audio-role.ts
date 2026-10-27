/**
 * The audio role of the worker: open the source, answer windows of 16 kHz PCM.
 *
 * Demuxing and the WebCodecs decode both live here so the page's thread never holds
 * a sample table or a cluster. A window is decoded from a short lead-in so the
 * codec's overlap has something to overlap, and the lead-in is trimmed off.
 */
import type { FromAudio, SourceSpec, ToAudio } from '../asr/protocol.js';
import { SubbotError } from '../errors.js';
import { canDecode, hasWebCodecs, PcmDecoder } from './decode.js';
import { FeedSource, openBlob, openUrl, SegmentedSource, type Source } from './sources.js';

type Post = (m: FromAudio, transfer?: Transferable[]) => void;

/** Frames before the window that the decoder sees and the caller does not. */
const LEAD_IN = 0.25;

export class AudioRole {
  private source: Source | null = null;
  private decoder: PcmDecoder | null = null;
  private language: string | undefined;

  constructor(private readonly post: Post) {}

  /** Reads go one at a time: the decoder is one instance, and two in flight would
   * hand each other's samples back. */
  private chain: Promise<void> = Promise.resolve();

  async handle(m: ToAudio): Promise<void> {
    if (m.type === 'read') {
      const run = () => this.guarded(m);
      this.chain = this.chain.then(run, run);
      return;
    }
    await this.guarded(m);
  }

  private async guarded(m: ToAudio): Promise<void> {
    try {
      if (m.type === 'init') await this.init(m.source, m.language);
      else if (m.type === 'read') await this.read(m.id, m.t0, m.t1);
      else if (m.type === 'feed') this.feed(m.bytes, m.init, m.start);
      else if (m.type === 'trim') this.source?.trim?.(m.keep);
    } catch (err) {
      const id = 'id' in m ? m.id : undefined;
      const code = err instanceof SubbotError ? err.code : undefined;
      this.post({
        type: 'error',
        id,
        message: err instanceof Error ? err.message : String(err),
        code,
      });
    }
  }

  private async init(spec: SourceSpec, language?: string): Promise<void> {
    this.language = language;
    // fetch is a method of the global: handed over bare and called as a property of
    // a source it throws "Illegal invocation". A wrapper keeps the receiver.
    const fetchFn: typeof fetch = (input, init) => fetch(input, init);
    if (spec.kind === 'blob') this.source = await openBlob(spec.blob, language, fetchFn);
    else if (spec.kind === 'url') this.source = await openUrl(spec.url, language, fetchFn);
    else if (spec.kind === 'hls')
      this.source = await new SegmentedSource('hls', fetchFn, language).openHls(spec.url);
    else if (spec.kind === 'dash')
      this.source = await new SegmentedSource('dash', fetchFn, language).openDash(spec.url);
    else this.source = new FeedSource(spec.container, language);
    if (this.source.random) await this.decoderFor();
    this.opened();
  }

  private opened(): void {
    const s = this.source as Source;
    if (!s.codec) return;
    this.post({
      type: 'opened',
      duration: s.duration,
      codec: s.codec,
      container: s.container,
      random: s.random,
    });
  }

  private async decoderFor(): Promise<PcmDecoder> {
    if (this.decoder) return this.decoder;
    const s = this.source as Source;
    if (!hasWebCodecs()) {
      throw new SubbotError('this browser has no WebCodecs audio decoder', 'no_webcodecs');
    }
    if (!(await canDecode(s.codec))) {
      throw new SubbotError(
        `this browser cannot decode ${s.codec.codec} (${s.codec.kind}) audio`,
        'unsupported_codec',
      );
    }
    this.decoder = new PcmDecoder(s.codec);
    return this.decoder;
  }

  private feed(bytes: Uint8Array, init: boolean, start: number | null): void {
    const s = this.source;
    if (!s?.feed) return;
    const had = Boolean(s.codec);
    s.feed(bytes, init, start);
    if (!had && s.codec) {
      // The first init segment names the codec; only now is there anything to open.
      void this.decoderFor().then(
        () => this.opened(),
        (err) =>
          this.post({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
            code: err instanceof SubbotError ? err.code : undefined,
          }),
      );
    }
    this.post({ type: 'coverage', spans: s.coverage() });
    void this.language;
  }

  private async read(id: number, t0: number, t1: number): Promise<void> {
    const s = this.source;
    if (!s) throw new SubbotError('read before open', 'no_source');
    const dec = await this.decoderFor();
    const from = Math.max(0, t0 - LEAD_IN);
    const chunks = await s.chunks(from, t1);
    const { t0: at, pcm } = await dec.decode(chunks, t0);
    this.post({ type: 'pcm', id, t0: at, pcm }, [pcm.buffer]);
  }
}
