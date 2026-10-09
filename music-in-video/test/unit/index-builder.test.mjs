// Phase-2 index builder: --tracks-file, the keyless audio-only reader, the
// audio cache, the egress budget, pending -> redo crash safety, per-track
// failures, moonshots write retries. Fake fetch / write / decode only: no
// network, no Supabase.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { FP_VERSION } from '../../public/music/fp.js';
import { buildIndex, extOf, parseTracksFile } from '../../scripts/build-catalog-index.mjs';
import { PROD_TRACKS_PREFIX, moonshotsWriter, prodAudioReader } from '../../scripts/lib/targets.mjs';
import { synthMusic } from '../synth.mjs';

const run = promisify(execFile);
const SCRIPT = new URL('../../scripts/build-catalog-index.mjs', import.meta.url).pathname;
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const url = (name) => `${PROD_TRACKS_PREFIX}fma/x/${name}`;
const entry = (n, name, extra = {}) => ({ track_id: uuid(n), title: `RA_TEST_title_${n}`, artist: 'RA_TEST_artist', stream_url: url(name), duration_s: 12, album_status: 'active', size: null, ...extra });
const quiet = () => {};
const noSleep = async () => {};

// Synthetic "audio files": raw float32 samples, decoded by the fake decoder.
const AUDIO = new Map([1, 2, 3, 4, 5].map((n) => [n, Buffer.from(synthMusic(5000 + n, 12).buffer)]));
const pcm = (buf) => new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
const decode = async (input) => pcm(typeof input === 'string' ? await readFile(input) : input);

// Fake production: serves AUDIO by file name, records every request.
function fakeProd({ failing = new Set(), noLength = new Set() } = {}) {
  const calls = [];
  const fetchImpl = async (href, init = {}) => {
    calls.push({ href, method: init.method, headers: init.headers });
    const name = decodeURIComponent(href.split('/').pop());
    const n = Number(name.match(/track(\d+)/)?.[1]);
    if (failing.has(n) || !AUDIO.has(n)) return new Response('nope', { status: 404 });
    const body = AUDIO.get(n);
    return new Response(body, { status: 200, headers: noLength.has(n) ? {} : { 'content-length': String(body.length) } });
  };
  return { calls, read: prodAudioReader(fetchImpl) };
}

// Fake moonshots REST, enough for the builder.
function fakeMoonshots({ failOn = null } = {}) {
  const db = { catalog: new Map(), fp: [] };
  const write = async (path, { method = 'GET', body } = {}) => {
    if (failOn && failOn(path, method)) throw new Error(`moonshots ${method} ${path} 500: fake outage`);
    if (path.startsWith('ms006_catalog?select')) return [...db.catalog.values()].map((r) => ({ ...r }));
    if (path.startsWith('ms006_catalog?on_conflict') && method === 'POST') { db.catalog.set(body.tid, { ...db.catalog.get(body.tid), ...body }); return null; }
    if (path.startsWith('ms006_catalog?tid=eq.') && method === 'PATCH') { Object.assign(db.catalog.get(Number(path.split('eq.')[1])), body); return null; }
    if (path.startsWith('ms006_catalog?tid=in.') && method === 'DELETE') {
      const tids = path.match(/\((.*)\)/)[1].split(',').map(Number);
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

test('tracks file: valid entries kept with only the known fields; invalid ones reported', () => {
  const { tracks, invalid } = parseTracksFile([
    entry(1, 'HoliznaCC0%20-%20Mercury%20%28Live%29%27s.mp3'),
    entry(2, 'b.wav', { track_id: 'not-a-uuid' }),
    entry(3, 'c.wav', { stream_url: 'https://uprfsmwbsvzuoiyfgtgx.supabase.co/storage/v1/object/public/agreements/c.pdf' }),
    entry(4, 'd.wav', { stream_url: `${PROD_TRACKS_PREFIX}../agreements/d.pdf` }),
    entry(5, 'e.wav', { title: '  ' }),
    entry(1, 'dup.wav'),
  ]);
  assert.deepEqual(tracks.map((t) => Object.keys(t)), [['track_id', 'title', 'artist', 'stream_url', 'duration_s']]);
  assert.deepEqual(invalid.map((x) => x.error), [
    'invalid entry: track_id is not a uuid',
    'invalid entry: stream_url is not under the public Tracks bucket',
    'invalid entry: stream_url is not under the public Tracks bucket',
    'invalid entry: empty title',
    'invalid entry: duplicate track_id',
  ]);
});

test('cache file extension comes from the decoded URL path', () => {
  assert.equal(extOf(url('A%20B%20%28mix%29.MP3')), '.mp3');
  assert.equal(extOf(url('x.m4a')), '.m4a');
  assert.equal(extOf(url('noext')), '.audio');
});

test('keyless audio reader: GET/HEAD of public Tracks objects only, no key, nothing else', async () => {
  const sent = [];
  const read = prodAudioReader(async (href, init) => { sent.push({ href, init }); return new Response(''); });
  await read(url('a.wav'));
  await read(url('a.wav'), { method: 'HEAD' });
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await assert.rejects(read(url('a.wav'), { method }), /read only/);
  for (const bad of [
    'https://uprfsmwbsvzuoiyfgtgx.supabase.co/rest/v1/Tracks?select=*',
    'https://uprfsmwbsvzuoiyfgtgx.supabase.co/rest/v1/rpc/increment_track_play',
    'https://uprfsmwbsvzuoiyfgtgx.supabase.co/storage/v1/object/public/agreements/a.pdf',
    'https://uprfsmwbsvzuoiyfgtgx.supabase.co/storage/v1/object/Tracks/a.wav',
    `${PROD_TRACKS_PREFIX}../agreements/a.pdf`,
    'https://kucwpmtkctafzkivuqtu.supabase.co/storage/v1/object/public/Tracks/a.wav',
    'not a url',
  ]) {
    await assert.rejects(read(bad), /Refusing/, bad);
  }
  assert.equal(sent.length, 2);
  assert.ok(sent.every((s) => !s.init.headers), 'no headers at all, so no key');
});

test('tracks file + cache: first run downloads once, second run uses only the cache', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'ms006-cache-'));
  const list = [entry(1, 'track1%20%28a%29.mp3'), entry(2, 'track2.wav'), entry(3, 'track3.m4a')];
  const { db, write } = fakeMoonshots();
  const prod = fakeProd();
  const first = await buildIndex({ tracksList: list, audioRead: prod.read, write, decode, cacheDir, sleep: noSleep, log: quiet });
  const total = [1, 2, 3].reduce((n, k) => n + AUDIO.get(k).length, 0);
  assert.equal(first.indexed, 3);
  assert.equal(first.bytes_downloaded, total);
  assert.equal(first.bytes_from_cache, 0);
  assert.equal(prod.calls.length, 3);
  assert.ok(prod.calls.every((c) => c.href.startsWith(PROD_TRACKS_PREFIX) && !c.headers), 'audio only, keyless; no REST');
  assert.deepEqual((await readdir(cacheDir)).sort(), [`${uuid(1)}.mp3`, `${uuid(2)}.wav`, `${uuid(3)}.m4a`, 'catalog.json']);
  const catalog = JSON.parse(await readFile(join(cacheDir, 'catalog.json'), 'utf8'));
  assert.deepEqual(catalog[0], { track_id: uuid(1), title: 'RA_TEST_title_1', artist: 'RA_TEST_artist', file: `${uuid(1)}.mp3`, stream_url: list[0].stream_url, duration_s: 12 });
  assert.ok([...db.catalog.values()].every((r) => r.audio_sha256 !== 'pending' && r.fp_version === FP_VERSION));
  assert.equal(db.fp.length, first.total_fp_rows);
  assert.ok(!('album_status' in db.catalog.get(1)) && !('size' in db.catalog.get(1)), 'only table columns are written');

  const prod2 = fakeProd();
  const second = await buildIndex({ tracksList: list, audioRead: prod2.read, write, decode, cacheDir, sleep: noSleep, log: quiet });
  assert.equal(prod2.calls.length, 0, 'no network on a full cache');
  assert.deepEqual([second.bytes_downloaded, second.bytes_from_cache, second.skipped, second.indexed], [0, total, 3, 0]);
  assert.deepEqual(second.per_track_hashes, first.per_track_hashes);
});

test('egress budget: a download that would cross it is cancelled before its body; no more downloads; cached tracks still index', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'ms006-budget-'));
  await writeFile(join(cacheDir, `${uuid(4)}.wav`), AUDIO.get(4)); // already cached
  const list = [entry(1, 'track1.wav'), entry(2, 'track2.wav'), entry(3, 'track3.wav'), entry(4, 'track4.wav')];
  const budget = AUDIO.get(1).length + 10;
  const prod = fakeProd();
  const { write } = fakeMoonshots();
  const stats = await buildIndex({ tracksList: list, audioRead: prod.read, write, decode, cacheDir, maxEgressBytes: budget, sleep: noSleep, log: quiet });
  assert.equal(stats.bytes_downloaded, AUDIO.get(1).length, 'track 2 cancelled before any body byte');
  assert.equal(stats.egress_budget_hit, true);
  assert.deepEqual(stats.failed.map((f) => [f.track_id, f.error.split(':')[0]]), [[uuid(2), 'egress budget'], [uuid(3), 'egress budget']]);
  assert.equal(prod.calls.length, 2, 'track 3 is never requested');
  assert.equal(stats.indexed, 2, 'track 1 (downloaded) and track 4 (cached)');
  assert.equal(stats.bytes_from_cache, AUDIO.get(4).length);
  const catalog = JSON.parse(await readFile(join(cacheDir, 'catalog.json'), 'utf8'));
  assert.deepEqual(catalog.map((c) => c.track_id), [uuid(1), uuid(4)]);
});

test('egress budget without Content-Length: partial bytes count and the .part file is removed', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'ms006-partial-'));
  const prod = fakeProd({ noLength: new Set([1]) });
  const stats = await buildIndex({ tracksList: [entry(1, 'track1.wav')], audioRead: prod.read, write: fakeMoonshots().write, decode, cacheDir, maxEgressBytes: 1000, sleep: noSleep, log: quiet });
  assert.ok(stats.bytes_downloaded > 1000 && stats.bytes_downloaded <= AUDIO.get(1).length, `counted ${stats.bytes_downloaded}`);
  assert.match(stats.failed[0].error, /egress budget/);
  assert.deepEqual(await readdir(cacheDir), ['catalog.json']);
});

test('crash between fingerprints and the final PATCH: the rerun redoes that track, same tid, no duplicate rows', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'ms006-crash-'));
  const list = [entry(1, 'track1.wav'), entry(2, 'track2.wav')];
  const moon = fakeMoonshots({ failOn: (path, method) => method === 'PATCH' && path === 'ms006_catalog?tid=eq.2' });
  await assert.rejects(
    buildIndex({ tracksList: list, audioRead: fakeProd().read, write: moon.write, decode, cacheDir, sleep: noSleep, log: quiet }),
    (err) => err.stats?.indexed === 1 && /fake outage/.test(err.stats.error),
  );
  assert.equal(moon.db.catalog.get(2).audio_sha256, 'pending');
  const rowsOf2 = moon.db.fp.filter((r) => r.tid === 2).length;
  assert.ok(rowsOf2 > 0, 'its fingerprints were written before the crash');

  const fixed = fakeMoonshots();
  fixed.db.catalog = moon.db.catalog;
  fixed.db.fp = moon.db.fp;
  const prod = fakeProd();
  const again = await buildIndex({ tracksList: list, audioRead: prod.read, write: fixed.write, decode, cacheDir, sleep: noSleep, log: quiet });
  assert.equal(prod.calls.length, 0, 'both files come from the cache');
  assert.deepEqual([again.skipped, again.indexed], [1, 1]);
  assert.notEqual(fixed.db.catalog.get(2).audio_sha256, 'pending');
  assert.equal(fixed.db.catalog.get(2).track_id, uuid(2), 'tid 2 kept for the same track');
  assert.equal(fixed.db.fp.filter((r) => r.tid === 2).length, rowsOf2, 'old rows deleted before the redo');
});

test('per-track failures (download 404 after retries, decode error, zero hashes) are recorded and the run continues', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'ms006-fail-'));
  const list = [entry(1, 'track1.wav'), entry(2, 'track2.wav'), entry(3, 'track3.wav'), entry(5, 'track5.wav')];
  const prod = fakeProd({ failing: new Set([1]) });
  AUDIO.set(5, Buffer.from(new Float32Array(16000 * 3).buffer)); // silence
  const badDecode = async (input) => {
    if (String(input).includes(uuid(2))) throw new Error('ffmpeg 1: Invalid data found when processing input');
    return decode(input);
  };
  const stats = await buildIndex({ tracksList: list, audioRead: prod.read, write: fakeMoonshots().write, decode: badDecode, cacheDir, sleep: noSleep, log: quiet });
  assert.deepEqual(stats.failed.map((f) => [f.track_id, f.error.split(':')[0]]), [
    [uuid(1), 'download failed after 3 attempts'],
    [uuid(2), 'decode'],
    [uuid(5), 'zero hashes (silent or undecodable audio)'],
  ]);
  assert.equal(prod.calls.filter((c) => c.href.includes('track1')).length, 3, '2 retries');
  assert.equal(stats.indexed, 1);
  AUDIO.delete(5);
});

test('removal: tracks no longer listed leave the index on a full run, not with --limit', async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'ms006-remove-'));
  const moon = fakeMoonshots();
  await buildIndex({ tracksList: [entry(1, 'track1.wav'), entry(2, 'track2.wav')], audioRead: fakeProd().read, write: moon.write, decode, cacheDir, sleep: noSleep, log: quiet });
  const limited = await buildIndex({ tracksList: [entry(1, 'track1.wav')], audioRead: fakeProd().read, write: moon.write, decode, cacheDir, limit: 1, sleep: noSleep, log: quiet });
  assert.equal(limited.removed, 0);
  const full = await buildIndex({ tracksList: [entry(1, 'track1.wav')], audioRead: fakeProd().read, write: moon.write, decode, cacheDir, sleep: noSleep, log: quiet });
  assert.equal(full.removed, 1);
  assert.deepEqual([...moon.db.catalog.keys()], [1]);
  assert.ok(moon.db.fp.every((r) => r.tid === 1));
  assert.equal(full.total_fp_rows, moon.db.fp.length);
});

test('CLI --dry-run --tracks-file: no keys needed, no network, report written', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ms006-cli-'));
  await writeFile(join(dir, 'tracks.json'), JSON.stringify([entry(1, 'track1.wav'), entry(2, 'x.wav', { track_id: 'bad' })]));
  const env = { PATH: process.env.PATH };
  const { stdout } = await run('node', [SCRIPT, '--dry-run', '--tracks-file', join(dir, 'tracks.json'), '--cache-dir', join(dir, 'cache'), '--report', join(dir, 'report.json')], { env })
    .catch((e) => e); // exit code 2: one invalid entry
  assert.match(stdout, /tracks-file: 1 tracks \(1 invalid entries skipped\)/);
  assert.match(stdout, /missing {2}RA_TEST_artist - RA_TEST_title_1/);
  const report = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8'));
  assert.deepEqual([report.source, report.tracks, report.bytes_downloaded, report.failed.length], ['tracks-file', 1, 0, 1]);
});

test('moonshots writes retry network errors, 5xx and 429 with backoff, but not 4xx', async () => {
  const waits = [];
  const sleep = async (ms) => { waits.push(ms); };
  const key = `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ ref: 'kucwpmtkctafzkivuqtu', role: 'service_role' })).toString('base64url')}.sig`;
  const script = [() => { throw new TypeError('fetch failed'); }, () => new Response('busy', { status: 503 }), () => new Response('slow', { status: 429 }), () => new Response(null, { status: 201 })];
  let n = 0;
  const write = moonshotsWriter('https://kucwpmtkctafzkivuqtu.supabase.co', key, async () => script[n++](), { sleep });
  assert.equal(await write('ms006_fp', { method: 'POST', body: [] }), null);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  let calls = 0;
  const bad = moonshotsWriter('https://kucwpmtkctafzkivuqtu.supabase.co', key, async () => { calls++; return new Response('nope', { status: 400 }); }, { sleep });
  await assert.rejects(bad('ms006_fp', { method: 'POST', body: [] }), /400: nope/);
  assert.equal(calls, 1);
  let tries = 0;
  const down = moonshotsWriter('https://kucwpmtkctafzkivuqtu.supabase.co', key, async () => { tries++; return new Response('down', { status: 502 }); }, { sleep });
  await assert.rejects(down('ms006_fp'), /502: down/);
  assert.equal(tries, 4, 'first try + 3 retries');
});
