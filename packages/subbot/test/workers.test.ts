import { describe, expect, it } from 'vitest';
import type { ToAsr } from '../src/asr/protocol.js';
import { AsrWorker, type WorkerLike } from '../src/workers.js';

/** A worker that answers by hand, so the client's bookkeeping can be watched. */
function manual() {
  const sent: ToAsr[] = [];
  const w: WorkerLike & { answer: (m: unknown) => void } = {
    onmessage: null,
    onerror: null,
    postMessage: (m) => sent.push(m as ToAsr),
    terminate: () => {},
    answer: (m) => w.onmessage?.({ data: m }),
  };
  return { w, sent };
}

const assets = { wasmUrl: 'w', modelUrl: 'm', vadUrl: null, cacheName: 'c' };

describe('AsrWorker', () => {
  it('posts init first, reports progress and resolves ready', async () => {
    const { w, sent } = manual();
    const progress: number[] = [];
    const a = new AsrWorker(
      () => w,
      assets,
      (_what, l) => progress.push(l),
      () => {},
    );
    expect(sent[0]).toMatchObject({ type: 'init', role: 'asr', modelUrl: 'm', load: true });
    w.answer({ type: 'progress', what: 'model', loaded: 5, total: 10 });
    w.answer({ type: 'ready' });
    await a.ready;
    expect(progress).toEqual([5]);
  });

  it('streams segments and settles on done, with buffers transferred', async () => {
    const { w, sent } = manual();
    const a = new AsrWorker(
      () => w,
      assets,
      () => {},
      () => {},
    );
    w.answer({ type: 'ready' });
    const got: string[] = [];
    const pcm = new Int16Array(16000);
    const p = a.transcribe(
      pcm,
      10,
      11,
      {
        language: 'en',
        translate: false,
        audioCtx: 64,
        tokenTimestamps: true,
        maxLen: 0,
        singleSegment: true,
        maxTokens: 20,
      },
      (s) => got.push(s.text),
    );
    const id = (sent[1] as { id: number }).id;
    expect(a.busy).toMatchObject({ t0: 10, t1: 11 });
    w.answer({ type: 'segment', id, segment: { t0: 10, t1: 11, text: 'hi', nsp: 0, p: 1 } });
    w.answer({
      type: 'done',
      id,
      segments: [{ t0: 10, t1: 11, text: 'hi', nsp: 0, p: 1 }],
      lang: 'en',
      ms: 5,
    });
    const r = await p;
    expect(got).toEqual(['hi']);
    expect(r.lang).toBe('en');
    expect(a.busy).toBeNull();
  });

  it('rejects a request by id on a worker error, and everything on a crash', async () => {
    const { w, sent } = manual();
    const failed: Error[] = [];
    const a = new AsrWorker(
      () => w,
      assets,
      () => {},
      (e) => failed.push(e),
    );
    w.answer({ type: 'ready' });
    const p = a.detect(new Int16Array(10));
    const id = (sent[1] as { id: number }).id;
    w.answer({ type: 'error', id, message: 'bad audio', code: 'decode_failed' });
    await expect(p).rejects.toMatchObject({ code: 'decode_failed' });
    const q = a.detect(new Int16Array(10));
    w.onerror?.({ message: 'boom' });
    await expect(q).rejects.toMatchObject({ code: 'worker_failed', message: 'boom' });
    expect(failed).toHaveLength(1);
    expect(a.dead).toBe(true);
  });

  it('rejects what is pending as aborted when stopped on purpose', async () => {
    const { w } = manual();
    const a = new AsrWorker(
      () => w,
      assets,
      () => {},
      () => {},
    );
    const ready = a.ready;
    a.terminate();
    await expect(ready).rejects.toMatchObject({ code: 'aborted' });
    await expect(a.detect(new Int16Array(1))).rejects.toMatchObject({ code: 'aborted' });
  });
});
