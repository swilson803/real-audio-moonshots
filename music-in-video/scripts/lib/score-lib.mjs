// Shared by scripts/score.mjs and scripts/separation.mjs: the practice /
// scored split (fixed in the approved MS-007 plan before the build), the
// per-clip verdict in the MS-006 results CSV's terms, the summary and the CSV.
import { readFile } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { withKinds } from './kinds.mjs';

// Practice (45): videos/RA_TEST_dev_quiet_*, videos-dev-7007, videos-dev-8007,
// videos-dev-neg. Scored, held out (38): the rest of videos/ (acceptance
// RA_TEST_quiet_*, RA_TEST_sweep_*, two_tracks, the two no-music videos).
export function splitOf(set, file) {
  if (['videos-dev-7007', 'videos-dev-8007', 'videos-dev-neg'].includes(set)) return 'practice';
  if (set === 'videos' && file.startsWith('RA_TEST_dev_quiet_')) return 'practice';
  return 'scored';
}

export async function loadClips(manifestPaths, split = 'all') {
  const clips = [];
  for (const m of manifestPaths) {
    const dir = dirname(m);
    const set = basename(dir);
    for (const v of withKinds(JSON.parse(await readFile(m, 'utf8')).videos)) {
      const s = splitOf(set, v.file);
      if (split === 'all' || split === s) clips.push({ ...v, set, dir, split: s });
    }
  }
  return clips;
}

const sign = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;

// matches: [{ track_id, title, start_s }] in video order.
// -> { result: hit | miss | clean | wrong, wrong: [titles], errors: [s], within1 }
// A hit finds every expected track (its first row gives the start error) and
// nothing else; any track not expected is a wrong track.
export function verdict(clip, matches) {
  const want = clip.expect;
  const wantIds = new Set(want.map((w) => w.track_id));
  const wrong = [...new Set(matches.filter((m) => !wantIds.has(m.track_id)).map((m) => `${m.title} [${m.track_id}]`))];
  if (wrong.length) return { result: 'wrong', wrong, errors: [], within1: false };
  if (!want.length) return { result: matches.length ? 'wrong' : 'clean', wrong, errors: [], within1: !matches.length };
  const firsts = want.map((w) => matches.find((m) => m.track_id === w.track_id));
  if (firsts.some((m) => !m)) return { result: 'miss', wrong, errors: [], within1: false };
  const errors = firsts.map((m, i) => m.start_s - want[i].start_s);
  return { result: 'hit', wrong, errors, within1: errors.every((e) => Math.abs(e) <= 1) };
}

export function summarize(rows) {
  const s = (xs) => {
    const hits = xs.filter((r) => r.v.result === 'hit');
    const within = hits.filter((r) => r.v.within1).length;
    const music = xs.filter((r) => r.clip.expect.length);
    const negatives = xs.filter((r) => !r.clip.expect.length);
    return {
      clips: xs.length,
      hits: hits.length,
      music_clips: music.length,
      misses: xs.filter((r) => r.v.result === 'miss').length,
      clean: xs.filter((r) => r.v.result === 'clean').length,
      negatives: negatives.length,
      wrong_track_clips: xs.filter((r) => r.v.result === 'wrong').length,
      within1_hits: within,
      within1_rate: hits.length ? Math.round((within / hits.length) * 1000) / 10 : null,
      within1_rows: hits.flatMap((r) => r.v.errors).filter((e) => Math.abs(e) <= 1).length,
      rows: hits.flatMap((r) => r.v.errors).length,
    };
  };
  return {
    all: s(rows),
    scored: s(rows.filter((r) => r.clip.split === 'scored')),
    practice: s(rows.filter((r) => r.clip.split === 'practice')),
    acceptance: s(rows.filter((r) => r.clip.kind === 'quiet')),
  };
}

const KIND_LABEL = {
  quiet: 'quiet (acceptance)', dev: 'dev', sweep: 'sweep', two_tracks: 'two_tracks', no_music: 'no_music',
};

// MS-006's per-clip CSV, keyed set/file, for the comparison column.
export async function ms006Results(path) {
  const text = await readFile(path, 'utf8');
  const lines = text.trim().split('\n');
  const head = parseCsvLine(lines[0]);
  const out = new Map();
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const row = Object.fromEntries(head.map((h, i) => [h, cells[i]]));
    out.set(`${row.set}/${row.file}`, row);
  }
  return out;
}

function parseCsvLine(line) {
  const cells = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { cells.push(cur); cur = ''; } else cur += ch;
  }
  cells.push(cur);
  return cells;
}

const esc = (x) => {
  const s = x === null || x === undefined ? '' : String(x);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

// The MS-006 columns, then: split, start_error_s (this run, = offset_error_s),
// ms006_offset_error_s, ms006_result, start_source per row, cpu_ms, wall_ms.
export function toCsv(rows, { source, ranAgainst, ms006 }) {
  const cols = ['set', 'file', 'kind', 'level_db', 'expected', 'detected', 'result', 'false_positive_tracks', 'offset_error_s', 'builder_pass_within_1s', 'run_error', 'source', 'ran_against', 'other_runs',
    'split', 'start_error_s', 'ms006_offset_error_s', 'ms006_result', 'start_source', 'cpu_ms', 'wall_ms'];
  const lines = [cols.join(',')];
  for (const r of rows) {
    const { clip, v, matches, starts = [], error } = r;
    const old = ms006.get(`${clip.set}/${clip.file}`) || {};
    const fmt = (xs) => xs.map((m) => `${m.title} @${m.start_s}s [${m.track_id}]`).join('; ') || '(none)';
    const result = { hit: 'hit', miss: 'miss', clean: 'clean (correct no-match)', wrong: 'WRONG TRACK' }[v.result];
    const errs = v.errors.map(sign).join('; ');
    const kind = clip.exclude_track_ids ? 'no_music/leave-one-out real music (track excluded from index)' : KIND_LABEL[clip.kind] ?? clip.kind;
    lines.push([
      clip.set, clip.file, kind, clip.level_db ?? '', fmt(clip.expect), fmt(matches), result, v.wrong.join('; '), errs,
      v.within1 ? 'True' : 'False', error ?? '', source, ranAgainst, '',
      clip.split, errs, old.offset_error_s ?? '', old.result ?? '', starts.map((s) => s.source).join('; '), r.cpu_ms ?? '', r.wall_ms ?? '',
    ].map(esc).join(','));
  }
  return `${lines.join('\n')}\n`;
}
