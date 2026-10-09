// make-test-videos CLI: never spends production egress by accident.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { synthSpeech, wavBytes } from '../synth.mjs';

const run = promisify(execFile);
const SCRIPT = new URL('../../scripts/make-test-videos.mjs', import.meta.url).pathname;
// Any fetch in the child process throws: proves no network is touched.
const NO_NETWORK = ['--import', `data:text/javascript,${encodeURIComponent("globalThis.fetch = () => { throw new Error('network used'); };")}`];
const env = { PATH: process.env.PATH };

test('refuses to run without --catalog-dir (no --allow-prod-download)', async () => {
  const err = await run('node', [...NO_NETWORK, SCRIPT, '--speech-dir', '/nonexistent'], { env }).then(() => null, (e) => e);
  assert.ok(err, 'must exit non-zero');
  assert.equal(err.code, 1);
  assert.match(err.stderr, /Refusing to run without --catalog-dir/);
});

test('rejects unknown --only values', async () => {
  const err = await run('node', [...NO_NETWORK, SCRIPT, '--catalog-dir', '/x', '--only', 'quiet,bogus'], { env }).then(() => null, (e) => e);
  assert.equal(err?.code, 1);
  assert.match(err.stderr, /--only: unknown bogus/);
});

test('with --catalog-dir and --only it makes just those videos, offline, and merges the manifest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ms006-videos-'));
  await mkdir(join(dir, 'cat'));
  await mkdir(join(dir, 'speech'));
  const catalog = [];
  for (let i = 1; i <= 10; i++) {
    await writeFile(join(dir, 'cat', `t${i}.wav`), wavBytes(new Float32Array(1600)));
    catalog.push({ track_id: `00000000-0000-4000-8000-00000000000${i - 1}`, title: `RA_TEST ${i}`, artist: 'RA_TEST', file: `t${i}.wav`, stream_url: 'x', duration_s: 120 });
  }
  await writeFile(join(dir, 'cat', 'catalog.json'), JSON.stringify(catalog));
  for (let i = 0; i < 4; i++) await writeFile(join(dir, 'speech', `s${i}.wav`), wavBytes(synthSpeech(40 + i, 20)));
  const out = join(dir, 'out');
  await mkdir(out);
  await writeFile(join(out, 'manifest.json'), JSON.stringify({ videos: [{ file: 'RA_TEST_two_tracks.mp4', kind: 'two_tracks', expect: [] }] }));
  await run('node', [...NO_NETWORK, SCRIPT, '--catalog-dir', join(dir, 'cat'), '--speech-dir', join(dir, 'speech'), '--only', 'no_music', '--out', out], { env, timeout: 120000 });
  const m = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
  assert.deepEqual(m.videos.map((v) => v.file), ['RA_TEST_two_tracks.mp4', 'RA_TEST_no_music_speech.mp4', 'RA_TEST_no_music_other.mp4']);
});
