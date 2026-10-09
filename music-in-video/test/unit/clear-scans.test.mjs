// clear-test-scans: only RA_TEST_ rows, dry run counts only, production refused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { clearTestScans } from '../../scripts/clear-test-scans.mjs';

const run = promisify(execFile);
const SCRIPT = new URL('../../scripts/clear-test-scans.mjs', import.meta.url).pathname;

function fakeDb(labels) {
  let rows = labels.map((label, i) => ({ id: `id${i}`, label }));
  const calls = [];
  // PostgREST like with \_ escapes: RA\_TEST\_* matches labels starting "RA_TEST_".
  const matching = () => rows.filter((r) => r.label?.startsWith('RA_TEST_'));
  const write = async (path, { method = 'GET' } = {}) => {
    calls.push(`${method} ${path}`);
    assert.match(path, /label=like\.RA%5C_TEST%5C_\*/);
    if (method === 'GET') return matching().map(({ id }) => ({ id }));
    if (method === 'DELETE') { const gone = matching(); rows = rows.filter((r) => !gone.includes(r)); return gone.map(({ id }) => ({ id })); }
    throw new Error(method);
  };
  return { write, calls, rows: () => rows };
}

test('dry run counts RA_TEST_ scans and deletes nothing', async () => {
  const db = fakeDb(['RA_TEST_ms006_two_tracks', null, 'RA_TEST_ms006_quiet_01']);
  assert.deepEqual(await clearTestScans({ write: db.write, dryRun: true }), { matched: 2, deleted: 0 });
  assert.ok(db.calls.every((c) => c.startsWith('GET ')));
  assert.equal(db.rows().length, 3);
});

test('a real run deletes only the RA_TEST_ scans', async () => {
  const db = fakeDb(['RA_TEST_ms006_two_tracks', null, 'RA_TEST_x']);
  assert.deepEqual(await clearTestScans({ write: db.write }), { matched: 2, deleted: 2 });
  assert.deepEqual(db.rows().map((r) => r.label), [null]);
});

test('the CLI refuses production and missing settings before any request', async () => {
  for (const [env, msg] of [
    [{ MOONSHOTS_SUPABASE_URL: 'https://uprfsmwbsvzuoiyfgtgx.supabase.co', MOONSHOTS_SERVICE_ROLE_KEY: 'sb_secret_x' }, /Refusing to write to Real Audio production/],
    [{}, /must be set/],
  ]) {
    const err = await run('node', [SCRIPT, '--dry-run'], { env: { PATH: process.env.PATH, ...env } }).then(() => null, (e) => e);
    assert.ok(err);
    assert.match(err.stderr, msg);
  }
});
