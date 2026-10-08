// The Worker on Node: MS-006 routes against a fake moonshots Supabase (the
// in-memory synthetic catalog behind the same REST/RPC shapes), and the
// clearance-check routes and cron passing through untouched. fetch is
// replaced, so nothing here reaches a network.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/worker.js';
import { FP_VERSION, QUERY, fingerprint } from '../../public/music/fp.js';
import { encodeScanBody } from '../../public/music/body.js';
import { syntheticCatalog } from '../fixtures.mjs';
import { place, slice, synthSpeech } from '../synth.mjs';

const MOONSHOTS = 'https://kucwpmtkctafzkivuqtu.supabase.co';
const STREAM = 'https://uprfsmwbsvzuoiyfgtgx.supabase.co/storage/v1/object/public/Tracks/tracks/u/';
const cat = syntheticCatalog(6, 60);
const catalogRows = cat.tracks.map((t) => ({
  tid: t.tid, track_id: `00000000-0000-0000-0000-00000000000${t.tid}`, title: `RA_TEST_title_${t.tid}`, artist: `RA_TEST_artist_${t.tid}`, stream_url: `${STREAM}${t.tid}.wav`,
}));

const requests = [];
const scans = new Map();
let submissionsQueried = 0;
const reply = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  requests.push({ host: url.host, method: init.method || 'GET', path: url.pathname, auth: init.headers?.apikey });
  if (url.origin !== MOONSHOTS) throw new Error(`unexpected request to ${url.origin}`);
  const path = url.pathname.replace('/rest/v1/', '');
  const body = init.body ? JSON.parse(init.body) : null;
  if (path === 'rpc/ms006_match') {
    const rows = await cat.deps.lookup(Int32Array.from(body.p_hashes), Int32Array.from(body.p_times));
    return reply(rows);
  }
  if (path === 'rpc/ms006_track_window') return reply([await cat.deps.trackWindow(body.p_tid, body.p_from, body.p_to)]);
  if (path === 'ms006_catalog') {
    const tids = url.searchParams.get('tid').match(/\d+/g).map(Number);
    return reply(catalogRows.filter((r) => tids.includes(r.tid)));
  }
  if (path === 'ms006_scans' && init.method === 'POST') {
    scans.set(body.id, { ...body, created_at: '2026-10-07T00:00:00Z' });
    return reply(null, 201);
  }
  if (path === 'ms006_scans') {
    const id = url.searchParams.get('id').replace('eq.', '');
    const row = scans.get(id);
    return reply(row && row.found ? [{ id, created_at: row.created_at, duration_s: row.duration_s, matches: row.matches }] : []);
  }
  if (path === 'submissions') {
    submissionsQueried++;
    return reply([]);
  }
  return reply({ message: 'not found' }, 404);
};

const assetPaths = [];
const env = {
  ASSETS: { fetch: async (req) => { assetPaths.push(new URL(req.url).pathname); return new Response(`asset ${new URL(req.url).pathname}`); } },
  SUPABASE_URL: MOONSHOTS,
  SUPABASE_ANON_KEY: 'eyJanon.test',
  SUPABASE_SERVICE_ROLE_KEY: 'eyJservice.test',
};
const call = (path, init, e = env) => worker.fetch(new Request(`https://copyrighttester.real.audio${path}`, init), e, { waitUntil() {} });

// The body the page sends: the QUERY fingerprint (hashes + verification peaks).
function body(audio, durationMs = Math.round((audio.length / 16000) * 1000)) {
  return encodeScanBody({ ...fingerprint(audio, QUERY), durationMs });
}
const scan = (buf, headers = {}, e = env) => call('/api/scan', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...headers }, body: buf }, e);

test('POST /api/scan: found tracks come back in order with catalog details, stored under a 10-char id', async () => {
  const audio = place(synthSpeech(11, 60), slice(cat.tracks[1].audio, 5, 25), 3, -12);
  place(audio, slice(cat.tracks[4].audio, 20, 50), 28, -12);
  requests.length = 0;
  const res = await scan(body(audio), { 'x-scan-label': 'RA_TEST_two.mp4' });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.found, true);
  assert.match(out.id, /^[0-9A-Za-z]{10}$/);
  assert.deepEqual(out.matches.map((m) => m.title), ['RA_TEST_title_2', 'RA_TEST_title_5']);
  assert.ok(Math.abs(out.matches[0].start_s - 3) <= 1 && Math.abs(out.matches[1].start_s - 28) <= 1, JSON.stringify(out.matches));
  assert.equal(out.matches[0].stream_url, `${STREAM}2.wav`);
  const row = scans.get(out.id);
  assert.equal(row.label, 'RA_TEST_two.mp4');
  assert.equal(row.found, true);
  assert.equal(row.duration_s, 60);
  assert.ok(requests.every((r) => r.host === 'kucwpmtkctafzkivuqtu.supabase.co'), 'the Worker only talks to moonshots');
  assert.ok(requests.every((r) => r.auth === 'eyJservice.test'), 'with the service key');

  const got = await call(`/api/scans/${out.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual((await got.json()).matches, out.matches);
});

test('POST /api/scan: no catalog music -> found false, no id; the scan is still counted', async () => {
  const before = scans.size;
  const res = await scan(body(synthSpeech(12, 40)), { 'x-scan-label': 'my holiday.mp4' });
  assert.deepEqual(await res.json(), { found: false });
  assert.equal(scans.size, before + 1);
  const row = [...scans.values()].at(-1);
  assert.equal(row.found, false);
  assert.equal(row.label, null, 'only RA_TEST_ labels are stored');
});

test('GET /api/scans: unknown and malformed ids are 404', async () => {
  assert.equal((await call('/api/scans/Zzzzzzzzzz')).status, 404);
  const n = requests.length;
  assert.equal((await call('/api/scans/not-an-id')).status, 404);
  assert.equal(requests.length, n, 'a malformed id never reaches Supabase');
});

test('POST /api/scan rejects bad bodies', async () => {
  const good = new Int32Array(body(synthSpeech(13, 5)));
  const wrongVersion = good.slice();
  wrongVersion[0] = FP_VERSION + 1;
  const tooLong = good.slice();
  tooLong[1] = 21 * 60 * 1000;
  assert.ok(good[2] > 0, 'peaks');
  const badPeak = good.slice();
  badPeak[3] = -1;
  const tooManyPeaks = good.slice();
  tooManyPeaks[2] += 1;
  const lateness = good.slice();
  lateness[2 + good[2]] = (21 * 60 * 63) * 512; // a peak after the video's end
  for (const [name, buf, status] of [
    ['empty', new ArrayBuffer(0), 400],
    ['ragged', new ArrayBuffer(10), 400],
    ['wrong version', wrongVersion.buffer, 400],
    ['over 20 minutes', tooLong.buffer, 400],
    ['peak out of range', badPeak.buffer, 400],
    ['peak count mismatch', tooManyPeaks.buffer, 400],
    ['peak after the end', lateness.buffer, 400],
    ['count mismatch', good.slice(0, good.length - 1).buffer, 400],
  ]) {
    assert.equal((await scan(buf)).status, status, name);
  }
  assert.equal((await scan(new ArrayBuffer(8), { 'Content-Length': String(2e6) })).status, 413);
  assert.equal((await call('/api/scan')).status, 404, 'GET /api/scan');
});

test('scan routes: 503 without a key; refuse a production URL or key; SUPABASE_SECRET_KEY works alone', async () => {
  const { SUPABASE_SERVICE_ROLE_KEY: _, ...noKey } = env;
  assert.equal((await scan(body(synthSpeech(14, 5)), {}, noKey)).status, 503);
  const n = requests.length;
  const res = await scan(body(synthSpeech(14, 5)), {}, { ...env, SUPABASE_URL: 'https://uprfsmwbsvzuoiyfgtgx.supabase.co' });
  assert.equal(res.status, 502);
  assert.equal(requests.length, n, 'no request to production');
  const prodKey = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ ref: 'uprfsmwbsvzuoiyfgtgx', role: 'service_role' })).toString('base64url')}.sig`;
  const { SUPABASE_SERVICE_ROLE_KEY: __, ...secretOnly } = env;
  assert.equal((await scan(body(synthSpeech(14, 5)), {}, { ...secretOnly, SUPABASE_SECRET_KEY: prodKey })).status, 502, 'a production key is refused');
  assert.equal(requests.length, n, 'no request with a production key');
  assert.equal((await scan(body(synthSpeech(14, 5)), {}, { ...secretOnly, SUPABASE_SECRET_KEY: 'sb_secret_test' })).status, 200, 'SUPABASE_SECRET_KEY alone works');
});

test('MS-006 pages: /music redirects, /v/<id> serves the result page', async () => {
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

test('the cron passes through to the clearance results-email sweep', async () => {
  submissionsQueried = 0;
  const jobs = [];
  await worker.scheduled({ cron: '* * * * *' }, { ...env, RESEND_API_KEY: 're_test', SITE_URL: 'https://clearance.test' }, { waitUntil: (p) => jobs.push(p) });
  await Promise.all(jobs);
  assert.equal(submissionsQueried, 1, 'the sweep queried submissions');
});
