// The POST /api/scan body codec shared by the page and the Worker: the page
// sends its verification peaks + a hash-peak bit each; the Worker rebuilds
// exactly the page's hashes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FP_VERSION, QUERY, fingerprint } from '../../public/music/fp.js';
import { decodeScanBody, encodeScanBody } from '../../public/music/body.js';
import { place, synthMusic, synthSpeech } from '../synth.mjs';

const fp = fingerprint(place(synthSpeech(71, 30), synthMusic(72, 25), 2, -12), QUERY);

test('the Worker rebuilds exactly the page\'s hashes and peaks from a small body', () => {
  assert.ok(fp.hashPeaksCovered);
  const buf = encodeScanBody({ ...fp, durationMs: 30000 });
  const q = decodeScanBody(buf);
  assert.equal(q.version, FP_VERSION);
  assert.equal(q.durationMs, 30000);
  assert.deepEqual(q.hashes, fp.hashes);
  assert.deepEqual(q.times, fp.times);
  assert.deepEqual(q.peaks.t, fp.peakT);
  assert.deepEqual(q.peaks.f, fp.peakF);
  assert.ok(buf.byteLength < 4.3 * fp.peakT.length + 16, 'about 4 bytes a peak');
  assert.ok(buf.byteLength < 50000, `${buf.byteLength} B for 30 s`);
});

test('malformed bodies decode to null; uncovered hash peaks refuse to encode', () => {
  const ok = new Int32Array(encodeScanBody({ ...fp, durationMs: 30000 }));
  assert.equal(decodeScanBody(new ArrayBuffer(0)), null);
  assert.equal(decodeScanBody(new ArrayBuffer(6)), null);
  assert.equal(decodeScanBody(new Int32Array([FP_VERSION, 1000]).buffer), null);
  assert.equal(decodeScanBody(ok.slice(0, ok.length - 1).buffer), null, 'flag words missing');
  const neg = ok.slice();
  neg[3] = -1;
  assert.equal(decodeScanBody(neg.buffer), null, 'negative peak');
  const unsorted = ok.slice();
  const i = [...unsorted.subarray(3, 3 + unsorted[2])].findIndex((p, k, a) => k && p > a[k - 1]) + 3;
  [unsorted[i - 1], unsorted[i]] = [unsorted[i], unsorted[i - 1]];
  assert.equal(decodeScanBody(unsorted.buffer), null, 'peaks out of order');
  assert.throws(() => encodeScanBody({ ...fp, hashPeaksCovered: false, durationMs: 1 }), /every hash peak/);
});
