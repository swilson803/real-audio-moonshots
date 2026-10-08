// Tuning loop, Node only: each manifest video is decoded with ffmpeg (16 kHz
// mono), fingerprinted exactly as the browser does (public/music/fp.js
// QUERY: hashes + verification peaks) and matched with src/match.js, with
// lookups sliced as in the Worker, against the REAL moonshots index or an
// offline replica of it (--replica, scripts/replica.mjs), then compared with
// the manifest. Real DB answers are cached in OUT/cache/, so threshold sweeps
// (--set) re-run without touching the DB.
//
//   SUPABASE_URL=… SUPABASE_SECRET_KEY=… node scripts/tune.mjs \
//     --manifest /workspace/ms006/videos/manifest.json --kind dev \
//     --out /workspace/ms006/tune [--name REGEX] [--set NAME=VALUE …] [--offline]
//
//   node scripts/tune.mjs --replica /workspace/ms006/replica \
//     --catalog-dir /workspace/ms006/audio-cache --manifest … [--manifest …] --kind dev,no_music
//
//   SUPABASE_URL / SUPABASE_SECRET_KEY   moonshots only (src/scan.js refuses
//                                        production); not needed with --offline
//                                        or --replica
//   --manifest PATH   make-test-videos / make-negatives manifest; videos are
//                     next to it (repeatable)
//   --replica DIR     match against the offline replica (no network; needs
//                     --catalog-dir); leave-one-out negatives
//                     (exclude_track_ids) only work here
//   --kind LIST       comma list of kinds (default dev; two_tracks,no_music,quiet,dev,sweep)
//   --name REGEX      only files matching
//   --set NAME=VALUE  matcher override (see TUNABLES in src/match.js; repeatable;
//                     NULL_SHIFTS takes a comma list)
//   --out DIR         cache + tune-<time>.json results (default ./tune-out)
//   --offline         use only the cache; fail if something isn't cached
//
// Cache: <video>.fp.json (the video's fingerprint, keyed by FP_VERSION and
// file size + mtime), <video>.match.json (its ms006_match rows) and
// track-<tid>.json (the track's whole fingerprint via ms006_track_window,
// sliced locally for each window).
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FP_VERSION, QUERY, fingerprint } from '../public/music/fp.js';
import { TUNABLES, framesToSec, match, tunables } from '../src/match.js';
import { moonshots } from '../src/scan.js';
import { decodeToPcm } from './build-catalog-index.mjs';
import { judge } from '../test/browser-suite.mjs';
import { withKinds } from './lib/kinds.mjs';
import { loadReplica } from './replica.mjs';

// --set NAME=VALUE pairs -> match() options.
export function parseSets(sets) {
  const out = {};
  for (const s of sets) {
    const [name, value] = s.split('=');
    if (!(name in TUNABLES)) throw new Error(`--set ${name}: not a tunable (${Object.keys(TUNABLES).join(', ')})`);
    out[name] = Array.isArray(TUNABLES[name]) ? value.split(',').map(Number) : Number(value);
    if ([].concat(out[name]).some((x) => !Number.isFinite(x))) throw new Error(`--set ${s}: not a number`);
  }
  return tunables(out) && out;
}

// A DB client whose answers are cached on disk (or only read, offline).
function cachedDb({ db, cacheDir, offline = false }) {
  const tracks = new Map();
  const load = async (file) => {
    try { return JSON.parse(await readFile(join(cacheDir, file), 'utf8')); } catch { return null; }
  };
  const save = (file, data) => writeFile(join(cacheDir, file), JSON.stringify(data));
  const track = async (tid) => {
    if (!tracks.has(tid)) {
      tracks.set(tid, (async () => {
        const file = `track-${tid}.json`;
        const hit = await load(file);
        if (hit?.fp_version === FP_VERSION) return hit;
        if (offline) throw new Error(`offline: ${file} not cached`);
        const whole = await db.trackWindow(tid, -2147483648, 2147483647);
        const data = { fp_version: FP_VERSION, hashes: whole.hashes, times: whole.times };
        await save(file, data);
        return data;
      })());
    }
    return tracks.get(tid);
  };
  return {
    forVideo(name) {
      return {
        async lookup(hashes, times) {
          const file = `${name}.match.json`;
          const hit = await load(file);
          if (hit?.fp_version === FP_VERSION && hit.n === hashes.length) return hit.rows;
          if (offline) throw new Error(`offline: ${file} not cached`);
          const rows = await db.lookup(hashes, times);
          await save(file, { fp_version: FP_VERSION, n: hashes.length, rows });
          return rows;
        },
        async trackWindow(tid, from, to) {
          const t = await track(tid);
          const out = { hashes: [], times: [] };
          for (let i = 0; i < t.times.length; i++) {
            if (t.times[i] >= from && t.times[i] <= to) {
              out.hashes.push(t.hashes[i]);
              out.times.push(t.times[i]);
            }
          }
          return out;
        },
      };
    },
  };
}

const QUERY_KEY = JSON.stringify(QUERY);

// The video's query fingerprint, cached (keyed by FP_VERSION, the QUERY
// preset and the file's size + mtime).
async function videoFingerprint(path, cacheDir, offline) {
  const st = await stat(path);
  const file = join(cacheDir, `${basename(path)}.fp.json`);
  let data = null;
  try {
    const hit = JSON.parse(await readFile(file, 'utf8'));
    if (hit.fp_version === FP_VERSION && hit.query === QUERY_KEY && hit.size === st.size && hit.mtime === st.mtimeMs) data = hit;
  } catch { /* not cached */ }
  if (!data) {
    if (offline) throw new Error(`offline: ${basename(file)} not cached`);
    const fp = fingerprint(await decodeToPcm(path), QUERY);
    data = {
      fp_version: FP_VERSION, query: QUERY_KEY, size: st.size, mtime: st.mtimeMs,
      hashes: Array.from(fp.hashes), times: Array.from(fp.times), peakT: Array.from(fp.peakT), peakF: Array.from(fp.peakF),
    };
    await writeFile(file, JSON.stringify(data));
  }
  return {
    hashes: Int32Array.from(data.hashes),
    times: Int32Array.from(data.times),
    peaks: { t: Int32Array.from(data.peakT), f: Int32Array.from(data.peakF) },
  };
}

export async function tune({ manifestPaths, kinds, nameRe, sets, outDir, db, offline, direct = false, allowAcceptance = false, log = console.log }) {
  if (kinds.includes('quiet') && !allowAcceptance) throw new Error('kind quiet is the acceptance set: never tune on it (--allow-acceptance to run it on purpose)');
  const videos = [];
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const dir = dirname(manifestPath);
    for (const v of withKinds(manifest.videos)) {
      if (kinds.includes(v.kind) && (!nameRe || nameRe.test(v.file))) videos.push({ ...v, dir, set: basename(dir) });
    }
  }
  const rows = [];
  for (const v of videos) {
    // One cache folder per video folder (file names repeat across sets).
    const cacheDir = join(outDir, 'cache', v.set);
    await mkdir(cacheDir, { recursive: true });
    if (v.exclude_track_ids && !direct) {
      log(`SKIP  ${v.file}: leave-one-out negative, replica only`);
      continue;
    }
    // direct: a local db (the replica) needs no answer cache.
    const deps = direct
      ? { lookup: db.lookupWithout(v.exclude_track_ids), trackWindow: db.trackWindow }
      : cachedDb({ db, cacheDir, offline }).forVideo(v.file);
    const q = await videoFingerprint(join(v.dir, v.file), cacheDir, offline);
    const segs = await match(q, deps, sets);
    const tids = [...new Set(segs.map((s) => s.tid))];
    // Map tids to track_ids via the cached catalog lookup (one row set per video).
    const catFile = join(cacheDir, `${v.file}.catalog.json`);
    let catalog = [];
    if (tids.length) {
      if (!direct) try { catalog = JSON.parse(await readFile(catFile, 'utf8')); } catch { /* not cached */ }
      if (tids.some((t) => !catalog.find((c) => c.tid === t))) {
        if (offline) throw new Error(`offline: ${basename(catFile)} not cached`);
        catalog = await db.catalog(tids);
        if (!direct) await writeFile(catFile, JSON.stringify(catalog));
      }
    }
    const matches = segs.map((s) => {
      const c = catalog.find((x) => x.tid === s.tid) ?? {};
      return { track_id: c.track_id, title: c.title, start_s: framesToSec(s.start), end_s: framesToSec(s.end), coincidences: s.coincidences };
    });
    const pass = judge(v, matches.length > 0, matches);
    rows.push({ set: v.set, file: v.file, kind: v.kind, pass, got: matches, want: v.expect.map((e) => ({ track_id: e.track_id, title: e.title, start_s: e.start_s })) });
    const fmt = (xs) => xs.map((x) => `${x.title}@${x.start_s}`).join(', ') || '—';
    log(`${(pass ? 'PASS' : 'FAIL').padEnd(5)} ${`${v.set}/${v.file}`.padEnd(46)} ${fmt(matches)}  want ${fmt(v.expect)}`);
  }
  const byKind = {};
  for (const r of rows) {
    const k = `${r.set}:${r.kind}`;
    byKind[k] ??= { pass: 0, total: 0 };
    byKind[k].total++;
    if (r.pass) byKind[k].pass++;
  }
  log(`summary ${JSON.stringify(byKind)}  overrides ${JSON.stringify(sets)}`);
  const result = { ran_at: new Date().toISOString(), fp_version: FP_VERSION, overrides: sets, summary: byKind, videos: rows };
  await writeFile(join(outDir, `tune-${Date.now()}.json`), JSON.stringify(result, null, 2));
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const all = (k) => args.flatMap((a, i) => (a === k ? [args[i + 1]] : []));
  const offline = args.includes('--offline');
  const manifestPaths = all('--manifest');
  if (!manifestPaths.length) throw new Error('--manifest is required');
  const replica = opt('--replica');
  let db = null;
  if (replica) {
    if (!opt('--catalog-dir')) throw new Error('--replica needs --catalog-dir (the audio cache with catalog.json)');
    ({ db } = await loadReplica({ cacheDir: opt('--catalog-dir'), out: replica }));
  } else if (!offline) {
    if (!process.env.SUPABASE_SECRET_KEY) throw new Error('SUPABASE_SECRET_KEY is not set (or use --offline / --replica)');
    db = moonshots({ SUPABASE_URL: process.env.SUPABASE_URL, SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY });
  }
  await tune({
    manifestPaths,
    kinds: (opt('--kind') || 'dev').split(','),
    nameRe: opt('--name') ? new RegExp(opt('--name')) : null,
    sets: parseSets(all('--set')),
    outDir: opt('--out') || 'tune-out',
    db,
    offline,
    direct: Boolean(replica),
    allowAcceptance: args.includes('--allow-acceptance'),
  });
}
