// Local E2E harness: runs src/worker.js on Node with a fake ASSETS binding, a
// fake Supabase (REST + storage, same rules as MS-001) and a fake Resend.
// Nothing here talks to a real Supabase project or sends real email.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import worker from '../src/worker.js';

const PORT = Number(process.env.PORT || 8787);
const ORIGIN = `http://localhost:${PORT}`;
const PUBLIC = new URL('../public/', import.meta.url).pathname;
const ALLOWED_MIME = ['audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/x-m4a'];
const MAX = 52428800;

export const state = { rows: new Map(), objects: new Map(), emails: [], notifyCalls: 0 };

const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.webp': 'image/webp', '.ico': 'image/x-icon' };
const ASSETS = {
  async fetch(req) {
    let p = new URL(req.url).pathname;
    if (p.endsWith('/')) p += 'index.html';
    const file = join(PUBLIC, p);
    try {
      if (!(await stat(file)).isFile()) throw 0;
      return new Response(await readFile(file), { headers: { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  },
};

const env = {
  ASSETS,
  SUPABASE_URL: `${ORIGIN}/mock-sb`,
  SUPABASE_ANON_KEY: 'anon-test',
  SUPABASE_SERVICE_ROLE_KEY: 'service-test',
  RESEND_API_KEY: 're_test',
};

// Fake Resend for the Worker's outbound fetch.
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.resend.com/')) {
    state.emails.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: `email_${state.emails.length}` }), { status: 200 });
  }
  return realFetch(input, init);
};

function filters(params) {
  const f = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'limit'].includes(k)) continue;
    const [op, ...rest] = v.split('.');
    const val = rest.join('.');
    f.push((row) => (op === 'eq' ? String(row[k]) === val : op === 'is' && val === 'null' ? row[k] == null : false));
  }
  return (row) => f.every((fn) => fn(row));
}

async function mockSupabase(req, url, body) {
  const role = req.headers.authorization === 'Bearer service-test' ? 'service' : req.headers.authorization === 'Bearer anon-test' ? 'anon' : null;
  if (!role) return [401, { error: 'no key' }];
  const path = url.pathname.replace('/mock-sb', '');

  if (path.startsWith('/storage/v1/object/clearance-uploads/') && req.method === 'POST') {
    const name = path.replace('/storage/v1/object/clearance-uploads/', '');
    if (!ALLOWED_MIME.includes(req.headers['content-type'])) return [400, { error: 'mime not allowed' }];
    if (body.length > MAX) return [413, { error: 'too large' }];
    if (state.objects.has(name)) return [409, { error: 'exists' }];
    state.objects.set(name, body.length);
    return [200, { Key: `clearance-uploads/${name}` }];
  }

  if (path === '/rest/v1/submissions') {
    if (req.method === 'POST') {
      const b = JSON.parse(body.toString());
      if (!b.email || !b.storage_path) return [400, { error: 'missing' }];
      if (role === 'anon' && (b.status || b.emailed_at || b.youtube_result)) return [403, { error: 'rls' }];
      const row = {
        id: b.id || crypto.randomUUID(), created_at: new Date().toISOString(), email: b.email,
        original_filename: b.original_filename ?? b.storage_path.split('/').pop(), storage_path: b.storage_path,
        status: 'queued', emailed_at: null,
        youtube_result: 'pending', youtube_note: null, tiktok_result: 'pending', tiktok_note: null,
        instagram_result: 'pending', instagram_note: null,
      };
      state.rows.set(row.id, row);
      return [201, null];
    }
    const match = filters(url.searchParams);
    let rows = [...state.rows.values()].filter(match);
    if (role === 'anon') rows = rows.filter((r) => r.id === req.headers['x-submission-id']);
    if (req.method === 'GET') return [200, rows];
    if (req.method === 'PATCH') {
      if (role !== 'service') return [403, { error: 'permission denied' }];
      const patch = JSON.parse(body.toString());
      rows.forEach((r) => Object.assign(r, patch));
      return [200, (req.headers.prefer || '').includes('representation') ? rows : null];
    }
  }
  return [404, { error: 'mock: unknown route' }];
}

export function start() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, ORIGIN);

    if (url.pathname.startsWith('/mock-sb/')) {
      const [status, payload] = await mockSupabase(req, url, body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      return res.end(payload == null ? '' : JSON.stringify(payload));
    }
    if (url.pathname === '/test/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ rows: [...state.rows.values()], objects: [...state.objects], emails: state.emails, notifyCalls: state.notifyCalls }));
    }
    if (url.pathname === '/test/update' && req.method === 'POST') {
      const { id, ...patch } = JSON.parse(body.toString());
      Object.assign(state.rows.get(id), patch);
      res.writeHead(204);
      return res.end();
    }

    if (url.pathname === '/api/notify') state.notifyCalls++;
    const request = new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const out = await worker.fetch(request, env, { waitUntil() {} });
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  return new Promise((r) => server.listen(PORT, () => r(server)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  start().then(() => console.log(`harness on ${ORIGIN}`));
}
