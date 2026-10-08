// match() options and the round-B tuning loop (fake DB, local files only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, FRAMES_PER_SEC } from '../../public/music/fp.js';
import { TUNABLES, match, tunables } from '../../src/match.js';
import { parseSets, tune } from '../../scripts/tune.mjs';
import { syntheticCatalog } from '../fixtures.mjs';
import { place, slice, synthSpeech, wavBytes } from '../synth.mjs';

const cat = syntheticCatalog(8, 60);

test('match() defaults are unchanged and an empty options object changes nothing', async () => {
  assert.deepEqual({ ...TUNABLES, NULL_SHIFTS: [...TUNABLES.NULL_SHIFTS] }, {
    CANDIDATE_HITS: 5,
    MAX_CANDIDATES: 8,
    SPLIT_GAP_FRAMES: Math.round(30 * FRAMES_PER_SEC),
    VERIFY_WINDOW: Math.round(2 * FRAMES_PER_SEC),
    VERIFY_MIN: 4,
    EDGE_NEAR: Math.round(1 * FRAMES_PER_SEC),
    EDGE_FAR: Math.round(2 * FRAMES_PER_SEC),
    OWNER_SMOOTH: 2,
    SEGMENT_MIN_COINCIDENCES: 12,
    NULL_SHIFTS: [37, 61, 97, 131, 173, 211, -41, -67, -103, -139, -181, -223],
    NULL_RATIO: 7,
    REFINE_REACH_FRAMES: Math.round(20 * FRAMES_PER_SEC),
  });
  for (const k of [0, 1, 2]) {
    const bed = synthSpeech(80 + k, 50);
    if (k) place(bed, slice(cat.tracks[k].audio, 5, 40), 3, -12);
    const q = fingerprint(bed);
    const plain = await match(q, cat.deps);
    assert.deepEqual(await match(q, cat.deps, {}), plain);
    if (k) assert.equal(plain.length, 1);
  }
});

test('match() options override, and unknown or SQL-fixed names throw', async () => {
  const q = fingerprint(place(synthSpeech(90, 50), slice(cat.tracks[3].audio, 5, 40), 3, -12));
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
  await writeFile(join(vids, 'RA_TEST_dev_quiet_01.wav'), wavBytes(place(synthSpeech(91, 50), slice(cat.tracks[2].audio, 5, 40), 6, -12)));
  await writeFile(join(vids, 'RA_TEST_no_music_speech.wav'), wavBytes(synthSpeech(92, 40)));
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
  const first = await tune({ manifestPath: join(vids, 'manifest.json'), kinds: ['dev', 'no_music'], sets: {}, outDir: out, db, offline: false, log });
  assert.deepEqual(first.summary, { dev: { pass: 1, total: 1 }, no_music: { pass: 1, total: 1 } });
  assert.deepEqual([calls.lookup, calls.catalog], [2, 1]);
  assert.ok(fetched.length > 0 && new Set(fetched).size === fetched.length, `each track fetched once, whole: ${fetched}`);
  const again = await tune({ manifestPath: join(vids, 'manifest.json'), kinds: ['dev', 'no_music'], sets: { NULL_RATIO: 7 }, outDir: out, db: null, offline: true, log });
  assert.deepEqual(again.videos.map((v) => v.got), first.videos.map((v) => v.got));
  const strict = await tune({ manifestPath: join(vids, 'manifest.json'), kinds: ['dev'], sets: { SEGMENT_MIN_COINCIDENCES: 1e9 }, outDir: out, db: null, offline: true, log });
  assert.deepEqual(strict.summary, { dev: { pass: 0, total: 1 } });
  assert.ok((await readdir(join(out, 'cache'))).some((f) => f.endsWith('.fp.json')));
});
