// Matcher on synthetic audio generated here: a clean match, two tracks under
// a speech-like voice, no-match cases, and the quiet bed at 20 dB under the
// voice. Synthetic music and "speech" are stand-ins: these show the matcher
// works as designed, not that it meets the bar on real recordings (phase 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprint } from '../../public/music/fp.js';
import { candidatesFromClusters, finalSegments, framesToSec, match } from '../../src/match.js';
import { syntheticCatalog } from '../fixtures.mjs';
import { place, silence, slice, synthMusic, synthSpeech } from '../synth.mjs';

const cat = syntheticCatalog();
const audioOf = (tid) => cat.tracks[tid - 1].audio;
const find = async (audio) => (await match(fingerprint(audio), cat.deps)).map((s) => ({ ...s, startS: framesToSec(s.start), endS: framesToSec(s.end) }));

test('clean match: a track excerpt in silence is found at its start time', async () => {
  const found = await find(place(silence(40), slice(audioOf(3), 10, 35), 4));
  assert.equal(found.length, 1);
  assert.equal(found[0].tid, 3);
  assert.ok(Math.abs(found[0].startS - 4) <= 1, `start ${found[0].startS}`);
  assert.ok(Math.abs(found[0].endS - 29) <= 1, `end ${found[0].endS}`);
});

test('two tracks under a voice (12 dB down) are both found, in order, with start times', async () => {
  const bed = synthSpeech(31, 75);
  place(bed, slice(audioOf(5), 30, 62), 4, -12);
  place(bed, slice(audioOf(9), 60, 88), 40, -12);
  const found = await find(bed);
  assert.deepEqual(found.map((s) => s.tid), [5, 9]);
  assert.ok(Math.abs(found[0].startS - 4) <= 1, `A start ${found[0].startS}`);
  assert.ok(Math.abs(found[1].startS - 40) <= 1, `B start ${found[1].startS}`);
});

test('no match: voice only finds nothing', async () => {
  for (const seed of [901, 902, 903]) assert.deepEqual(await find(synthSpeech(seed, 60)), [], `seed ${seed}`);
});

test('no match: voice over music that is not in the catalog finds nothing', async () => {
  // Seeds whose tempo isn't within 1% of a catalog track (see the
  // same-tempo test below for what happens when it is).
  for (const seed of [5001, 5002, 5003]) {
    assert.deepEqual(await find(place(synthSpeech(seed + 50, 60), synthMusic(seed, 55), 3, -10)), [], `seed ${seed}`);
  }
});

test('quiet bed 20 dB under a voice: found with the right start in at least 8 of 10 synthetic trials', async () => {
  let ok = 0;
  const log = [];
  for (let k = 0; k < 10; k++) {
    const tid = (k % 12) + 1;
    const at = 2 + ((k * 0.73) % 8);
    const from = 3 + k * 2;
    const found = await find(place(synthSpeech(500 + k, 60), slice(audioOf(tid), from, from + 45), at, -20));
    const good = found.length === 1 && found[0].tid === tid && Math.abs(found[0].startS - at) <= 1;
    if (good) ok++;
    log.push(found.length ? `${found[0].tid === tid ? (found[0].startS - at).toFixed(2) : 'wrong'}${found.length > 1 ? '+extra' : ''}` : 'none');
  }
  console.log(`  synthetic -20 dB trials: ${ok}/10 (start error s: ${log.join(' ')})`);
  assert.ok(ok >= 8, `${ok}/10`);
});

test('a track used twice (restarted) is two rows', async () => {
  const bed = silence(80);
  place(bed, slice(audioOf(2), 0, 25), 2);
  place(bed, slice(audioOf(2), 0, 25), 45);
  const found = await find(bed);
  assert.deepEqual(found.map((s) => s.tid), [2, 2]);
  assert.ok(Math.abs(found[0].startS - 2) <= 1 && Math.abs(found[1].startS - 45) <= 1, found.map((s) => s.startS).join(','));
});

test('candidates: adjacent offset bins merge, distinct hits count once, weak alignments drop', () => {
  const clusters = [
    { tid: 1, bin: 10, hits: [100, 110, 120], deltas: [40, 41, 42] },
    { tid: 1, bin: 11, hits: [120, 130, 140], deltas: [44, 45, 46] },
    { tid: 2, bin: -3, hits: [5, 6], deltas: [-10, -9] },
  ];
  const c = candidatesFromClusters(clusters, { minHits: 5 });
  assert.equal(c.length, 1);
  assert.deepEqual({ tid: c[0].tid, start: c[0].start, end: c[0].end, hits: c[0].hits }, { tid: 1, start: 100, end: 140, hits: 5 });
  assert.equal(c[0].delta, 44);
});

test('final segments: each second goes to the locally strongest alignment; scraps drop', () => {
  // Coincidence times (frames) every ~0.2 s over [from, to) seconds.
  const run = (from, to) => Array.from({ length: Math.round((to - from) * 5) }, (_, i) => Math.round((from + i / 5) * 62.5));
  const out = finalSegments([
    { tid: 1, delta: 0, times: [...run(2, 27), ...run(45, 50).filter((_, i) => i % 3 === 0)] }, // weakly echoes into the restart
    { tid: 1, delta: 2700, times: run(45, 70) }, // the restart
    { tid: 2, delta: 50, times: run(10, 12) }, // a chance scrap inside track 1
    { tid: 3, delta: 9, times: run(75, 90) }, // separate, kept
  ]);
  assert.deepEqual(out.map((s) => [s.tid, Math.round(s.start / 62.5), Math.round(s.end / 62.5)]), [[1, 2, 27], [1, 45, 70], [3, 75, 90]]);
});
