// MS-006 matching, in two stages.
//
// 1. Lookup: query hashes -> (track, offset bin) clusters. Postgres does it in
//    real use (public.ms006_match in supabase/migrations); clustersInMemory()
//    is the same query in JS for the unit tests and the local harness. Keep
//    them in step: DELTA_BIN, MIN_BIN_HITS, MAX_CLUSTERS, floor() on negative
//    offsets, and the hits/deltas arrays.
// 2. Verify: a candidate alignment is kept only if single spectral peaks of
//    the video line up with the track's peaks at that offset well above
//    chance, and its start and end come from where they line up. Single peaks
//    survive speech far more often than peak pairs (hashes), so this finds
//    the real start of a quiet bed and rejects chance hash clusters. The
//    peaks are rebuilt from the hashes on both sides, so nothing extra is
//    sent or stored.

import { FRAMES_PER_SEC, unpackHash } from '../public/music/fp.js';

const DELTA_BIN = 4; // frames per offset bin (64 ms)
const MIN_BIN_HITS = 2;
// Under Supabase's default 1000-row cap on API responses.
const MAX_CLUSTERS = 500;

// Tunables. match(query, deps, options) can override any of them (round-B
// tuning, scripts/tune.mjs); these values are the defaults. DELTA_BIN,
// MIN_BIN_HITS and MAX_CLUSTERS above are not tunable: Postgres applies them.
export const TUNABLES = Object.freeze({
  // Stage 1: hashes on one alignment needed to become a candidate, and how
  // many candidates (the strongest) go to stage 2.
  CANDIDATE_HITS: 3,
  MAX_CANDIDATES: 16,
  // Hits on one alignment further apart than this are two uses of the track.
  // (A track restarted later is a different alignment, so it is two rows
  // anyway; this only splits a track that went silent for a long stretch.
  // Shorter gaps are speech masking a quiet bed, not a new use.)
  SPLIT_GAP_FRAMES: Math.round(30 * FRAMES_PER_SEC),
  // Stage 2 (see verifyCandidate): coincidences are counted in BIN_FRAMES
  // bins; a stretch is audible where a LOCAL_WINDOW_BINS window holds at
  // least LOCAL_MIN coincidences and beats chance by LOCAL_Z * sqrt(chance+1).
  BIN_FRAMES: 16, // 256 ms
  LOCAL_WINDOW_BINS: 16, // ~4 s
  LOCAL_MIN: 4,
  LOCAL_Z: 3,
  OWNER_SMOOTH: 2, // seconds either side when deciding which alignment owns a second
  // A listed row needs this many coincidences, beating chance by ROW_Z.
  SEGMENT_MIN_COINCIDENCES: 30,
  ROW_Z: 5,
  // Off-alignment shifts (frames) giving the chance distribution of peak
  // coincidences for this video and track; a match must stand Z_MIN
  // standard deviations above its mean and NULL_RATIO times above it.
  NULL_SHIFTS: Object.freeze([31, 47, 67, 89, 113, 139, 167, 197, 229, 251, 277, 307,
    -37, -53, -73, -97, -127, -149, -181, -211, -239, -263, -289, -313]),
  Z_MIN: 6,
  NULL_RATIO: 2,
  // Rows of one track closer than this are one use (a looped track can
  // line up at several offsets, each owning a stretch of the video).
  MERGE_GAP_FRAMES: Math.round(2 * FRAMES_PER_SEC),
  // How far past a candidate's first and last hash the true start/end may lie.
  REFINE_REACH_FRAMES: Math.round(20 * FRAMES_PER_SEC),
});

// Defaults plus overrides; an unknown name throws (catches --set typos).
export function tunables(options = {}) {
  for (const k of Object.keys(options)) {
    if (!(k in TUNABLES)) throw new Error(`unknown matcher option ${k} (DELTA_BIN, MIN_BIN_HITS, MAX_CLUSTERS are fixed by SQL)`);
  }
  return { ...TUNABLES, ...options };
}

// tracks: [{ tid, hashes, times }] -> Map(hash -> [tid, t, tid, t, ...])
export function buildIndex(tracks) {
  const index = new Map();
  for (const { tid, hashes, times } of tracks) {
    for (let i = 0; i < hashes.length; i++) {
      let list = index.get(hashes[i]);
      if (!list) index.set(hashes[i], (list = []));
      list.push(tid, times[i]);
    }
  }
  return index;
}

// Same rows as public.ms006_match: [{ tid, bin, hits: [query t], deltas: [query t - track t] }]
// hits ascending (deltas in the same order), >= MIN_BIN_HITS rows, biggest first, capped.
// skipTids (replica only): behave as if those tracks were not indexed.
export function clustersInMemory(index, hashes, times, skipTids = null) {
  const groups = new Map();
  for (let i = 0; i < hashes.length; i++) {
    const list = index.get(hashes[i]);
    if (!list) continue;
    for (let j = 0; j < list.length; j += 2) {
      const tid = list[j];
      if (skipTids?.has(tid)) continue;
      const delta = times[i] - list[j + 1];
      const bin = Math.floor(delta / DELTA_BIN);
      const key = `${tid}:${bin}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { tid, bin, pairs: [] }));
      g.pairs.push([times[i], delta]);
    }
  }
  return [...groups.values()]
    .filter((g) => g.pairs.length >= MIN_BIN_HITS)
    .sort((a, b) => b.pairs.length - a.pairs.length)
    .slice(0, MAX_CLUSTERS)
    .map(({ tid, bin, pairs }) => {
      pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      return { tid, bin, hits: pairs.map((p) => p[0]), deltas: pairs.map((p) => p[1]) };
    });
}

// Hashes on one track whose times fall in [from, to]: the reference side of
// stage 2 (public.ms006_track_window in real use).
export function trackWindowInMemory(tracksByTid, tid, from, to) {
  const tr = tracksByTid.get(tid);
  const out = { hashes: [], times: [] };
  if (!tr) return out;
  for (let i = 0; i < tr.hashes.length; i++) {
    if (tr.times[i] >= from && tr.times[i] <= to) {
      out.hashes.push(tr.hashes[i]);
      out.times.push(tr.times[i]);
    }
  }
  return out;
}

// Stage 1: clusters -> candidate alignments [{ tid, delta, start, end, hits }]
// (frames). Adjacent offset bins of one track are one alignment (frame jitter
// splits a true match over two bins); each alignment splits at long gaps.
export function candidatesFromClusters(clusters, { minHits = TUNABLES.CANDIDATE_HITS, gap = TUNABLES.SPLIT_GAP_FRAMES, max = TUNABLES.MAX_CANDIDATES } = {}) {
  const byTrack = new Map();
  for (const c of clusters) {
    if (!byTrack.has(c.tid)) byTrack.set(c.tid, []);
    byTrack.get(c.tid).push(c);
  }
  const out = [];
  for (const [tid, list] of byTrack) {
    list.sort((a, b) => a.bin - b.bin);
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const pairs = run.flatMap((c) => c.hits.map((h, i) => [h, c.deltas[i]])).sort((a, b) => a[0] - b[0]);
      let from = 0;
      for (let i = 1; i <= pairs.length; i++) {
        if (i === pairs.length || pairs[i][0] - pairs[i - 1][0] > gap) {
          const part = pairs.slice(from, i);
          const distinct = new Set(part.map((p) => p[0])).size;
          if (distinct >= minHits) {
            const ds = part.map((p) => p[1]).sort((a, b) => a - b);
            out.push({ tid, delta: ds[ds.length >> 1], start: part[0][0], end: part[part.length - 1][0], hits: distinct });
          }
          from = i;
        }
      }
      run = [];
    };
    for (const c of list) {
      if (run.length && c.bin - run[run.length - 1].bin > 1) flush();
      run.push(c);
    }
    flush();
  }
  return out.sort((a, b) => b.hits - a.hits).slice(0, max);
}

// Peaks rebuilt from hashes (each holds its anchor (t, f1) and its target
// (t + dt, f2)), deduplicated: { t: Int32Array, f: Int32Array } sorted by t.
function peaksFromHashes(hashes, times) {
  const set = new Set();
  for (let i = 0; i < hashes.length; i++) {
    const [f1, f2, dt] = unpackHash(hashes[i]);
    set.add(times[i] * 512 + f1);
    set.add((times[i] + dt) * 512 + f2);
  }
  const keys = Float64Array.from(set).sort();
  const t = new Int32Array(keys.length);
  const f = new Int32Array(keys.length);
  keys.forEach((k, i) => { t[i] = Math.floor(k / 512); f[i] = k % 512; });
  return { t, f };
}

// A track's peaks over track frames [from, to] as a bitmap dilated by +-1
// frame and +-1 bin, so testing a query peak against it is one read.
function peakMap(peaks, from, to) {
  const span = to - from + 1;
  const map = new Uint8Array(Math.max(0, span) * 512);
  for (let i = 0; i < peaks.t.length; i++) {
    const t = peaks.t[i] - from;
    if (t < -1 || t > span) continue;
    for (let e = -1; e <= 1; e++) {
      const u = t + e;
      if (u < 0 || u >= span) continue;
      for (let g = -1; g <= 1; g++) {
        const b = peaks.f[i] + g;
        if (b >= 0 && b < 512) map[u * 512 + b] = 1;
      }
    }
  }
  return { map, from, span };
}

// Query peaks in [lo, hi] (query frames) that land on a track peak at this
// alignment: their times (ascending), or just the count.
function coincidences(q, pm, delta, lo, hi, countOnly = false) {
  const out = countOnly ? null : [];
  let n = 0;
  for (let i = 0; i < q.t.length; i++) {
    const t = q.t[i];
    if (t < lo) continue;
    if (t > hi) break;
    const u = t - delta - pm.from;
    if (u < 0 || u >= pm.span || !pm.map[u * 512 + q.f[i]]) continue;
    n++;
    if (out) out.push(t);
  }
  return countOnly ? n : out;
}

// Stage 2 for one candidate. queryPeaks: peaksFromHashes of the video;
// trackMap: peakMap of the track. Returns the alignment's stretch of the
// video { start, end, times, nullIn, z, ratio } or null.
// Chance: the counts at off-alignment shifts (NULL_SHIFTS) are the chance
// distribution for this pair of recordings (tonal music in the same key and
// tempo lines up by chance far more often than noise does). The alignment
// as a whole must stand Z_MIN standard deviations (at least Poisson's) and
// NULL_RATIO times above it. Then, in BIN_FRAMES bins: the stretch where the
// track is audible is a run of bins whose 2-second window beats chance by
// LOCAL_Z, and its start and end are the Poisson change points between the
// chance rate and chance plus the track's own rate.
function verifyCandidate(cand, queryPeaks, trackMap, o = TUNABLES) {
  const lo = Math.max(0, cand.start - o.REFINE_REACH_FRAMES);
  const hi = cand.end + o.REFINE_REACH_FRAMES;
  const times = coincidences(queryPeaks, trackMap, cand.delta, lo, hi);
  const B = o.BIN_FRAMES;
  const nb = Math.floor((hi - lo) / B) + 1;
  const real = new Float64Array(nb);
  for (const t of times) real[Math.floor((t - lo) / B)]++;
  const nul = new Float64Array(nb);
  const totals = o.NULL_SHIFTS.map((sh) => {
    const ts = coincidences(queryPeaks, trackMap, cand.delta + sh, lo, hi);
    for (const t of ts) nul[Math.floor((t - lo) / B)] += 1 / o.NULL_SHIFTS.length;
    return ts.length;
  });
  const mean = totals.reduce((x, y) => x + y, 0) / totals.length;
  const sd = Math.sqrt(totals.reduce((x, y) => x + (y - mean) ** 2, 0) / totals.length);
  const z = (times.length - mean) / Math.max(sd, Math.sqrt(mean), 1);
  const ratio = times.length / Math.max(1, mean);
  if (z < o.Z_MIN || ratio < o.NULL_RATIO) return null;

  // Bins whose surrounding window (LOCAL_WINDOW_BINS) beats chance.
  const W = o.LOCAL_WINDOW_BINS;
  const pre = (arr) => { const c = new Float64Array(arr.length + 1); arr.forEach((v, i) => { c[i + 1] = c[i] + v; }); return c; };
  const R = pre(real);
  const N = pre(nul);
  const sum = (c, a, b) => c[Math.min(nb, Math.max(0, b))] - c[Math.min(nb, Math.max(0, a))];
  const on = new Uint8Array(nb);
  for (let i = 0; i < nb; i++) {
    const a0 = i - (W >> 1);
    const r = sum(R, a0, a0 + W);
    const n = sum(N, a0, a0 + W);
    if (r >= o.LOCAL_MIN && r - n >= o.LOCAL_Z * Math.sqrt(n + 1)) on[i] = 1;
  }
  // The run of on-bins (gaps up to SPLIT_GAP) overlapping the candidate's
  // hashes, with the most coincidences.
  const gapBins = Math.ceil(o.SPLIT_GAP_FRAMES / B);
  let best = null;
  for (let i = 0; i < nb;) {
    if (!on[i]) { i++; continue; }
    let j = i;
    let last = i;
    while (j + 1 < nb && j + 1 - last <= gapBins) { j++; if (on[j]) last = j; }
    const run = { s: i, e: last, n: sum(R, i, last + 1) };
    const t0 = lo + i * B;
    const t1 = lo + (last + 1) * B;
    if (t1 >= cand.start && t0 <= cand.end && (!best || run.n > best.n)) best = run;
    i = last + 1;
  }
  if (!best) return null;

  // Change points. m: the track's own rate per bin inside the run.
  const m = Math.max(0.05, (sum(R, best.s, best.e + 1) - sum(N, best.s, best.e + 1)) / (best.e - best.s + 1));
  const ll = (k, lam) => k * Math.log(lam) - lam;
  const span = 2 * W;
  // Best cut in [c0, c1], every cut scored over the same bins [a0, a1)
  // (default [c0 - span, c1 + span)): chance before and chance + m after
  // (rising), or the reverse.
  const change = (c0, c1, rising, a0 = c0 - span, a1 = c1 + span) => {
    c0 = Math.max(0, c0);
    c1 = Math.min(nb, c1);
    a0 = Math.max(0, a0);
    a1 = Math.min(nb, a1);
    let bestC = c0;
    let bestL = -Infinity;
    for (let c = c0; c <= c1; c++) {
      let L = 0;
      for (let k = a0; k < a1; k++) L += ll(real[k], nul[k] + 0.02 + ((k >= c) === rising ? m : 0));
      if (L > bestL) { bestL = L; bestC = c; }
    }
    return bestC;
  };
  const sBin = change(best.s - W, Math.min(best.e, best.s + W), true);
  const eBin = change(Math.max(sBin + 1, best.e + 1 - W), best.e + 1 + W, false);
  const start = lo + sBin * B;
  const end = Math.min(hi, lo + eBin * B - 1);
  const inside = times.filter((t) => t >= start && t <= end);
  if (inside.length < o.SEGMENT_MIN_COINCIDENCES) return null;
  // Chance coincidences expected in [a, b] (query frames) at this alignment.
  const nullIn = (a, b) => {
    let x = 0;
    for (let i = Math.max(0, Math.floor((a - lo) / B)); i <= Math.min(nb - 1, Math.floor((b - lo) / B)); i++) x += nul[i];
    return x;
  };
  // Where another alignment owns the stretch's edge (finalSegments), the
  // edge is found again inside the owned part: the first (last) bin from
  // frame a (b) where this alignment's own rate starts (stops).
  const bin = (t) => Math.max(0, Math.min(nb - 1, Math.floor((t - lo) / B)));
  const startAfter = (a) => lo + change(bin(a), bin(a) + 2 * W, true, bin(a), bin(a) + 4 * W) * B;
  const endBefore = (b) => Math.min(hi, lo + change(bin(b) + 1 - 2 * W, bin(b) + 1, false, bin(b) + 1 - 4 * W, bin(b) + 1) * B - 1);
  return { start, end, times: inside, nullIn, startAfter, endBefore, ratio: Math.round(ratio * 10) / 10, z: Math.round(z * 10) / 10 };
}

// Verified alignments -> what the page lists, in video order:
// [{ tid, delta, start, end, coincidences }].
// Music repeats (choruses, loops, a restarted track), so an alignment can
// also line up, more weakly, where another alignment is the real one. Each
// second of the video goes to the alignment with the most coincidences
// around it (OWNER_SMOOTH either side; ties to the stronger alignment
// overall), and each alignment keeps only its own seconds. What's left is cut
// at long gaps into rows; a row must itself beat chance by ROW_Z with
// SEGMENT_MIN_COINCIDENCES. Rows of one track closer than MERGE_GAP are one
// use and are merged.
export function finalSegments(verified, o = TUNABLES) {
  const strength = (v) => v.times.length;
  const owner = new Map(); // second -> alignment
  const local = verified.map((v) => {
    const perSec = new Map();
    for (const t of v.times) {
      const sec = Math.floor(t / FRAMES_PER_SEC);
      perSec.set(sec, (perSec.get(sec) || 0) + 1);
    }
    return perSec;
  });
  const seconds = new Set(local.flatMap((m) => [...m.keys()]));
  for (const sec of seconds) {
    let best = -1;
    let bestScore = -1;
    verified.forEach((v, i) => {
      let score = 0;
      for (let d = -o.OWNER_SMOOTH; d <= o.OWNER_SMOOTH; d++) score += local[i].get(sec + d) || 0;
      if (score > bestScore || (score === bestScore && strength(v) > strength(verified[best]))) {
        best = i;
        bestScore = score;
      }
    });
    owner.set(sec, best);
  }
  const rows = [];
  const near = FRAMES_PER_SEC; // owning within 1 s of an edge keeps that edge
  verified.forEach((v, i) => {
    const own = v.times.filter((t) => owner.get(Math.floor(t / FRAMES_PER_SEC)) === i);
    let from = 0;
    for (let k = 1; k <= own.length; k++) {
      if (k === own.length || own[k] - own[k - 1] > o.SPLIT_GAP_FRAMES) {
        const run = own.slice(from, k);
        from = k;
        // An edge cut by another TRACK (its music just before / after) is
        // found again inside this alignment's own part; an edge cut by another
        // alignment of the same track (a repeat) is left where it is.
        const otherTrackAt = (sec) => {
          const k = owner.get(sec);
          return k !== undefined && verified[k].tid !== v.tid;
        };
        const s0 = Math.floor(run[0] / FRAMES_PER_SEC);
        const s1 = Math.floor(run[run.length - 1] / FRAMES_PER_SEC);
        let start = run[0];
        if (run[0] - v.start <= near) start = v.start;
        else if (otherTrackAt(s0 - 1) || otherTrackAt(s0 - 2)) start = Math.min(run[run.length - 1], v.startAfter(run[0]));
        let end = run[run.length - 1];
        if (v.end - run[run.length - 1] <= near) end = v.end;
        else if (otherTrackAt(s1 + 1) || otherTrackAt(s1 + 2)) end = Math.max(start, v.endBefore(run[run.length - 1]));
        const chance = v.nullIn(start, end);
        if (run.length < o.SEGMENT_MIN_COINCIDENCES || run.length - chance < o.ROW_Z * Math.sqrt(chance + 1)) continue;
        rows.push({ tid: v.tid, delta: v.delta, start, end, coincidences: run.length });
      }
    }
  });
  rows.sort((a, b) => a.start - b.start || b.coincidences - a.coincidences);
  const merged = [];
  for (const r of rows) {
    const prev = [...merged].reverse().find((m) => m.tid === r.tid);
    if (prev && r.start - prev.end <= o.MERGE_GAP_FRAMES) {
      prev.end = Math.max(prev.end, r.end);
      prev.coincidences += r.coincidences;
    } else {
      merged.push({ ...r });
    }
  }
  return merged;
}

// One ms006_match call per LOOKUP_SLICE_FRAMES of video (about 60 s, so
// each call joins ~75k index rows and stays well inside the 8 s statement
// timeout), CONCURRENCY at a time; rows of the same (track, bin) from
// different slices are merged. A video up to 60 s is one call.
const LOOKUP_SLICE_FRAMES = Math.round(60 * FRAMES_PER_SEC);
export function slicedLookup(lookup, { sliceFrames = LOOKUP_SLICE_FRAMES, concurrency = 4 } = {}) {
  return async (hashes, times) => {
    let last = 0;
    for (const t of times) if (t > last) last = t;
    const slices = [];
    for (let from = 0; from <= last; from += sliceFrames) {
      const idx = [];
      for (let i = 0; i < times.length; i++) if (times[i] >= from && times[i] < from + sliceFrames) idx.push(i);
      if (idx.length) slices.push(idx);
    }
    if (slices.length <= 1) return lookup(hashes, times);
    const results = new Array(slices.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, slices.length) }, async () => {
      while (next < slices.length) {
        const k = next++;
        const idx = slices[k];
        results[k] = await lookup(Int32Array.from(idx, (i) => hashes[i]), Int32Array.from(idx, (i) => times[i]));
      }
    }));
    const merged = new Map();
    for (const rows of results) {
      for (const r of rows) {
        const key = `${r.tid}:${r.bin}`;
        const m = merged.get(key);
        if (m) {
          m.hits.push(...r.hits);
          m.deltas.push(...r.deltas);
        } else {
          merged.set(key, { tid: r.tid, bin: r.bin, hits: [...r.hits], deltas: [...r.deltas] });
        }
      }
    }
    return [...merged.values()];
  };
}

// The whole match given lookups (async so the Worker can pass Supabase RPCs
// and the tests in-memory ones):
//   lookup(hashes, times) -> clusters
//   trackWindow(tid, from, to) -> { hashes, times } of that track
export async function match(query, { lookup, trackWindow }, options = {}) {
  const o = tunables(options);
  const clusters = await lookup(query.hashes, query.times);
  const candidates = candidatesFromClusters(clusters, { minHits: o.CANDIDATE_HITS, gap: o.SPLIT_GAP_FRAMES, max: o.MAX_CANDIDATES });
  if (!candidates.length) return [];
  // Stage 2 uses the video's own peak list when it was sent (denser than
  // the peaks inside its hashes), else the peaks rebuilt from the hashes.
  const queryPeaks = query.peaks ?? peaksFromHashes(query.hashes, query.times);
  // The track window covers the candidate's reach plus the largest null
  // shift, so every shifted comparison sees real track peaks.
  const pad = Math.max(...o.NULL_SHIFTS.map(Math.abs)) + 64;
  // Track windows are fetched together; candidates are verified one at a
  // time, so only one ~3 MB peak map is alive (Worker memory).
  const windows = await Promise.all(candidates.map((c) => {
    const from = c.start - c.delta - o.REFINE_REACH_FRAMES - pad;
    const to = c.end - c.delta + o.REFINE_REACH_FRAMES + pad;
    return trackWindow(c.tid, from, to).then((ref) => ({ ref, from, to }));
  }));
  const verified = [];
  candidates.forEach((c, i) => {
    const { ref, from, to } = windows[i];
    const v = verifyCandidate(c, queryPeaks, peakMap(peaksFromHashes(ref.hashes, ref.times), from - 64, to + 64), o);
    if (v) verified.push({ tid: c.tid, delta: c.delta, ...v });
  });
  return finalSegments(verified, o);
}

export const framesToSec = (f) => Math.round((f / FRAMES_PER_SEC) * 100) / 100;
