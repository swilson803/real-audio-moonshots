// MS-007 start times (src/refine.js), and the two locks:
//  - REFINE as frozen on the practice clips before the one scored run;
//  - the confidence threshold, unchanged from MS-006 (match.js TUNABLES and
//    the SQL's MIN_BIN_HITS / DELTA_BIN / MAX_CLUSTERS, FP_VERSION, QUERY).
// Synthetic audio only (test/synth.mjs); no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { REFINE, atRefineRate, diff, phatLag, refineStarts } from '../../src/refine.js';
import { TUNABLES } from '../../src/match.js';
import { FP_VERSION, FRAMES_PER_SEC, QUERY } from '../../public/music/fp.js';
import { place, slice, synthMusic, synthSpeech } from '../synth.mjs';

const read = (rel) => readFile(new URL(rel, import.meta.url));

test('REFINE is frozen at the settings locked on the practice clips', () => {
  assert.ok(Object.isFrozen(REFINE));
  assert.deepEqual({ ...REFINE }, {
    RATE: 8000,
    LAG_SPAN_S: 30,
    WINDOW_S: 0.25,
    SE_ALLOWANCE: 2,
    STRONG_Z: 5,
    SE_FLOOR: 0.001,
    AFTER_FIRST_STRONG_S: 20,
    REACH_BACK_S: 30,
    SPAN_AFTER_START_S: 60,
  });
});

test('threshold lock: the confidence threshold is MS-006\'s, unchanged', async () => {
  assert.deepEqual(JSON.parse(JSON.stringify(TUNABLES)), {
    CANDIDATE_HITS: 3, MAX_CANDIDATES: 16, SPLIT_GAP_FRAMES: 1875, BIN_FRAMES: 16, LOCAL_WINDOW_BINS: 16,
    LOCAL_MIN: 4, LOCAL_Z: 3, OWNER_SMOOTH: 2, SEGMENT_MIN_COINCIDENCES: 30, ROW_Z: 5,
    NULL_SHIFTS: [31, 47, 67, 89, 113, 139, 167, 197, 229, 251, 277, 307, -37, -53, -73, -97, -127, -149, -181, -211, -239, -263, -289, -313],
    Z_MIN: 6, NULL_RATIO: 2, MERGE_GAP_FRAMES: 125, REFINE_REACH_FRAMES: 1250,
  });
  assert.equal(FP_VERSION, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(QUERY)), { binsPerBand: 3, rank: 3, fanout: 4, skipLowPairsBelowHz: 600, verifyPeaks: { rank: 3, peakHalfWidth: 4, minRise: 0.15 } });
  const match = (await read('../../src/match.js')).toString();
  assert.match(match, /^const DELTA_BIN = 4;/m);
  assert.match(match, /^const MIN_BIN_HITS = 2;/m);
  assert.match(match, /^const MAX_CLUSTERS = 500;/m);
  // The applied MS-006 migration (ms006_match: bins of 4, >= 2 hits, 500 rows),
  // byte for byte: md5 d902c56f… as applied to moonshots on 2026-10-08.
  const sql = await read('../../supabase/migrations/20261007000000_ms006_track_detection.sql');
  assert.equal(createHash('md5').update(sql).digest('hex'), 'd902c56f0163acf9346f497a83b0dc13');
});

// A track 10..38 s placed into speech at `at` seconds, gainDb under it.
const track = synthMusic(2001, 60);
const trackAt8k = async () => atRefineRate(track);
const video = (seed, at, gainDb) => place(synthSpeech(seed, 40), slice(track, 10, 38), at, gainDb);
// The matcher's row: late, and lined up with a "repeat" 8 s away.
const row = (at) => ({ tid: 1, delta: Math.round((at - 10) * FRAMES_PER_SEC) + 500, start: (at + 4) * FRAMES_PER_SEC, end: 37 * FRAMES_PER_SEC, coincidences: 99 });

test('the start comes from the waveform, even when the matcher lined up with a repeat', async () => {
  for (const [seed, at, gainDb] of [[31, 7.3, -20], [32, 3.1, -12], [33, 12.6, -26]]) {
    const [out] = await refineStarts([row(at)], video(seed, at, gainDb), trackAt8k);
    assert.equal(out.startSource, 'waveform');
    assert.equal(out.refine.lag_s, Math.round((at - 10) * 1000) / 1000, 'lag (video t = track t + lag)');
    assert.ok(Math.abs(out.start / FRAMES_PER_SEC - at) <= 1, `${at} s: got ${out.start / FRAMES_PER_SEC}`);
  }
});

test('rows are never added, dropped or renamed; only start moves', async () => {
  const rows = [row(7.3), { tid: 2, delta: 0, start: 38 * FRAMES_PER_SEC, end: 39.5 * FRAMES_PER_SEC, coincidences: 40 }];
  const out = await refineStarts(rows, video(31, 7.3, -20), async (tid) => (tid === 1 ? trackAt8k() : new Float32Array(8000 * 30)));
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => [r.tid, r.delta, r.end, r.coincidences]), rows.map((r) => [r.tid, r.delta, r.end, r.coincidences]));
});

test('guard rails: no waveform evidence keeps the matcher\'s start', async () => {
  const [none] = await refineStarts([row(7.3)], synthSpeech(31, 40), trackAt8k);
  assert.equal(none.startSource, 'matcher');
  assert.equal(none.start, row(7.3).start);
  assert.equal(none.refine.why, 'no strong window');
  const [silent] = await refineStarts([row(7.3)], video(31, 7.3, -20), async () => new Float32Array(0));
  assert.equal(silent.startSource, 'matcher');
  assert.deepEqual(await refineStarts([], video(31, 7.3, -20), trackAt8k), []);
});

test('a start never runs into the previous row', async () => {
  // The previous row ends at 9 s, after the track's true start (7.3 s).
  const prev = { tid: 2, delta: 0, start: 0, end: 9 * FRAMES_PER_SEC, coincidences: 40 };
  const out = await refineStarts([prev, row(7.3)], video(31, 7.3, -20), async (tid) => (tid === 1 ? trackAt8k() : new Float32Array(8000 * 60)));
  assert.ok(out[1].start / FRAMES_PER_SEC >= 9, `${out[1].start / FRAMES_PER_SEC}`);
});

test('phatLag finds a lag anywhere in the track, across blocks', () => {
  const t = diff(atRefineRate(synthMusic(2002, 240)));
  for (const at of [3.5, 100.25, 215]) {
    const s0 = 8000;
    const x = t.slice(Math.round(at * 8000), Math.round(at * 8000) + 8000 * 10);
    assert.equal(phatLag(x, s0, t), s0 - Math.round(at * 8000));
  }
});
