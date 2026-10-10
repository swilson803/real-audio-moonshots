// MS-007 scan API, called by the Worker. Processing runs off the Worker, in
// the Processor container (src/container.js, processor/server.mjs); the
// Worker only takes the upload, queues it and reports status:
//   POST /api/scan              body: the video's soundtrack (public/music/
//                               body.js), never the picture. Stored in R2
//                               (UPLOADS, uploads/<id>), a queued
//                               ms006_scans row, a JOBS message { id }.
//                               -> 202 { id }
//   GET  /api/scans/<id>/status the upload page's poll:
//                               { status, found, matches?, error? }
//   GET  /api/scans/<id>        the /v/<id> page: a found result (200, as in
//                               MS-006), 202 { status: 'working' } while
//                               queued or working, else 404
//   handleJobs                  JOBS consumer: the container processes the
//                               upload; the result is written, the upload
//                               deleted
//   handleDeadLetters           retries used up: failed, upload deleted
//   sweep                       cron: stale jobs failed, orphan uploads deleted
// Storage: the moonshots Supabase project only (src/moonshots.js), with the
// service role, through ms006_scans (supabase/migrations). Nothing is
// readable by anon; nothing here ever talks to production.

import { getRandom } from '@cloudflare/containers';
import { FP_VERSION, SAMPLE_RATE } from '../public/music/fp.js';
import { BODY_VERSION, HEADER_BYTES, MAX_DURATION_MS, readScanHeader } from '../public/music/body.js';
import { moonshots } from './moonshots.js';

const MAX_SAMPLES = Math.ceil((MAX_DURATION_MS / 1000) * SAMPLE_RATE);
const MAX_BODY_BYTES = HEADER_BYTES + MAX_SAMPLES * 2; // ~38.5 MB
const ID_RE = /^[0-9A-Za-z]{10}$/;
const LABEL_RE = /^RA_TEST_[A-Za-z0-9._-]{1,80}$/;
const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const JOBS_DLQ = 'ms007-jobs-dlq';
// Container instances the queue spreads jobs over (max_instances in the root
// wrangler config).
export const PROCESSOR_INSTANCES = 3;
// The sweep: a job open this long is failed; an upload this old with no open
// job is deleted (the R2 lifecycle rule deletes anything left after a day).
export const STALE_JOB_MS = 15 * 60 * 1000;
export const ORPHAN_UPLOAD_MS = 30 * 60 * 1000;
export const uploadKey = (id) => `uploads/${id}`;

class BadRequest extends Error {}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

// 10 random base62 characters (rejection sampling keeps them uniform).
function newScanId() {
  let id = '';
  while (id.length < 10) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < 248 && id.length < 10) id += ID_CHARS[b % 62];
    }
  }
  return id;
}

function checkBody(buf) {
  const head = readScanHeader(buf);
  if (!head) throw new BadRequest('bad body');
  if (head.version !== BODY_VERSION || head.sampleRate !== SAMPLE_RATE) throw new BadRequest('body version mismatch: reload the page');
  if (!(head.durationMs > 0 && head.durationMs <= MAX_DURATION_MS) || head.n > MAX_SAMPLES) throw new BadRequest('video too long');
  if (!head.n) throw new BadRequest('no audio');
  return head;
}

export async function handleScan(request, env, dbOptions) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413);
  const buf = await request.arrayBuffer();
  if (buf.byteLength > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413);
  let head;
  try {
    head = checkBody(buf);
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    throw err;
  }
  const db = moonshots(env, dbOptions);
  const label = request.headers.get('x-scan-label');
  const row = {
    duration_s: Math.round(head.durationMs / 10) / 100,
    found: false,
    matches: [],
    fp_version: FP_VERSION,
    label: label && LABEL_RE.test(label) ? label : null,
    status: 'queued',
  };
  for (let attempt = 0; ; attempt++) {
    const id = newScanId();
    await env.UPLOADS.put(uploadKey(id), buf, row.label ? { customMetadata: { label: row.label } } : undefined);
    try {
      await db.insertScan({ id, ...row });
    } catch (err) {
      await env.UPLOADS.delete(uploadKey(id));
      if (attempt < 2 && /\b409\b/.test(err.message)) continue; // id collision: draw again
      throw err;
    }
    try {
      await env.JOBS.send({ id });
    } catch (err) {
      await env.UPLOADS.delete(uploadKey(id));
      await db.updateScan(id, { status: 'failed', error: 'internal' }).catch(() => {});
      throw err;
    }
    return json({ id }, 202);
  }
}

const OPEN = ['queued', 'working'];

// The upload page's poll.
export async function handleScanStatus(id, env) {
  if (!ID_RE.test(id)) return json({ error: 'not found' }, 404);
  const [row] = await moonshots(env).getScan(id);
  if (!row) return json({ error: 'not found' }, 404);
  if (OPEN.includes(row.status)) return json({ status: 'working' });
  if (row.status === 'failed') return json({ status: 'failed', error: row.error || 'internal' });
  return json(row.found ? { status: 'done', found: true, id: row.id, matches: row.matches } : { status: 'done', found: false });
}

// The result page: as MS-006 for a found scan, plus the working state.
export async function handleGetScan(id, env) {
  if (!ID_RE.test(id)) return json({ error: 'not found' }, 404);
  const [row] = await moonshots(env).getScan(id);
  if (row && OPEN.includes(row.status)) return json({ status: 'working' }, 202);
  if (!row || row.status !== 'done' || !row.found) return json({ error: 'not found' }, 404);
  return json({ id: row.id, created_at: row.created_at, duration_s: row.duration_s, matches: row.matches });
}

const backoff = (attempts) => Math.min(60, 15 * attempts);

async function fail(db, env, id, error) {
  await db.updateScan(id, { status: 'failed', error }, '&status=neq.done');
  await env.UPLOADS.delete(uploadKey(id));
}

// One queued job. The container answers 200 with the result, 422 with a
// permanent error code (unreadable / no-audio / too-long), or anything else
// for a transient failure (cold start, database busy), which is retried.
async function runJob(msg, env) {
  const { id } = msg.body;
  const db = moonshots(env);
  const [row] = ID_RE.test(id) ? await db.getScan(id) : [];
  if (!row || !OPEN.includes(row.status)) {
    await env.UPLOADS.delete(uploadKey(id));
    return msg.ack();
  }
  const upload = await env.UPLOADS.get(uploadKey(id));
  if (!upload) {
    await fail(db, env, id, 'internal');
    return msg.ack();
  }
  await db.updateScan(id, { status: 'working', attempts: (row.attempts || 0) + 1 }, '&status=in.(queued,working)');
  const container = await getRandom(env.PROCESSOR, PROCESSOR_INSTANCES);
  const res = await container.fetch(new Request('http://processor/process', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'x-scan-id': id },
    body: upload.body,
    duplex: 'half', // a streamed body (required by Node's fetch; accepted by Workers)
  }));
  if (res.status === 200) {
    const out = await res.json();
    await db.updateScan(id, {
      status: 'done', found: out.found, matches: out.matches, error: null,
      proc_ms: out.proc_ms, cpu_ms: out.cpu_ms, peak_mb: out.peak_mb, separation: Boolean(out.separation),
    }, '&status=neq.done');
    await env.UPLOADS.delete(uploadKey(id));
    return msg.ack();
  }
  if (res.status === 422) {
    const { error } = await res.json().catch(() => ({}));
    await fail(db, env, id, ['unreadable', 'no-audio', 'too-long'].includes(error) ? error : 'internal');
    return msg.ack();
  }
  throw new Error(`processor ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

export async function handleJobs(batch, env) {
  for (const msg of batch.messages) {
    try {
      await runJob(msg, env);
    } catch (err) {
      console.error('job failed, retrying', msg.body?.id, err.message);
      msg.retry({ delaySeconds: backoff(msg.attempts) });
    }
  }
}

// Retries used up (the JOBS queue's dead-letter queue).
export async function handleDeadLetters(batch, env) {
  const db = moonshots(env);
  for (const msg of batch.messages) {
    const { id } = msg.body;
    if (ID_RE.test(id)) await fail(db, env, id, 'internal').catch((err) => console.error('dead letter', id, err.message));
    else await env.UPLOADS.delete(uploadKey(id));
    msg.ack();
  }
}

// Cron (every minute, with the clearance-check sweep): jobs open past
// STALE_JOB_MS are failed (their uploads deleted); uploads older than
// ORPHAN_UPLOAD_MS with no open job are deleted.
export async function sweep(env, now = Date.now()) {
  const db = moonshots(env);
  const stale = await db.staleJobs(new Date(now - STALE_JOB_MS).toISOString());
  for (const { id } of stale) await fail(db, env, id, 'internal');
  const old = [];
  let cursor;
  do {
    const page = await env.UPLOADS.list({ prefix: 'uploads/', cursor });
    for (const o of page.objects) if (now - new Date(o.uploaded).getTime() > ORPHAN_UPLOAD_MS) old.push(o.key.slice('uploads/'.length));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  const valid = old.filter((id) => ID_RE.test(id));
  const open = new Set(valid.length ? (await db.openJobs(valid)).map((r) => r.id) : []);
  const orphans = old.filter((id) => !open.has(id));
  if (orphans.length) await env.UPLOADS.delete(orphans.map(uploadKey));
  return { failed: stale.length, deleted: orphans.length };
}
