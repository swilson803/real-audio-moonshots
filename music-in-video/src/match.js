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
  // Stage 1: hashes on one alignment needed to become a candidate.
  CANDIDATE_HITS: 5,
  MAX_CANDIDATES: 8,
  // Hits on one alignment further apart than this are two uses of the track.
  // (A track restarted later is a different alignment, so it is two rows
  // anyway; this only splits a track that went silent for a long stretch.
  // Shorter gaps are speech masking a quiet bed, not a new use.)
  SPLIT_GAP_FRAMES: Math.round(30 * FRAMES_PER_SEC),
  // Stage 2: peak coincidences in a VERIFY_WINDOW must reach VERIFY_MIN to
  // mark where the track is audible; a segment needs SEGMENT_MIN_COINCIDENCES.
  VERIFY_WINDOW: Math.round(2 * FRAMES_PER_SEC),
  VERIFY_MIN: 4,
  EDGE_NEAR: Math.round(1 * FRAMES_PER_SEC),
  EDGE_FAR: Math.round(2 * FRAMES_PER_SEC),
  OWNER_SMOOTH: 2, // seconds either side when deciding which alignment owns a second
  SEGMENT_MIN_COINCIDENCES: 12,
  // Off-alignment shifts (frames, not multiples of a common beat) for the
  // chance level, and how far above it a match must be.
  NULL_SHIFTS: Object.freeze([37, 61, 97, 131, 173, 211, -41, -67, -103, -139, -181, -223]),
  NULL_RATIO: 7,
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
export function clustersInMemory(index, hashes, times) {
  const groups = new Map();
  for (let i = 0; i < hashes.length; i++) {
    const list = index.get(hashes[i]);
    if (!list) continue;
    for (let j = 0; j < list.length; j += 2) {
      const tid = list[j];
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

// Peaks (t * 512 + f) rebuilt from hashes: each hash holds its anchor (t, f1)
// and its target (t + dt, f2).
function peaksFromHashes(hashes, times) {
  const set = new Set();
  for (let i = 0; i < hashes.length; i++) {
    const [f1, f2, dt] = unpackHash(hashes[i]);
    set.add(times[i] * 512 + f1);
    set.add((times[i] + dt) * 512 + f2);
  }
  return set;
}

// Peak coincidences of the video with the track at one alignment, inside
// [lo, hi] (query frames), +-1 frame and +-1 bin. Sorted times.
function coincidences(queryPeaks, trackPeaks, delta, lo, hi) {
  const times = [];
  for (const key of queryPeaks) {
    const t = Math.floor(key / 512);
    if (t < lo || t > hi) continue;
    const f = key % 512;
    const rt = t - delta;
    let hit = false;
    for (let e = -1; e <= 1 && !hit; e++) {
      for (let g = -1; g <= 1 && !hit; g++) {
        if (trackPeaks.has((rt + e) * 512 + f + g)) hit = true;
      }
    }
    if (hit) times.push(t);
  }
  return times.sort((a, b) => a - b);
}

// Count of times in [t, t + w] for each time (or [t - w, t] when back).
function windowCounts(times, w, back = false) {
  const out = new Array(times.length);
  for (let i = 0, j = 0; i < times.length; i++) {
    if (back) {
      while (times[j] < times[i] - w) j++;
      out[i] = i - j + 1;
    }
  }
  if (!back) {
    for (let i = times.length - 1, j = times.length - 1; i >= 0; i--) {
      while (times[j] > times[i] + w) j--;
      out[i] = j - i + 1;
    }
  }
  return out;
}

// Stage 2 for one candidate. queryPeaks / trackPeaks: Sets from
// peaksFromHashes. Returns { times, ratio } (the coincidence times of the
// dense run around the candidate's hashes) or null.
// The same count at off-alignment shifts is the chance level for this pair
// of recordings (tonal music in the same key and tempo lines up by chance far
// more often than noise does), so a match must beat it by NULL_RATIO.
function verifyCandidate(cand, queryPeaks, trackPeaks, o = TUNABLES) {
  const lo = Math.max(0, cand.start - o.REFINE_REACH_FRAMES);
  const hi = cand.end + o.REFINE_REACH_FRAMES;
  const times = coincidences(queryPeaks, trackPeaks, cand.delta, lo, hi);
  const nulls = o.NULL_SHIFTS.map((s) => coincidences(queryPeaks, trackPeaks, cand.delta + s, lo, hi).length);
  const chance = Math.max(1, nulls.reduce((a, b) => a + b, 0) / nulls.length);
  const ratio = times.length / chance;
  if (ratio < o.NULL_RATIO) return null;

  // Coincidences in a dense window (VERIFY_MIN within VERIFY_WINDOW) mark
  // where the track is audible; lone chance coincidences drop out.
  const fwd = windowCounts(times, o.VERIFY_WINDOW);
  const dense = new Uint8Array(times.length);
  for (let i = 0; i < times.length; i++) {
    if (fwd[i] >= o.VERIFY_MIN) {
      for (let k = i; k < times.length && times[k] <= times[i] + o.VERIFY_WINDOW; k++) dense[k] = 1;
    }
  }
  const kept = times.filter((_, i) => dense[i]);
  // The dense run that overlaps the candidate's own hashes.
  let best = null;
  let from = 0;
  for (let i = 1; i <= kept.length; i++) {
    if (i === kept.length || kept[i] - kept[i - 1] > o.SPLIT_GAP_FRAMES) {
      const run = kept.slice(from, i);
      if (run[run.length - 1] >= cand.start && run[0] <= cand.end && (!best || run.length > best.length)) best = run;
      from = i;
    }
  }
  if (!best || best.length < o.SEGMENT_MIN_COINCIDENCES) return null;
  return { times: best, ratio: Math.round(ratio * 10) / 10 };
}

// Edges of a run of coincidence times: the first (last) coincidence that
// opens (closes) a 2-second window holding at least half the run's typical
// count for 2 seconds (and at least 3), with another coincidence within 1 s.
// A chance coincidence just outside the track can then only pass if the
// track itself fills most of its window, so it moves the edge by under ~1 s.
function edges(times, o = TUNABLES) {
  const edge = (back) => {
    const near = windowCounts(times, o.EDGE_NEAR, back);
    const far = windowCounts(times, o.EDGE_FAR, back);
    const typical = [...far].sort((a, b) => a - b)[far.length >> 1];
    const need = Math.max(3, Math.ceil(typical / 2));
    for (let k = 0; k < times.length; k++) {
      const i = back ? times.length - 1 - k : k;
      if (near[i] >= 2 && far[i] >= need) return times[i];
    }
    return back ? times[times.length - 1] : times[0];
  };
  return { start: edge(false), end: edge(true) };
}

// Verified alignments -> what the page lists, in video order:
// [{ tid, delta, start, end, coincidences }].
// Music repeats (choruses, loops, a restarted track), so an alignment can
// also line up, more weakly, where another alignment is the real one. Each
// second of the video goes to the alignment with the most coincidences
// around it (OWNER_SMOOTH either side; ties to the stronger alignment
// overall), and each alignment keeps only its own seconds. What's left is cut
// at long gaps into rows; scraps below SEGMENT_MIN_COINCIDENCES drop.
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
      if (!local[i].has(sec)) return;
      if (score > bestScore || (score === bestScore && strength(v) > strength(verified[best]))) {
        best = i;
        bestScore = score;
      }
    });
    owner.set(sec, best);
  }
  const rows = [];
  verified.forEach((v, i) => {
    const own = v.times.filter((t) => owner.get(Math.floor(t / FRAMES_PER_SEC)) === i);
    let from = 0;
    for (let k = 1; k <= own.length; k++) {
      if (k === own.length || own[k] - own[k - 1] > o.SPLIT_GAP_FRAMES) {
        const run = own.slice(from, k);
        if (run.length >= o.SEGMENT_MIN_COINCIDENCES) rows.push({ tid: v.tid, delta: v.delta, ...edges(run, o), coincidences: run.length });
        from = k;
      }
    }
  });
  return rows.sort((a, b) => a.start - b.start || b.coincidences - a.coincidences);
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
  const queryPeaks = peaksFromHashes(query.hashes, query.times);
  const verified = await Promise.all(candidates.map(async (c) => {
    const ref = await trackWindow(c.tid, c.start - c.delta - o.REFINE_REACH_FRAMES - 64, c.end - c.delta + o.REFINE_REACH_FRAMES + 64);
    const v = verifyCandidate(c, queryPeaks, peaksFromHashes(ref.hashes, ref.times), o);
    return v && { tid: c.tid, delta: c.delta, ...v };
  }));
  return finalSegments(verified.filter(Boolean), o);
}

export const framesToSec = (f) => Math.round((f / FRAMES_PER_SEC) * 100) / 100;
