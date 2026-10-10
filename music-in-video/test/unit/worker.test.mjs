// The Worker on Node (MS-007): upload -> R2 + queued row + queue message;
// the queue consumer -> the processor -> result row, upload deleted; status
// and result routes; dead letters; the sweep; and the clearance-check routes
// and cron passing through untouched. moonshots is a fake (the ms006_scans
// table in memory), R2 a local stand-in, the queue and the container are
// stand-ins: nothing here reaches a network or Cloudflare.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '../../src/worker.js';
import { ORPHAN_UPLOAD_MS, PROCESSOR_INSTANCES, STALE_JOB_MS, uploadKey } from '../../src/scan.js';
import { atRefineRate } from '../../src/refine.js';
import { handleProcess } from '../../processor/server.mjs';
import { scansTable } from '../fake-scans.mjs';
import { r2StandIn } from '../r2-standin.mjs';
import { bodyOf, syntheticCatalog } from '../fixtures.mjs';
import { place, slice, synthSpeech } from '../synth.mjs';

const MOONSHOTS = 'https://kucwpmtkctafzkivuqtu.supabase.co';
const STREAM = 'https://uprfsmwbsvzuoiyfgtgx.supabase.co/storage/v1/object/public/Tracks/tracks/u/';
const cat = syntheticCatalog(6, 60);
const catalogRows = cat.tracks.map((t) => ({
  tid: t.tid, track_id: `00000000-0000-0000-0000-00000000000${t.tid}`, title: `RA_TEST_title_${t.tid}`, artist: `RA_TEST_artist_${t.tid}`, stream_url: `${STREAM}${t.tid}.wav`,
}));

const requests = [];
const scans = scansTable();
let submissionsQueried = 0;
const reply = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  requests.push({ host: url.host, method: init.method || 'GET', path: url.pathname, auth: init.headers?.apikey });
  if (url.origin !== MOONSHOTS) throw new Error(`unexpected request to ${url.origin}`);
  const scanReply = scans.handle(url, init.method || 'GET', init.body ? JSON.parse(init.body) : null);
  if (scanReply) return scanReply;
  if (url.pathname === '/rest/v1/submissions') {
    submissionsQueried++;
    return reply([]);
  }
  return reply({ message: 'not found' }, 404);
};

// The processor stand-in: the real handler on the synthetic catalog. mode:
// 'ok', or a forced status for the failure paths.
const processor = { calls: 0, instances: new Set(), mode: 'ok' };
const processorDeps = {
  db: { ...cat.deps, catalog: async (tids) => catalogRows.filter((r) => tids.includes(r.tid)) },
  ref: { track: async (trackId) => atRefineRate(cat.tracks[Number(trackId.slice(-1)) - 1].audio) },
};
const PROCESSOR = {
  idFromName: (name) => name,
  get: (name) => ({
    async fetch(req) {
      processor.calls++;
      processor.instances.add(name);
      if (processor.mode === 'busy') return reply({ error: 'busy' }, 503);
      const { status, body } = await handleProcess(await req.arrayBuffer(), processorDeps);
      return reply(body, status);
    },
  }),
};

const assetPaths = [];
const uploads = await r2StandIn(await mkdtemp(join(tmpdir(), 'ms007-worker-uploads-')));
const sent = [];
const env = {
  ASSETS: { fetch: async (req) => { assetPaths.push(new URL(req.url).pathname); return new Response(`asset ${new URL(req.url).pathname}`); } },
  SUPABASE_URL: MOONSHOTS,
  SUPABASE_ANON_KEY: 'eyJanon.test',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJservice.test',
  UPLOADS: uploads,
  JOBS: { send: async (m) => { sent.push(m); } },
  PROCESSOR,
};
const call = (path, init, e = env) => worker.fetch(new Request(`https://copyrighttester.real.audio${path}`, init), e, { waitUntil() {} });
const scan = (buf, headers = {}, e = env) => call('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: buf }, e);
const message = (body, attempts = 1) => ({
  body, attempts, acked: false, retried: null,
  ack() { this.acked = true; },
  retry(o) { this.retried = o; },
});
const deliver = async (msg, queue = 'ms007-jobs') => { await worker.queue({ queue, messages: [msg] }, env, { waitUntil() {} }); return msg; };
const stored = async (id) => Boolean(await uploads.head(uploadKey(id)));

test('POST /api/scan: the soundtrack goes to R2, a queued row, a queue message; 202 with the id', async () => {
  const audio = place(synthSpeech(11, 60), slice(cat.tracks[1].audio, 5, 25), 3, -12);
  place(audio, slice(cat.tracks[4].audio, 20, 50), 28, -12);
  requests.length = 0;
  const res = await scan(bodyOf(audio), { 'x-scan-label': 'RA_TEST_two.mp4' });
  assert.equal(res.status, 202);
  const { id } = await res.json();
  assert.match(id, /^[0-9A-Za-z]{10}$/);
  assert.ok(await stored(id), 'upload stored as uploads/<id>');
  const row = scans.rows.get(id);
  assert.equal(row.status, 'queued');
  assert.equal(row.found, false);
  assert.equal(row.label, 'RA_TEST_two.mp4');
  assert.equal(row.duration_s, 60);
  assert.deepEqual(sent.at(-1), { id });
  assert.ok(requests.every((r) => r.host === 'kucwpmtkctafzkivuqtu.supabase.co' && r.auth === 'eyJservice.test'), 'the Worker only talks to moonshots, with the service key');

  // Still working: the poll says so, the result page gets 202.
  assert.deepEqual(await (await call(`/api/scans/${id}/status`)).json(), { status: 'working' });
  const early = await call(`/api/scans/${id}`);
  assert.equal(early.status, 202);
  assert.deepEqual(await early.json(), { status: 'working' });

  // The queue consumer: processed in the container, result written, upload deleted.
  const msg = await deliver(message({ id }));
  assert.ok(msg.acked);
  assert.equal(await stored(id), false, 'upload deleted after processing');
  assert.ok(PROCESSOR_INSTANCES >= processor.instances.size);
  const done = scans.rows.get(id);
  assert.equal(done.status, 'done');
  assert.equal(done.attempts, 1);
  assert.equal(done.separation, false);
  for (const k of ['proc_ms', 'cpu_ms', 'peak_mb']) assert.ok(Number.isInteger(done[k]), k);
  assert.deepEqual(done.matches.map((m) => m.title), ['RA_TEST_title_2', 'RA_TEST_title_5']);
  assert.ok(Math.abs(done.matches[0].start_s - 3) <= 1 && Math.abs(done.matches[1].start_s - 28) <= 1, JSON.stringify(done.matches));

  const status = await (await call(`/api/scans/${id}/status`)).json();
  assert.equal(status.status, 'done');
  assert.equal(status.found, true);
  assert.deepEqual(status.matches, done.matches);
  const got = await call(`/api/scans/${id}`);
  assert.equal(got.status, 200);
  const page = await got.json();
  assert.deepEqual(Object.keys(page), ['id', 'created_at', 'duration_s', 'matches'], 'the MS-006 result shape');
  assert.deepEqual(page.matches, done.matches);

  // A redelivered message for a finished job does nothing more.
  const calls = processor.calls;
  assert.ok((await deliver(message({ id }, 2))).acked);
  assert.equal(processor.calls, calls);
});

test('no catalog music: done, found false; the result page says not found; only RA_TEST_ labels kept', async () => {
  const res = await scan(bodyOf(synthSpeech(12, 40)), { 'x-scan-label': 'my holiday.mp4' });
  const { id } = await res.json();
  assert.equal(scans.rows.get(id).label, null);
  await deliver(message({ id }));
  assert.deepEqual(await (await call(`/api/scans/${id}/status`)).json(), { status: 'done', found: false });
  assert.equal((await call(`/api/scans/${id}`)).status, 404);
  assert.equal(await stored(id), false);
});

test('a busy processor (cold start, database) is retried with a delay; the upload is kept until it works', async () => {
  const { id } = await (await scan(bodyOf(synthSpeech(13, 10)))).json();
  processor.mode = 'busy';
  const msg = await deliver(message({ id }));
  assert.equal(msg.acked, false);
  assert.deepEqual(msg.retried, { delaySeconds: 15 });
  assert.equal(scans.rows.get(id).status, 'working');
  assert.ok(await stored(id));
  assert.deepEqual((await deliver(message({ id }, 5))).retried, { delaySeconds: 60 }, 'backoff capped at 60 s');
  processor.mode = 'ok';
  assert.ok((await deliver(message({ id }, 3))).acked);
  assert.equal(scans.rows.get(id).status, 'done');
  assert.equal(scans.rows.get(id).attempts, 3);
  assert.equal(await stored(id), false);
});

test('a permanent processing error fails the job with its code and deletes the upload', async () => {
  // A body that passes the Worker's checks but holds nothing usable: the
  // processor refuses it (unreadable) -> failed, no retry.
  const id = 'Unread0001';
  await uploads.put(uploadKey(id), new ArrayBuffer(4));
  scans.rows.set(id, { id, status: 'queued', attempts: 0, found: false, matches: [], updated_at: new Date().toISOString() });
  const msg = await deliver(message({ id }));
  assert.ok(msg.acked);
  assert.equal(msg.retried, null);
  assert.equal(scans.rows.get(id).status, 'failed');
  assert.equal(scans.rows.get(id).error, 'unreadable');
  assert.equal(await stored(id), false);
  assert.deepEqual(await (await call(`/api/scans/${id}/status`)).json(), { status: 'failed', error: 'unreadable' });
  assert.equal((await call(`/api/scans/${id}`)).status, 404);
});

test('dead letters (retries used up): failed, upload deleted', async () => {
  const { id } = await (await scan(bodyOf(synthSpeech(14, 10)))).json();
  const msg = await deliver(message({ id }, 5), 'ms007-jobs-dlq');
  assert.ok(msg.acked);
  assert.equal(scans.rows.get(id).status, 'failed');
  assert.equal(scans.rows.get(id).error, 'internal');
  assert.equal(await stored(id), false);
});

test('failure on the way in: nothing kept', async () => {
  // The queue is down: the row is failed and the upload deleted.
  const down = { ...env, JOBS: { send: async () => { throw new Error('queue down'); } } };
  const before = new Set(scans.rows.keys());
  const res = await scan(bodyOf(synthSpeech(15, 5)), {}, down);
  assert.equal(res.status, 502);
  const [id] = [...scans.rows.keys()].filter((k) => !before.has(k));
  assert.equal(scans.rows.get(id).status, 'failed');
  assert.equal((await uploads.list({ prefix: 'uploads/' })).objects.filter((o) => o.key === uploadKey(id)).length, 0);
  // The database refuses the row: the upload is deleted.
  const n = (await uploads.list({ prefix: 'uploads/' })).objects.length;
  const badDb = { ...env, SUPABASE_URL: 'https://kucwpmtkctafzkivuqtu.supabase.co/broken' };
  assert.equal((await scan(bodyOf(synthSpeech(15, 5)), {}, badDb)).status, 502);
  assert.equal((await uploads.list({ prefix: 'uploads/' })).objects.length, n);
});

test('the sweep: stale jobs failed, orphan uploads deleted, live ones kept', async () => {
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const put = async (id, row, ageMs) => {
    await uploads.put(uploadKey(id), new ArrayBuffer(2));
    const { utimes } = await import('node:fs/promises');
    const t = new Date(now - ageMs);
    await utimes(join(uploads.dir, uploadKey(id).replaceAll('/', '__')), t, t);
    if (row) scans.rows.set(id, { id, attempts: 1, found: false, matches: [], ...row });
  };
  await put('StaleJob01', { status: 'working', updated_at: iso(now - STALE_JOB_MS - 1000) }, STALE_JOB_MS + 1000);
  await put('LiveJob001', { status: 'working', updated_at: iso(now - 1000) }, ORPHAN_UPLOAD_MS + 1000);
  await put('Orphan0001', null, ORPHAN_UPLOAD_MS + 1000);
  await put('DoneJob001', { status: 'done', updated_at: iso(now) }, ORPHAN_UPLOAD_MS + 1000);
  await put('FreshNoRow', null, 1000);
  const jobs = [];
  await worker.scheduled({ cron: '* * * * *' }, env, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
  assert.equal(scans.rows.get('StaleJob01').status, 'failed');
  assert.equal(await stored('StaleJob01'), false);
  assert.equal(await stored('Orphan0001'), false);
  assert.equal(await stored('DoneJob001'), false);
  assert.ok(await stored('LiveJob001'), 'a job still being retried keeps its upload');
  assert.ok(await stored('FreshNoRow'), 'a fresh upload is left alone');
  for (const id of ['LiveJob001', 'FreshNoRow']) await uploads.delete(uploadKey(id));
});

test('GET /api/scans: unknown and malformed ids are 404', async () => {
  assert.equal((await call('/api/scans/Zzzzzzzzzz')).status, 404);
  assert.equal((await call('/api/scans/Zzzzzzzzzz/status')).status, 404);
  const n = requests.length;
  assert.equal((await call('/api/scans/not-an-id')).status, 404);
  assert.equal((await call('/api/scans/not-an-id/status')).status, 404);
  assert.equal(requests.length, n, 'a malformed id never reaches Supabase');
});

test('POST /api/scan rejects bad bodies; nothing is stored', async () => {
  const before = (await uploads.list({ prefix: 'uploads/' })).objects.length;
  const rows = scans.rows.size;
  const good = new Uint8Array(bodyOf(synthSpeech(16, 2)));
  const patch = (offset, value) => { const b = good.slice(); new DataView(b.buffer).setUint32(offset, value, true); return b.buffer; };
  for (const [name, buf] of [
    ['empty', new ArrayBuffer(0)],
    ['not a body', new ArrayBuffer(40)],
    ['an MS-006 fingerprint body', Int32Array.from([1, 2000, 0]).buffer],
    ['wrong version', patch(4, 2)],
    ['wrong rate', patch(8, 44100)],
    ['over 20 minutes', patch(12, 21 * 60 * 1000)],
    ['length mismatch', good.slice(0, good.length - 2).buffer],
  ]) {
    assert.equal((await scan(buf)).status, 400, name);
  }
  assert.equal((await scan(new ArrayBuffer(8), { 'Content-Length': String(40e6) })).status, 413);
  assert.equal((await call('/api/scan')).status, 404, 'GET /api/scan');
  assert.equal((await uploads.list({ prefix: 'uploads/' })).objects.length, before);
  assert.equal(scans.rows.size, rows);
});

test('scan routes: 503 naming what is missing; refuse a production URL or key; SUPABASE_SECRET_KEY works alone', async () => {
  const { SUPABASE_SERVICE_ROLE_KEY: _, ...noKey } = env;
  const r1 = await scan(bodyOf(synthSpeech(14, 5)), {}, noKey);
  assert.equal(r1.status, 503);
  assert.deepEqual((await r1.json()).missing, ['SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY']);
  const { UPLOADS: __, JOBS: ___, ...noBindings } = env;
  assert.deepEqual((await (await scan(bodyOf(synthSpeech(14, 5)), {}, noBindings)).json()).missing, ['UPLOADS', 'JOBS']);
  const n = requests.length;
  assert.equal((await scan(bodyOf(synthSpeech(14, 5)), {}, { ...env, SUPABASE_URL: 'https://uprfsmwbsvzuoiyfgtgx.supabase.co' })).status, 502);
  assert.equal(requests.length, n, 'no request to production');
  const prodKey = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ ref: 'uprfsmwbsvzuoiyfgtgx', role: 'service_role' })).toString('base64url')}.sig`;
  const { SUPABASE_SERVICE_ROLE_KEY: ____, ...secretOnly } = env;
  assert.equal((await scan(bodyOf(synthSpeech(14, 5)), {}, { ...secretOnly, SUPABASE_SECRET_KEY: prodKey })).status, 502, 'a production key is refused');
  assert.equal(requests.length, n, 'no request with a production key');
  const ok = await scan(bodyOf(synthSpeech(14, 5)), {}, { ...secretOnly, SUPABASE_SECRET_KEY: 'sb_secret_test' });
  assert.equal(ok.status, 202, 'SUPABASE_SECRET_KEY alone works');
  await deliver(message(await ok.json()));
});

test('pages: /music redirects, /v/<id> serves the result page', async () => {
  const r = await call('/music');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('Location'), 'https://copyrighttester.real.audio/music/');
  assetPaths.length = 0;
  await call('/v/Ab3dE5gH9k');
  assert.deepEqual(assetPaths, ['/v/']);
});

test('clearance-check routes pass through unchanged', async () => {
  assetPaths.length = 0;
  await call('/');
  await call('/r/2b7e1516-28ae-4d2a-9f3c-0a1b2c3d4e5f');
  await call('/styles.css');
  assert.deepEqual(assetPaths, ['/', '/r/', '/styles.css']);
  const cfg = await call('/api/config');
  assert.equal(cfg.status, 200);
  assert.deepEqual(await cfg.json(), { supabaseUrl: MOONSHOTS, anonKey: 'eyJanon.test' });
  assert.equal((await call('/api/other')).status, 404);
});

test('the cron passes through to the clearance results-email sweep (ours runs first)', async () => {
  submissionsQueried = 0;
  const jobs = [];
  await worker.scheduled({ cron: '* * * * *' }, { ...env, RESEND_API_KEY: 're_test', SITE_URL: 'https://clearance.test' }, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
  assert.equal(submissionsQueried, 1, 'the clearance sweep queried submissions');
  // Without our bindings the clearance cron still runs.
  const { UPLOADS: _, ...plain } = env;
  submissionsQueried = 0;
  const more = [];
  await worker.scheduled({ cron: '* * * * *' }, { ...plain, RESEND_API_KEY: 're_test', SITE_URL: 'https://clearance.test' }, { waitUntil: (p) => more.push(p) });
  await Promise.all(more);
  assert.equal(submissionsQueried, 1);
});

test('every upload this file made is gone', async () => {
  assert.deepEqual((await uploads.list({ prefix: 'uploads/' })).objects, []);
});
