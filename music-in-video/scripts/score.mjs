// MS-007 scored run, Node only and offline: every clip goes through the same
// path as production, minus the network:
//   soundtrack read the way the page reads it (scripts/lib/soundtrack.mjs)
//   -> body.js upload body -> local R2 stand-in (uploads/<id>, RA_TEST_ label)
//   -> src/process.js (fingerprint, match, waveform start times) against the
//      offline replica of the moonshots index (scripts/replica.mjs) and the
//      local catalog reference copy (scripts/build-ref-audio.mjs)
//   -> upload deleted, and checked gone.
// Results in the MS-006 per-clip CSV's columns plus the new start error.
//
//   node scripts/score.mjs --split practice|scored|all \
//     --manifest /workspace/ms006/videos/manifest.json [--manifest …] \
//     --replica /workspace/ms006/replica --catalog-dir /workspace/ms006/audio-cache \
//     --ref /workspace/ms007/ref --ms006-csv /workspace/ms006_per_clip_results.csv \
//     --out DIR [--set NAME=VALUE …] [--record DIR]
//
//   --set NAME=VALUE  REFINE override (src/refine.js); practice split only.
//                     The scored and full runs take the frozen REFINE.
//   --record DIR      save each clip's database answers (to replay a clip in a
//                     fresh process for cost measurement).
//   --separate PYTHON with the music/speech separation (processor/
//                     separate.py run by this Python, e.g. a venv with demucs)
// OUT must not exist yet for --split scored|all: those run once.
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { REFINE } from '../src/refine.js';
import { localRef } from '../src/ref.js';
import { demucsSeparator } from '../src/separate.js';
import { processScan, ProcessError } from '../src/process.js';
import { loadReplica } from './replica.mjs';
import { soundtrackBody } from './lib/soundtrack.mjs';
import { loadClips, ms006Results, summarize, toCsv, verdict } from './lib/score-lib.mjs';
import { r2StandIn } from '../test/r2-standin.mjs';

export function parseRefineSets(sets) {
  const out = {};
  for (const s of sets) {
    const [name, value] = s.split('=');
    if (!(name in REFINE)) throw new Error(`--set ${name}: not a REFINE setting (${Object.keys(REFINE).join(', ')})`);
    out[name] = Number(value);
    if (!Number.isFinite(out[name])) throw new Error(`--set ${s}: not a number`);
  }
  return out;
}

const cpuMs = (u) => (u.user + u.system) / 1000;

// A db whose calls are timed (their CPU is the replica's in-memory lookup, not
// the processor's) and optionally recorded for replay.
export function instrumented(db, record) {
  const t = { dbCpuMs: 0 };
  const timed = (name, fn) => async (...args) => {
    const c0 = process.cpuUsage();
    const out = await fn(...args);
    t.dbCpuMs += cpuMs(process.cpuUsage(c0));
    if (record) record[name].push({ args: name === 'lookup' ? null : args, out });
    return out;
  };
  return { t, db: { lookup: timed('lookup', db.lookup), trackWindow: timed('trackWindow', db.trackWindow), catalog: timed('catalog', db.catalog) } };
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(-10).padStart(10, '0');

export async function scoreClips({ clips, db, ref, uploads, separate = null, refine = REFINE, recordDir = null, log = console.log, process: run = processScan }) {
  const rows = [];
  for (const clip of clips) {
    const key = `uploads/${newId()}`;
    const label = `RA_TEST_ms007_${clip.set}_${clip.file}`;
    const { body } = await soundtrackBody(join(clip.dir, clip.file));
    await uploads.put(key, body, { customMetadata: { label } });
    const record = recordDir ? { lookup: [], trackWindow: [], catalog: [] } : null;
    const { t, db: idb } = instrumented({ ...db, lookup: db.lookupWithout(clip.exclude_track_ids) }, record);
    let out = null;
    let error = null;
    const c0 = process.cpuUsage();
    const w0 = performance.now();
    try {
      const obj = await uploads.get(key);
      out = await run(await obj.arrayBuffer(), { db: idb, ref, separate, refine });
    } catch (err) {
      if (!(err instanceof ProcessError)) throw err;
      error = err.code;
    } finally {
      await uploads.delete(key);
    }
    const cpu = cpuMs(process.cpuUsage(c0)) - t.dbCpuMs + (separate?.last?.cpu_ms ?? 0);
    const wall = performance.now() - w0;
    if (await uploads.head(key)) throw new Error(`${key} still in the upload bucket after processing`);
    if (recordDir) await writeFile(join(recordDir, `${clip.set}__${clip.file}.json`), JSON.stringify({ clip: { set: clip.set, file: clip.file, dir: clip.dir }, ...record }));
    const matches = out?.matches ?? [];
    const v = verdict(clip, matches);
    rows.push({ clip, v, matches, starts: out?.starts ?? [], error, cpu_ms: Math.round(cpu), wall_ms: Math.round(wall) });
    const fmt = (xs) => xs.map((m) => `${m.title}@${m.start_s}`).join(', ') || '—';
    log(`${v.result.padEnd(5)} ${v.within1 ? '≤1s' : '   '} ${`${clip.set}/${clip.file}`.padEnd(46)} ${fmt(matches)}  want ${fmt(clip.expect)}  [${(out?.starts ?? []).map((s) => s.source).join(',')}]`);
  }
  const left = await uploads.list({ prefix: 'uploads/' });
  if (left.objects.length) throw new Error(`upload bucket not empty after the run: ${left.objects.map((o) => o.key).join(', ')}`);
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const all = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
  const split = opt('--split');
  if (!['practice', 'scored', 'all'].includes(split)) throw new Error('--split practice|scored|all');
  const sets = parseRefineSets(all('--set'));
  if (split !== 'practice' && Object.keys(sets).length) throw new Error('--set is for practice clips only: the scored run takes the frozen REFINE');
  const out = opt('--out');
  if (split !== 'practice' && (await stat(out).catch(() => null))) throw new Error(`${out} exists: the ${split} run happens once`);
  await mkdir(out, { recursive: true });
  const recordDir = opt('--record');
  if (recordDir) await mkdir(recordDir, { recursive: true });
  const refine = { ...REFINE, ...sets };
  const head = execFileSync('git', ['rev-parse', 'HEAD']).toString().trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', '.']).toString().trim();
  const clips = await loadClips(all('--manifest'), split);
  const { db } = await loadReplica({ cacheDir: opt('--catalog-dir'), out: opt('--replica') });
  const uploads = await r2StandIn(join(out, 'uploads-standin'));
  const logLines = [];
  const log = (s) => { logLines.push(s); console.log(s); };
  log(`MS-007 ${split} run ${new Date().toISOString()}  HEAD ${head}${dirty ? ' (uncommitted changes)' : ''}  ${clips.length} clips  separation ${opt('--separate') ? 'on' : 'off'}  REFINE ${JSON.stringify(refine)}`);
  const separate = opt('--separate') ? demucsSeparator({ python: opt('--separate') }) : null;
  const rows = await scoreClips({ clips, db, ref: localRef(opt('--ref')), uploads, separate, refine, recordDir, log });
  const summary = summarize(rows);
  log(`summary ${JSON.stringify(summary, null, 1)}`);
  const source = `MS-007 local scored run (scripts/score.mjs, ${split}, HEAD ${head.slice(0, 7)}, ${new Date().toISOString()})`;
  await writeFile(join(out, `results-${split}.csv`), toCsv(rows, { source, ranAgainst: 'offline replica only', ms006: await ms006Results(opt('--ms006-csv')) }));
  await writeFile(join(out, `results-${split}.json`), JSON.stringify({ split, head, dirty: Boolean(dirty), refine, summary, rows: rows.map(({ clip, ...r }) => ({ set: clip.set, file: clip.file, split: clip.split, kind: clip.kind, expect: clip.expect, ...r })) }, null, 2));
  await writeFile(join(out, `run-${split}.log`), `${logLines.join('\n')}\n`);
}
