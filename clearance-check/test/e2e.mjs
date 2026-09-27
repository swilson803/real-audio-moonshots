// E2E against the local harness (fake Supabase + fake Resend). Walks the
// MS-002 DONE WHEN lines and writes screenshots to test/screenshots/.
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { start } from './harness.mjs';

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node22/lib/node_modules/playwright')); }

const ORIGIN = 'http://localhost:8787';
const SHOTS = new URL('../docs/screenshots/', import.meta.url).pathname;
await mkdir(SHOTS, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`); };
const state = () => fetch(`${ORIGIN}/test/state`).then((r) => r.json());
const update = (body) => fetch(`${ORIGIN}/test/update`, { method: 'POST', body: JSON.stringify(body) });
const mp3 = (bytes) => ({ name: 'my song.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(bytes, 1) });

const server = await start();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
// The sandbox browser can't reach Google Fonts directly; fetch them with curl
// (which honours the session proxy) so screenshots use the real fonts.
const exec = promisify(execFile);
const fontCache = new Map();
browser.newPage = ((orig) => async (...a) => {
  const p = await orig.apply(browser, a);
  await p.route(/fonts\.(googleapis|gstatic)\.com/, async (route) => {
    const u = route.request().url();
    if (!fontCache.has(u)) {
      const { stdout } = await exec('curl', ['-sS', '-A', 'Mozilla/5.0 Chrome/140', u], { encoding: 'buffer', maxBuffer: 1 << 24 });
      fontCache.set(u, stdout);
    }
    const type = u.includes('googleapis') ? 'text/css' : 'font/woff2';
    await route.fulfill({ status: 200, body: fontCache.get(u), headers: { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' } });
  });
  return p;
})(browser.newPage);
const hosts = new Set();

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.on('request', (r) => hosts.add(new URL(r.url()).host));

  // Bad type / size rejected inline, nothing uploaded.
  await page.goto(ORIGIN);
  await page.setInputFiles('#file', { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(10) });
  const typeErr = await page.textContent('#file-error');
  check('bad file type rejected inline', /isn’t supported/.test(typeErr), typeErr);
  await page.setInputFiles('#file', { name: 'song.flac', mimeType: 'audio/flac', buffer: Buffer.alloc(10) });
  check('flac rejected inline', /isn’t supported/.test(await page.textContent('#file-error')));
  const big = new URL('./big.mp3', import.meta.url).pathname;
  await writeFile(big, Buffer.alloc(50 * 1024 * 1024 + 1));
  await page.setInputFiles('#file', big);
  await rm(big);
  const sizeErr = await page.textContent('#file-error');
  check('over 50 MB rejected inline', /over 50 MB/.test(sizeErr), sizeErr);
  await page.fill('#email', 'a@b.co');
  await page.click('#submit');
  check('invalid file blocks submit', page.url() === `${ORIGIN}/` && (await state()).objects.length === 0);
  await page.screenshot({ path: `${SHOTS}landing-error-1280.jpg`, fullPage: true, quality: 70 });

  // Bad email rejected inline.
  await page.setInputFiles('#file', mp3(2048));
  await page.fill('#email', 'not-an-email');
  await page.click('#submit');
  check('bad email rejected inline', /valid email/.test(await page.textContent('#email-error')));

  // Upload + email creates a row and lands on /r/[id].
  await page.fill('#email', 'creator@example.com');
  await Promise.all([page.waitForURL(/\/r\/[0-9a-f-]{36}$/), page.click('#submit')]);
  const id = page.url().split('/r/')[1];
  let s = await state();
  const row = s.rows.find((r) => r.id === id);
  check('upload + email creates queued row', row?.status === 'queued' && row.email === 'creator@example.com' && row.storage_path === `clearance-uploads/${id}/my_song.mp3`);
  check('file stored in clearance-uploads', s.objects.some(([k, n]) => k === `${id}/my_song.mp3` && n === 2048));
  check('lands on /r/[id]', /\/r\/[0-9a-f-]{36}$/.test(page.url()));

  const warning = () => page.isVisible('.warning');
  await page.waitForSelector('.platform-status');
  await page.waitForFunction(() => document.querySelector('.platform-status')?.textContent === 'Queued');
  check('warning visible while queued', await warning());
  await page.screenshot({ path: `${SHOTS}result-queued-1280.jpg`, fullPage: true, quality: 70 });

  // Poll reflects changes without reload.
  let navs = 0;
  page.on('framenavigated', () => navs++);
  await update({ id, status: 'checking', youtube_result: 'clear', youtube_note: 'no match' });
  await page.waitForFunction(() => [...document.querySelectorAll('.platform-status')][0].textContent === 'Clear', null, { timeout: 10000 });
  const mid = await page.$$eval('.platform-status', (els) => els.map((e) => e.textContent));
  check('polls and updates without reload', navs === 0 && mid[0] === 'Clear' && mid[1] === 'Checking…', mid.join(' / '));
  check('no verdict before all three', !(await page.isVisible('#verdict')));
  check('warning visible while checking', await warning());
  check('no email before done', (await state()).emails.length === 0);

  // Done row: per-platform results + verdict + one email.
  await update({ id, status: 'done', tiktok_result: 'muted', tiktok_note: 'muted at 0:12', instagram_result: 'clear' });
  await page.waitForSelector('#verdict-box:not([hidden])', { timeout: 10000 });
  const done = await page.$$eval('.platform-status', (els) => els.map((e) => e.textContent));
  const verdict = await page.textContent('#verdict');
  check('done row shows per-platform results', done.join('/') === 'Clear/Muted/Clear', done.join(' / '));
  check('verdict names flagged platform', verdict === 'Heads up: TikTok muted it.', verdict);
  check('warning visible when done', await warning());
  await page.waitForTimeout(500);
  s = await state();
  check('email sent once on done', s.emails.length === 1 && s.emails[0].to[0] === 'creator@example.com', `${s.emails.length} email(s)`);
  check('email has verdict + result link', s.emails[0]?.html.includes('Heads up: TikTok muted it.') && s.emails[0]?.text.includes(`${ORIGIN}/r/${id}`));
  check('emailed_at set', Boolean(s.rows.find((r) => r.id === id).emailed_at));
  await page.screenshot({ path: `${SHOTS}result-done-flagged-1280.jpg`, fullPage: true, quality: 70 });

  // Reloads never resend; direct notify calls no-op too.
  await page.reload();
  await page.waitForSelector('#verdict-box:not([hidden])');
  await page.reload();
  await page.waitForSelector('#verdict-box:not([hidden])');
  const again = await fetch(`${ORIGIN}/api/notify`, { method: 'POST', body: JSON.stringify({ id }) }).then((r) => r.json());
  await page.waitForTimeout(500);
  check('no resend on reload / repeat notify', (await state()).emails.length === 1 && again.sent === false);

  // Concurrent notify on a fresh done row sends exactly one.
  const fresh = crypto.randomUUID();
  await fetch(`${ORIGIN}/mock-sb/rest/v1/submissions`, { method: 'POST', headers: { Authorization: 'Bearer anon-test' }, body: JSON.stringify({ id: fresh, email: 'x@example.com', storage_path: `clearance-uploads/${fresh}/a.wav` }) });
  await update({ id: fresh, status: 'done', youtube_result: 'clear', tiktok_result: 'clear', instagram_result: 'clear' });
  await Promise.all([1, 2, 3].map(() => fetch(`${ORIGIN}/api/notify`, { method: 'POST', body: JSON.stringify({ id: fresh }) })));
  check('parallel notify sends once', (await state()).emails.filter((e) => e.to[0] === 'x@example.com').length === 1);

  // All-clear verdict copy.
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  p2.on('request', (r) => hosts.add(new URL(r.url()).host));
  await p2.goto(`${ORIGIN}/r/${fresh}`);
  await p2.waitForSelector('#verdict-box:not([hidden])');
  check('all-clear verdict', (await p2.textContent('#verdict')) === 'Looks clear on all three.');
  await p2.screenshot({ path: `${SHOTS}result-done-clear-1280.jpg`, fullPage: true, quality: 70 });

  // Breakpoints: no sideways scroll, warning + CTA visible.
  for (const w of [375, 768, 1280]) {
    const p = await browser.newPage({ viewport: { width: w, height: 900 } });
    p.on('request', (r) => hosts.add(new URL(r.url()).host));
    await p.goto(ORIGIN);
    await p.waitForLoadState('networkidle');
    const o1 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await p.screenshot({ path: `${SHOTS}landing-${w}.jpg`, fullPage: true, quality: 70 });
    await p.goto(`${ORIGIN}/r/${id}`);
    await p.waitForSelector('#verdict-box:not([hidden])');
    await p.waitForLoadState('networkidle');
    const o2 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await p.screenshot({ path: `${SHOTS}result-${w}.jpg`, fullPage: true, quality: 70 });
    check(`no horizontal overflow at ${w}`, o1 <= 0 && o2 <= 0, `landing ${o1}, result ${o2}`);
    await p.close();
  }

  const external = [...hosts].filter((h) => !['localhost:8787', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(h));
  const loaded = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')); });
  const fontsOk = ['Patrick Hand', 'Inter', 'Sometype Mono'].every((f) => loaded.includes(f));
  check('Patrick Hand + Inter + Sometype Mono loaded', fontsOk, [...new Set(loaded)].join(', '));
  check('browser requests only app/Supabase(+Google Fonts)', external.length === 0, [...hosts].join(', '));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
