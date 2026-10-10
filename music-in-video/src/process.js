// MS-007 processing, off the Worker: one uploaded soundtrack (public/music/
// body.js) -> the rows the result page lists. Runs in the processor container
// (processor/server.mjs) and, unchanged, in the local scored run
// (scripts/score.mjs) against the offline replica.
//   fingerprint (fp.js QUERY, as the page did in MS-006)
//   -> match (src/match.js, thresholds unchanged)
//   -> catalog rows -> start times from the waveform (src/refine.js)
// db: src/scan.js moonshots() (or the replica's db): lookup, trackWindow,
// catalog. ref: src/ref.js reader of the 8 kHz catalog reference copy.
import { FP_VERSION, QUERY, SAMPLE_RATE, fingerprint } from '../public/music/fp.js';
import { BODY_VERSION, MAX_DURATION_MS, decodeScanBody } from '../public/music/body.js';
import { framesToSec, match } from './match.js';
import { REFINE, refineStarts } from './refine.js';

// A job that can never succeed; code is ms006_scans.error.
export class ProcessError extends Error {
  constructor(code) {
    super(code);
    this.code = code; // 'unreadable' | 'no-audio' | 'too-long'
  }
}

// refine: REFINE overrides, practice clips only (scripts/score.mjs).
export async function processScan(body, { db, ref, refine = REFINE }) {
  const up = decodeScanBody(body);
  if (!up || up.version !== BODY_VERSION || up.sampleRate !== SAMPLE_RATE) throw new ProcessError('unreadable');
  if (up.durationMs > MAX_DURATION_MS || up.samples.length > (MAX_DURATION_MS / 1000) * SAMPLE_RATE) throw new ProcessError('too-long');
  if (!up.samples.length) throw new ProcessError('no-audio');

  const fp = fingerprint(up.samples, QUERY);
  const segments = await match({ hashes: fp.hashes, times: fp.times, peaks: { t: fp.peakT, f: fp.peakF } }, db);
  const tracks = segments.length ? await db.catalog([...new Set(segments.map((s) => s.tid))]) : [];
  const byTid = new Map(tracks.map((t) => [t.tid, t]));
  const rows = await refineStarts(segments.filter((s) => byTid.has(s.tid)), up.samples,
    (tid) => ref.track(byTid.get(tid).track_id), refine);
  const matches = rows.map((s) => {
    const t = byTid.get(s.tid);
    return {
      start_s: framesToSec(s.start),
      end_s: framesToSec(s.end),
      track_id: t.track_id,
      title: t.title,
      artist: t.artist,
      stream_url: t.stream_url,
    };
  });
  return {
    duration_s: Math.round(up.durationMs / 10) / 100,
    found: matches.length > 0,
    matches,
    fp_version: FP_VERSION,
    // Per row, for the scored run and logs (not stored, not shown).
    starts: rows.map((r) => ({ source: r.startSource, matcher_start_s: framesToSec(segments.find((s) => s.tid === r.tid && s.end === r.end).start), ...r.refine })),
  };
}
