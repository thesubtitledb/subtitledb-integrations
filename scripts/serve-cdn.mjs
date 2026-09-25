#!/usr/bin/env node
/**
 * Serves the built `cdn/` tree, on a different port from the examples.
 *
 * The port is the point. Everything this loader does that is hard to get right is
 * cross-origin: the CORS check on a module fetch, the resource policy a COEP page
 * enforces, and the fact that a classic script resolves `import()` against the page
 * rather than against itself. Serving the loader from the same origin as the page
 * that uses it passes all three by accident and proves none of them.
 *
 * Headers come from `packages/loader/public/_headers`, the same file Cloudflare Pages
 * reads, rather than from a copy here. A copy would be a second place to update and
 * the first one to be forgotten, and the failure it hides only appears in production.
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dir = join(root, 'cdn');
const port = Number(process.env.CDN_PORT ?? 4174);

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
};

/**
 * Cloudflare's `_headers` format, only as far as this needs it: an unindented line is
 * a path pattern, an indented one is a header for the pattern above it, and `*` is
 * the only wildcard used here.
 */
function parseHeaders(text) {
  const rules = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      current = { pattern: line.trim(), headers: {} };
      rules.push(current);
      continue;
    }
    const at = line.indexOf(':');
    if (at < 0 || !current) continue;
    current.headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return rules;
}

const rules = parseHeaders(await readFile(join(root, 'packages/loader/public/_headers'), 'utf8'));

const literal = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function headersFor(path) {
  const out = {};
  for (const rule of rules) {
    const re = new RegExp(`^${rule.pattern.split('*').map(literal).join('.*')}$`);
    if (re.test(path)) Object.assign(out, rule.headers);
  }
  return out;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = decodeURIComponent(url.pathname);
  // normalize collapses any ../ before it is joined, so a request cannot escape the
  // served directory.
  const path = join(dir, normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  try {
    const info = await stat(path);
    if (info.isDirectory()) throw new Error('directory');
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'content-length': info.size,
      ...headersFor(rel),
    });
    createReadStream(path).pipe(res);
  } catch {
    // Deliberately HTML, because that is what a real CDN 404 is, and a module that
    // gets HTML back fails with a parse error rather than a status. The loader's own
    // message exists to survive exactly this, so the test has to reproduce it.
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>404</title>not found');
  }
});

server.listen(port, () => {
  console.log(`cdn on http://localhost:${port}/`);
});
