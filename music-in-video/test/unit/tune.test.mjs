// match() options and the round-B tuning loop (fake DB, local files only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, FRAMES_PER_SEC, QUERY } from '../../public/music/fp.js';
import { TUNABLES, match, tunables } from '../../src/match.js';
import { parseSets, tune } from '../../scripts/tune.mjs';
import { kindOf } from '../../scripts/lib/kinds.mjs';
import { syntheticCatalog } from '../fixtures.mjs';
import { place, slice, synthSpeech, wavBytes } from '../synth.mjs';

const cat = syntheticCatalog(8, 60);
const queryOf = (audio) => {
  const fp = fingerprint(audio, QUERY);
  return { hashes: fp.hashes, times: fp.times, peaks: { t: fp.peakT, f: fp.peakF } };
};

test('match() defaults are the round-B values and an empty options object changes nothing', async () => {
  assert.deepEqual({ ...TUNABLES, NULL_SHIFTS: [...TUNABLES.NULL_SHIFTS] }, {
    CANDIDATE_HITS: 3,
    MAX_CANDIDATES: 16,
    SPLIT_GAP_FRAMES: Math.round(30 * FRAMES_PER_SEC),
    BIN_FRAMES: 16,
    LOCAL_WINDOW_BINS: 16,
    LOCAL_MIN: 4,
    LOCAL_Z: 3,
    OWNER_SMOOTH: 2,
    SEGMENT_MIN_COINCIDENCES: 30,
    ROW_Z: 5,
    NULL_SHIFTS: [31, 47, 67, 89, 113, 139, 167, 197, 229, 251, 277, 307,
      -37, -53, -73, -97, -127, -149, -181, -211, -239, -263, -289, -313],
    Z_MIN: 6,
    NULL_RATIO: 2,
    MERGE_GAP_FRAMES: Math.round(2 * FRAMES_PER_SEC),
    REFINE_REACH_FRAMES: Math.round(20 * FRAMES_PER_SEC),
  });
  for (const k of [0, 1, 2]) {
    const bed = synthSpeech(80 + k, 50);
    if (k) place(bed, slice(cat.tracks[k].audio, 5, 40), 3, -12);
    const q = queryOf(bed);
    const plain = await match(q, cat.deps);
    assert.deepEqual(await match(q, cat.deps, {}), plain);
    if (k) assert.equal(plain.length, 1);
  }
});

test('match() options override, and unknown or SQL-fixed names throw', async () => {
  const q = queryOf(place(synthSpeech(90, 50), slice(cat.tracks[3].audio, 5, 40), 3, -12));
  assert.equal((await match(q, cat.deps)).length, 1);
  assert.equal((await match(q, cat.deps, { SEGMENT_MIN_COINCIDENCES: 1e9 })).length, 0);
  for (const bad of ['DELTA_BIN', 'MIN_BIN_HITS', 'MAX_CLUSTERS', 'NOPE']) assert.throws(() => tunables({ [bad]: 1 }), /unknown matcher option/);
  assert.deepEqual(parseSets(['NULL_RATIO=5', 'NULL_SHIFTS=10,-10']), { NULL_RATIO: 5, NULL_SHIFTS: [10, -10] });
  assert.throws(() => parseSets(['DELTA_BIN=2']), /not a tunable/);
  assert.throws(() => parseSets(['NULL_RATIO=x']), /not a number/);
});

test('tune: matches a manifest against the DB once, then re-runs from its cache offline', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ms006-tune-'));
  const vids = join(dir, 'videos');
  await mkdir(vids);
  const id = (tid) => `00000000-0000-4000-8000-00000000000${tid}`;
  await writeFile(join(vids, 'RA_TEST_dev_quiet_01.wav'), wavBytes(place(synthSpeech(92, 50), slice(cat.tracks[2].audio, 5, 40), 6, -12)));
  await writeFile(join(vids, 'RA_TEST_no_music_speech.wav'), wavBytes(synthSpeech(93, 40)));
  await writeFile(join(vids, 'manifest.json'), JSON.stringify({ videos: [
    { file: 'RA_TEST_dev_quiet_01.wav', kind: 'dev', expect: [{ track_id: id(3), title: 'T3', start_s: 6 }] },
    { file: 'RA_TEST_no_music_speech.wav', kind: 'no_music', expect: [] },
  ] }));
  const calls = { lookup: 0, trackWindow: 0, catalog: 0 };
  const fetched = [];
  const db = {
    lookup: async (h, t) => { calls.lookup++; return cat.deps.lookup(Int32Array.from(h), Int32Array.from(t)); },
    trackWindow: async (tid, a, b) => { calls.trackWindow++; fetched.push(tid); return cat.deps.trackWindow(tid, a, b); },
    catalog: async (tids) => { calls.catalog++; return tids.map((tid) => ({ tid, track_id: id(tid), title: `T${tid}` })); },
  };
  const out = join(dir, 'out');
  const log = () => {};
  const first = await tune({ manifestPaths: [join(vids, 'manifest.json')], kinds: ['dev', 'no_music'], sets: {}, outDir: out, db, offline: false, log });
  assert.deepEqual(first.summary, { 'videos:dev': { pass: 1, total: 1 }, 'videos:no_music': { pass: 1, total: 1 } });
  assert.deepEqual([calls.lookup, calls.catalog], [2, 1]);
  assert.ok(fetched.length > 0 && new Set(fetched).size === fetched.length, `each track fetched once, whole: ${fetched}`);
  const again = await tune({ manifestPaths: [join(vids, 'manifest.json')], kinds: ['dev', 'no_music'], sets: { NULL_RATIO: 7 }, outDir: out, db: null, offline: true, log });
  assert.deepEqual(again.videos.map((v) => v.got), first.videos.map((v) => v.got));
  const strict = await tune({ manifestPaths: [join(vids, 'manifest.json')], kinds: ['dev'], sets: { SEGMENT_MIN_COINCIDENCES: 1e9 }, outDir: out, db: null, offline: true, log });
  assert.deepEqual(strict.summary, { 'videos:dev': { pass: 0, total: 1 } });
  assert.ok((await readdir(join(out, 'cache', 'videos'))).some((f) => f.endsWith('.fp.json')));
  await assert.rejects(tune({ manifestPaths: [join(vids, 'manifest.json')], kinds: ['quiet'], sets: {}, outDir: out, db: null, offline: true, log }), /acceptance set/);
});

test('kinds come from the file name: acceptance quiet, dev, sweep', () => {
  // The phase-2 manifest said "quiet" for all three.
  assert.equal(kindOf({ file: 'RA_TEST_quiet_03.mov', kind: 'quiet' }), 'quiet');
  assert.equal(kindOf({ file: 'RA_TEST_dev_quiet_03.mov', kind: 'quiet' }), 'dev');
  assert.equal(kindOf({ file: 'RA_TEST_sweep_24db_2.mp4', kind: 'quiet' }), 'sweep');
  assert.equal(kindOf({ file: 'RA_TEST_no_music_other.mp4', kind: 'no_music' }), 'no_music');
});
