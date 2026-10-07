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
// Mock bucket limit: 50 MB like MS-001's migration; tests can raise it.
let MAX = 52428800;
export const setBucketLimit = (n) => { MAX = n; };

export const state = { rows: new Map(), objects: new Map(), emails: [] };

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

// KEY_STYLE=new uses sb_publishable_/sb_secret_ keys (not JWTs) under the
// new secret names; default is legacy anon/service_role JWTs.
export const KEYS = process.env.KEY_STYLE === 'new'
  ? { anon: 'sb_publishable_test', service: 'sb_secret_test' }
  : { anon: 'eyJanon.test', service: 'eyJservice.test' };
export const env = {
  ASSETS,
  SUPABASE_URL: `${ORIGIN}/mock-sb`,
  ...(process.env.KEY_STYLE === 'new'
    ? { SUPABASE_PUBLISHABLE_KEY: KEYS.anon, SUPABASE_SECRET_KEY: KEYS.service }
    : { SUPABASE_ANON_KEY: KEYS.anon, SUPABASE_SERVICE_ROLE_KEY: KEYS.service }),
  RESEND_API_KEY: 're_test',
  // Fake site origin: result links in emails must come from SITE_URL, never
  // from a request (the cron has none).
  SITE_URL: 'https://clearance.test',
};

// Run the Worker's cron once and wait for everything it scheduled.
export async function runCron(e = env) {
  const jobs = [];
  await worker.scheduled({ cron: '* * * * *' }, e, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
}

// Fake Resend for the Worker's outbound fetch. failResend(n) makes the next n
// sends fail with a 500 (nothing delivered).
let resendFailures = 0;
export const failResend = (n) => { resendFailures = n; };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://api.resend.com/')) {
    if (resendFailures > 0) {
      resendFailures--;
      return new Response(JSON.stringify({ message: 'fake outage' }), { status: 500 });
    }
    state.emails.push({ ...JSON.parse(init.body), idempotencyKey: init.headers?.['Idempotency-Key'] ?? null });
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
  // Like the Supabase gateway: the key is read from apikey. A Bearer token must
  // be a JWT (a non-JWT sb_ key as Bearer is rejected) matching that key.
  const key = req.headers.apikey;
  const role = key === KEYS.service ? 'service' : key === KEYS.anon ? 'anon' : null;
  if (!role) return [401, { error: 'no key' }];
  const auth = req.headers.authorization;
  if (auth && (!auth.startsWith('Bearer eyJ') || auth !== `Bearer ${key}`)) return [401, { error: 'Invalid JWT' }];
  const path = url.pathname.replace('/mock-sb', '');

  if (path.startsWith('/storage/v1/object/clearance-uploads/') && req.method === 'POST') {
    const name = path.replace('/storage/v1/object/clearance-uploads/', '');
    if (!ALLOWED_MIME.includes(req.headers['content-type'])) return [400, { error: 'mime not allowed' }];
    // Reject13: match real Supabase storage oversize (HTTP 400 + EntityTooLarge body)
    if (body.length > MAX) return [400, {
      statusCode: '413',
      error: 'Payload too large',
      message: 'The object exceeded the maximum allowed size',
      code: 'EntityTooLarge',
    }];
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
      return res.end(JSON.stringify({ rows: [...state.rows.values()], objects: [...state.objects], emails: state.emails }));
    }
    if (url.pathname === '/test/update' && req.method === 'POST') {
      const { id, ...patch } = JSON.parse(body.toString());
      Object.assign(state.rows.get(id), patch);
      res.writeHead(204);
      return res.end();
    }

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
