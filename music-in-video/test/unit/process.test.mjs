// The processor pipeline (src/process.js) and its HTTP handler
// (processor/server.mjs) on a synthetic catalog: uploaded soundtrack ->
// fingerprint -> match (thresholds unchanged) -> waveform start times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessError, processScan } from '../../src/process.js';
import { atRefineRate } from '../../src/refine.js';
import { DbBusy } from '../../src/moonshots.js';
import { createServer, handleProcess } from '../../processor/server.mjs';
import { bodyOf, syntheticCatalog } from '../fixtures.mjs';
import { place, slice, synthSpeech } from '../synth.mjs';

const cat = syntheticCatalog(6, 60);
const rows = cat.tracks.map((t) => ({ tid: t.tid, track_id: `track-${t.tid}`, title: `RA_TEST ${t.tid}`, artist: 'RA_TEST artist', stream_url: `https://example.test/${t.tid}.wav` }));
const db = { ...cat.deps, catalog: async (tids) => rows.filter((r) => tids.includes(r.tid)) };
const ref = { track: async (trackId) => atRefineRate(cat.tracks[Number(trackId.split('-')[1]) - 1].audio) };

test('two tracks under speech: both found, in order, starts from the waveform', async () => {
  const audio = place(synthSpeech(11, 60), slice(cat.tracks[1].audio, 5, 25), 3.4, -12);
  place(audio, slice(cat.tracks[4].audio, 20, 50), 28.6, -16);
  const out = await processScan(bodyOf(audio), { db, ref });
  assert.equal(out.found, true);
  assert.deepEqual(out.matches.map((m) => m.title), ['RA_TEST 2', 'RA_TEST 5']);
  assert.deepEqual(Object.keys(out.matches[0]), ['start_s', 'end_s', 'track_id', 'title', 'artist', 'stream_url'], 'the MS-006 row shape');
  assert.ok(Math.abs(out.matches[0].start_s - 3.4) <= 0.5 && Math.abs(out.matches[1].start_s - 28.6) <= 0.5, JSON.stringify(out.matches));
  assert.deepEqual(out.starts.map((s) => s.source), ['waveform', 'waveform']);
  assert.equal(out.duration_s, 60);
});

test('no catalog music finds nothing', async () => {
  const out = await processScan(bodyOf(synthSpeech(12, 40)), { db, ref });
  assert.equal(out.found, false);
  assert.deepEqual(out.matches, []);
});

test('bodies that can never be processed are permanent errors', async () => {
  const code = async (buf) => { try { await processScan(buf, { db, ref }); return null; } catch (e) { assert.ok(e instanceof ProcessError); return e.code; } };
  assert.equal(await code(new ArrayBuffer(8)), 'unreadable');
  assert.equal(await code(bodyOf(new Float32Array(0), 1000)), 'no-audio');
  assert.equal(await code(bodyOf(new Float32Array(16), 21 * 60 * 1000)), 'too-long');
});

test('the handler: 200 with cost measurements, 422 for permanent errors, 503 busy, 500 otherwise', async () => {
  const ok = await handleProcess(bodyOf(synthSpeech(13, 10)), { db, ref });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.found, false);
  for (const k of ['proc_ms', 'cpu_ms', 'peak_mb']) assert.ok(Number.isInteger(ok.body[k]) && ok.body[k] >= 0, k);
  assert.deepEqual(await handleProcess(new ArrayBuffer(3), { db, ref }), { status: 422, body: { error: 'unreadable' } });
  const busy = { ...db, lookup: async () => { throw new DbBusy('57014'); } };
  const music = place(synthSpeech(14, 30), slice(cat.tracks[0].audio, 0, 20), 2, -12);
  assert.deepEqual(await handleProcess(bodyOf(music), { db: busy, ref }), { status: 503, body: { error: 'busy' } });
  const broken = { ...db, lookup: async () => { throw new Error('boom'); } };
  assert.deepEqual(await handleProcess(bodyOf(music), { db: broken, ref }), { status: 500, body: { error: 'internal' } });
});

test('the container server: POST /process and GET /health; fresh dependencies per job', async () => {
  let made = 0;
  const server = createServer(() => { made++; return { db, ref }; });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    const res = await fetch(`${base}/process`, { method: 'POST', body: bodyOf(synthSpeech(15, 8)) });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).found, false);
    await fetch(`${base}/process`, { method: 'POST', body: bodyOf(synthSpeech(16, 4)) });
    assert.equal(made, 2, 'one moonshots client per job: its retry deadline is per client');
    assert.equal((await fetch(`${base}/other`)).status, 404);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

