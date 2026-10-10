// Local harness: runs src/worker.js on Node (test/serve.mjs) with a fake
// moonshots Supabase behind it (test/fake-moonshots.mjs) and local stand-ins
// for its Cloudflare bindings (test/local-cloud.mjs: R2 uploads, the JOBS
// queue, the Processor container running the real processor code against
// the same fake moonshots and the catalog's 8 kHz reference). Nothing here
// talks to a real Supabase project or to Cloudflare.
import { join } from 'node:path';
import worker from '../src/worker.js';
import { moonshots } from '../src/moonshots.js';
import { decodeRef } from '../scripts/build-ref-audio.mjs';
import { MOONSHOTS, installFakeMoonshots } from './fake-moonshots.mjs';
import { localCloud } from './local-cloud.mjs';
import { serveWorker } from './serve.mjs';

const toFloat = (b) => Float32Array.from(new Int16Array(b.buffer, b.byteOffset, b.length / 2), (x) => x / 32768);

// catalog: [{ track_id, title, artist, file, stream_url }] with local audio.
// workDir: where the R2 stand-in keeps uploads.
export async function start({ catalog, workDir }) {
  const { scans, workerRequests, control } = await installFakeMoonshots({ catalog });
  const keys = { SUPABASE_URL: MOONSHOTS, SUPABASE_ANON_KEY: 'eyJanon.test', SUPABASE_SERVICE_ROLE_KEY: 'eyJservice.test' };
  const refs = new Map();
  for (const t of catalog) refs.set(t.track_id, toFloat(await decodeRef(t.file)));
  const cloud = await localCloud({
    worker,
    uploadsDir: join(workDir, 'uploads'),
    makeDeps: () => ({ db: moonshots(keys), ref: { track: async (id) => refs.get(id) } }),
  });
  const server = await serveWorker({ env: cloud.bindings(keys) });
  // fake: the fake moonshots' controls (statement timeouts); cloud: the
  // queue / container controls and the upload bucket.
  return { origin: server.origin, scans, workerRequests, fake: control, cloud, close: server.close };
}
