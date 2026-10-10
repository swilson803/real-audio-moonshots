// The moonshots Supabase REST client (service role), shared by the Worker
// (src/scan.js) and the processor container (processor/server.mjs). The
// moonshots project only: a production URL or a key for another project is
// refused before any request.
import { supabaseHeaders } from '../../clearance-check/public/lib.js';
import { slicedLookup } from './match.js';

const PRODUCTION_REF = 'uprfsmwbsvzuoiyfgtgx';
const MOONSHOTS_REF = 'kucwpmtkctafzkivuqtu';

// Project ref inside a legacy JWT key (null for sb_ keys).
function jwtRef(key) {
  try {
    const b64 = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))).ref || null;
  } catch {
    return null;
  }
}

// Retries for moonshots READS (the two RPCs and the selects), per client: a
// cold database's first ms006_match can hit PostgREST's 8 s statement
// timeout (HTTP 500, code 57014) and succeed seconds later. Only transient
// failures are retried: that timeout, 502/503/504/520-524, and network
// errors. Each read gets at most ATTEMPTS tries, with BACKOFF_MS between
// them; the client as a whole gets at most RETRIES extra tries and starts no
// new try after DEADLINE_MS. Past that the processor answers busy and the
// queue retries the job later, behind the page's "Still working…".
// Writes are never retried here (the queue retries the whole job).
export const RETRY = Object.freeze({ ATTEMPTS: 3, BACKOFF_MS: [1000, 2000], RETRIES: 20, DEADLINE_MS: 40000 });

// The database stayed unavailable (transient errors) past the retry cap.
export class DbBusy extends Error {}

export function isTransient(status, body = '') {
  if ([502, 503, 504, 520, 521, 522, 523, 524].includes(status)) return true;
  return status === 500 && /57014|statement timeout/.test(body);
}

// Moonshots REST client with the service role. opts (tests): retry policy
// overrides, sleep, now. Used by the Worker and by the processor.
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
  // A read: transient failures retried within the client's cap.
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
  const minimal = { Prefer: 'return=minimal' };
  return {
    // ~60 s of video per ms006_match call (see slicedLookup in match.js).
    lookup: slicedLookup((hashes, times) => rpc('ms006_match', { p_hashes: Array.from(hashes), p_times: Array.from(times) })),
    async trackWindow(tid, from, to) {
      const [row] = await rpc('ms006_track_window', { p_tid: tid, p_from: Math.floor(from), p_to: Math.ceil(to) });
      return { hashes: row?.hashes ?? [], times: row?.times ?? [] };
    },
    catalog: (tids) => read(`ms006_catalog?tid=in.(${tids.join(',')})&select=tid,track_id,title,artist,stream_url`),
    insertScan: (row) => call('ms006_scans', { method: 'POST', headers: minimal, body: JSON.stringify(row) }),
    getScan: (id) => read(`ms006_scans?id=eq.${id}&select=id,created_at,duration_s,found,matches,status,error,attempts`),
    // where: extra PostgREST filters, e.g. '&status=neq.done' (idempotent result writes).
    updateScan: (id, patch, where = '') => call(`ms006_scans?id=eq.${id}${where}`, { method: 'PATCH', headers: minimal, body: JSON.stringify({ ...patch, updated_at: new Date(now()).toISOString() }) }),
    staleJobs: (before) => read(`ms006_scans?status=in.(queued,working)&updated_at=lt.${encodeURIComponent(before)}&select=id`),
    openJobs: (ids) => read(`ms006_scans?id=in.(${ids.join(',')})&status=in.(queued,working)&select=id`),
  };
}
