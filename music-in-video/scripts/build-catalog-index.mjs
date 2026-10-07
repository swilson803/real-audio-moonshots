// Builds the MS-006 catalog fingerprint index in the moonshots project from
// Real Audio's production catalog, which it only READS (see lib/targets.mjs).
//
//   node --env-file=.env scripts/build-catalog-index.mjs [--dry-run] [--limit N]
//
// .env (gitignored; names only):
//   PROD_SUPABASE_ANON_KEY       production anon key, the public one shipped in
//                                real-audio-creator src/integrations/supabase/client.ts
//   MOONSHOTS_SUPABASE_URL       https://kucwpmtkctafzkivuqtu.supabase.co
//   MOONSHOTS_SERVICE_ROLE_KEY   moonshots service role key
//
// For each active, non-SFX track: download its public audio file (production
// egress: the full catalog is about 5.5 GB), skip it if its sha256 and
// FP_VERSION are unchanged, else decode with local ffmpeg to 16 kHz mono,
// fingerprint (public/music/fp.js, the same code the browser runs) and
// replace its rows in ms006_catalog / ms006_fp. Tracks no longer active are
// removed from the index. --dry-run reads production metadata only: no audio,
// no moonshots writes.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { FP_VERSION, SAMPLE_RATE, fingerprint } from '../public/music/fp.js';
import { fetchActiveTracks, moonshotsWriter, prodReader } from './lib/targets.mjs';

const BATCH = 5000;
// ms006_fp costs ~73 bytes a row with both indexes (measured on PGlite with
// this migration). The moonshots project is on Supabase Free (500 MB), so
// the index stops short of ~280 MB: a track that would cross this is not
// written, and the run fails, so the budget is never silently exceeded.
export const MAX_FP_ROWS = 3_800_000;

export function decodeToPcm(bytes) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', 'pipe:0', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1']);
    const out = [];
    let err = '';
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg ${code}: ${err.trim()}`));
      const buf = Buffer.concat(out);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4));
    });
    ff.stdin.on('error', () => {}); // ffmpeg may close stdin early on bad input
    ff.stdin.end(bytes);
  });
}

export async function buildIndex({ read, write, decode = decodeToPcm, dryRun = false, limit = Infinity, maxRows = MAX_FP_ROWS, log = console.log }) {
  const tracks = (await fetchActiveTracks(read)).slice(0, limit);
  log(`production: ${tracks.length} active tracks`);
  if (dryRun) {
    for (const t of tracks) log(`  ${t.track_id}  ${t.artist} - ${t.title}`);
    return { tracks: tracks.length, indexed: 0, skipped: 0, removed: 0, bytes: 0 };
  }

  const existing = await write('ms006_catalog?select=tid,track_id,audio_sha256,fp_version,hash_count');
  const byTrack = new Map(existing.map((r) => [r.track_id, r]));
  let nextTid = existing.reduce((m, r) => Math.max(m, r.tid), 0) + 1;
  let totalRows = existing.reduce((n, r) => n + r.hash_count, 0);
  const stats = { tracks: tracks.length, indexed: 0, skipped: 0, removed: 0, bytes: 0 };

  for (const t of tracks) {
    const bytes = Buffer.from(await (await read(t.stream_url)).arrayBuffer());
    stats.bytes += bytes.length;
    const sha = createHash('sha256').update(bytes).digest('hex');
    const prev = byTrack.get(t.track_id);
    if (prev && prev.audio_sha256 === sha && prev.fp_version === FP_VERSION) {
      stats.skipped++;
      continue;
    }
    const fp = fingerprint(await decode(bytes));
    const projected = totalRows - (prev?.hash_count ?? 0) + fp.hashes.length;
    if (projected > maxRows) {
      throw new Error(`index budget: ${t.artist} - ${t.title} would take ms006_fp to ${projected} rows (limit ${maxRows}); `
        + 'lower the peak density or FANOUT in public/music/fp.js, bump FP_VERSION and rebuild');
    }
    totalRows = projected;
    const tid = prev?.tid ?? nextTid++;
    if (prev) await write(`ms006_fp?tid=eq.${tid}`, { method: 'DELETE' });
    await write('ms006_catalog?on_conflict=tid', {
      method: 'POST',
      prefer: 'resolution=merge-duplicates,return=minimal',
      body: { tid, ...t, audio_sha256: sha, fp_version: FP_VERSION, hash_count: fp.hashes.length, indexed_at: new Date().toISOString() },
    });
    for (let i = 0; i < fp.hashes.length; i += BATCH) {
      const rows = [];
      for (let j = i; j < Math.min(i + BATCH, fp.hashes.length); j++) rows.push({ hash: fp.hashes[j], tid, t: fp.times[j] });
      await write('ms006_fp', { method: 'POST', prefer: 'return=minimal', body: rows });
    }
    stats.indexed++;
    stats.rows = totalRows;
    log(`  indexed ${t.artist} - ${t.title} (${fp.hashes.length} hashes)`);
  }

  const active = new Set(tracks.map((t) => t.track_id));
  const gone = existing.filter((r) => !active.has(r.track_id));
  if (gone.length && limit === Infinity) {
    await write(`ms006_catalog?tid=in.(${gone.map((r) => r.tid).join(',')})`, { method: 'DELETE' }); // fp rows cascade
    stats.removed = gone.length;
  }
  log(`done: ${JSON.stringify(stats)} (production egress ${(stats.bytes / 1e9).toFixed(2)} GB)`);
  return stats;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const li = args.indexOf('--limit');
  const limit = li >= 0 ? Number(args[li + 1]) : Infinity;
  const read = prodReader(process.env.PROD_SUPABASE_ANON_KEY);
  const write = dryRun
    ? () => { throw new Error('dry run: no moonshots writes'); }
    : moonshotsWriter(process.env.MOONSHOTS_SUPABASE_URL, process.env.MOONSHOTS_SERVICE_ROLE_KEY);
  await buildIndex({ read, write, dryRun, limit });
}
