/**
 * worker.html: the hidden frame ai.ts puts in the page to run SubBot's workers in the
 * extension's own origin. One real worker per MessageChannel it is handed.
 *
 * The page can see this frame and post to it, so a spawn is honoured only with a token
 * the content script sent first through chrome.runtime, which the page cannot reach.
 * Without that check a page could drive a worker that fetches with the extension's
 * host access.
 */

const tokens = new Set<string>();

chrome.runtime.onMessage.addListener((m, _sender, reply) => {
  const msg = m as { type?: unknown; token?: unknown } | null;
  if (msg?.type !== 'tsdb-token' || typeof msg.token !== 'string') return false;
  tokens.add(msg.token);
  reply(true);
  return false;
});

addEventListener('message', (e: MessageEvent) => {
  const d = e.data as { tsdb?: unknown; token?: unknown } | null;
  const port = e.ports[0];
  if (d?.tsdb !== 'spawn' || typeof d.token !== 'string' || !tokens.has(d.token) || !port) return;
  const worker = new Worker('subbot-worker.js', { type: 'module' });
  worker.onmessage = (ev) => port.postMessage({ k: 'm', m: ev.data });
  worker.onerror = (ev) => {
    ev.preventDefault();
    port.postMessage({ k: 'e', message: ev.message || 'the worker failed' });
  };
  port.onmessage = (ev) => {
    const x = ev.data as { k: string; m?: unknown; t?: Transferable[] };
    if (x.k === 'm') worker.postMessage(x.m, x.t ?? []);
    else if (x.k === 't') {
      worker.terminate();
      port.close();
    }
  };
});
