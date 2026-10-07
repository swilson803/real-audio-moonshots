// Synthetic audio for the tests, generated locally from a seed: no catalog
// audio, no network. All at SAMPLE_RATE, mono, roughly -1..1.
import { SAMPLE_RATE } from '../public/music/fp.js';

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SR = SAMPLE_RATE;

// A "track": a melody over a bass line with a kick and noisy hats, notes from
// a seeded scale and tempo, so every seed is a different piece.
export function synthMusic(seed, seconds) {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * SR));
  const bpm = 80 + r() * 60;
  const beat = 60 / bpm;
  const root = 40 + Math.floor(r() * 12);
  // Each piece gets its own kit and groove, so two pieces at the same tempo
  // don't share a drum track.
  const kickHz = 45 + r() * 30;
  const hatDecay = 0.004 + r() * 0.012;
  const hatEvery = 1 + Math.floor(r() * 2); // every 8th or every quarter
  const kickPattern = [0b10001000, 0b10010010, 0b10100100, 0b10001010][Math.floor(r() * 4)];
  const scale = [0, 2, 3, 5, 7, 8, 10, 12, 14, 15];
  const hz = (m) => 440 * 2 ** ((m - 69) / 12);
  const add = (t0, dur, f, amp, harmonics) => {
    const i0 = Math.round(t0 * SR);
    const n = Math.round(dur * SR);
    for (let i = 0; i < n && i0 + i < out.length; i++) {
      const t = i / SR;
      const env = Math.min(1, t / 0.01) * Math.exp(-3 * t / dur);
      let v = 0;
      for (let h = 1; h <= harmonics; h++) v += Math.sin(2 * Math.PI * f * h * t) / h;
      out[i0 + i] += amp * env * v;
    }
  };
  const steps = Math.floor(seconds / (beat / 2));
  for (let s = 0; s < steps; s++) {
    const t = s * beat / 2;
    if (r() < 0.85) add(t, beat / 2, hz(root + 24 + scale[Math.floor(r() * scale.length)]), 0.18, 4);
    if (s % 2 === 0) add(t, beat, hz(root + scale[Math.floor(r() * 5)]), 0.25, 3);
    if ((kickPattern >> (7 - (s % 8))) & 1) add(t, 0.15, kickHz, 0.5, 1); // kick
    if (s % hatEvery) continue;
    // hat: short burst of differentiated noise (bright)
    const i0 = Math.round(t * SR);
    let prev = 0;
    for (let i = 0; i < 0.04 * SR && i0 + i < out.length; i++) {
      const w = r() * 2 - 1;
      out[i0 + i] += 0.12 * (w - prev) * Math.exp(-i / (hatDecay * SR));
      prev = w;
    }
  }
  return normalize(out, 0.25);
}

// Speech-like: a glottal pulse train (f0 100-220 Hz, wandering) through three
// formant resonators that change every syllable (~4 per second), with
// fricative noise and pauses between phrases. Not speech, but it fills the
// same band with the same rhythm, which is what masks music.
export function synthSpeech(seed, seconds) {
  const r = rng(seed);
  const out = new Float32Array(Math.round(seconds * SR));
  const VOWELS = [[730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410], [660, 1720, 2410]];
  let i = 0;
  let phase = 0;
  const state = [[0, 0], [0, 0], [0, 0]];
  while (i < out.length) {
    const phrase = 1 + r() * 3;
    const f0base = 100 + r() * 120;
    let t = 0;
    while (t < phrase && i < out.length) {
      const syl = 0.15 + r() * 0.15;
      const formants = VOWELS[Math.floor(r() * VOWELS.length)];
      const fricative = r() < 0.3;
      const n = Math.round(syl * SR);
      const coeffs = formants.map((f, k) => {
        const bw = 80 + 40 * k;
        const rr = Math.exp(-Math.PI * bw / SR);
        return [2 * rr * Math.cos(2 * Math.PI * f / SR), -rr * rr];
      });
      for (let j = 0; j < n && i < out.length; j++, i++) {
        const env = Math.sin(Math.PI * j / n);
        const f0 = f0base * (1 + 0.1 * Math.sin(2 * Math.PI * (t + j / SR) * 0.7));
        phase += f0 / SR;
        let src = 0;
        if (phase >= 1) { phase -= 1; src = 1; }
        if (fricative && j < n * 0.4) src = (r() * 2 - 1) * 0.3;
        let y = 0;
        for (let k = 0; k < 3; k++) {
          const [a1, a2] = coeffs[k];
          const v = src + a1 * state[k][0] + a2 * state[k][1];
          state[k][1] = state[k][0];
          state[k][0] = v;
          y += v / (k + 1);
        }
        out[i] = env * y;
      }
      t += syl;
    }
    i += Math.round((0.2 + r() * 0.4) * SR); // pause
  }
  return normalize(out, 0.25);
}

export function normalize(x, rms) {
  let s = 0;
  for (const v of x) s += v * v;
  const g = rms / Math.sqrt(s / x.length || 1);
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

// Place clip into a silent bed of `seconds` at `at` seconds, scaled by gainDb.
export function place(bed, clip, at, gainDb = 0) {
  const g = 10 ** (gainDb / 20);
  const i0 = Math.round(at * SR);
  for (let i = 0; i < clip.length && i0 + i < bed.length; i++) bed[i0 + i] += g * clip[i];
  return bed;
}

export const slice = (x, from, to) => x.slice(Math.round(from * SR), Math.round(to * SR));
export const silence = (seconds) => new Float32Array(Math.round(seconds * SR));
export const tone = (hz, seconds, rate = SR) => Float32Array.from({ length: Math.round(seconds * rate) }, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * i / rate));

// 16-bit PCM WAV bytes, for the browser test videos (ffmpeg reads them).
export function wavBytes(x, rate = SR) {
  const buf = Buffer.alloc(44 + x.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + x.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  return buf;
}
