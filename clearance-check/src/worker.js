// Clearance Check Worker (MS-002, MS-004).
// Serves the static page (public/) and one endpoint:
//   GET  /api/config  -> moonshots Supabase URL + anon key for the browser
// A 1-minute cron sends the results email once for every row whose status is
// done and emailed_at is null, then leaves emailed_at set. It doesn't matter
// who set the row to done (usually the Catalogue Bot with the service role),
// and no page has to be open. The browser never triggers a send.
//
// Supabase: the moonshots project (kucwpmtkctafzkivuqtu) ONLY. Never production.

import { sendResultEmail } from './email.js';
import { supabaseHeaders } from '../public/lib.js';

const MOONSHOTS_REF = 'kucwpmtkctafzkivuqtu';
const PRODUCTION_REF = 'uprfsmwbsvzuoiyfgtgx';

// Project ref inside a legacy JWT key (null for sb_ keys or garbage).
function jwtRef(key) {
  try {
    const b64 = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))).ref || null;
  } catch {
    return null;
  }
}

function supabaseUrl(env) {
  const url = (env.SUPABASE_URL || `https://${MOONSHOTS_REF}.supabase.co`).replace(/\/+$/, '');
  if (url.includes(PRODUCTION_REF)) throw new Error('Refusing to talk to Real Audio production Supabase');
  return url;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Worker secrets. Either Supabase key style works: legacy anon / service_role
// JWTs, or the newer publishable / secret keys under their own names.
// SUPABASE_ANON_KEY is committed as a public var in wrangler.jsonc.
const anonKey = (env) => {
  const key = env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY;
  if (key && jwtRef(key) && jwtRef(key) !== MOONSHOTS_REF) throw new Error('Refusing a Supabase key for another project');
  return key;
};
const serviceKey = (env) => env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SECRET_KEY;

// Names (never values) of the secrets a route still needs, for a clear 503.
function missing(env, needs) {
  const out = [];
  if (needs.includes('anon') && !anonKey(env)) out.push('SUPABASE_ANON_KEY');
  if (needs.includes('service') && !serviceKey(env)) out.push('SUPABASE_SERVICE_ROLE_KEY');
  if (needs.includes('resend') && !env.RESEND_API_KEY) out.push('RESEND_API_KEY');
  return out;
}

function serviceHeaders(env) {
  return { ...supabaseHeaders(serviceKey(env)), 'Content-Type': 'application/json' };
}

// Claim the row by setting emailed_at only where status = done and emailed_at
// is still null. Postgres applies the PATCH atomically, so overlapping sweeps
// get the row back at most once, and only that caller sends. If the send fails, release the claim so a later try can send.
export async function notifyOnce(env, id, siteUrl) {
  const base = supabaseUrl(env);
  const stamp = new Date().toISOString();
  const claim = await fetch(
    `${base}/rest/v1/submissions?id=eq.${id}&status=eq.done&emailed_at=is.null`,
    {
      method: 'PATCH',
      headers: { ...serviceHeaders(env), Prefer: 'return=representation' },
      body: JSON.stringify({ emailed_at: stamp }),
    },
  );
  if (!claim.ok) throw new Error(`claim ${claim.status}: ${await claim.text()}`);
  const [row] = await claim.json();
  if (!row) return { sent: false, reason: 'not done or already emailed' };

  try {
    await sendResultEmail(env, row, `${siteUrl}/r/${row.id}`);
    return { sent: true };
  } catch (err) {
    await fetch(`${base}/rest/v1/submissions?id=eq.${id}&emailed_at=eq.${encodeURIComponent(stamp)}`, {
      method: 'PATCH',
      headers: { ...serviceHeaders(env), Prefer: 'return=minimal' },
      body: JSON.stringify({ emailed_at: null }),
    });
    throw err;
  }
}

export async function sweep(env) {
  if (!env.SITE_URL) {
    console.warn('sweep skipped: SITE_URL is not set, so result links cannot be built');
    return { skipped: 'SITE_URL not set' };
  }
  const base = supabaseUrl(env);
  const res = await fetch(
    `${base}/rest/v1/submissions?status=eq.done&emailed_at=is.null&select=id&order=created_at.asc&limit=25`,
    { headers: serviceHeaders(env) },
  );
  if (!res.ok) throw new Error(`sweep ${res.status}`);
  const ids = (await res.json()).map((r) => r.id);
  let sent = 0;
  for (const id of ids) {
    try {
      if ((await notifyOnce(env, id, env.SITE_URL.replace(/\/+$/, ''))).sent) sent++;
    } catch (err) {
      console.error('sweep send failed', id, err.message);
    }
  }
  return { checked: ids.length, sent };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/config' && request.method === 'GET') {
      const need = missing(env, ['anon']);
      if (need.length) return json({ error: 'not configured', missing: need }, 503);
      return json({ supabaseUrl: supabaseUrl(env), anonKey: anonKey(env) });
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);

    // /r/<id> is one static page; result.js reads the id from the path.
    if (/^\/r\/[^/]+\/?$/.test(url.pathname)) {
      return env.ASSETS.fetch(new Request(new URL('/r/', url), request));
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    const need = missing(env, ['service', 'resend']);
    if (need.length) {
      console.warn(`sweep skipped: missing ${need.join(', ')}`);
      return;
    }
    ctx.waitUntil(sweep(env).then((r) => console.log('sweep', JSON.stringify(r))));
  },
};
