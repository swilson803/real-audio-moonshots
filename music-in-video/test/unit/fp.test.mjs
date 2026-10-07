// Fingerprint module: hash packing, determinism across chunking, the
// resampler, silence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Fingerprinter, Resampler, SAMPLE_RATE, fingerprint, packHash, unpackHash } from '../../public/music/fp.js';
import { synthMusic, tone } from '../synth.mjs';

test('hash packs and unpacks f1, f2, dt in 24 bits', () => {
  for (const [f1, f2, dt] of [[0, 0, 0], [511, 511, 63], [17, 400, 9]]) {
    const h = packHash(f1, f2, dt);
    assert.ok(h >= 0 && h < 1 << 24);
    assert.deepEqual(unpackHash(h), [f1, f2, dt]);
  }
});

test('the same audio gives the same hashes however it is chunked', () => {
  const audio = synthMusic(42, 12);
  const whole = fingerprint(audio);
  const fp = new Fingerprinter();
  for (let i = 0, step = 777; i < audio.length; i += step, step = 333 + ((step * 7) % 4001)) fp.push(audio.subarray(i, i + step));
  const chunked = fp.finish();
  assert.ok(whole.hashes.length > 300, `expected plenty of hashes, got ${whole.hashes.length}`);
  assert.deepEqual(chunked.hashes, whole.hashes);
  assert.deepEqual(chunked.times, whole.times);
});

test('music gives roughly 20 peaks and 40 hashes a second (the index size budget)', () => {
  const r = fingerprint(synthMusic(7, 30));
  assert.ok(r.peaks / 30 > 10 && r.peaks / 30 < 30, `peaks/s ${r.peaks / 30}`);
  assert.ok(r.hashes.length / 30 > 25 && r.hashes.length / 30 < 50, `hashes/s ${r.hashes.length / 30}`);
});

test('digital silence gives no hashes', () => {
  assert.equal(fingerprint(new Float32Array(SAMPLE_RATE * 5)).hashes.length, 0);
});

// Dominant frequency by brute-force DFT over a short window.
function dominantHz(x, rate, from, to, step) {
  let best = 0;
  let bestHz = 0;
  const n = 4096;
  const seg = x.subarray(x.length / 2, x.length / 2 + n);
  for (let hz = from; hz <= to; hz += step) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      re += seg[i] * Math.cos((2 * Math.PI * hz * i) / rate);
      im -= seg[i] * Math.sin((2 * Math.PI * hz * i) / rate);
    }
    const p = re * re + im * im;
    if (p > best) { best = p; bestHz = hz; }
  }
  return bestHz;
}

for (const src of [44100, 48000, 22050]) {
  test(`resampler ${src} -> 16000 keeps pitch and length, streamed in chunks`, () => {
    const x = tone(1000, 2, src);
    const rs = new Resampler(src);
    const parts = [];
    for (let i = 0; i < x.length; i += 1000) parts.push(rs.push(x.subarray(i, i + 1000)));
    const y = Float32Array.from(parts.flatMap((p) => Array.from(p)));
    assert.ok(Math.abs(y.length - 2 * SAMPLE_RATE) < 40, `length ${y.length}`);
    assert.equal(dominantHz(y, SAMPLE_RATE, 900, 1100, 5), 1000);
    let rms = 0;
    for (let i = 4000; i < 28000; i++) rms += y[i] * y[i];
    assert.ok(Math.abs(Math.sqrt(rms / 24000) - 0.5 / Math.SQRT2) < 0.02, 'amplitude kept');
  });
}

test('resampler removes content above the new Nyquist', () => {
  const y = new Resampler(48000).push(tone(11000, 1, 48000));
  let rms = 0;
  for (let i = 1000; i < y.length - 1000; i++) rms += y[i] * y[i];
  assert.ok(Math.sqrt(rms / (y.length - 2000)) < 0.01, 'an 11 kHz tone must not alias into 16 kHz audio');
});
