// POST /api/scan body, shared by the page (encode) and the Worker (decode).
// The page sends only its verification peaks and, one bit each, which of
// them are hash peaks; the Worker rebuilds the query's hashes from those
// with fp.js pairPeaks and the QUERY settings, exactly as the page made them.
// About 30 KB a minute of video. Layout, int32s (native byte order:
// little-endian on every browser and Worker):
//   [FP_VERSION, duration_ms, nPeaks, peak x nPeaks, flag words]
//   peak = t * 512 + bin, (t, bin) non-decreasing (a band-edge bin can be a
//   peak twice); flag words: bit i of word
//   (i >> 5) set when peak i is a hash peak.
import { FP_VERSION, QUERY, lowBin, pairPeaks } from './fp.js';

export function encodeScanBody({ peakT, peakF, hashPeak, hashPeaksCovered, durationMs }) {
  if (!hashPeaksCovered) throw new Error('verification peaks must include every hash peak');
  const n = peakT.length;
  const words = Math.ceil(n / 32);
  const body = new Int32Array(3 + n + words);
  body.set([FP_VERSION, durationMs, n]);
  for (let i = 0; i < n; i++) {
    body[3 + i] = peakT[i] * 512 + peakF[i];
    if (hashPeak[i]) body[3 + n + (i >> 5)] |= 1 << (i & 31);
  }
  return body.buffer;
}

// -> { version, durationMs, hashes, times, peaks: { t, f } } or null if the
// layout doesn't add up (the caller validates values and limits).
export function decodeScanBody(buf) {
  if (!buf.byteLength || buf.byteLength % 4) return null;
  const v = new Int32Array(buf);
  if (v.length < 3) return null;
  const [version, durationMs, n] = v;
  if (!(n >= 0) || v.length !== 3 + n + Math.ceil(n / 32)) return null;
  const t = new Int32Array(n);
  const f = new Int32Array(n);
  const hashPeaks = [];
  for (let i = 0; i < n; i++) {
    const p = v[3 + i];
    if (p < 0 || (i && p < v[2 + i])) return null; // non-decreasing (t, bin)
    t[i] = Math.floor(p / 512);
    f[i] = p % 512;
    if ((v[3 + n + (i >> 5)] >>> (i & 31)) & 1) hashPeaks.push([t[i], f[i]]);
  }
  const { hashes, times } = pairPeaks(hashPeaks, QUERY.fanout, lowBin(QUERY.skipLowPairsBelowHz));
  return { version, durationMs, hashes, times, peaks: { t, f } };
}
