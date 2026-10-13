// Browser end-to-end on synthetic media, fully local:
//  - a synthetic catalog (seeded WAVs) and synthetic voice clips are written
//    to a temp dir, and scripts/make-test-videos.mjs turns them into the same
//    RA_TEST_ videos phase 2 makes from the real catalog (two tracks, no
//    music x2, 10 quiet beds at -20 dB incl. .mov, moov-at-end and WebM);
//  - each video goes through the real upload page in Chrome, the real Worker,
//    local stand-ins for its R2 bucket, queue and Processor container (the
//    real processor code) and a fake moonshots Supabase (test/harness.mjs),
//    via the shared checks in test/browser-suite.mjs, including the slow
//    paths behind the queue;
//  - Play's production audio requests are answered locally, so nothing
//    reaches any Supabase project or Cloudflare.
// Screenshots go to SHOTS (default test/out/shots); the slow-path ones to
// FAULT_SHOTS. Work files go under TMPDIR.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start } from './harness.mjs';
import { runBrowserSuite, PROD_TRACKS_PREFIX } from './browser-suite.mjs';
import { makeVideos } from '../scripts/make-test-videos.mjs';
import { synthMusic, synthSpeech, wavBytes } from './synth.mjs';

const SHOTS = process.env.SHOTS || new URL('./out/shots', import.meta.url).pathname;
const FAULT_SHOTS = process.env.FAULT_SHOTS || join(SHOTS, 'slow-paths');
// A fresh directory per run, so parallel runs on one box can't collide.
const WORK = await mkdtemp(join(tmpdir(), 'ms006_e2e-'));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

await mkdir(join(WORK, 'catalog'), { recursive: true });
await mkdir(join(WORK, 'speech'), { recursive: true });
await mkdir(SHOTS, { recursive: true });
const catalog = [];
for (let i = 1; i <= 12; i++) {
  const file = join(WORK, 'catalog', `${i}.wav`);
  await writeFile(file, wavBytes(synthMusic(1000 + i, 100)));
  catalog.push({ track_id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, title: `RA_TEST Track ${i}`, artist: `RA_TEST Artist ${(i % 4) + 1}`, file, stream_url: `${PROD_TRACKS_PREFIX}tracks/RA_TEST/${i}.wav`, duration_s: 100 });
}
const speechFiles = [];
for (let i = 0; i < 24; i++) {
  const f = join(WORK, 'speech', `clip${String(i).padStart(2, '0')}.wav`);
  await writeFile(f, wavBytes(synthSpeech(700 + i, 6 + (i % 5))));
  speechFiles.push(f);
}
console.log('making test videos…');
const videos = await makeVideos({ catalog, speechFiles, outDir: join(WORK, 'videos'), only: ['two_tracks', 'no_music', 'quiet'], log: () => {} });

const server = await start({ catalog, workDir: WORK });
try {
  await runBrowserSuite({
    origin: server.origin, videos, videosDir: join(WORK, 'videos'), catalog, shotsDir: SHOTS, check,
    cloud: server.cloud, faults: { db: server.fake, shotsDir: FAULT_SHOTS },
  });
  const workerHosts = [...new Set(server.workerRequests.map((r) => r.split(' ')[1].split('/')[0]))];
  check('Worker requests: only moonshots', workerHosts.every((h) => h === 'kucwpmtkctafzkivuqtu.supabase.co'), workerHosts.join(', '));
} finally {
  await server.close();
  await rm(WORK, { recursive: true, force: true });
}

await writeFile(`${SHOTS}/e2e-results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed; screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
