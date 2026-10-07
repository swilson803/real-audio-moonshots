// Production read-only guards and the catalog index builder, with fake
// fetch / read / write / decode: no network, no Supabase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProdAnonKey, fetchActiveTracks, moonshotsWriter, prodReader, PROD_TRACKS_PREFIX, PROD_URL } from '../../scripts/lib/targets.mjs';
import { buildIndex } from '../../scripts/build-catalog-index.mjs';
import { FP_VERSION } from '../../public/music/fp.js';
import { synthMusic } from '../synth.mjs';

const jwt = (claims) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
const PROD_ANON = jwt({ ref: 'uprfsmwbsvzuoiyfgtgx', role: 'anon' });
const PROD_SERVICE = jwt({ ref: 'uprfsmwbsvzuoiyfgtgx', role: 'service_role' });
const MOON_SERVICE = jwt({ ref: 'kucwpmtkctafzkivuqtu', role: 'service_role' });
const MOON_URL = 'https://kucwpmtkctafzkivuqtu.supabase.co';

test('production key: anon only', () => {
  assert.equal(assertProdAnonKey(PROD_ANON), PROD_ANON);
  assert.throws(() => assertProdAnonKey(PROD_SERVICE), /role anon/);
  assert.throws(() => assertProdAnonKey(jwt({ ref: 'kucwpmtkctafzkivuqtu', role: 'anon' })), /production anon key/);
  assert.throws(() => assertProdAnonKey('sb_secret_abc'), /secret/);
  assert.throws(() => assertProdAnonKey(undefined), /not set/);
});

test('production reader: GET/HEAD of catalog tables and public Tracks audio only, nothing is sent', async () => {
  const sent = [];
  const read = prodReader(PROD_ANON, async (url, init) => { sent.push({ url, ...init }); return new Response('[]'); });
  await read(`${PROD_URL}/rest/v1/Tracks?select=track_id`);
  await read(`${PROD_TRACKS_PREFIX}tracks/u/1.wav`, { method: 'HEAD' });
  for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
    await assert.rejects(read(`${PROD_URL}/rest/v1/Tracks`, { method }), /read only/);
  }
  for (const url of [
    `${PROD_URL}/rest/v1/rpc/increment_track_play`,
    `${PROD_URL}/rest/v1/Downloads`,
    `${PROD_URL}/storage/v1/object/public/agreements/x.pdf`,
    `${PROD_URL}/storage/v1/object/Tracks/private.wav`,
    `${PROD_URL}/auth/v1/user`,
    `${MOON_URL}/rest/v1/Tracks`,
  ]) {
    await assert.rejects(read(url), /Refusing|only reads/, url);
  }
  assert.equal(sent.length, 2);
  assert.ok(sent.every((s) => s.method === 'GET' || s.method === 'HEAD'));
  assert.equal(sent[0].headers.apikey, PROD_ANON);
  assert.deepEqual(sent[1].headers, {}, 'no key on public audio');
});

test('moonshots writer: refuses production and other projects', () => {
  assert.throws(() => moonshotsWriter('https://uprfsmwbsvzuoiyfgtgx.supabase.co', MOON_SERVICE), /production/);
  assert.throws(() => moonshotsWriter('https://other.supabase.co', MOON_SERVICE), /moonshots/);
  assert.throws(() => moonshotsWriter(MOON_URL, PROD_SERVICE), /another project/);
  assert.throws(() => moonshotsWriter(MOON_URL, undefined), /must be set/);
  assert.equal(typeof moonshotsWriter(MOON_URL, MOON_SERVICE), 'function');
});

// Fake production catalog of three tracks, one with a non-Tracks URL.
const catalogPage = [
  { track_id: 'a1', name: 'RA_TEST_One', track_ref: `${PROD_TRACKS_PREFIX}tracks/u/1.wav`, duration_seconds: 20, Albums: { Artists: { name: 'RA_TEST_Artist', status: 'active' } } },
  { track_id: 'a2', name: 'RA_TEST_Two', track_ref: `${PROD_TRACKS_PREFIX}tracks/u/2.wav`, duration_seconds: 20, Albums: { Artists: { name: 'RA_TEST_Artist', status: 'active' } } },
  { track_id: 'a3', name: 'RA_TEST_Elsewhere', track_ref: 'https://cdn.example.com/3.mp3', duration_seconds: 20, Albums: { Artists: { name: 'X', status: 'active' } } },
];
const audioFor = { '1.wav': synthMusic(31, 20), '2.wav': synthMusic(32, 20) };
function fakeRead(log) {
  return prodReader(PROD_ANON, async (url, init) => {
    log.push(`${init.method} ${url.replace(PROD_URL, '')}`);
    if (url.includes('/rest/v1/Tracks')) return new Response(JSON.stringify(catalogPage));
    const name = url.split('/').pop();
    return new Response(Buffer.from(audioFor[name].buffer));
  });
}
function fakeMoonshots() {
  const db = { catalog: new Map(), fp: [] };
  const write = async (path, { method = 'GET', body } = {}) => {
    if (path.startsWith('ms006_catalog?select')) return [...db.catalog.values()];
    if (path.startsWith('ms006_catalog') && method === 'POST') { db.catalog.set(body.tid, body); return null; }
    if (path.startsWith('ms006_catalog') && method === 'DELETE') {
      const tids = path.match(/\d+/g).map(Number);
      for (const t of tids) db.catalog.delete(t);
      db.fp = db.fp.filter((r) => !tids.includes(r.tid));
      return null;
    }
    if (path === 'ms006_fp' && method === 'POST') { db.fp.push(...body); return null; }
    if (path.startsWith('ms006_fp?tid=eq.') && method === 'DELETE') { const t = Number(path.split('eq.')[1]); db.fp = db.fp.filter((r) => r.tid !== t); return null; }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { db, write };
}
const decode = async (bytes) => new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);

test('fetchActiveTracks keeps only tracks streamed from the public Tracks bucket', async () => {
  const tracks = await fetchActiveTracks(fakeRead([]));
  assert.deepEqual(tracks.map((t) => [t.track_id, t.title, t.artist]), [['a1', 'RA_TEST_One', 'RA_TEST_Artist'], ['a2', 'RA_TEST_Two', 'RA_TEST_Artist']]);
});

test('index builder: production only GETs; moonshots gets catalog rows and fingerprints; reruns skip unchanged audio', async () => {
  const log = [];
  const { db, write } = fakeMoonshots();
  const quiet = () => {};
  const first = await buildIndex({ read: fakeRead(log), write, decode, log: quiet });
  assert.equal(first.indexed, 2);
  assert.ok(log.every((l) => l.startsWith('GET ')), log.join('\n'));
  assert.deepEqual([...db.catalog.values()].map((r) => [r.tid, r.track_id, r.fp_version]), [[1, 'a1', FP_VERSION], [2, 'a2', FP_VERSION]]);
  assert.ok(db.fp.length > 1000 && db.fp.every((r) => r.tid === 1 || r.tid === 2));
  assert.equal(db.catalog.get(1).hash_count, db.fp.filter((r) => r.tid === 1).length);

  const fpBefore = db.fp.length;
  const again = await buildIndex({ read: fakeRead([]), write, decode, log: quiet });
  assert.deepEqual([again.indexed, again.skipped], [0, 2]);
  assert.equal(db.fp.length, fpBefore);

  // a2 leaves the active catalog -> removed from the index.
  catalogPage.splice(1, 1);
  const pruned = await buildIndex({ read: fakeRead([]), write, decode, log: quiet });
  assert.equal(pruned.removed, 1);
  assert.deepEqual([...db.catalog.keys()], [1]);
  assert.ok(db.fp.every((r) => r.tid === 1));
});

test('index builder stops before the row budget, writing nothing for the track that would cross it', async () => {
  catalogPage.splice(1, 0, { track_id: 'a2', name: 'RA_TEST_Two', track_ref: `${PROD_TRACKS_PREFIX}tracks/u/2.wav`, duration_seconds: 20, Albums: { Artists: { name: 'RA_TEST_Artist', status: 'active' } } });
  const { db, write } = fakeMoonshots();
  const oneTrack = (await buildIndex({ read: fakeRead([]), write: fakeMoonshots().write, decode, limit: 1, log: () => {} })).rows;
  await assert.rejects(
    buildIndex({ read: fakeRead([]), write, decode, maxRows: oneTrack + 10, log: () => {} }),
    /index budget: RA_TEST_Artist - RA_TEST_Two/,
  );
  assert.deepEqual([...db.catalog.keys()], [1], 'the first track fits; the second is not written');
  assert.ok(db.fp.every((r) => r.tid === 1));
});

test('index builder --dry-run reads production metadata only', async () => {
  const log = [];
  const stats = await buildIndex({ read: fakeRead(log), write: () => { throw new Error('no writes'); }, dryRun: true, log: () => {} });
  assert.equal(stats.indexed, 0);
  assert.ok(log.every((l) => l.includes('/rest/v1/Tracks')), 'no audio downloaded');
});
