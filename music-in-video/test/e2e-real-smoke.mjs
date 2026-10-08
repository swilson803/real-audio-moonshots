// Offline smoke run of test/e2e-real.mjs: a synthetic catalog cache and
// synthetic RA_TEST_ videos (made like phase 2's), with the fake moonshots
// (test/fake-moonshots.mjs) standing in for the real one and blocking any
// other host. Checks the script itself (env handling, labels, HEAD checks,
// results.json, scan-ids.txt, the table), not the real index.
//   node test/e2e-real-smoke.mjs   (after npm run build)
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installFakeMoonshots, MOONSHOTS } from './fake-moonshots.mjs';
import { makeVideos } from '../scripts/make-test-videos.mjs';
import { PROD_TRACKS_PREFIX } from './browser-suite.mjs';
import { synthMusic, synthSpeech, wavBytes } from './synth.mjs';

const WORK = await mkdtemp(join(tmpdir(), 'ms006_e2e_real_smoke-'));
const cache = join(WORK, 'audio-cache');
await mkdir(cache, { recursive: true });
await mkdir(join(WORK, 'speech'), { recursive: true });
const catalog = [];
for (let i = 1; i <= 12; i++) {
  const id = `00000000-0000-4000-8000-0000000001${String(i).padStart(2, '0')}`;
  await writeFile(join(cache, `${id}.wav`), wavBytes(synthMusic(1000 + i, 100)));
  catalog.push({ track_id: id, title: `RA_TEST Track ${i}`, artist: `RA_TEST Artist ${i}`, file: `${id}.wav`, stream_url: `${PROD_TRACKS_PREFIX}fma/RA_TEST/Track%20${i}%20%28mix%29.wav`, duration_s: 100 });
}
await writeFile(join(cache, 'catalog.json'), JSON.stringify(catalog, null, 2));
const speech = [];
for (let i = 0; i < 24; i++) {
  const f = join(WORK, 'speech', `clip${i}.wav`);
  await writeFile(f, wavBytes(synthSpeech(700 + i, 6 + (i % 5))));
  speech.push(f);
}
const local = catalog.map((t) => ({ ...t, file: join(cache, t.file) }));
await makeVideos({ catalog: local, speechFiles: speech, outDir: join(WORK, 'videos'), only: ['two_tracks', 'no_music', 'quiet'], log: () => {} });
await installFakeMoonshots({ catalog: local });

Object.assign(process.env, {
  SUPABASE_URL: MOONSHOTS,
  SUPABASE_SECRET_KEY: 'sb_secret_fake_for_smoke',
  VIDEOS: join(WORK, 'videos'),
  CATALOG: cache,
  OUT: join(WORK, 'out'),
  SELECT: 'two_tracks,no_music,quiet',
});
await import('./e2e-real.mjs');
