// MS-007 start times: each row the matcher accepted gets its start from the
// matched track's own waveform.
//
// The matcher (src/match.js) knows which track is playing. Tracks are used
// unedited, so the soundtrack holds a copy of the track's waveform under the
// voice. Here, at 8 kHz, on first-differenced audio:
// 1. Lag: PHAT-whitened cross-correlation of LAG_SPAN_S of the video from
//    the row's start against the WHOLE track, in blocks. Not just near the
//    matcher's own alignment: music repeats, and the matcher can line a row
//    up with a repeat (practice run 1: 8.9 s and 78 s away), which is right
//    for the track and wrong for its start.
// 2. In WINDOW_S windows: the least-squares gain g of the track in the video
//    and its standard error se (x SE_ALLOWANCE: neighbouring samples are not
//    independent). A window is strong when g / se > STRONG_Z; G is the
//    median g of the strong windows.
// 3. Start: the window boundary c maximising the sum, from c to
//    AFTER_FIRST_STRONG_S past the first strong window, of
//    (g^2 - (g - G)^2) / (2 se^2): "the track at gain G from here on" against
//    "no track". Windows where the track itself is silent count ~0, so a
//    quiet intro doesn't push the start late. Earliest c on ties. se is
//    floored at SE_FLOOR x G in this sum only: a window with (almost) no
//    residual, which only noise-free synthetic audio has, would otherwise
//    outweigh the rest past float precision.
// Guard rails: no strong window, or a start outside
// [max(previous row's end, start - REACH_BACK_S), row end], keeps the
// matcher's start. Rows are never added, dropped or renamed here, and no
// match threshold is read or changed.
//
// REFINE is frozen (test/unit/refine.test.mjs pins it): the settings were
// locked on the practice clips before the scored run.
import { FRAMES_PER_SEC, Resampler, SAMPLE_RATE } from '../public/music/fp.js';

export const REFINE = Object.freeze({
  RATE: 8000,
  LAG_SPAN_S: 30,
  WINDOW_S: 0.25,
  SE_ALLOWANCE: 2,
  STRONG_Z: 5,
  SE_FLOOR: 0.001,
  AFTER_FIRST_STRONG_S: 20,
  REACH_BACK_S: 30,
  // Evidence is read up to this far past the matcher's start (bounds the
  // work for a long row).
  SPAN_AFTER_START_S: 60,
});

// The 16 kHz soundtrack at REFINE.RATE (fp.js's resampler: windowed sinc,
// no delay).
export const atRefineRate = (samples16k) => new Resampler(SAMPLE_RATE, REFINE.RATE).push(samples16k);

export function diff(x) {
  const d = new Float32Array(x.length);
  for (let i = 1; i < x.length; i++) d[i] = x[i] - x[i - 1];
  return d;
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// In-place iterative radix-2 FFT (inverse: conjugate trick, unscaled).
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const sign = inverse ? 1 : -1;
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

// The lag (video sample i lines up with track sample i - lag) that best lines
// x (video samples from s0) up with the whole track, by PHAT cross-correlation
// in overlap-save blocks of N samples.
export function phatLag(x, s0, track) {
  let N = 1 << 16;
  while (N < 4 * x.length) N <<= 1;
  const X = { re: new Float64Array(N), im: new Float64Array(N) };
  X.re.set(x);
  fft(X.re, X.im);
  const step = N - x.length + 1; // valid lags per block
  let best = -Infinity;
  let bestLag = 0;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let b = -x.length + 1; b < track.length; b += step) {
    re.fill(0);
    im.fill(0);
    for (let k = 0; k < N; k++) {
      const j = b + k;
      if (j >= 0 && j < track.length) re[k] = track[j];
    }
    fft(re, im);
    for (let k = 0; k < N; k++) {
      // conj(X) * Y, whitened
      const r = X.re[k] * re[k] + X.im[k] * im[k];
      const i = X.re[k] * im[k] - X.im[k] * re[k];
      const m = Math.hypot(r, i) + 1e-12;
      re[k] = r / m;
      im[k] = i / m;
    }
    fft(re, im, true);
    // re[tau] = sum_i x[i] y[i + tau] (circular); valid for tau < step
    for (let tau = 0; tau < step; tau++) {
      if (re[tau] > best) { best = re[tau]; bestLag = s0 - b - tau; }
    }
  }
  return bestLag;
}

// One row: -> { start (s), source: 'waveform' | 'matcher', ... diagnostics }.
// video: first-differenced soundtrack at o.RATE; track: the first-
// differenced whole track at o.RATE.
function refineRow(row, video, prevEnd, track, o) {
  const R = o.RATE;
  const start = row.start / FRAMES_PER_SEC;
  const end = row.end / FRAMES_PER_SEC;
  const keep = (why) => ({ start, source: 'matcher', why });
  const lo = Math.max(0, prevEnd, start - o.REACH_BACK_S);
  const spanEnd = Math.min(video.length / R, end, Math.max(start, lo) + o.SPAN_AFTER_START_S);
  const a = Math.floor(lo * R);
  const b = Math.min(video.length, Math.ceil(spanEnd * R));
  if (b - a < R || !track.length) return keep('short');

  // 1. Lag, from this row's own stretch of the video.
  const s0 = Math.max(a, Math.floor(start * R));
  const s1 = Math.min(b, s0 + Math.round(o.LAG_SPAN_S * R));
  if (s1 - s0 < R) return keep('short');
  const lag = phatLag(video.subarray(s0, s1), s0, track);
  const ref = (i) => {
    const j = i - lag;
    return j >= 0 && j < track.length ? track[j] : 0;
  };

  // 2. Gain and its standard error per window.
  const W = Math.round(o.WINDOW_S * R);
  const K = Math.floor((b - a) / W);
  const g = new Float64Array(K);
  const se = new Float64Array(K).fill(Infinity);
  for (let k = 0; k < K; k++) {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let i = a + k * W; i < a + (k + 1) * W; i++) {
      const y = ref(i);
      xy += video[i] * y;
      xx += video[i] * video[i];
      yy += y * y;
    }
    if (yy < 1e-9) continue;
    const gk = xy / yy;
    g[k] = gk;
    se[k] = Math.sqrt(Math.max(0, xx - 2 * gk * xy + gk * gk * yy) / W / yy) * o.SE_ALLOWANCE;
  }
  const strong = [];
  for (let k = 0; k < K; k++) if (Number.isFinite(se[k]) && g[k] / se[k] > o.STRONG_Z) strong.push(k);
  if (!strong.length) return keep('no strong window');
  const G = median(strong.map((k) => g[k]));

  // 3. Change point.
  const hi = Math.min(K, strong[0] + Math.round(o.AFTER_FIRST_STRONG_S / o.WINDOW_S));
  let acc = 0;
  let bestSum = -Infinity;
  let c = 0;
  const floor = o.SE_FLOOR * Math.abs(G);
  for (let k = hi - 1; k >= 0; k--) {
    const s = Math.max(se[k], floor);
    if (Number.isFinite(s)) acc += (g[k] * g[k] - (g[k] - G) ** 2) / (2 * s * s);
    if (acc >= bestSum) { bestSum = acc; c = k; }
  }
  const refined = (a + c * W) / R;
  const diag = { lag_s: Math.round((lag / R) * 1000) / 1000, strong: strong.length, gain: Math.round(G * 1e4) / 1e4 };
  if (!(refined >= lo && refined >= start - o.REACH_BACK_S && refined <= end)) return { ...keep('outside the row'), ...diag };
  return { start: refined, source: 'waveform', ...diag };
}

// rows: finalSegments() output (frames), in video order. samples16k: the
// soundtrack (fp.js SAMPLE_RATE). trackAudio(tid) -> Promise<Float32Array>,
// the whole track at o.RATE. -> the same rows, start replaced where the
// waveform says so, plus startSource / refine diagnostics.
export async function refineStarts(rows, samples16k, trackAudio, o = REFINE) {
  if (!rows.length) return [];
  const video = diff(atRefineRate(samples16k));
  const tracks = new Map();
  const out = [];
  let prevEnd = 0;
  for (const row of rows) {
    if (!tracks.has(row.tid)) tracks.set(row.tid, diff(await trackAudio(row.tid)));
    const { start, source, ...refine } = refineRow(row, video, prevEnd, tracks.get(row.tid), o);
    out.push({ ...row, start: start * FRAMES_PER_SEC, startSource: source, refine });
    prevEnd = Math.max(prevEnd, row.end / FRAMES_PER_SEC);
  }
  return out;
}
