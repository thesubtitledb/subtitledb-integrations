#!/usr/bin/env node
/**
 * Static file server for examples/. Deliberately tiny: the examples are plain ES
 * modules, so nothing needs building or transforming to serve them.
 *
 * Used by `npm run serve` for hand testing and by Playwright as its webServer.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = join(dirname(dirname(fileURLToPath(import.meta.url))), 'examples');
const port = Number(process.env.PORT ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.m4s': 'video/iso.segment',
  '.ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
};

/**
 * /archive/<item>/<file>: a file on the Internet Archive read through this origin, for
 * the bench (e2e-bench/). archive.org's /download/ honours Range but redirects to a
 * node that sends no CORS header, so SubBot's worker cannot read it directly; the
 * site reads its demo films through its own /archive/ the same way.
 */
async function archive(path, req, res) {
  const headers = { 'user-agent': 'subtitledb examples' };
  if (req.headers.range) headers.range = req.headers.range;
  const method = req.method === 'HEAD' ? 'HEAD' : 'GET';
  let up;
  // archive.org now and then ignores Range and sends the whole file, or one of its
  // nodes answers 5xx: ask again.
  for (let i = 0; i < 3; i++) {
    up = await fetch(`https://archive.org/download/${path}`, { method, headers });
    if (up.status < 500 && !(headers.range && up.status === 200)) break;
    await up.body?.cancel();
  }
  if (headers.range && up.status === 200) {
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('archive.org ignored the range');
    return;
  }
  const out = { 'access-control-allow-origin': '*', 'cache-control': 'no-store' };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = up.headers.get(h);
    if (v) out[h] = v;
  }
  res.writeHead(up.status, out);
  if (!up.body || method === 'HEAD') {
    res.end();
    return;
  }
  const body = Readable.fromWeb(up.body);
  // A media element drops a range it no longer wants; stop reading archive.org too.
  res.on('close', () => body.destroy());
  body.on('error', () => res.destroy());
  body.pipe(res);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.startsWith('/archive/')) {
      await archive(url.pathname.slice('/archive/'.length), req, res);
      return;
    }
    const rel = decodeURIComponent(url.pathname);
    // normalize collapses any ../ before it is joined, so a request cannot escape
    // the examples directory.
    const target = join(root, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    const path = rel.endsWith('/') ? join(target, 'index.html') : target;

    const info = await stat(path);
    if (info.isDirectory()) {
      res.writeHead(302, { location: `${rel}/` });
      res.end();
      return;
    }

    const type = TYPES[extname(path)] ?? 'application/octet-stream';
    // Byte ranges, because a media element cannot seek without them: it reports a
    // seekable range of nothing at all and every currentTime lands back at zero. The
    // e2e suite seeks to the first cue to prove a subtitle is on screen, and a host
    // page serving media has to do this too.
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
    if (range && info.size > 0) {
      const last = info.size - 1;
      const suffix = range[1] === '';
      const start = suffix ? Math.max(0, info.size - Number(range[2])) : Number(range[1]);
      const end = suffix || range[2] === '' ? last : Math.min(Number(range[2]), last);
      if (!Number.isFinite(start) || start > end) {
        res.writeHead(416, { 'content-range': `bytes */${info.size}` });
        res.end();
        return;
      }
      res.writeHead(206, {
        'content-type': type,
        'content-length': end - start + 1,
        'content-range': `bytes ${start}-${end}/${info.size}`,
        'accept-ranges': 'bytes',
        'cache-control': 'no-store',
      });
      createReadStream(path, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, {
      'content-type': type,
      'content-length': info.size,
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
    });
    createReadStream(path).pipe(res);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
});

server.listen(port, () => {
  console.log(`examples on http://localhost:${port}/`);
});
