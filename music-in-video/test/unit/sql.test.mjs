// The moonshots migration, applied to an in-process Postgres (PGlite, WASM;
// no server, no network): it applies cleanly, anon gets nothing, and the two
// RPCs return exactly what the in-memory mirrors in src/match.js return.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { fingerprint } from '../../public/music/fp.js';
import { buildIndex, clustersInMemory, trackWindowInMemory } from '../../src/match.js';
import { place, silence, slice, synthMusic, synthSpeech } from '../synth.mjs';

const MIGRATION = new URL('../../supabase/migrations/20261008192425_ms006_track_detection.sql', import.meta.url);
const STREAM = 'https://uprfsmwbsvzuoiyfgtgx.supabase.co/storage/v1/object/public/Tracks/tracks/x/';

const db = new PGlite();
// Supabase's API roles, which the migration grants to and revokes from.
await db.exec('create role anon; create role authenticated; create role service_role;');
await db.exec(await readFile(MIGRATION, 'utf8'));

const tracks = [1, 2, 3, 4].map((tid) => ({ tid, ...fingerprint(synthMusic(2000 + tid, 40)) }));
for (const t of tracks) {
  await db.query(
    `insert into ms006_catalog (tid, track_id, title, artist, stream_url, audio_sha256, fp_version, hash_count)
     values ($1, gen_random_uuid(), $2, 'RA_TEST_artist', $3, 'x', 1, $4)`,
    [t.tid, `RA_TEST_track_${t.tid}`, `${STREAM}${t.tid}.wav`, t.hashes.length],
  );
  await db.query('insert into ms006_fp (hash, tid, t) select * from unnest($1::int[], $2::smallint[], $3::int[])',
    [Array.from(t.hashes), Array.from(t.hashes, () => t.tid), Array.from(t.times)]);
}
const index = buildIndex(tracks);
const byTid = new Map(tracks.map((t) => [t.tid, t]));

const sortRows = (rows) => rows
  .map((r) => ({ tid: Number(r.tid), bin: Number(r.bin), hits: [...r.hits], deltas: [...r.deltas] }))
  .sort((a, b) => b.hits.length - a.hits.length || a.tid - b.tid || a.bin - b.bin);

test('ms006_match returns the same clusters as clustersInMemory (incl. negative offsets)', async () => {
  // Track 2 from 10 s placed at 3 s: offsets are negative.
  const audio = place(synthSpeech(77, 30), slice(synthMusic(2002, 40), 10, 35), 3, -6);
  const q = fingerprint(audio);
  const { rows } = await db.query('select * from ms006_match($1, $2)', [Array.from(q.hashes), Array.from(q.times)]);
  const mem = clustersInMemory(index, q.hashes, q.times);
  assert.ok(rows.length > 0 && rows.length <= 500);
  assert.ok(mem.some((c) => c.bin < 0), 'expected a negative-offset cluster');
  // Ties in size may be ordered differently; compare as sets.
  assert.deepEqual(sortRows(rows), sortRows(mem));
});

test('ms006_match on silence returns nothing', async () => {
  const q = fingerprint(silence(5));
  const { rows } = await db.query('select * from ms006_match($1, $2)', [Array.from(q.hashes), Array.from(q.times)]);
  assert.equal(rows.length, 0);
});

test('ms006_track_window returns one row of arrays matching trackWindowInMemory', async () => {
  const { rows } = await db.query('select * from ms006_track_window($1, $2, $3)', [3, 100, 900]);
  assert.equal(rows.length, 1);
  const mem = trackWindowInMemory(byTid, 3, 100, 900);
  const pairs = (h, t) => h.map((x, i) => `${t[i]}:${x}`).sort();
  assert.deepEqual(pairs(rows[0].hashes, rows[0].times), pairs(mem.hashes, mem.times));
});

test('anon and authenticated can read, write and call nothing', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    for (const sql of [
      'select * from ms006_scans',
      'select * from ms006_catalog',
      'select * from ms006_fp limit 1',
      "insert into ms006_scans (id, duration_s, found, fp_version) values ('AAAAAAAAAA', 1, false, 1)",
      "select * from ms006_match('{1}', '{1}')",
      'select * from ms006_track_window(1::smallint, 0, 10)',
    ]) {
      await assert.rejects(db.query(sql), /permission denied/, `${role}: ${sql}`);
    }
    await db.exec('reset role');
  }
});

test('scans: id shape, test labels only, and stream URLs only from the public Tracks bucket', async () => {
  await db.query("insert into ms006_scans (id, duration_s, found, fp_version, label) values ('Ab3dE5gH9k', 60, true, 1, 'RA_TEST_x.mp4')");
  await assert.rejects(db.query("insert into ms006_scans (id, duration_s, found, fp_version) values ('short', 1, false, 1)"), /check/);
  await assert.rejects(db.query("insert into ms006_scans (id, duration_s, found, fp_version, label) values ('Zb3dE5gH9k', 1, false, 1, 'my holiday.mp4')"), /check/);
  await assert.rejects(db.query(
    "insert into ms006_catalog (tid, track_id, title, artist, stream_url, audio_sha256, fp_version, hash_count) values (99, gen_random_uuid(), 't', 'a', 'https://example.com/a.mp3', 'x', 1, 0)",
  ), /check/);
});

test('deleting a catalog track removes its fingerprints', async () => {
  await db.query('delete from ms006_catalog where tid = 4');
  const { rows } = await db.query('select count(*)::int as n from ms006_fp where tid = 4');
  assert.equal(rows[0].n, 0);
});
