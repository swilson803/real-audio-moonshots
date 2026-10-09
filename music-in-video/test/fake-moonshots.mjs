// A fake moonshots Supabase for local runs: replaces globalThis.fetch with an
// in-memory index of a synthetic catalog behind the same REST/RPC shapes as
// the migration. Production public Tracks audio (GET/HEAD) is answered from
// the local files; the local test server is passed through; any other host
// throws, so a run using it is offline.
import { readFile, stat } from 'node:fs/promises';
import { fingerprint } from '../public/music/fp.js';
import { buildIndex, clustersInMemory, trackWindowInMemory } from '../src/match.js';
import { decodeToPcm } from '../scripts/build-catalog-index.mjs';

export const MOONSHOTS = 'https://kucwpmtkctafzkivuqtu.supabase.co';
const PROD_TRACKS_PREFIX = 'https://uprfsmwbsvzuoiyfgtgx.supabase.co/storage/v1/object/public/Tracks/';

// catalog: [{ track_id, title, artist, file, stream_url }] with local audio.
export async function installFakeMoonshots({ catalog }) {
  const fps = [];
  const rows = [];
  for (const [i, t] of catalog.entries()) {
    const tid = i + 1;
    fps.push({ tid, ...fingerprint(await decodeToPcm(t.file)) });
    rows.push({ tid, track_id: t.track_id, title: t.title, artist: t.artist, stream_url: t.stream_url });
  }
  const index = buildIndex(fps);
  const byTid = new Map(fps.map((f) => [f.tid, f]));
  const scans = new Map();
  const workerRequests = [];

  // Cold-start simulation: the next `next` ms006_match calls (or every call,
  // with always) wait delayMs, then fail the way PostgREST does when the
  // statement timeout cancels the query.
  const timeouts = { next: 0, always: false, delayMs: 0, served: 0 };
  const control = {
    statementTimeouts({ next = 0, always = false, delayMs = 0 } = {}) {
      Object.assign(timeouts, { next, always, delayMs, served: 0 });
    },
    get timeoutsServed() { return timeouts.served; },
    get matchCalls() { return workerRequests.filter((r) => r.endsWith('/rest/v1/rpc/ms006_match')).length; },
    get scanInserts() { return workerRequests.filter((r) => r === `POST ${new URL(MOONSHOTS).host}/rest/v1/ms006_scans`).length; },
  };
  const reply = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const localFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const href = typeof input === 'string' ? input : input.url;
    const url = new URL(href);
    const method = init.method || 'GET';
    workerRequests.push(`${method} ${url.host}${url.pathname}`);
    if (href.startsWith(PROD_TRACKS_PREFIX)) {
      const t = catalog.find((c) => decodeURI(c.stream_url) === decodeURI(href));
      if (!t || !['GET', 'HEAD'].includes(method)) return new Response(null, { status: 404 });
      const size = (await stat(t.file)).size;
      return new Response(method === 'HEAD' ? null : await readFile(t.file), { status: 200, headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(size) } });
    }
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return localFetch(input, init);
    if (url.origin !== MOONSHOTS) throw new Error(`fake moonshots: network blocked (${url.host})`);
    const path = url.pathname.replace('/rest/v1/', '');
    const body = init.body ? JSON.parse(init.body) : null;
    if (path === 'rpc/ms006_match') {
      if (timeouts.always || timeouts.next > 0) {
        if (timeouts.next > 0) timeouts.next--;
        timeouts.served++;
        if (timeouts.delayMs) await new Promise((r) => setTimeout(r, timeouts.delayMs));
        return reply({ code: '57014', details: null, hint: null, message: 'canceling statement due to statement timeout' }, 500);
      }
      return reply(clustersInMemory(index, body.p_hashes, body.p_times));
    }
    if (path === 'rpc/ms006_track_window') return reply([trackWindowInMemory(byTid, body.p_tid, body.p_from, body.p_to)]);
    if (path === 'ms006_catalog') {
      const tids = url.searchParams.get('tid').match(/\d+/g).map(Number);
      return reply(rows.filter((r) => tids.includes(r.tid)));
    }
    if (path === 'ms006_scans' && method === 'POST') {
      scans.set(body.id, { ...body, created_at: new Date().toISOString() });
      return reply(null, 201);
    }
    if (path === 'ms006_scans') {
      const row = scans.get(url.searchParams.get('id').replace('eq.', ''));
      return reply(row?.found ? [{ id: row.id, created_at: row.created_at, duration_s: row.duration_s, matches: row.matches }] : []);
    }
    return reply({ message: 'not found' }, 404);
  };
  return { scans, workerRequests, control };
}
