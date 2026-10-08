// The two Supabase projects the MS-006 scripts touch, each behind a guard.
//
// Production (uprfsmwbsvzuoiyfgtgx) is READ ONLY: GET or HEAD, the public anon
// key the shipped apps already use (never a service key), and only the
// catalog REST tables and the public Tracks bucket. Anything else throws
// before a request leaves the machine.
// Moonshots (kucwpmtkctafzkivuqtu) takes the writes, with its service key;
// a production URL or key there throws.

const PROD_REF = 'uprfsmwbsvzuoiyfgtgx';
export const PROD_URL = `https://${PROD_REF}.supabase.co`;
const MOONSHOTS_REF = 'kucwpmtkctafzkivuqtu';
export const PROD_TRACKS_PREFIX = `${PROD_URL}/storage/v1/object/public/Tracks/`;
const PROD_REST_TABLES = ['Tracks', 'Albums', 'Artists'];

// Claims of a legacy JWT key, or null (sb_ keys aren't JWTs).
function jwtClaims(key) {
  try {
    const b64 = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

export function assertProdAnonKey(key) {
  if (!key) throw new Error('PROD_SUPABASE_ANON_KEY is not set');
  if (key.startsWith('sb_secret_')) throw new Error('Refusing a production secret key: anon / publishable only');
  if (key.startsWith('sb_publishable_')) return key;
  const c = jwtClaims(key);
  if (!c || c.ref !== PROD_REF || c.role !== 'anon') throw new Error('PROD_SUPABASE_ANON_KEY must be the production anon key (role anon)');
  return key;
}

// fetch for production: read-only, catalog paths only.
export function prodReader(anonKey, fetchImpl = fetch) {
  const key = assertProdAnonKey(anonKey);
  const headers = key.startsWith('eyJ') ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key };
  return async (url, { method = 'GET' } = {}) => {
    if (method !== 'GET' && method !== 'HEAD') throw new Error(`Refusing ${method} to production: read only`);
    const u = new URL(url);
    if (u.origin !== PROD_URL) throw new Error(`prodReader only reads ${PROD_URL}`);
    const table = u.pathname.match(/^\/rest\/v1\/([^/]+)$/)?.[1];
    const isCatalogRest = table && PROD_REST_TABLES.includes(table);
    const isTrackAudio = url.startsWith(PROD_TRACKS_PREFIX);
    if (!isCatalogRest && !isTrackAudio) throw new Error(`Refusing production path ${u.pathname}`);
    // Audio is a public object: no key needed, and none is sent.
    const res = await fetchImpl(url, { method, headers: isTrackAudio ? {} : headers });
    if (!res.ok) throw new Error(`production ${method} ${u.pathname} ${res.status}`);
    return res;
  };
}

// Keyless reader for production catalog AUDIO only: GET or HEAD of a public
// object under PROD_TRACKS_PREFIX, no key or auth header of any kind. The
// URL is normalised first, so ../ tricks can't climb out of the bucket. Used
// for audio whenever the track list comes from a file (no REST at all).
export function prodAudioReader(fetchImpl = fetch) {
  return async (url, { method = 'GET', signal } = {}) => {
    if (method !== 'GET' && method !== 'HEAD') throw new Error(`Refusing ${method} to production: read only`);
    let href;
    try {
      href = new URL(url).href;
    } catch {
      throw new Error(`Refusing production URL ${url}: not a URL`);
    }
    if (!href.startsWith(PROD_TRACKS_PREFIX)) throw new Error(`Refusing production URL ${url}: not under the public Tracks bucket`);
    return fetchImpl(href, { method, signal });
  };
}

// Active, non-SFX catalog tracks with their artist, paged like
// real-audio-creator scripts/catalog.mjs.
export async function fetchActiveTracks(read) {
  const PAGE = 1000;
  const rows = [];
  for (let offset = 0; ; offset += PAGE) {
    const res = await read(
      `${PROD_URL}/rest/v1/Tracks?select=track_id,name,track_ref,duration_seconds,Albums!inner(Artists!inner(name,status))` +
        `&status=eq.active&sfx_category=is.null&Albums.Artists.status=eq.active&order=track_id&limit=${PAGE}&offset=${offset}`,
    );
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows
    .filter((r) => typeof r.track_ref === 'string' && r.track_ref.startsWith(PROD_TRACKS_PREFIX))
    .map((r) => ({
      track_id: r.track_id,
      title: r.name,
      artist: r.Albums.Artists.name,
      stream_url: r.track_ref,
      duration_s: r.duration_seconds ?? null,
    }));
}

// Moonshots REST with the service key; refuses production.
// retries: extra attempts after a network error, 5xx or 429, with
// exponential backoff (sleep is injectable for tests).
export function moonshotsWriter(url, serviceKey, fetchImpl = fetch, { retries = 3, backoffMs = 1000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (!url || !serviceKey) throw new Error('MOONSHOTS_SUPABASE_URL and MOONSHOTS_SERVICE_ROLE_KEY must be set');
  if (url.includes(PROD_REF)) throw new Error('Refusing to write to Real Audio production');
  if (!url.includes(MOONSHOTS_REF)) throw new Error(`MOONSHOTS_SUPABASE_URL must be the moonshots project (${MOONSHOTS_REF})`);
  const c = jwtClaims(serviceKey);
  if (c && c.ref !== MOONSHOTS_REF) throw new Error('MOONSHOTS_SERVICE_ROLE_KEY is for another project');
  const base = url.replace(/\/+$/, '');
  const headers = serviceKey.startsWith('eyJ')
    ? { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` }
    : { apikey: serviceKey };
  return async (path, { method = 'GET', body, prefer } = {}) => {
    const label = `moonshots ${method} ${path.split('?')[0]}`;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetchImpl(`${base}/rest/v1/${path}`, {
          method,
          headers: { ...headers, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (attempt < retries) { await sleep(backoffMs * 2 ** attempt); continue; }
        throw new Error(`${label}: ${err.message}`);
      }
      if (res.ok) return res.status === 204 || res.status === 201 ? null : res.json();
      const text = await res.text();
      if ((res.status >= 500 || res.status === 429) && attempt < retries) { await sleep(backoffMs * 2 ** attempt); continue; }
      throw new Error(`${label} ${res.status}: ${text}`);
    }
  };
}
