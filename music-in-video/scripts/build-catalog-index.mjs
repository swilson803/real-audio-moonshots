// Builds the MS-006 catalog fingerprint index in the moonshots project from
// Real Audio's production catalog, which it only READS (see lib/targets.mjs).
//
// Phase 2 (the track list from Builder's read-only SQL export; audio from the
// public Tracks bucket with no key; one download per track, cached):
//   MOONSHOTS_SUPABASE_URL=… MOONSHOTS_SERVICE_ROLE_KEY=… \
//   node scripts/build-catalog-index.mjs --tracks-file /workspace/ms006/prod_catalog_tracks.json \
//     --cache-dir /workspace/ms006/audio-cache --report /workspace/ms006/index-report.json
//
// Options:
//   --tracks-file PATH       [{ track_id, title, artist, stream_url, duration_s, … }];
//                            no production REST request is made and no
//                            production key is needed. Without it the list is
//                            read over REST with PROD_SUPABASE_ANON_KEY.
//   --cache-dir DIR          audio cache, DIR/<track_id><ext>. A cached file is
//                            used with no network; a download goes to .part,
//                            then is renamed. DIR/catalog.json lists every
//                            cached track (make-test-videos --catalog-dir format).
//   --max-egress-bytes N     production download budget (default 5900000000):
//                            a download that would cross it is cancelled before
//                            its body is read and no further downloads start.
//   --report PATH            JSON report of the run (also written on abort).
//   --dry-run                list the tracks and their cache state only: no
//                            audio download, no moonshots writes (and with
//                            --tracks-file, no network at all).
//   --limit N                first N tracks only (never removes tracks).
//
// Per track: cached or downloaded audio -> sha256; unchanged (same sha and
// FP_VERSION) is skipped; otherwise ffmpeg decodes to 16 kHz mono, fp.js
// fingerprints (the code the browser runs) and the track's rows are replaced.
// Crash safety: the catalog row is written with audio_sha256 = 'pending'
// before its fingerprints and PATCHed to the real hash after the last batch,
// so a track cut off mid-write is redone (its rows deleted first) on rerun;
// tid stays the same for a track_id. A download, decode or zero-hash failure
// is recorded and the run moves on; the row budget aborts the run.
// Exit code: 0 all fine, 2 some tracks failed (rerun to retry them), 1 aborted.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FP_VERSION, SAMPLE_RATE, fingerprint } from '../public/music/fp.js';
import { PROD_TRACKS_PREFIX, fetchActiveTracks, moonshotsWriter, prodAudioReader, prodReader } from './lib/targets.mjs';

const BATCH = 5000;
// ms006_fp costs ~73 bytes a row with both indexes (measured on PGlite with
// this migration). The moonshots project is on Supabase Free (500 MB), so
// the index stops short of ~280 MB: a track that would cross this is not
// written, and the run fails, so the budget is never silently exceeded.
const MAX_FP_ROWS = 3_800_000;
// Approved phase-2 production egress is ~5.83 GB (the catalog is
// 5,833,418,774 bytes); a little slack for retries, never a second pass.
const MAX_EGRESS_BYTES = 5_900_000_000;
const DOWNLOAD_ATTEMPTS = 3; // the first try plus 2 retries
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class BudgetError extends Error {}

// ffmpeg -> mono SAMPLE_RATE float samples. input: a file path (seekable, so
// an m4a/mp4 with its moov at the end decodes) or a Buffer (piped).
export function decodeToPcm(input) {
  return new Promise((resolve, reject) => {
    const src = typeof input === 'string' ? input : 'pipe:0';
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', src, '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1']);
    const out = [];
    let err = '';
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg ${code}: ${err.trim().slice(0, 300)}`));
      const buf = Buffer.concat(out);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4)));
    });
    ff.stdin.on('error', () => {}); // ffmpeg may close stdin early on bad input
    if (typeof input === 'string') ff.stdin.end();
    else ff.stdin.end(input);
  });
}

// The track list file -> { tracks, invalid }. Unknown fields are ignored.
export function parseTracksFile(list) {
  if (!Array.isArray(list)) throw new Error('tracks file must be a JSON array');
  const tracks = [];
  const invalid = [];
  const seen = new Set();
  for (const e of list) {
    const why = [];
    if (!(typeof e?.track_id === 'string' && UUID.test(e.track_id))) why.push('track_id is not a uuid');
    else if (seen.has(e.track_id)) why.push('duplicate track_id');
    let href = null;
    try { href = new URL(e?.stream_url).href; } catch { /* reported below */ }
    if (!href || !href.startsWith(PROD_TRACKS_PREFIX)) why.push('stream_url is not under the public Tracks bucket');
    if (!(typeof e?.title === 'string' && e.title.trim())) why.push('empty title');
    if (!(typeof e?.artist === 'string' && e.artist.trim())) why.push('empty artist');
    if (why.length) {
      invalid.push({ track_id: e?.track_id ?? null, title: e?.title ?? null, artist: e?.artist ?? null, error: `invalid entry: ${why.join(', ')}` });
      continue;
    }
    seen.add(e.track_id);
    tracks.push({
      track_id: e.track_id,
      title: e.title,
      artist: e.artist,
      stream_url: e.stream_url,
      duration_s: Number.isFinite(e.duration_s) ? e.duration_s : null,
    });
  }
  return { tracks, invalid };
}

// Cache file extension from the URL path (decoded), else .audio.
export function extOf(url) {
  let ext = '';
  try { ext = extname(decodeURIComponent(new URL(url).pathname)).toLowerCase(); } catch { /* fall through */ }
  return /^\.[a-z0-9]{1,5}$/.test(ext) ? ext : '.audio';
}

const exists = async (p) => {
  try { return (await stat(p)).size > 0; } catch { return false; }
};

// One download, counted against the egress budget as bytes arrive; to `dest`
// (via dest.part) or into memory. Retries non-2xx, network errors and
// truncated bodies; every byte received counts, retries included.
async function download(url, { read, dest, stats, maxEgress, sleep }) {
  let lastErr;
  for (let attempt = 0; attempt < DOWNLOAD_ATTEMPTS; attempt++) {
    if (attempt) await sleep(1000 * 2 ** (attempt - 1));
    let res;
    try {
      res = await read(url);
    } catch (err) {
      if (/^Refusing/.test(err.message)) throw err;
      lastErr = err;
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      lastErr = new Error(`HTTP ${res.status}`);
      continue;
    }
    const length = Number(res.headers.get('content-length')) || null;
    if (length !== null && stats.bytes_downloaded + length > maxEgress) {
      await res.body?.cancel().catch(() => {});
      throw new BudgetError(`egress budget: ${length} more bytes would pass ${maxEgress}`);
    }
    const part = dest ? `${dest}.part` : null;
    const file = part ? createWriteStream(part) : null;
    const chunks = [];
    let received = 0;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        stats.bytes_downloaded += value.length;
        if (stats.bytes_downloaded > maxEgress) {
          await reader.cancel().catch(() => {});
          throw new BudgetError(`egress budget: passed ${maxEgress} mid-download`);
        }
        if (file) {
          if (!file.write(value)) await new Promise((r) => file.once('drain', r));
        } else {
          chunks.push(value);
        }
      }
      if (length !== null && received !== length) throw new Error(`truncated: ${received} of ${length} bytes`);
      if (file) {
        await new Promise((resolve, reject) => file.end((e) => (e ? reject(e) : resolve())));
        await rename(part, dest);
        return await readFile(dest);
      }
      return Buffer.concat(chunks);
    } catch (err) {
      if (file) {
        file.destroy();
        await rm(part, { force: true });
      }
      if (err instanceof BudgetError) throw err;
      lastErr = err;
    }
  }
  throw new Error(`download failed after ${DOWNLOAD_ATTEMPTS} attempts: ${lastErr?.message}`);
}

export async function buildIndex({
  tracksList = null, // parsed --tracks-file entries; null = production REST via `read`
  read = null, // prodReader (REST path)
  audioRead = null, // prodAudioReader (tracks-file path)
  write,
  decode = decodeToPcm,
  cacheDir = null,
  maxEgressBytes = MAX_EGRESS_BYTES,
  dryRun = false,
  limit = Infinity,
  maxRows = MAX_FP_ROWS,
  log = console.log,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const started = Date.now();
  const stats = {
    started_at: new Date(started).toISOString(),
    ended_at: null,
    source: tracksList ? 'tracks-file' : 'production-rest',
    tracks_listed: 0,
    tracks: 0,
    indexed: 0,
    skipped: 0,
    removed: 0,
    failed: [],
    bytes_downloaded: 0,
    bytes_from_cache: 0,
    max_egress_bytes: maxEgressBytes,
    egress_budget_hit: false,
    total_fp_rows: 0,
    per_track_hashes: {},
    error: null,
  };
  const cached = new Map(); // track_id -> catalog.json entry
  const writeCatalogJson = async () => {
    if (!cacheDir || dryRun) return;
    await writeFile(join(cacheDir, 'catalog.json'), JSON.stringify([...cached.values()], null, 2));
  };

  try {
    let all;
    if (tracksList) {
      const { tracks, invalid } = parseTracksFile(tracksList);
      stats.tracks_listed = tracksList.length;
      stats.failed.push(...invalid);
      all = tracks;
    } else {
      all = await fetchActiveTracks(read);
      stats.tracks_listed = all.length;
    }
    const tracks = all.slice(0, limit);
    stats.tracks = tracks.length;
    const audio = tracksList ? audioRead : read;
    if (cacheDir) await mkdir(cacheDir, { recursive: true });
    const fileOf = (t) => (cacheDir ? join(cacheDir, `${t.track_id}${extOf(t.stream_url)}`) : null);
    log(`${stats.source}: ${tracks.length} tracks${stats.failed.length ? ` (${stats.failed.length} invalid entries skipped)` : ''}`);

    if (dryRun) {
      for (const t of tracks) log(`  ${t.track_id}  ${(await exists(fileOf(t) ?? '')) ? 'cached ' : 'missing'}  ${t.artist} - ${t.title}`);
      return stats;
    }

    const existing = await write('ms006_catalog?select=tid,track_id,audio_sha256,fp_version,hash_count');
    const byTrack = new Map(existing.map((r) => [r.track_id, r]));
    let nextTid = existing.reduce((m, r) => Math.max(m, r.tid), 0) + 1;
    let totalRows = existing.reduce((n, r) => n + r.hash_count, 0);
    stats.total_fp_rows = totalRows;
    const fail = (t, error) => {
      stats.failed.push({ track_id: t.track_id, title: t.title, artist: t.artist, error });
      log(`    FAILED ${t.artist} - ${t.title}: ${error}`);
    };

    for (const [i, t] of tracks.entries()) {
      const dest = fileOf(t);
      let bytes;
      let source;
      if (dest && (await exists(dest))) {
        bytes = await readFile(dest);
        source = 'cache';
        stats.bytes_from_cache += bytes.length;
      } else if (stats.egress_budget_hit) {
        fail(t, 'egress budget: not downloaded');
        continue;
      } else {
        try {
          bytes = await download(t.stream_url, { read: audio, dest, stats, maxEgress: maxEgressBytes, sleep });
          source = 'download';
        } catch (err) {
          if (err instanceof BudgetError) stats.egress_budget_hit = true;
          fail(t, err.message);
          continue;
        }
      }
      if (dest) cached.set(t.track_id, { track_id: t.track_id, title: t.title, artist: t.artist, file: `${t.track_id}${extOf(t.stream_url)}`, stream_url: t.stream_url, duration_s: t.duration_s });

      const progress = (hashes) => log(`[${i + 1}/${tracks.length}] ${t.artist} - ${t.title}  ${source}  ${bytes.length} B  ${hashes}  rows ${totalRows}  ${((Date.now() - started) / 1000).toFixed(1)} s`);
      const sha = createHash('sha256').update(bytes).digest('hex');
      const prev = byTrack.get(t.track_id);
      if (prev && prev.audio_sha256 === sha && prev.fp_version === FP_VERSION) {
        stats.skipped++;
        stats.per_track_hashes[t.track_id] = prev.hash_count;
        progress('unchanged');
        continue;
      }

      let fp;
      try {
        fp = fingerprint(await decode(dest ?? bytes));
      } catch (err) {
        fail(t, `decode: ${err.message}`);
        continue;
      }
      if (!fp.hashes.length) {
        fail(t, 'zero hashes (silent or undecodable audio)');
        continue;
      }
      const projected = totalRows - (prev?.hash_count ?? 0) + fp.hashes.length;
      if (projected > maxRows) {
        throw new Error(`index budget: ${t.artist} - ${t.title} would take ms006_fp to ${projected} rows (limit ${maxRows}); `
          + 'lower the peak density or FANOUT in public/music/fp.js, bump FP_VERSION and rebuild');
      }

      const tid = prev?.tid ?? nextTid++;
      // 'pending' until the last fingerprint batch is in (see the header).
      await write('ms006_catalog?on_conflict=tid', {
        method: 'POST',
        prefer: 'resolution=merge-duplicates,return=minimal',
        body: {
          tid, track_id: t.track_id, title: t.title, artist: t.artist, stream_url: t.stream_url, duration_s: t.duration_s,
          audio_sha256: 'pending', fp_version: FP_VERSION, hash_count: fp.hashes.length, indexed_at: new Date().toISOString(),
        },
      });
      totalRows = projected;
      byTrack.set(t.track_id, { tid, track_id: t.track_id, audio_sha256: 'pending', fp_version: FP_VERSION, hash_count: fp.hashes.length });
      if (prev) await write(`ms006_fp?tid=eq.${tid}`, { method: 'DELETE' });
      for (let j = 0; j < fp.hashes.length; j += BATCH) {
        const rows = [];
        for (let k = j; k < Math.min(j + BATCH, fp.hashes.length); k++) rows.push({ hash: fp.hashes[k], tid, t: fp.times[k] });
        await write('ms006_fp', { method: 'POST', prefer: 'return=minimal', body: rows });
      }
      await write(`ms006_catalog?tid=eq.${tid}`, { method: 'PATCH', prefer: 'return=minimal', body: { audio_sha256: sha, indexed_at: new Date().toISOString() } });
      byTrack.get(t.track_id).audio_sha256 = sha;
      stats.indexed++;
      stats.total_fp_rows = totalRows;
      stats.per_track_hashes[t.track_id] = fp.hashes.length;
      progress(`${fp.hashes.length} hashes`);
    }

    // Tracks no longer in the list leave the index (full runs only).
    if (limit === Infinity) {
      const listed = new Set(all.map((t) => t.track_id));
      const gone = [...byTrack.values()].filter((r) => !listed.has(r.track_id));
      if (gone.length) {
        await write(`ms006_catalog?tid=in.(${gone.map((r) => r.tid).join(',')})`, { method: 'DELETE' }); // fp rows cascade
        stats.removed = gone.length;
        totalRows -= gone.reduce((n, r) => n + r.hash_count, 0);
        stats.total_fp_rows = totalRows;
      }
    }
    return stats;
  } catch (err) {
    stats.error = err.message;
    err.stats = stats; // so the CLI can still write the report
    throw err;
  } finally {
    stats.ended_at = new Date().toISOString();
    await writeCatalogJson();
    log(`done: indexed ${stats.indexed}, unchanged ${stats.skipped}, failed ${stats.failed.length}, removed ${stats.removed}, `
      + `fp rows ${stats.total_fp_rows}; production egress ${stats.bytes_downloaded} B, from cache ${stats.bytes_from_cache} B`
      + `${stats.egress_budget_hit ? ' (EGRESS BUDGET HIT)' : ''}${stats.error ? `; ABORTED: ${stats.error}` : ''}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const dryRun = args.includes('--dry-run');
  const tracksFile = opt('--tracks-file');
  const reportPath = opt('--report');
  let stats = null;
  let code = 0;
  try {
    stats = await buildIndex({
      tracksList: tracksFile ? JSON.parse(await readFile(tracksFile, 'utf8')) : null,
      read: tracksFile ? null : prodReader(process.env.PROD_SUPABASE_ANON_KEY),
      audioRead: tracksFile ? prodAudioReader() : null,
      write: dryRun
        ? () => { throw new Error('dry run: no moonshots writes'); }
        : moonshotsWriter(process.env.MOONSHOTS_SUPABASE_URL, process.env.MOONSHOTS_SERVICE_ROLE_KEY),
      cacheDir: opt('--cache-dir'),
      maxEgressBytes: opt('--max-egress-bytes') ? Number(opt('--max-egress-bytes')) : MAX_EGRESS_BYTES,
      dryRun,
      limit: opt('--limit') ? Number(opt('--limit')) : Infinity,
      log: (line) => console.log(line),
    });
    if (stats.failed.length) code = 2;
  } catch (err) {
    console.error(`ABORTED: ${err.message}`);
    ({ stats } = err);
    code = 1;
  }
  if (reportPath && stats) await writeFile(reportPath, JSON.stringify(stats, null, 2));
  process.exit(code);
}
