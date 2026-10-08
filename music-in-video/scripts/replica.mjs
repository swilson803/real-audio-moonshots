// Offline replica of the moonshots index. The index is a pure function of
// the cached catalog audio and public/music/fp.js, so it can be rebuilt
// locally with no keys and no network, and matched with the in-memory
// mirrors of the SQL (clustersInMemory / trackWindowInMemory in src/match.js).
//
//   node scripts/replica.mjs --cache-dir /workspace/ms006/audio-cache --out /workspace/ms006/replica
//
// Writes OUT/fp-v<FP_VERSION>/<track_id>.bin (int32 hashes then int32 times)
// for each track in CACHE/catalog.json, in parallel, skipping files already
// there. tid = position in catalog.json + 1: the order the index build
// assigned them in (it writes catalog.json in tracks-file order).
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { FP_VERSION, fingerprint } from '../public/music/fp.js';
import { buildIndex, clustersInMemory, slicedLookup, trackWindowInMemory } from '../src/match.js';
import { decodeToPcm } from './build-catalog-index.mjs';

// opts: experimental index options (fp.js Fingerprinter); {} = the real index.
const optKey = (opts) => Object.entries(opts || {}).map(([k, v]) => `${k}=${v}`).join(',');
const versionDir = (out, opts) => join(out, `fp-v${FP_VERSION}${optKey(opts) ? `-${optKey(opts)}` : ''}`);

async function fingerprintTo(file, dest, opts) {
  const fp = fingerprint(await decodeToPcm(file), opts);
  const buf = new Int32Array(fp.hashes.length * 2);
  buf.set(fp.hashes, 0);
  buf.set(fp.times, fp.hashes.length);
  await writeFile(dest, Buffer.from(buf.buffer));
  return fp.hashes.length;
}

const exists = async (p) => { try { return (await stat(p)).size >= 0; } catch { return false; } };

export async function buildReplica({ cacheDir, out, opts = {}, threads = Math.max(1, Math.min(6, cpus().length - 2)), log = console.log }) {
  const catalog = JSON.parse(await readFile(join(cacheDir, 'catalog.json'), 'utf8'));
  const dir = versionDir(out, opts);
  await mkdir(dir, { recursive: true });
  const todo = [];
  for (const t of catalog) if (!(await exists(join(dir, `${t.track_id}.bin`)))) todo.push(t);
  log(`replica fp-v${FP_VERSION}: ${catalog.length - todo.length} done, ${todo.length} to fingerprint on ${threads} threads`);
  let next = 0;
  let done = 0;
  const started = Date.now();
  await Promise.all(Array.from({ length: Math.min(threads, todo.length) }, () => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { worker: true } });
    const feed = () => {
      if (next >= todo.length) { w.terminate().then(resolve); return; }
      const t = todo[next++];
      w.postMessage({ file: join(cacheDir, t.file), dest: join(dir, `${t.track_id}.bin`), title: t.title, opts });
    };
    w.on('message', (m) => {
      if (m.error) { reject(new Error(`${m.title}: ${m.error}`)); return; }
      done++;
      log(`  [${done}/${todo.length}] ${m.title}: ${m.n} hashes (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      feed();
    });
    w.on('error', reject);
    feed();
  })));
  return loadReplica({ cacheDir, out, opts });
}

// -> { tracks: [{ tid, track_id, title, artist, hashes, times }], rows, db }
// db has the shape of src/scan.js moonshots(): lookup / trackWindow / catalog.
export async function loadReplica({ cacheDir, out, opts = {} }) {
  const catalog = JSON.parse(await readFile(join(cacheDir, 'catalog.json'), 'utf8'));
  const dir = versionDir(out, opts);
  const tracks = [];
  for (const [i, t] of catalog.entries()) {
    const buf = await readFile(join(dir, `${t.track_id}.bin`));
    const all = new Int32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    const n = all.length / 2;
    tracks.push({ tid: i + 1, track_id: t.track_id, title: t.title, artist: t.artist, stream_url: t.stream_url, hashes: all.subarray(0, n), times: all.subarray(n) });
  }
  const index = buildIndex(tracks);
  const byTid = new Map(tracks.map((t) => [t.tid, t]));
  const rows = tracks.reduce((n, t) => n + t.hashes.length, 0);
  // lookup is sliced like the Worker's (src/scan.js); lookupWithout(ids)
  // behaves as if those tracks were not indexed (leave-one-out negatives).
  const tidOf = new Map(tracks.map((t) => [t.track_id, t.tid]));
  const lookupWithout = (trackIds = []) => {
    const skip = trackIds.length ? new Set(trackIds.map((id) => tidOf.get(id))) : null;
    return slicedLookup(async (hashes, times) => clustersInMemory(index, hashes, times, skip));
  };
  const db = {
    lookup: lookupWithout(),
    lookupWithout,
    trackWindow: async (tid, from, to) => trackWindowInMemory(byTid, tid, from, to),
    catalog: async (tids) => tracks.filter((t) => tids.includes(t.tid)).map(({ tid, track_id, title, artist, stream_url }) => ({ tid, track_id, title, artist, stream_url })),
  };
  return { tracks, rows, index, db };
}

if (!isMainThread && workerData?.worker) {
  parentPort.on('message', async ({ file, dest, title, opts }) => {
    try {
      parentPort.postMessage({ title, n: await fingerprintTo(file, dest, opts) });
    } catch (err) {
      parentPort.postMessage({ title, error: err.message });
    }
  });
} else if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const r = await buildReplica({ cacheDir: opt('--cache-dir'), out: opt('--out'), opts: JSON.parse(opt('--index-opts') || '{}'), threads: opt('--threads') ? Number(opt('--threads')) : undefined });
  console.log(`replica: ${r.tracks.length} tracks, ${r.rows} fp rows`);
}
