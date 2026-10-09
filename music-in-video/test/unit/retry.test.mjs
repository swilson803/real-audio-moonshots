// Fix 1: the Worker's retries of moonshots reads on a cold database
// (PostgREST statement timeout, 57014). fetch is replaced; no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../../src/worker.js';
import { DbBusy, RETRY, isTransient, moonshots } from '../../src/scan.js';
import { QUERY, fingerprint } from '../../public/music/fp.js';
import { encodeScanBody } from '../../public/music/body.js';
import { syntheticCatalog } from '../fixtures.mjs';
import { place, slice, synthSpeech } from '../synth.mjs';

const MOONSHOTS = 'https://kucwpmtkctafzkivuqtu.supabase.co';
const env = { SUPABASE_URL: MOONSHOTS, SUPABASE_SERVICE_ROLE_KEY: 'eyJservice.test' };
const TIMEOUT_BODY = JSON.stringify({ code: '57014', details: null, hint: null, message: 'canceling statement due to statement timeout' });
const reply = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// fetch stub answering from a script of responses (functions or values).
function script(...steps) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ path: new URL(url).pathname, method: init.method || 'GET' });
    const step = steps.length > 1 ? steps.shift() : steps[0];
    return typeof step === 'function' ? step() : step.clone();
  };
  return calls;
}
const fakeTime = () => {
  let t = 0;
  const waits = [];
  return { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; }, waits, advance: (ms) => { t += ms; } };
};

test('transient errors: 57014 timeout, gateway errors; not 400 or other 500s', () => {
  assert.equal(isTransient(500, TIMEOUT_BODY), true);
  for (const s of [502, 503, 504, 520, 522, 524]) assert.equal(isTransient(s, ''), true, String(s));
  assert.equal(isTransient(500, '{"code":"42883","message":"function does not exist"}'), false);
  for (const s of [400, 401, 404, 409, 413]) assert.equal(isTransient(s, TIMEOUT_BODY), false, String(s));
});

test('a statement timeout is retried, then the lookup succeeds', async () => {
  const calls = script(reply(TIMEOUT_BODY, 500), reply([{ tid: 1, bin: 2, hits: [3, 4], deltas: [5, 6] }]));
  const clock = fakeTime();
  const rows = await moonshots(env, clock).lookup(Int32Array.from([1, 2]), Int32Array.from([3, 4]));
  assert.deepEqual(rows, [{ tid: 1, bin: 2, hits: [3, 4], deltas: [5, 6] }]);
  assert.equal(calls.length, 2);
  assert.deepEqual(clock.waits, [1000]);
});

test('a network error is retried', async () => {
  const calls = script(() => { throw new TypeError('fetch failed'); }, reply([{ hashes: [1], times: [2] }]));
  const w = await moonshots(env, fakeTime()).trackWindow(1, 0, 10);
  assert.deepEqual(w, { hashes: [1], times: [2] });
  assert.equal(calls.length, 2);
});

test('400 and non-timeout 500s are not retried', async () => {
  for (const [status, body] of [[400, '{"message":"bad"}'], [500, '{"code":"42883","message":"no such function"}']]) {
    const calls = script(reply(body, status));
    const clock = fakeTime();
    await assert.rejects(moonshots(env, clock).lookup(Int32Array.from([1]), Int32Array.from([1])), (err) => !(err instanceof DbBusy) && err.message.includes(String(status)));
    assert.equal(calls.length, 1, `${status} tried once`);
    assert.deepEqual(clock.waits, []);
  }
});

test('the cap: at most RETRY.ATTEMPTS tries per read, then DbBusy', async () => {
  const calls = script(reply(TIMEOUT_BODY, 500));
  const clock = fakeTime();
  await assert.rejects(moonshots(env, clock).lookup(Int32Array.from([1]), Int32Array.from([1])), DbBusy);
  assert.equal(calls.length, RETRY.ATTEMPTS);
  assert.deepEqual(clock.waits, [1000, 2000]);
});

test('the cap: a request-wide retry budget and a deadline', async () => {
  // Budget: 1 retry for the whole request; two failing reads -> 3 fetches.
  let calls = script(reply(TIMEOUT_BODY, 500));
  const db = moonshots(env, { ...fakeTime(), retry: { ...RETRY, RETRIES: 1 } });
  await assert.rejects(db.lookup(Int32Array.from([1]), Int32Array.from([1])), DbBusy);
  await assert.rejects(db.trackWindow(1, 0, 10), DbBusy);
  assert.equal(calls.length, 3);
  // Deadline: each try takes 8 s (the statement timeout); no new try starts
  // once the next would begin after DEADLINE_MS.
  const clock = fakeTime();
  calls = script(() => { clock.advance(8000); return reply(TIMEOUT_BODY, 500); });
  await assert.rejects(moonshots(env, { ...clock, retry: { ...RETRY, ATTEMPTS: 10, DEADLINE_MS: 18000 } }).lookup(Int32Array.from([1]), Int32Array.from([1])), DbBusy);
  assert.equal(calls.length, 2, 'tries start at 0 s and 9 s; a third would start at 19 s, past the 18 s deadline');
});

// Through the Worker: a real scan body, a fake moonshots behind fetch.
const cat = syntheticCatalog(6, 60);
const rows = cat.tracks.map((t) => ({ tid: t.tid, track_id: `00000000-0000-4000-8000-00000000000${t.tid}`, title: `RA_TEST ${t.tid}`, artist: 'RA_TEST', stream_url: 'x' }));
function fakeMoonshots({ timeouts }) {
  const log = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace('/rest/v1/', '');
    log.push(`${init.method || 'GET'} ${path}`);
    const body = init.body ? JSON.parse(init.body) : null;
    if (path === 'rpc/ms006_match') {
      if (timeouts.left > 0 || timeouts.always) { timeouts.left--; return reply(TIMEOUT_BODY, 500); }
      return reply(await cat.deps.lookup(Int32Array.from(body.p_hashes), Int32Array.from(body.p_times)));
    }
    if (path === 'rpc/ms006_track_window') return reply([await cat.deps.trackWindow(body.p_tid, body.p_from, body.p_to)]);
    if (path === 'ms006_catalog') return reply(rows.filter((r) => u.searchParams.get('tid').includes(String(r.tid))));
    if (path === 'ms006_scans' && init.method === 'POST') return new Response(null, { status: 201 });
    return reply([], 404);
  };
  return log;
}
const video = place(synthSpeech(5, 40), slice(cat.tracks[1].audio, 5, 30), 3, -12);
const scanRequest = () => new Request('https://copyrighttester.real.audio/api/scan', { method: 'POST', body: encodeScanBody({ ...fingerprint(video, QUERY), durationMs: 40000 }) });

test('Worker: a cold first lookup is retried; one result, one scan row', async () => {
  const log = fakeMoonshots({ timeouts: { left: 1 } });
  const res = await worker.fetch(scanRequest(), env, { waitUntil() {} });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.found, true);
  assert.deepEqual(out.matches.map((m) => m.title), ['RA_TEST 2']);
  assert.equal(log.filter((l) => l === 'POST rpc/ms006_match').length, 2);
  assert.equal(log.filter((l) => l === 'POST ms006_scans').length, 1, 'exactly one insert');
});

test('Worker: a database that keeps timing out -> 503 busy after the cap, no scan row', async () => {
  const log = fakeMoonshots({ timeouts: { always: true } });
  const res = await worker.fetch(scanRequest(), env, { waitUntil() {} });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: 'busy' });
  assert.equal(log.filter((l) => l === 'POST rpc/ms006_match').length, RETRY.ATTEMPTS);
  assert.equal(log.filter((l) => l === 'POST ms006_scans').length, 0);
});
