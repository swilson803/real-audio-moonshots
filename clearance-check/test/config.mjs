// /api/config: serves the committed public moonshots anon key from wrangler.jsonc
// vars with no Cloudflare secret; refuses a JWT for any other project.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../src/worker.js';

const URL_ = 'https://kucwpmtkctafzkivuqtu.supabase.co';
for (const f of ['../wrangler.jsonc', '../../wrangler.jsonc']) {
  const cfg = readFileSync(new URL(f, import.meta.url), 'utf8');
  const keys = [...cfg.matchAll(/"SUPABASE_ANON_KEY": "([^"]+)"/g)].map((m) => m[1]);
  const urls = [...cfg.matchAll(/"SUPABASE_URL": "([^"]+)"/g)].map((m) => m[1]);
  assert.equal(keys.length, 2, `${f}: anon key in vars and previews.vars`);
  assert.equal(new Set(keys).size, 1, `${f}: vars and previews.vars match`);
  assert.deepEqual(urls, [URL_, URL_], `${f}: moonshots URL in vars and previews.vars`);
  const p = JSON.parse(Buffer.from(keys[0].split('.')[1], 'base64url').toString());
  assert.equal(p.ref, 'kucwpmtkctafzkivuqtu');
  assert.equal(p.role, 'anon');
  // No secret values: no sb_secret_/Resend keys, and every committed JWT is anon.
  const values = [...cfg.matchAll(/"[^"]*": "([^"]*)"/g)].map((m) => m[1]);
  assert.ok(!values.some((v) => /^sb_secret_|^re_/.test(v)), `${f}: no secret key values`);
  for (const v of values.filter((x) => x.startsWith('eyJ'))) {
    assert.equal(JSON.parse(Buffer.from(v.split('.')[1], 'base64url').toString()).role, 'anon', `${f}: only anon JWTs`);
  }

  const r = await worker.fetch(new Request('https://x/api/config'), { SUPABASE_URL: urls[0], SUPABASE_ANON_KEY: keys[0] });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { supabaseUrl: URL_, anonKey: keys[0] });
}

const fake = (ref) => `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ ref, role: 'anon' })).toString('base64url')}.sig`;
await assert.rejects(() => worker.fetch(new Request('https://x/api/config'), { SUPABASE_ANON_KEY: fake('uprfsmwbsvzuoiyfgtgx') }), /another project/);
assert.equal((await worker.fetch(new Request('https://x/api/config'), {})).status, 503);
console.log('config: ALL PASS');
