// The offline replica of the index: built from a cached catalog with the same
// fingerprint as the index build; leave-one-out lookups.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fingerprint, QUERY } from '../../public/music/fp.js';
import { clustersInMemory, match } from '../../src/match.js';
import { buildReplica } from '../../scripts/replica.mjs';
import { decodeToPcm } from '../../scripts/build-catalog-index.mjs';
import { place, slice, synthMusic, synthSpeech, wavBytes } from '../synth.mjs';

test('replica: index-identical fingerprints, sliced lookups, leave-one-out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ms006-replica-'));
  const audio = [synthMusic(61, 40), synthMusic(62, 40), synthMusic(63, 40)];
  const catalog = [];
  for (const [i, a] of audio.entries()) {
    await writeFile(join(dir, `t${i}.wav`), wavBytes(a));
    catalog.push({ track_id: `00000000-0000-4000-8000-00000000000${i}`, title: `RA_TEST ${i}`, artist: 'RA_TEST', file: `t${i}.wav`, stream_url: 'x', duration_s: 40 });
  }
  await writeFile(join(dir, 'catalog.json'), JSON.stringify(catalog));
  const rep = await buildReplica({ cacheDir: dir, out: join(dir, 'replica'), threads: 2, log: () => {} });
  assert.equal(rep.tracks.length, 3);
  assert.deepEqual(rep.tracks.map((t) => t.tid), [1, 2, 3]);
  const direct = fingerprint(await decodeToPcm(join(dir, 't1.wav')));
  assert.deepEqual(rep.tracks[1].hashes, direct.hashes);
  assert.equal(rep.rows, rep.tracks.reduce((n, t) => n + t.hashes.length, 0));

  const fp = fingerprint(place(synthSpeech(64, 30), slice(audio[1], 5, 30), 3, -12), QUERY);
  const q = { hashes: fp.hashes, times: fp.times, peaks: { t: fp.peakT, f: fp.peakF } };
  assert.deepEqual(await rep.db.lookup(q.hashes, q.times), clustersInMemory(rep.index, q.hashes, q.times));
  assert.deepEqual((await match(q, rep.db)).map((s) => s.tid), [2]);
  const without = { ...rep.db, lookup: rep.db.lookupWithout([catalog[1].track_id]) };
  assert.deepEqual(await match(q, without), [], 'track left out: nothing found');
});
