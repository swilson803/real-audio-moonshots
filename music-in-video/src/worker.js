// Cloudflare Worker for "music in this video" (MS-006, processing moved off
// the Worker in MS-007), sharing one Worker (and copyrighttester.real.audio)
// with the MS-002/MS-004 clearance check.
//
// Ours:
//   /music/                    upload page (static, public/music/)
//   /v/<id>                    result page (static, public/v/; result.js reads the id)
//   POST /api/scan             queue a soundtrack (src/scan.js)
//   GET  /api/scans/<id>/status  the upload page's poll
//   GET  /api/scans/<id>       one result, or 202 while it's still working
//   queue                      JOBS consumer (and its dead-letter queue):
//                              processing in the Processor container
//   scheduled                  our sweep, then clearance-check's cron
// Everything else, and the cron, goes to clearance-check/src/worker.js
// unchanged, so the clearance check stays live.
//
// Assets: scripts/build-assets.mjs merges clearance-check/public and
// music-in-video/public into music-in-video/dist (ASSETS).
// Supabase: the moonshots project only, service role: SUPABASE_SECRET_KEY
// (the Worker Secret already set for the clearance cron) or
// SUPABASE_SERVICE_ROLE_KEY.
// Bindings (root wrangler config): UPLOADS (R2 ms007-uploads), JOBS (queue
// ms007-jobs, dead letters to ms007-jobs-dlq), PROCESSOR (the container).

import clearance from '../../clearance-check/src/worker.js';
import { DbBusy } from './moonshots.js';
import { JOBS_DLQ, handleDeadLetters, handleGetScan, handleJobs, handleScan, handleScanStatus, sweep } from './scan.js';

export { Processor } from './container.js';

const json = (body, status) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

// What a route needs and isn't set: secret / binding names.
function missing(env, needs) {
  const out = [];
  if (!(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY)) out.push('SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY');
  for (const name of needs) if (!env[name]) out.push(name);
  return out;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/scan' || pathname.startsWith('/api/scans/')) {
      const posting = pathname === '/api/scan' && request.method === 'POST';
      const need = missing(env, posting ? ['UPLOADS', 'JOBS'] : []);
      if (need.length) return json({ error: 'not configured', missing: need }, 503);
      try {
        if (posting) return await handleScan(request, env);
        const rest = pathname.slice('/api/scans/'.length);
        if (request.method === 'GET' && rest.endsWith('/status')) return await handleScanStatus(decodeURIComponent(rest.slice(0, -'/status'.length)), env);
        if (request.method === 'GET' && rest) return await handleGetScan(decodeURIComponent(rest), env);
        return json({ error: 'not found' }, 404);
      } catch (err) {
        console.error('scan route failed', err.message);
        // busy: a read stayed unavailable past the retry cap; the pages poll again.
        if (err instanceof DbBusy) return json({ error: 'busy' }, 503);
        return json({ error: 'scan failed' }, 502);
      }
    }

    if (pathname === '/music') return Response.redirect(new URL('/music/', url), 301);

    // /v/<id> is one static page.
    if (/^\/v\/[^/]+\/?$/.test(pathname)) {
      return env.ASSETS.fetch(new Request(new URL('/v/', url), request));
    }

    return clearance.fetch(request, env, ctx);
  },

  async queue(batch, env) {
    if (batch.queue === JOBS_DLQ) return handleDeadLetters(batch, env);
    return handleJobs(batch, env);
  },

  async scheduled(event, env, ctx) {
    if (!missing(env, ['UPLOADS']).length) {
      ctx.waitUntil(sweep(env).then((r) => console.log('ms007 sweep', JSON.stringify(r)), (err) => console.error('ms007 sweep failed', err.message)));
    }
    return clearance.scheduled(event, env, ctx);
  },
};
