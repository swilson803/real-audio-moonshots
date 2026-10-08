// MS-006 audio fingerprint: one module for the browser (upload page), the
// Worker (constants only) and Node (catalog index builder, tests), so a query
// and the catalog are always fingerprinted the same way.
//
// Landmark fingerprinting (Wang 2003 / Shazam family), tuned for music under
// speech: 16 kHz mono, short-time spectrum, a causal per-bin running mean
// subtracted from the log spectrum (stationary sound and slow speech formants
// fade, onsets stand out), and peaks picked separately in each frequency band
// so the bass and the hats above 4 kHz, where speech is weak, keep producing
// peaks while someone talks. Peak pairs become 24-bit hashes.
//
// Changing anything here changes the hashes: bump FP_VERSION and rebuild the
// catalog index (scripts/build-catalog-index.mjs).

export const FP_VERSION = 1;
export const SAMPLE_RATE = 16000;
const N_FFT = 1024;
const HOP = 256;
export const FRAMES_PER_SEC = SAMPLE_RATE / HOP; // 62.5, so one frame is 16 ms

const NBINS = N_FFT / 2;
const BIN_HZ = SAMPLE_RATE / N_FFT;
const BAND_EDGES_HZ = [60, 150, 300, 600, 1200, 2400, 4000, 6000, 7900];
const BANDS = BAND_EDGES_HZ.slice(0, -1).map((lo, i) => [Math.ceil(lo / BIN_HZ), Math.floor(BAND_EDGES_HZ[i + 1] / BIN_HZ)]);
const NBANDS = BANDS.length;
const WHITEN_ALPHA = 1 / (0.5 * FRAMES_PER_SEC); // running mean over ~0.5 s
const RAW_FLOOR = Math.log(0.05); // about -74 dBFS: ignore near-silence
const MIN_RISE = 0.5; // a peak rises at least ~4.3 dB above its bin's running mean
const PEAK_HALF_WIDTH = 12; // a band peak is the max over +-12 frames (~0.4 s)
// Target peaks paired with each anchor. 2 rather than 3: a third fewer
// rows in ms006_fp (it has to fit Supabase Free) with no measurable loss on
// the synthetic sweep, because stage 2 verifies on single peaks, which every
// anchor still contributes.
const FANOUT = 2;
const MAX_DT = 63; // frames (~1 s); 6 bits in the hash
const SHORT_DT = 4;

// hash = f1 (9 bits) | f2 (9 bits) | dt (6 bits)
export const packHash = (f1, f2, dt) => (f1 << 15) | (f2 << 6) | dt;
export const unpackHash = (h) => [(h >> 15) & 511, (h >> 6) & 511, h & 63];

// In-place iterative radix-2 FFT of size N_FFT.
const LOG2N = Math.log2(N_FFT);
const REV = new Uint16Array(N_FFT);
for (let i = 0; i < N_FFT; i++) {
  let r = 0;
  for (let b = 0; b < LOG2N; b++) r |= ((i >> b) & 1) << (LOG2N - 1 - b);
  REV[i] = r;
}
const COS = new Float64Array(N_FFT / 2);
const SIN = new Float64Array(N_FFT / 2);
for (let i = 0; i < N_FFT / 2; i++) {
  COS[i] = Math.cos((2 * Math.PI * i) / N_FFT);
  SIN[i] = -Math.sin((2 * Math.PI * i) / N_FFT);
}
const HANN = new Float64Array(N_FFT);
for (let i = 0; i < N_FFT; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT);

function fft(re, im) {
  for (let i = 0; i < N_FFT; i++) {
    const j = REV[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= N_FFT; size <<= 1) {
    const half = size >> 1;
    const step = N_FFT / size;
    for (let start = 0; start < N_FFT; start += size) {
      for (let k = 0; k < half; k++) {
        const c = COS[k * step];
        const s = SIN[k * step];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * c - im[b] * s;
        const ti = re[b] * s + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
      }
    }
  }
}

// Streaming fingerprinter: push() mono SAMPLE_RATE audio in chunks of any
// size (the browser feeds it while decoding, so a 20-minute video never sits
// in memory as raw audio), then finish(). The result doesn't depend on how
// the audio was chunked.
export class Fingerprinter {
  // Options; the defaults are the index's rule (scripts/build-catalog-index),
  // the browser uses QUERY:
  //   binsPerBand    candidates per band per frame: its strongest bins
  //   rank           a candidate is a peak if fewer than `rank` candidates
  //                  of its band within +-peakHalfWidth frames are stronger
  //   peakHalfWidth  the time window a peak competes in
  //   minRise        smallest whitened rise a peak needs (log units)
  //   fanout         target peaks paired with each anchor
  //   skipLowPairsBelowHz  no pairs of two peaks both below this frequency
  //                  and under SHORT_DT frames apart (query side: near-
  //                  simultaneous bass/kick pairs are common to many tracks,
  //                  make most of the index lookup's work and say little
  //                  about which track it is)
  //   verifyPeaks    also return a second, denser peak list (same options
  //                  shape: binsPerBand is shared) for stage-2 verification
  // binsPerBand = rank = 1 is one bin per band and frame, the band's best
  // within +-12 frames. Larger values give a superset: a music peak can be
  // second in its band behind a louder voice and still be kept, so the query
  // holds the index's peaks even under speech.
  constructor({
    binsPerBand = 1, rank = 1, peakHalfWidth = PEAK_HALF_WIDTH, minRise = MIN_RISE,
    fanout = FANOUT, skipLowPairsBelowHz = 0, verifyPeaks = null,
  } = {}) {
    this.k = binsPerBand;
    this.pick = { rank, halfWidth: peakHalfWidth, minRise };
    this.verifyPick = verifyPeaks && { rank: verifyPeaks.rank ?? rank, halfWidth: verifyPeaks.peakHalfWidth ?? peakHalfWidth, minRise: verifyPeaks.minRise ?? minRise };
    this.fanout = fanout;
    this.skipLowBin = lowBin(skipLowPairsBelowHz);
    this.ring = new Float32Array(N_FFT);
    this.filled = 0; // samples received so far
    this.sinceFrame = 0; // samples since the last frame
    this.frames = 0;
    this.re = new Float64Array(N_FFT);
    this.im = new Float64Array(N_FFT);
    this.mean = null; // per-bin running mean of the log spectrum
    this.bandVal = []; // per frame, per band: whitened value of the band's best bin
    this.bandBin = [];
  }

  push(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      this.ring[this.filled % N_FFT] = chunk[i];
      this.filled++;
      if (this.filled >= N_FFT && (this.filled === N_FFT || ++this.sinceFrame === HOP)) {
        this.sinceFrame = 0;
        this.frame();
      }
    }
  }

  frame() {
    const { re, im, ring } = this;
    const start = this.filled % N_FFT; // oldest sample in the ring
    for (let i = 0; i < N_FFT; i++) {
      re[i] = ring[(start + i) % N_FFT] * HANN[i];
      im[i] = 0;
    }
    fft(re, im);
    const first = !this.mean;
    if (first) this.mean = new Float64Array(NBINS);
    // K best (whitened value, bin) per band, best first.
    const K = this.k;
    const vals = new Float32Array(NBANDS * K).fill(-Infinity);
    const bins = new Int16Array(NBANDS * K).fill(-1);
    for (let k = 0; k < NBANDS; k++) {
      const [lo, hi] = BANDS[k];
      const o = k * K;
      for (let b = lo; b <= hi; b++) {
        const raw = Math.log(Math.sqrt(re[b] * re[b] + im[b] * im[b]) + 1e-5);
        const prev = first ? raw : this.mean[b];
        this.mean[b] = prev + WHITEN_ALPHA * (raw - prev);
        if (raw < RAW_FLOOR) continue;
        const v = raw - prev;
        if (v > vals[o + K - 1]) {
          let j = K - 1;
          while (j > 0 && v > vals[o + j - 1]) { vals[o + j] = vals[o + j - 1]; bins[o + j] = bins[o + j - 1]; j--; }
          vals[o + j] = v;
          bins[o + j] = b;
        }
      }
    }
    this.bandVal.push(vals);
    this.bandBin.push(bins);
    this.frames++;
  }

  // Peaks [t, bin] in (t, frequency) order under one picking rule.
  peaksBy({ rank: R, halfWidth: W, minRise }) {
    const n = this.frames;
    const K = this.k;
    const peaks = [];
    for (let t = 0; t < n; t++) {
      for (let k = 0; k < NBANDS; k++) {
        const o = k * K;
        const found = [];
        for (let j = 0; j < K; j++) {
          const v = this.bandVal[t][o + j];
          if (!(v >= minRise)) break;
          // Stronger candidates of this band within the window (ties go to
          // the earlier frame, then the better-ranked bin).
          let stronger = 0;
          for (let u = Math.max(0, t - W); u <= Math.min(n - 1, t + W) && stronger < R; u++) {
            for (let i = 0; i < K && stronger < R; i++) {
              if (u === t && i === j) continue;
              const w = this.bandVal[u][o + i];
              if (w > v || (w === v && (u < t || (u === t && i < j)))) stronger++;
            }
          }
          if (stronger < R) found.push(this.bandBin[t][o + j]);
        }
        found.sort((x, y) => x - y);
        for (const b of found) peaks.push([t, b]);
      }
    }
    return peaks;
  }

  finish() {
    const peaks = this.peaksBy(this.pick);
    const { hashes, times } = pairPeaks(peaks, this.fanout, this.skipLowBin);
    const out = { hashes, times, frames: this.frames, peakCount: peaks.length };
    if (this.verifyPick) {
      const vp = this.peaksBy(this.verifyPick);
      out.peakT = Int32Array.from(vp, (p) => p[0]);
      out.peakF = Int32Array.from(vp, (p) => p[1]);
      // Which verification peaks are also hash peaks (a subset whenever the
      // verification rule is looser: smaller window, lower rise, same rank),
      // so the page can send the peaks once and the Worker rebuild the
      // hashes with pairPeaks (body.js). A bin on a band edge (4 and 6 kHz)
      // can be a peak of both bands, so a peak can occur twice: the first
      // n occurrences of a key are flagged, n = its count among hash peaks.
      const need = new Map();
      for (const [t, f] of peaks) need.set(t * 512 + f, (need.get(t * 512 + f) || 0) + 1);
      out.hashPeak = Uint8Array.from(vp, ([t, f]) => {
        const k = t * 512 + f;
        const left = need.get(k) || 0;
        if (!left) return 0;
        need.set(k, left - 1);
        return 1;
      });
      out.hashPeaksCovered = [...need.values()].every((x) => x === 0);
    }
    return out;
  }
}

// Hashes from peaks [t, bin] in (t, frequency) order: each anchor with its
// next `fanout` peaks within MAX_DT frames, minus near-simultaneous pairs of
// two bins below skipLowBin. Shared by Fingerprinter and the Worker (which
// rebuilds the query's hashes from the peaks the page sends).
export function pairPeaks(peaks, fanout = FANOUT, skipLowBin = 0) {
  const hashes = [];
  const times = [];
  for (let i = 0; i < peaks.length; i++) {
    const [t1, f1] = peaks[i];
    let made = 0;
    for (let j = i + 1; j < peaks.length && made < fanout; j++) {
      const [t2, f2] = peaks[j];
      const dt = t2 - t1;
      if (dt > MAX_DT) break;
      if (dt < SHORT_DT && f1 < skipLowBin && f2 < skipLowBin) continue;
      hashes.push(packHash(f1, f2, dt));
      times.push(t1);
      made++;
    }
  }
  return { hashes: Int32Array.from(hashes), times: Int32Array.from(times) };
}

// Bin below which QUERY skips near-simultaneous pairs.
export const lowBin = (hz) => Math.floor(hz / BIN_HZ);

// The browser's query fingerprint (phase 2, tuned on the real catalog with
// the offline replica): three candidate bins per band (the index keeps one),
// so music under a voice keeps its peaks; four targets per anchor; no
// near-simultaneous low pairs (most of the lookup's work, little identity);
// and a denser peak list for stage-2 verification. Same hash layout as the
// index, so the index is unchanged.
export const QUERY = Object.freeze({
  binsPerBand: 3,
  rank: 3,
  fanout: 4,
  skipLowPairsBelowHz: 600,
  verifyPeaks: Object.freeze({ rank: 3, peakHalfWidth: 4, minRise: 0.15 }),
});

export function fingerprint(samples, options) {
  const fp = new Fingerprinter(options);
  fp.push(samples);
  return fp.finish();
}

// Streaming windowed-sinc resampler (any rate -> SAMPLE_RATE by default).
// Phase is quantised to 256 steps, so the timing error is under 1/512 of an
// input sample. The browser uses it on decoded video audio; ffmpeg does the
// same job for the catalog.
export class Resampler {
  constructor(srcRate, dstRate = SAMPLE_RATE, zeros = 8, phases = 256) {
    this.ratio = srcRate / dstRate;
    this.pass = srcRate === dstRate;
    const stretch = Math.max(1, this.ratio);
    this.half = Math.ceil(zeros * stretch);
    this.taps = 2 * this.half;
    this.phases = phases;
    const fc = (0.5 * 0.95) / stretch; // cutoff in cycles per input sample
    this.table = new Float32Array((phases + 1) * this.taps);
    for (let p = 0; p <= phases; p++) {
      const frac = p / phases;
      for (let k = 0; k < this.taps; k++) {
        const x = k - this.half + 1 - frac; // input index minus output position
        const sinc = x === 0 ? 1 : Math.sin(2 * Math.PI * fc * x) / (2 * Math.PI * fc * x);
        const win = 0.5 + 0.5 * Math.cos((Math.PI * x) / (this.half + 1));
        this.table[p * this.taps + k] = 2 * fc * sinc * win;
      }
    }
    this.buf = new Float32Array(this.taps); // history starts as silence
    this.len = this.half - 1; // zero history before sample 0
    this.base = -(this.half - 1); // absolute input index of buf[0]
    this.n = 0;
  }

  push(chunk) {
    if (this.pass) return Float32Array.from(chunk);
    if (this.len + chunk.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.buf.length * 2, this.len + chunk.length));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    const out = [];
    const { table, taps, half, phases, ratio, buf } = this;
    for (;;) {
      const x = this.n * ratio;
      const i0 = Math.floor(x);
      const p = Math.round((x - i0) * phases);
      const first = i0 - half + 1 - this.base;
      if (first + taps > this.len) break;
      let s = 0;
      const row = p * taps;
      for (let k = 0; k < taps; k++) s += table[row + k] * buf[first + k];
      out.push(s);
      this.n++;
    }
    // Drop input no longer needed by the next output.
    const keepFrom = Math.floor(this.n * ratio) - half + 1 - this.base;
    if (keepFrom > 0) {
      buf.copyWithin(0, keepFrom, this.len);
      this.len -= keepFrom;
      this.base += keepFrom;
    }
    return Float32Array.from(out);
  }
}
