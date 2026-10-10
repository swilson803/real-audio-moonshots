// MS-007 processing, off the Worker: one uploaded soundtrack (public/music/
// body.js) -> the rows the result page lists. Runs in the processor container
// (processor/server.mjs) and, unchanged, in the local scored run
// (scripts/score.mjs) against the offline replica.
//   fingerprint (fp.js QUERY, as the page did in MS-006)
//   -> match (src/match.js, thresholds unchanged)
//   -> with separate: the music stem (Demucs) matched too, and its rows added
//      where no row of the same track from the soundtrack overlaps them
//      (the separation experiment's arm C, kept)
//   -> catalog rows -> start times from the soundtrack's waveform
//      (src/refine.js)
// db: src/moonshots.js moonshots() (or the replica's db): lookup,
// trackWindow, catalog. ref: src/ref.js reader of the 8 kHz catalog
// reference copy. separate: src/separate.js demucsSeparator(), or null.
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

const query = (samples) => {
  const fp = fingerprint(samples, QUERY);
  return { hashes: fp.hashes, times: fp.times, peaks: { t: fp.peakT, f: fp.peakF } };
};
const overlaps = (a, b) => a.tid === b.tid && a.start <= b.end && b.start <= a.end;

// refine: REFINE overrides, practice clips only (scripts/score.mjs).
export async function processScan(body, { db, ref, separate = null, refine = REFINE }) {
  const up = decodeScanBody(body);
  if (!up || up.version !== BODY_VERSION || up.sampleRate !== SAMPLE_RATE) throw new ProcessError('unreadable');
  if (up.durationMs > MAX_DURATION_MS || up.samples.length > (MAX_DURATION_MS / 1000) * SAMPLE_RATE) throw new ProcessError('too-long');
  if (!up.samples.length) throw new ProcessError('no-audio');

  let segments = await match(query(up.samples), db);
  if (separate) {
    const fromStem = await match(query(await separate(up.samples)), db);
    segments = [...segments, ...fromStem.filter((s) => !segments.some((o) => overlaps(o, s)))].sort((a, b) => a.start - b.start);
  }
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
    separation: Boolean(separate),
    // Per row, for the scored run and logs (not stored, not shown).
    starts: rows.map((r) => ({ source: r.startSource, matcher_start_s: framesToSec(segments.find((s) => s.tid === r.tid && s.end === r.end).start), ...r.refine })),
  };
}
