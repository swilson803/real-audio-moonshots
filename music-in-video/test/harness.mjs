// Local harness: runs src/worker.js on Node, serving dist/ as ASSETS, with a
// fake moonshots Supabase behind it (an in-memory index of a synthetic
// catalog, same REST/RPC shapes as the migration). Nothing here talks to a
// real Supabase project.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import worker from '../src/worker.js';
import { fingerprint } from '../public/music/fp.js';
import { buildIndex, clustersInMemory, trackWindowInMemory } from '../src/match.js';
import { decodeToPcm } from '../scripts/build-catalog-index.mjs';

const MOONSHOTS = 'https://kucwpmtkctafzkivuqtu.supabase.co';
const DIST = new URL('../dist/', import.meta.url).pathname;
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.webp': 'image/webp',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

const ASSETS = {
  async fetch(req) {
    let p = decodeURIComponent(new URL(req.url).pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = join(DIST, p);
    try {
      if (!file.startsWith(DIST) || !(await stat(file)).isFile()) throw new Error('missing');
      return new Response(await readFile(file), { headers: { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' } });
    } catch {
      // Like Workers assets' auto-trailing-slash: /music -> /music/
      try {
        if ((await stat(join(DIST, p, 'index.html'))).isFile()) return Response.redirect(new URL(`${p}/`, req.url), 307);
      } catch { /* fall through */ }
      return new Response('not found', { status: 404 });
    }
  },
};

// catalog: [{ track_id, title, artist, file, stream_url }] with local audio.
export async function start({ catalog, port = Number(process.env.PORT || 8797) }) {
  const fps = [];
  const rows = [];
  for (const [i, t] of catalog.entries()) {
    const tid = i + 1;
    fps.push({ tid, ...fingerprint(await decodeToPcm(await readFile(t.file))) });
    rows.push({ tid, track_id: t.track_id, title: t.title, artist: t.artist, stream_url: t.stream_url });
  }
  const index = buildIndex(fps);
  const byTid = new Map(fps.map((f) => [f.tid, f]));
  const scans = new Map();
  const workerRequests = [];

  const reply = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    workerRequests.push(`${init.method || 'GET'} ${url.host}${url.pathname}`);
    if (url.origin !== MOONSHOTS) return realFetch(input, init);
    const path = url.pathname.replace('/rest/v1/', '');
    const body = init.body ? JSON.parse(init.body) : null;
    if (path === 'rpc/ms006_match') return reply(clustersInMemory(index, body.p_hashes, body.p_times));
    if (path === 'rpc/ms006_track_window') return reply([trackWindowInMemory(byTid, body.p_tid, body.p_from, body.p_to)]);
    if (path === 'ms006_catalog') {
      const tids = url.searchParams.get('tid').match(/\d+/g).map(Number);
      return reply(rows.filter((r) => tids.includes(r.tid)));
    }
    if (path === 'ms006_scans' && init.method === 'POST') {
      scans.set(body.id, { ...body, created_at: new Date().toISOString() });
      return reply(null, 201);
    }
    if (path === 'ms006_scans') {
      const row = scans.get(url.searchParams.get('id').replace('eq.', ''));
      return reply(row?.found ? [{ id: row.id, created_at: row.created_at, duration_s: row.duration_s, matches: row.matches }] : []);
    }
    return reply({ message: 'not found' }, 404);
  };

  const env = { ASSETS, SUPABASE_URL: MOONSHOTS, SUPABASE_ANON_KEY: 'eyJanon.test', SUPABASE_SERVICE_ROLE_KEY: 'eyJservice.test' };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const request = new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const response = await worker.fetch(request, env, { waitUntil() {} });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { origin: `http://localhost:${port}`, scans, workerRequests, close: () => new Promise((r) => server.close(r)) };
}
