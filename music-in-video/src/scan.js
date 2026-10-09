// MS-006 scan API, called by the Worker:
//   POST /api/scan       body: the video's fingerprint (never the video)
//   GET  /api/scans/<id> one found result, for the /v/<id> page
// Storage and lookup: the moonshots Supabase project only, with the service
// role, through the ms006_* tables and RPCs (supabase/migrations). Nothing is
// readable by anon; nothing here ever talks to production.

import { FP_VERSION, FRAMES_PER_SEC } from '../public/music/fp.js';
import { decodeScanBody } from '../public/music/body.js';
import { supabaseHeaders } from '../../clearance-check/public/lib.js';
import { match, framesToSec, slicedLookup } from './match.js';

const PRODUCTION_REF = 'uprfsmwbsvzuoiyfgtgx';
const MOONSHOTS_REF = 'kucwpmtkctafzkivuqtu';
const MAX_DURATION_MS = 20 * 60 * 1000 + 5000; // 20 minutes, plus slack for container rounding
// The QUERY fingerprint (fp.js) sends ~120 verification peaks a second of
// video (the Worker rebuilds ~200 hashes a second from them); allow about
// twice that.
const MAX_PEAKS = Math.ceil((MAX_DURATION_MS / 1000) * 300);
const MAX_BODY_BYTES = 12 + MAX_PEAKS * 4 + Math.ceil(MAX_PEAKS / 32) * 4;
const ID_RE = /^[0-9A-Za-z]{10}$/;
const LABEL_RE = /^RA_TEST_[A-Za-z0-9._-]{1,80}$/;
const ID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

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

// Body: little-endian int32s [FP_VERSION, duration_ms, n, hash x n, time x n]
// (public/music/app.js builds it).
function parseScanBody(buf) {
  const q = decodeScanBody(buf);
  if (!q) throw new BadRequest('bad body');
  if (q.version !== FP_VERSION) throw new BadRequest('fingerprint version mismatch: reload the page');
  if (!(q.durationMs > 0 && q.durationMs <= MAX_DURATION_MS)) throw new BadRequest('video too long');
  if (q.peaks.t.length > MAX_PEAKS) throw new BadRequest('bad body');
  const maxFrame = Math.ceil((q.durationMs / 1000) * FRAMES_PER_SEC) + 64;
  // Peaks are non-negative and ascending (decodeScanBody); hashes built from
  // them are in range by construction.
  if (q.peaks.t.length && q.peaks.t[q.peaks.t.length - 1] > maxFrame) throw new BadRequest('bad body');
  return { durationMs: q.durationMs, hashes: q.hashes, times: q.times, peaks: q.peaks };
}

// Project ref inside a legacy JWT key (null for sb_ keys).
function jwtRef(key) {
  try {
    const b64 = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))).ref || null;
  } catch {
    return null;
  }
}

// Retries for moonshots READS (the two RPCs and the catalog select), per
// request: a cold database's first ms006_match can hit PostgREST's 8 s
// statement timeout (HTTP 500, code 57014) and succeed seconds later. Only
// transient failures are retried: that timeout, 502/503/504/520-524, and
// network errors. Each read gets at most ATTEMPTS tries, with BACKOFF_MS
// between them; the request as a whole gets at most RETRIES extra tries
// (so a scan stays far below the Worker's 50-subrequest limit: ~20 reads +
// 20) and starts no new try after DEADLINE_MS (worst case about 50 s, well
// inside Cloudflare's 100 s). Writes (the scan row) are never retried.
export const RETRY = Object.freeze({ ATTEMPTS: 3, BACKOFF_MS: [1000, 2000], RETRIES: 20, DEADLINE_MS: 40000 });

// The database stayed unavailable (transient errors) past the retry cap.
export class DbBusy extends Error {}

export function isTransient(status, body = '') {
  if ([502, 503, 504, 520, 521, 522, 523, 524].includes(status)) return true;
  return status === 500 && /57014|statement timeout/.test(body);
}

// Moonshots REST client with the service role. opts (tests): retry policy
// overrides, sleep, now.
export function moonshots(env, { retry = RETRY, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  const base = (env.SUPABASE_URL || '').replace(/\/+$/, '');
  if (!base || base.includes(PRODUCTION_REF)) throw new Error('Refusing to talk to Real Audio production Supabase');
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;
  const ref = jwtRef(key);
  if (ref && ref !== MOONSHOTS_REF) throw new Error('Refusing a Supabase key for another project');
  const headers = { ...supabaseHeaders(key), 'Content-Type': 'application/json' };
  const deadline = now() + retry.DEADLINE_MS;
  let retriesLeft = retry.RETRIES;
  const once = async (path, init) => {
    let res;
    try {
      res = await fetch(`${base}/rest/v1/${path}`, { ...init, headers: { ...headers, ...init.headers } });
    } catch (err) {
      return { transient: true, error: `${path.split('?')[0]}: ${err.message}` };
    }
    if (res.ok) return { value: res.status === 201 || res.status === 204 ? null : await res.json() };
    const text = await res.text();
    return { transient: isTransient(res.status, text), error: `${path.split('?')[0]} ${res.status}: ${text}` };
  };
  // A write: one try.
  const call = async (path, init = {}) => {
    const r = await once(path, init);
    if ('value' in r) return r.value;
    throw new Error(r.error);
  };
  // A read: transient failures retried within the request's cap.
  const read = async (path, init = {}) => {
    for (let attempt = 1; ; attempt++) {
      const r = await once(path, init);
      if ('value' in r) return r.value;
      if (!r.transient) throw new Error(r.error);
      const wait = retry.BACKOFF_MS[Math.min(attempt - 1, retry.BACKOFF_MS.length - 1)];
      if (attempt >= retry.ATTEMPTS || retriesLeft <= 0 || now() + wait >= deadline) throw new DbBusy(r.error);
      retriesLeft--;
      console.warn(`moonshots read retry ${attempt}: ${r.error.slice(0, 160)}`);
      await sleep(wait);
    }
  };
  const rpc = (name, args) => read(`rpc/${name}`, { method: 'POST', body: JSON.stringify(args) });
  return {
    // ~60 s of video per ms006_match call (see slicedLookup in match.js).
    lookup: slicedLookup((hashes, times) => rpc('ms006_match', { p_hashes: Array.from(hashes), p_times: Array.from(times) })),
    async trackWindow(tid, from, to) {
      const [row] = await rpc('ms006_track_window', { p_tid: tid, p_from: Math.floor(from), p_to: Math.ceil(to) });
      return { hashes: row?.hashes ?? [], times: row?.times ?? [] };
    },
    catalog: (tids) => read(`ms006_catalog?tid=in.(${tids.join(',')})&select=tid,track_id,title,artist,stream_url`),
    insertScan: (row) => call('ms006_scans', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(row) }),
    getScan: (id) => read(`ms006_scans?id=eq.${id}&found=is.true&select=id,created_at,duration_s,matches`),
  };
}

export async function handleScan(request, env, dbOptions) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > MAX_BODY_BYTES) return json({ error: 'body too large' }, 413);
  let query;
  try {
    query = parseScanBody(await request.arrayBuffer());
  } catch (err) {
    if (err instanceof BadRequest) return json({ error: err.message }, 400);
    throw err;
  }
  const db = moonshots(env, dbOptions);
  const segments = await match(query, db);
  const tracks = segments.length ? await db.catalog([...new Set(segments.map((s) => s.tid))]) : [];
  const byTid = new Map(tracks.map((t) => [t.tid, t]));
  const matches = segments.filter((s) => byTid.has(s.tid)).map((s) => {
    const t = byTid.get(s.tid);
    return {
      start_s: framesToSec(s.start),
      end_s: framesToSec(s.end),
      track_id: t.track_id,
      title: t.title,
      artist: t.artist,
      stream_url: t.stream_url,
    };
  });
  const label = request.headers.get('x-scan-label');
  const row = {
    duration_s: Math.round(query.durationMs / 10) / 100,
    found: matches.length > 0,
    matches,
    fp_version: FP_VERSION,
    label: label && LABEL_RE.test(label) ? label : null,
  };
  // A no-match scan is still recorded (counts for the experiment) but gets no link.
  for (let attempt = 0; ; attempt++) {
    const id = newScanId();
    try {
      await db.insertScan({ id, ...row });
      return json(row.found ? { found: true, id, matches } : { found: false });
    } catch (err) {
      if (attempt < 2 && /\b409\b/.test(err.message)) continue; // id collision: draw again
      throw err;
    }
  }
}

export async function handleGetScan(id, env) {
  if (!ID_RE.test(id)) return json({ error: 'not found' }, 404);
  const [row] = await moonshots(env).getScan(id);
  return row ? json(row) : json({ error: 'not found' }, 404);
}
