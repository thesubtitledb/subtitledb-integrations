#!/usr/bin/env node
/**
 * Serves the e2e pages and the Sintel clip SubBot's own tests use, with Range support
 * so the video can seek. Run by both the Chromium and the Firefox suites.
 *
 *   node e2e/server.mjs [port]   default 4180
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOTS = {
  '/media/': join(here, '../../subbot/test/media/'),
  '/': join(here, 'pages/'),
};
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.srt': 'text/plain; charset=utf-8',
};

export function serve(port = 4180) {
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    const [prefix, dir] = Object.entries(ROOTS).find(([p]) => path.startsWith(p)) ?? [];
    const rel = normalize(path.slice(prefix.length) || 'index.html');
    if (rel.startsWith('..')) return void res.writeHead(403).end();
    const file = join(dir, rel);
    let size = 0;
    try {
      size = (await stat(file)).size;
    } catch {
      return void res.writeHead(404).end('not found');
    }
    const headers = {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'no-store',
      // SubBot fetches the clip from the page's own origin and from the iframe's.
      'access-control-allow-origin': '*',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range) {
      const start = range[1] ? Number(range[1]) : size - Number(range[2]);
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      res.writeHead(206, {
        ...headers,
        'content-range': `bytes ${start}-${end}/${size}`,
        'content-length': end - start + 1,
      });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': size });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, () => ok(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] ?? process.env.PORT ?? 4180);
  await serve(port);
  console.log(`e2e pages on http://localhost:${port}/`);
}
