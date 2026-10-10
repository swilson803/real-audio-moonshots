// The POST /api/scan body (MS-007): the soundtrack as 16 kHz mono 16-bit PCM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BODY_VERSION, HEADER_BYTES, PcmCollector, decodeScanBody, readScanHeader } from '../../public/music/body.js';
import { SAMPLE_RATE } from '../../public/music/fp.js';

const join = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) { out.set(new Uint8Array(p), at); at += p.byteLength; }
  return out.buffer;
};

test('the page\'s chunks come back as the same samples (to 16-bit precision), with the header', () => {
  const pcm = new PcmCollector();
  const a = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i / 7) * 0.8);
  const b = Float32Array.from({ length: 500 }, (_, i) => (i % 2 ? 1.5 : -1.5)); // clipped
  pcm.push(a);
  pcm.push(b);
  const { parts, bytes, durationMs } = pcm.finish(93.75);
  const buf = join(parts);
  assert.equal(bytes, HEADER_BYTES + 1500 * 2);
  assert.equal(buf.byteLength, bytes);
  assert.equal(durationMs, 94);
  const out = decodeScanBody(buf);
  assert.equal(out.version, BODY_VERSION);
  assert.equal(out.sampleRate, SAMPLE_RATE);
  assert.equal(out.durationMs, 94);
  assert.equal(out.samples.length, 1500);
  for (let i = 0; i < 1000; i++) assert.ok(Math.abs(out.samples[i] - a[i]) < 1 / 16000, `sample ${i}`);
  assert.ok(Math.abs(out.samples[1000] + 1) < 1e-3 && Math.abs(out.samples[1001] - 1) < 1e-3, 'clipped to full scale');
  assert.deepEqual(readScanHeader(buf), { version: BODY_VERSION, sampleRate: SAMPLE_RATE, durationMs: 94, n: 1500 });
});

test('anything else is not a body: wrong magic, short, or a length that doesn\'t add up', () => {
  const pcm = new PcmCollector();
  pcm.push(new Float32Array(10));
  const good = join(pcm.finish(1).parts);
  assert.ok(readScanHeader(good));
  assert.equal(readScanHeader(new ArrayBuffer(0)), null);
  assert.equal(readScanHeader(good.slice(0, HEADER_BYTES - 1)), null);
  assert.equal(readScanHeader(good.slice(0, good.byteLength - 2)), null, 'a sample short');
  const extra = new Uint8Array(good.byteLength + 2);
  extra.set(new Uint8Array(good));
  assert.equal(readScanHeader(extra.buffer), null, 'a sample long');
  const notOurs = new Uint8Array(good.slice(0));
  notOurs[0] = 0x00;
  assert.equal(decodeScanBody(notOurs.buffer), null);
  // An MS-006 fingerprint body ([FP_VERSION, duration_ms, n, ...] int32s) is refused.
  assert.equal(readScanHeader(Int32Array.from([1, 60000, 0, 0, 0]).buffer), null);
});
