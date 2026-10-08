// MS-006 browser suite against the REAL moonshots index (phase 2). Run by
// Builder with the secrets in its own environment:
//
//   SUPABASE_URL=… SUPABASE_SECRET_KEY=… VIDEOS=/workspace/ms006/videos \
//   CATALOG=/workspace/ms006/audio-cache OUT=/workspace/ms006/e2e-real \
//   SELECT=two_tracks,no_music,quiet node test/e2e-real.mjs
//
//   SUPABASE_URL / SUPABASE_SECRET_KEY  moonshots (kucwpmtkctafzkivuqtu) only;
//                                       the key is never logged
//   VIDEOS   make-test-videos output (manifest.json + RA_TEST_ videos)
//   CATALOG  the index build's audio cache (catalog.json + files)
//   OUT      results.json, scan-ids.txt, worker-requests.json, shots/
//   SELECT   manifest kinds to run (two_tracks,no_music,quiet,dev,sweep)
//   PORT     local port (default: any free port)
//
// The Worker (src/worker.js) runs on Node with the real env; every request it
// makes is logged (method, host, path) and must go to moonshots. Each scan is
// labelled x-scan-label: RA_TEST_ms006_<file stem> (clear them afterwards
// with scripts/clear-test-scans.mjs). Play's production audio is answered
// from CATALOG (no egress). For each track on the two-track result, exactly
// one HEAD (no body) goes to its real public stream_url, keyless.
// Run `npm run build` first (the page is served from dist/).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { serveWorker } from './serve.mjs';
import { runBrowserSuite } from './browser-suite.mjs';
import { prodAudioReader } from '../scripts/lib/targets.mjs';

const MOONSHOTS_HOST = 'kucwpmtkctafzkivuqtu.supabase.co';
const need = (k) => {
  if (!process.env[k]) {
    console.error(`${k} is not set`);
    process.exit(1);
  }
  return process.env[k];
};
const SUPABASE_URL = need('SUPABASE_URL');
const SUPABASE_SECRET_KEY = need('SUPABASE_SECRET_KEY');
const VIDEOS = need('VIDEOS');
const CATALOG = need('CATALOG');
const OUT = need('OUT');
const SELECT = (process.env.SELECT || 'two_tracks,no_music,quiet').split(',').map((s) => s.trim());
if (new URL(SUPABASE_URL).host !== MOONSHOTS_HOST) {
  console.error(`SUPABASE_URL must be the moonshots project (${MOONSHOTS_HOST})`);
  process.exit(1);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const shots = join(OUT, 'shots');
await mkdir(shots, { recursive: true });

// Log every Worker outbound request (never headers, so never the key).
const workerRequests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const u = new URL(typeof input === 'string' ? input : input.url);
  workerRequests.push({ method: init.method || (typeof input === 'string' ? 'GET' : input.method), host: u.host, path: u.pathname });
  return realFetch(input, init);
};

const manifest = JSON.parse(await readFile(join(VIDEOS, 'manifest.json'), 'utf8'));
const videos = manifest.videos.filter((v) => SELECT.includes(v.kind));
const catalog = JSON.parse(await readFile(join(CATALOG, 'catalog.json'), 'utf8')).map((t) => ({ ...t, file: join(CATALOG, t.file) }));
const labelFor = (file) => `RA_TEST_ms006_${parse(file).name.replace(/^RA_TEST_/, '')}`;
console.log(`${videos.length} videos (${SELECT.join(', ')}); catalog cache ${catalog.length} tracks`);

let suite = { results: [], playRequests: [] };
const heads = [];
const server = await serveWorker({ env: { SUPABASE_URL, SUPABASE_SECRET_KEY } });
try {
  suite = await runBrowserSuite({ origin: server.origin, videos, videosDir: VIDEOS, catalog, shotsDir: shots, labelFor, check });

  // One keyless HEAD per track on the two-track result: is the real public
  // stream URL there? (No body is read.)
  const two = suite.results.find((r) => r.kind === 'two_tracks' && r.scan_id);
  if (two) {
    const scan = await (await realFetch(`${server.origin}/api/scans/${two.scan_id}`)).json();
    const head = prodAudioReader(realFetch);
    for (const m of scan.matches) {
      try {
        const res = await head(m.stream_url, { method: 'HEAD' });
        heads.push({ track_id: m.track_id, title: m.title, status: res.status, content_type: res.headers.get('content-type'), content_length: Number(res.headers.get('content-length')) || null });
      } catch (err) {
        heads.push({ track_id: m.track_id, title: m.title, error: err.message });
      }
    }
    check('two-track result: each stream URL answers a HEAD with 200', heads.length > 0 && heads.every((h) => h.status === 200), JSON.stringify(heads));
  } else if (SELECT.includes('two_tracks')) {
    check('two-track result: stream URLs checked', false, 'no two-track scan id');
  }

  const scanRequests = workerRequests.filter((r) => r.host !== '127.0.0.1' && r.host !== 'localhost');
  const hosts = [...new Set(scanRequests.map((r) => r.host))];
  check('Worker requests: only moonshots', hosts.every((h) => h === MOONSHOTS_HOST), hosts.join(', ') || 'none');
} finally {
  await server.close();
  const ids = suite.results.map((r) => r.scan_id).filter(Boolean);
  await writeFile(join(OUT, 'results.json'), JSON.stringify({
    ran_at: new Date().toISOString(),
    select: SELECT,
    videos: suite.results,
    checks: results,
    play_requests: suite.playRequests,
    stream_heads: heads,
  }, null, 2));
  await writeFile(join(OUT, 'scan-ids.txt'), ids.join('\n') + (ids.length ? '\n' : ''));
  await writeFile(join(OUT, 'worker-requests.json'), JSON.stringify(workerRequests, null, 2));
}

console.log('\nvideo                               kind        pass  got → want');
for (const r of suite.results) {
  const fmt = (xs) => xs.map((x) => `${x.title}@${x.start_s}`).join(', ') || '—';
  console.log(`${r.file.padEnd(36)}${r.kind.padEnd(12)}${(r.pass ? 'PASS' : 'FAIL').padEnd(6)}${fmt(r.got)} → ${fmt(r.want)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed; results in ${OUT}`);
process.exit(failed.length ? 1 : 0);
