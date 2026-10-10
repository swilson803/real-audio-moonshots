// The MS-007 migration on top of MS-006's, applied to an in-process Postgres
// (PGlite, WASM; no server, no network). Never applied anywhere else by this
// branch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const dir = new URL('../../supabase/migrations/', import.meta.url);
const db = new PGlite();
await db.exec('create role anon; create role authenticated; create role service_role;');
await db.exec(await readFile(new URL('20261007000000_ms006_track_detection.sql', dir), 'utf8'));
await db.exec(await readFile(new URL('20261009000000_ms007_processing.sql', dir), 'utf8'));

const insert = (cols) => {
  const keys = Object.keys(cols);
  return db.query(`insert into ms006_scans (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(cols));
};
const rejects = async (p, re) => assert.rejects(p, (e) => re.test(e.message));

test('an MS-006 insert (no status) still works and reads as done', async () => {
  await insert({ id: 'Ms006Row01', duration_s: 60, found: true, matches: JSON.stringify([{ start_s: 4 }]), fp_version: 1 });
  const { rows: [r] } = await db.query("select status, attempts, error, updated_at is not null as stamped from ms006_scans where id = 'Ms006Row01'");
  assert.deepEqual(r, { status: 'done', attempts: 0, error: null, stamped: true });
});

test('a job: queued -> working -> done, with its cost columns', async () => {
  await insert({ id: 'JobRow0001', duration_s: 30, found: false, fp_version: 1, status: 'queued', label: 'RA_TEST_x.mp4' });
  await db.query("update ms006_scans set status = 'working', attempts = 1 where id = 'JobRow0001'");
  await db.query("update ms006_scans set status = 'done', found = true, matches = '[{\"start_s\":1}]', proc_ms = 9000, cpu_ms = 4100, peak_mb = 180, separation = false where id = 'JobRow0001'");
  const { rows: [r] } = await db.query("select status, found, proc_ms, cpu_ms, peak_mb, separation from ms006_scans where id = 'JobRow0001'");
  assert.deepEqual(r, { status: 'done', found: true, proc_ms: 9000, cpu_ms: 4100, peak_mb: 180, separation: false });
});

test('only a finished job can have found anything; status and error are checked', async () => {
  await rejects(insert({ id: 'BadRow0001', duration_s: 1, found: true, fp_version: 1, status: 'queued' }), /ms006_scans_found_when_done/);
  await rejects(insert({ id: 'BadRow0002', duration_s: 1, found: false, matches: '[{"x":1}]', fp_version: 1, status: 'working' }), /ms006_scans_found_when_done/);
  await rejects(insert({ id: 'BadRow0003', duration_s: 1, found: false, fp_version: 1, status: 'lost' }), /check/);
  await rejects(insert({ id: 'BadRow0004', duration_s: 1, found: false, fp_version: 1, status: 'failed', error: 'timeout' }), /check/);
  await insert({ id: 'FailRow001', duration_s: 1, found: false, fp_version: 1, status: 'failed', error: 'unreadable' });
});

test('the sweep\'s open-jobs index exists and covers queued and working only', async () => {
  const { rows: [r] } = await db.query("select indexdef from pg_indexes where indexname = 'ms006_scans_open'");
  assert.match(r.indexdef, /\(updated_at\) WHERE \(status = ANY \(ARRAY\['queued'::text, 'working'::text\]\)\)/);
});

test('still nothing for anon or authenticated', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`set role ${role}`);
    await rejects(db.query('select status from ms006_scans'), /permission denied/);
    await rejects(db.query("update ms006_scans set status = 'done'"), /permission denied/);
    await db.exec('reset role');
  }
});
