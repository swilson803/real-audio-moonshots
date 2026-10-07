// Cloudflare Worker for MS-006 "music in this video", sharing one Worker
// (and copyrighttester.real.audio) with the MS-002/MS-004 clearance check.
//
// Ours:
//   /music/              upload page (static, public/music/)
//   /v/<id>              result page (static, public/v/; result.js reads the id)
//   POST /api/scan       match a video's fingerprint (src/scan.js)
//   GET  /api/scans/<id> one found result
// Everything else, and the cron, goes to clearance-check/src/worker.js
// unchanged, so the clearance check stays live.
//
// Assets: scripts/build-assets.mjs merges clearance-check/public and
// music-in-video/public into music-in-video/dist (ASSETS).
// Supabase: the moonshots project only, service role: SUPABASE_SECRET_KEY
// (the Worker Secret already set for the clearance cron) or
// SUPABASE_SERVICE_ROLE_KEY.

import clearance from '../../clearance-check/src/worker.js';
import { handleScan, handleGetScan } from './scan.js';

const json = (body, status) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/scan' || pathname.startsWith('/api/scans/')) {
      if (!(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY)) {
        return json({ error: 'not configured', missing: ['SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY'] }, 503);
      }
      try {
        if (pathname === '/api/scan' && request.method === 'POST') return await handleScan(request, env);
        const id = pathname.slice('/api/scans/'.length);
        if (request.method === 'GET' && id) return await handleGetScan(decodeURIComponent(id), env);
        return json({ error: 'not found' }, 404);
      } catch (err) {
        console.error('scan failed', err.message);
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

  scheduled(event, env, ctx) {
    return clearance.scheduled(event, env, ctx);
  },
};
