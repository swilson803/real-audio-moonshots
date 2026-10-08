// Runs src/worker.js on Node behind a local HTTP server, serving dist/ as its
// ASSETS binding (like Workers assets, incl. /music -> /music/). Used by the
// synthetic harness (fake moonshots) and test/e2e-real.mjs (real moonshots).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import worker from '../src/worker.js';

const DIST = new URL('../dist/', import.meta.url).pathname;
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.webp': 'image/webp',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

export const ASSETS = {
  async fetch(req) {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(DIST, p);
    try {
      if (!file.startsWith(DIST) || !(await stat(file)).isFile()) throw new Error('missing');
      return new Response(await readFile(file), { headers: { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' } });
    } catch {
      try {
        if ((await stat(join(DIST, p, 'index.html'))).isFile()) return Response.redirect(new URL(`${p}/`, req.url), 307);
      } catch { /* fall through */ }
      return new Response('not found', { status: 404 });
    }
  },
};

// env: the Worker's bindings, without ASSETS (added here).
// port 0 (default, unless PORT is set) lets the OS pick a free one.
export async function serveWorker({ env, port = Number(process.env.PORT || 0) }) {
  const bindings = { ...env, ASSETS };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://localhost:${server.address().port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const response = await worker.fetch(request, bindings, { waitUntil() {} });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { origin: `http://localhost:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
