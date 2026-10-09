// Local harness: runs src/worker.js on Node (test/serve.mjs) with a fake
// moonshots Supabase behind it (test/fake-moonshots.mjs). Nothing here talks
// to a real Supabase project.
import { MOONSHOTS, installFakeMoonshots } from './fake-moonshots.mjs';
import { serveWorker } from './serve.mjs';

// catalog: [{ track_id, title, artist, file, stream_url }] with local audio.
export async function start({ catalog, port }) {
  const { scans, workerRequests, control } = await installFakeMoonshots({ catalog });
  const env = { SUPABASE_URL: MOONSHOTS, SUPABASE_ANON_KEY: 'eyJanon.test', SUPABASE_SERVICE_ROLE_KEY: 'eyJservice.test' };
  const server = await serveWorker({ env, port });
  // fake: the fake moonshots' controls (statement timeouts).
  return { origin: server.origin, scans, workerRequests, fake: control, close: server.close };
}
