// Clearance Check Worker (MS-002).
// Serves the static page (public/) and two small endpoints:
//   GET  /api/config  -> moonshots Supabase URL + anon key for the browser
//   POST /api/notify  -> send the results email once (status done, emailed_at null)
// A cron trigger runs the same send for any done row nobody has open, so the
// email still goes out if the visitor closed the tab.
//
// Supabase: the moonshots project (kucwpmtkctafzkivuqtu) ONLY. Never production.

import { sendResultEmail } from './email.js';

const MOONSHOTS_REF = 'kucwpmtkctafzkivuqtu';
const PRODUCTION_REF = 'uprfsmwbsvzuoiyfgtgx';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function serviceHeaders(env) {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

// Claim the row by setting emailed_at only where status = done and emailed_at
// is still null. Postgres applies the PATCH atomically, so concurrent callers
// (two tabs, a reload, the cron) get the row back at most once, and only that
// caller sends. If the send fails, release the claim so a later try can send.
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
  if (!env.SITE_URL) return { skipped: 'SITE_URL not set' };
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
      if (!env.SUPABASE_ANON_KEY) return json({ error: 'not configured' }, 500);
      return json({ supabaseUrl: supabaseUrl(env), anonKey: env.SUPABASE_ANON_KEY });
    }

    if (url.pathname === '/api/notify' && request.method === 'POST') {
      if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.RESEND_API_KEY) return json({ error: 'not configured' }, 500);
      let id;
      try {
        ({ id } = await request.json());
      } catch {
        return json({ error: 'bad request' }, 400);
      }
      if (typeof id !== 'string' || !UUID.test(id)) return json({ error: 'bad id' }, 400);
      try {
        return json(await notifyOnce(env, id, env.SITE_URL?.replace(/\/+$/, '') || url.origin));
      } catch (err) {
        console.error('notify failed', id, err.message);
        return json({ error: 'send failed' }, 502);
      }
    }

    if (url.pathname.startsWith('/api/')) return json({ error: 'not found' }, 404);

    // /r/<id> is one static page; result.js reads the id from the path.
    if (/^\/r\/[^/]+\/?$/.test(url.pathname)) {
      return env.ASSETS.fetch(new Request(new URL('/r/', url), request));
    }

    return env.ASSETS.fetch(request);
  },

  async scheduled(_event, env, ctx) {
    if (!env.SUPABASE_SERVICE_ROLE_KEY || !env.RESEND_API_KEY) return;
    ctx.waitUntil(sweep(env).then((r) => console.log('sweep', JSON.stringify(r))));
  },
};
