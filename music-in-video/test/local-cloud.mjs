// Local stand-ins for the Worker's Cloudflare bindings (MS-007), for the
// browser harness and test/e2e-real.mjs. No Cloudflare call of any kind.
//   UPLOADS    test/r2-standin.mjs (a folder)
//   JOBS       a queue with the root wrangler config's consumer settings:
//              batches of 1, msg.retry({ delaySeconds }) re-delivers after the
//              delay (x timeScale), max_retries 4, then the dead-letter queue
//   PROCESSOR  the Container binding: the real handler (processor/server.mjs)
//              in this process, with fault controls for the slow paths
// worker: src/worker.js (its queue() handler consumes JOBS).
import { setTimeout as sleep } from 'node:timers/promises';
import { handleProcess } from '../processor/server.mjs';
import { r2StandIn } from './r2-standin.mjs';

const MAX_RETRIES = 4; // root wrangler config: queues.consumers[].max_retries
const QUEUE = 'ms007-jobs';
const DLQ = 'ms007-jobs-dlq';

// makeDeps() -> { db, ref } for one processor job. timeScale shrinks queue retry delays
// (15 s, 30 s, … in production) so a run doesn't take minutes.
export async function localCloud({ worker, uploadsDir, makeDeps, timeScale = 0.1 }) {
  const uploads = await r2StandIn(uploadsDir);
  const control = {
    // The next `n` jobs fail inside the container (a crash: 500).
    crashNext: 0,
    // Every job fails (500) until cleared: the dead-letter path.
    crashAlways: false,
    // Each job takes at least this long in the container (a slow job).
    delayMs: 0,
    // The first job after this is set waits this long first (a cold start).
    coldStartMs: 0,
    // Holds every job until released (the result page's working state).
    hold: null,
    jobs: 0,
    deliveries: [],
    deadLetters: 0,
    pending: 0,
  };
  control.holdJobs = () => {
    let release;
    control.hold = new Promise((r) => { release = r; });
    return () => { control.hold = null; release(); };
  };
  let env = null;
  const deliver = async (body, attempts) => {
    const msg = { body, attempts, acked: false, retried: null, ack() { this.acked = true; }, retry(o = {}) { this.retried = o; } };
    control.deliveries.push({ id: body.id, attempts });
    await worker.queue({ queue: QUEUE, messages: [msg] }, env, { waitUntil() {} });
    if (msg.acked || !msg.retried) return;
    if (attempts > MAX_RETRIES) {
      control.deadLetters++;
      const dead = { body, attempts, ack() {}, retry() {} };
      await worker.queue({ queue: DLQ, messages: [dead] }, env, { waitUntil() {} });
      return;
    }
    await sleep((msg.retried.delaySeconds ?? 0) * 1000 * timeScale);
    await deliver(body, attempts + 1);
  };
  const PROCESSOR = {
    idFromName: (name) => name,
    get: () => ({
      async fetch(req) {
        const buf = await req.arrayBuffer();
        control.jobs++;
        if (control.coldStartMs) {
          const ms = control.coldStartMs;
          control.coldStartMs = 0;
          await sleep(ms);
        }
        if (control.hold) await control.hold;
        if (control.crashAlways || control.crashNext > 0) {
          if (control.crashNext > 0) control.crashNext--;
          return new Response(JSON.stringify({ error: 'internal' }), { status: 500 });
        }
        const t0 = Date.now();
        const { status, body } = await handleProcess(buf, makeDeps());
        const left = control.delayMs - (Date.now() - t0);
        if (left > 0) await sleep(left);
        return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      },
    }),
  };
  const JOBS = {
    async send(body) {
      control.pending++;
      // Delivered asynchronously, like a real queue.
      setTimeout(() => deliver(body, 1).catch((err) => console.error('local queue:', err.message)).finally(() => { control.pending--; }), 10);
    },
  };
  return {
    bindings: (workerEnv) => {
      env = { ...workerEnv, UPLOADS: uploads, JOBS, PROCESSOR };
      return env;
    },
    uploads,
    control,
    // Every upload still in the bucket (should be none once jobs finish).
    uploadsLeft: async () => (await uploads.list({ prefix: 'uploads/' })).objects.map((o) => o.key),
    // Waits for queued jobs to finish (or fail) before checking.
    idle: async () => { while (control.pending) await sleep(50); },
  };
}
