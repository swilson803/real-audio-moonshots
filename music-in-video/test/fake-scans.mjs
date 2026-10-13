// The ms006_scans table behind PostgREST, in memory, for the fakes (unit
// tests and test/fake-moonshots.mjs): POST (insert; 409 on a duplicate id),
// GET (select) and PATCH (update) with the filters src/moonshots.js uses:
// col=eq.X, col=neq.X, col=in.(a,b), col=is.true|false|null, col=lt.X.
// Column defaults follow both migrations (MS-007 adds status 'done', attempts
// 0, updated_at now()).
const reply = (body, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function matches(row, params) {
  for (const [col, cond] of params) {
    if (['select', 'order', 'limit'].includes(col)) continue;
    const dot = cond.indexOf('.');
    const op = cond.slice(0, dot);
    const arg = cond.slice(dot + 1);
    const v = row[col];
    if (op === 'eq' && String(v) !== arg) return false;
    if (op === 'neq' && String(v) === arg) return false;
    if (op === 'in' && !arg.replace(/^\(|\)$/g, '').split(',').includes(String(v))) return false;
    if (op === 'is' && v !== { true: true, false: false, null: null }[arg]) return false;
    if (op === 'lt' && !(String(v) < arg)) return false;
  }
  return true;
}

export function scansTable({ now = () => new Date().toISOString() } = {}) {
  const rows = new Map();
  const log = [];
  return {
    rows,
    log,
    // -> a Response, or null if the path isn't ms006_scans.
    handle(url, method, body) {
      if (url.pathname !== '/rest/v1/ms006_scans') return null;
      const params = [...url.searchParams];
      log.push(`${method} ${url.search}`);
      if (method === 'POST') {
        if (rows.has(body.id)) return reply({ code: '23505', message: 'duplicate key' }, 409);
        rows.set(body.id, { status: 'done', attempts: 0, error: null, created_at: now(), updated_at: now(), ...body });
        return reply(null, 201);
      }
      const hit = [...rows.values()].filter((r) => matches(r, params));
      if (method === 'PATCH') {
        for (const r of hit) Object.assign(r, body);
        return reply(null, 204);
      }
      const select = url.searchParams.get('select');
      const cols = select ? select.split(',') : null;
      return reply(hit.map((r) => (cols ? Object.fromEntries(cols.map((c) => [c, r[c] ?? null])) : r)));
    },
  };
}
