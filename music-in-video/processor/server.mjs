// The Processor container's HTTP server (MS-007), Node 20, port 8080:
//   POST /process  body: one uploaded soundtrack (public/music/body.js)
//     200 { found, matches, duration_s, proc_ms, cpu_ms, peak_mb }
//     422 { error }  never processable: unreadable / no-audio / too-long
//     503 { error: 'busy' }  moonshots stayed unavailable (the queue retries)
//     500            anything else (the queue retries)
//   GET /health    200
// The soundtrack is held in memory for the one request and never written to
// disk or logged. Environment: see src/container.js.
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { DbBusy, moonshots } from '../src/moonshots.js';
import { ProcessError, processScan } from '../src/process.js';
import { r2Ref } from '../src/ref.js';

const cpuMs = (u) => Math.round((u.user + u.system) / 1000);

// The real dependencies, from the container's environment.
export const depsFromEnv = (env) => ({
  db: moonshots(env),
  ref: r2Ref({ endpoint: env.R2_REF_ENDPOINT, bucket: env.R2_REF_BUCKET, accessKeyId: env.R2_REF_ACCESS_KEY_ID, secretAccessKey: env.R2_REF_SECRET_ACCESS_KEY }),
});

// One job: ArrayBuffer -> { status, body } (also used by the local harness).
export async function handleProcess(buf, deps) {
  const c0 = process.cpuUsage();
  const t0 = performance.now();
  try {
    const out = await processScan(buf, deps);
    return {
      status: 200,
      body: {
        found: out.found, matches: out.matches, duration_s: out.duration_s,
        proc_ms: Math.round(performance.now() - t0),
        cpu_ms: cpuMs(process.cpuUsage(c0)),
        peak_mb: Math.round(process.resourceUsage().maxRSS / 1024),
      },
    };
  } catch (err) {
    if (err instanceof ProcessError) return { status: 422, body: { error: err.code } };
    if (err instanceof DbBusy) return { status: 503, body: { error: 'busy' } };
    console.error('process failed', err.message);
    return { status: 500, body: { error: 'internal' } };
  }
}

export function createServer(deps) {
  return http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true });
    if (req.method !== 'POST' || req.url !== '/process') return send(404, { error: 'not found' });
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const buf = Buffer.concat(chunks);
    chunks.length = 0;
    const { status, body } = await handleProcess(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length), deps);
    return send(status, body);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8080);
  createServer(depsFromEnv(process.env)).listen(port, () => console.log(`processor listening on ${port}`));
}
