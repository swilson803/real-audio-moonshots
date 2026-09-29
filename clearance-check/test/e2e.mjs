// E2E against the local harness (fake Supabase + fake Resend). Walks the
// MS-002 DONE WHEN lines and writes screenshots to test/screenshots/.
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { start, env, KEYS, setBucketLimit } from './harness.mjs';

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
  check('headline + lead copy (Spencer notes, verbatim)',
    (await page.$eval('h1.headline img.headline-img', (el) => el.getAttribute('alt'))) === 'Music Copyright Tester'
    && (await page.isVisible('h1.headline img.headline-img'))
    && (await page.textContent('.lead')) === 'Let us test the track first so you can avoid having your content muted or demonitized.');
  const landingWarning = await page.textContent('.landing-warning .warning');
  check('landing shows the permanent warning', await page.isVisible('.landing-warning .warning')
    && /reflects right now/.test(landingWarning) && /any rightsholder can turn on enforcement at any time/i.test(landingWarning), landingWarning);
  check('file selection is a sketched button, not a text input',
    await page.$eval('#file-pick', (el) => el.querySelector('.file-pick-label')?.textContent.trim() === 'CHOOSE FILE' && el.classList.contains('btn-primary-cta') && !el.classList.contains('input-text')));
  const rest = await page.$eval('#file-pick', (el) => getComputedStyle(el).color);
  const box = await page.locator('#file-pick').boundingBox();
  const clip = { x: box.x - 24, y: box.y - 24, width: box.width + 48, height: box.height + 48 };
  const restShot = await page.screenshot({ clip });
  await page.screenshot({ path: `${SHOTS}choose-file-rest-1280.jpg`, clip, quality: 90 });
  // Real mouse, screenshot in the same frame (no wait): must already differ.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const hoverShot = await page.screenshot({ clip });
  await page.screenshot({ path: `${SHOTS}choose-file-hover-1280.jpg`, clip, quality: 90 });
  const hov = await page.$eval('#file-pick', (el) => ({ c: getComputedStyle(el).color, t: getComputedStyle(el).transform, f: getComputedStyle(el).filter }));
  check('CHOOSE FILE red at rest, only expands on hover', rest === 'rgb(229, 90, 60)' && hov.c === rest && hov.t === 'matrix(1.04, 0, 0, 1.04, 0, 0)' && hov.f === 'none', `${rest} -> ${JSON.stringify(hov)}`);
  check('hover screenshot differs from rest (not byte-identical)', !restShot.equals(hoverShot));
  await page.mouse.move(0, 0);
  // Hovering the file input itself grows the button too.
  await page.locator('#file').hover({ force: true });
  check('hovering the file input also grows the button', (await page.$eval('#file-pick', (el) => getComputedStyle(el).transform)) === 'matrix(1.04, 0, 0, 1.04, 0, 0)');
  await page.mouse.move(0, 0);
  await page.waitForTimeout(250);
  check('line under the logo', await page.isVisible('nav .nav-line'));
  const align = await page.$$eval('#file-pick, #file-name, #file-hint', (els) => els.map((e) => { const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right), getComputedStyle(e).textAlign]; }));
  check('file subtext centred under the button', align.every(([l, r]) => l === align[0][0] && r === align[0][1]) && align.slice(1).every((a) => a[2] === 'center'), JSON.stringify(align));
  await page.setInputFiles('#file', { name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(10) });
  const typeErr = await page.textContent('#file-error');
  check('bad file type rejected inline', /isn’t supported/.test(typeErr), typeErr);
  await page.setInputFiles('#file', { name: 'song.flac', mimeType: 'audio/flac', buffer: Buffer.alloc(10) });
  check('flac rejected inline', /isn’t supported/.test(await page.textContent('#file-error')));
  // No 50 MB cap in the page (Spencer note 4). If the bucket itself refuses a
  // size (harness bucket: 50 MB, like MS-001's migration), say so inline.
  const big = new URL('./big.mp3', import.meta.url).pathname;
  await writeFile(big, Buffer.alloc(60 * 1024 * 1024));
  await page.setInputFiles('#file', big);
  check('60 MB file passes page validation', (await page.textContent('#file-error')) === '' && (await page.textContent('#file-name')) === 'big.mp3');
  check('file selected state is obvious (FILE UPLOADED + filename)',
    (await page.$eval('#file-pick .file-pick-label', (el) => el.textContent.trim())) === 'FILE UPLOADED'
    && (await page.$eval('#file-pick', (el) => el.classList.contains('has-file')))
    && (await page.textContent('#file-name')) === 'big.mp3');
  const fileNameColor = await page.$eval('#file-name', (el) => getComputedStyle(el).color);
  check('uploaded filename is brand red', fileNameColor === 'rgb(229, 90, 60)', fileNameColor);
  const displayFont = await page.$eval('#file-name', (el) => getComputedStyle(el).fontFamily);
  check('uploaded filename uses drawn display font', /Patrick Hand/i.test(displayFont), displayFont);
  const landingFonts = await page.$$eval('.lead, .field-label, .file-hint, #submit, #file-name', (els) =>
    els.map((e) => ({ t: (e.textContent || '').slice(0, 24), f: getComputedStyle(e).fontFamily })));
  check('landing UI copy uses drawn display font',
    landingFonts.every((x) => /Patrick Hand/i.test(x.f)), JSON.stringify(landingFonts));
  await page.fill('#email', 'a@b.co');
  await page.click('#submit');
  await page.waitForFunction(() => /too large/.test(document.getElementById('file-error').textContent), null, { timeout: 30000 });
  await rm(big);
  check('bucket size rejection shown inline', /too large for the checker/.test(await page.textContent('#file-error')));
  check('landing warning still visible after inline errors', await page.isVisible('.landing-warning .warning'));
  check('rejected file blocks submit', page.url() === `${ORIGIN}/` && (await state()).objects.length === 0 && (await state()).rows.length === 0);
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
  const queuedSummary = await page.textContent('#summary');
  const queuedFoot = await page.textContent('#footnote');
  check('queued status folds email note into the updates line',
    /This page updates on its own\.\s+We.ll email you when all three are in\./.test(queuedSummary)
    && (queuedFoot || '').trim() === '',
    JSON.stringify({ queuedSummary, queuedFoot }));
  // Reject9: icons same rendered height, natural aspect (YT wider than square TT/IG)
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll('.platform-icon')];
    return imgs.length === 3 && imgs.every((img) => img.complete && img.naturalWidth > 0);
  }, null, { timeout: 10000 });
  const iconGeom = await page.$$eval('.platform-icon', (els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return {
      src: el.getAttribute('src'),
      h: Math.round(r.height * 100) / 100,
      w: Math.round(r.width * 100) / 100,
      nw: el.naturalWidth,
      nh: el.naturalHeight,
    };
  }));
  const heights = iconGeom.map((g) => g.h);
  const heightMatch = heights.every((h) => Math.abs(h - heights[0]) < 0.5);
  const naturalAspect = iconGeom.every((g) => {
    const expected = g.nw / g.nh;
    const actual = g.w / g.h;
    return Math.abs(expected - actual) < 0.05;
  });
  const yt = iconGeom.find((g) => /youtube/.test(g.src));
  check('platform icons equal height with natural aspect',
    heightMatch && naturalAspect && yt && yt.w > yt.h,
    JSON.stringify(iconGeom));
  // Reject10: summary width matches warning/platform card content; names left-aligned; tighter outer gaps
  const layoutR10 = await page.evaluate(() => {
    const summary = document.getElementById('summary');
    const warning = document.querySelector('.box-sketched-light-red .warning');
    const box = document.getElementById('platforms-box');
    const plats = [...document.querySelectorAll('.platform')];
    const names = [...document.querySelectorAll('.platform-name')];
    const sr = summary.getBoundingClientRect();
    const wr = warning.getBoundingClientRect();
    const br = box.getBoundingClientRect();
    const first = plats[0].getBoundingClientRect();
    const last = plats[plats.length - 1].getBoundingClientRect();
    const midGap = plats[1].getBoundingClientRect().top - first.bottom;
    const nameLefts = names.map((n) => Math.round(n.getBoundingClientRect().left * 100) / 100);
    const cs = getComputedStyle(summary);
    const contentWidth = sr.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    return {
      summaryContentW: Math.round(contentWidth * 100) / 100,
      warningW: Math.round(wr.width * 100) / 100,
      nameLefts,
      gapAboveFirst: Math.round((first.top - br.top) * 100) / 100,
      gapBelowLast: Math.round((br.bottom - last.bottom) * 100) / 100,
      midGap: Math.round(midGap * 100) / 100,
      boxPadTop: parseFloat(getComputedStyle(box).paddingTop),
      firstPadTop: parseFloat(getComputedStyle(plats[0]).paddingTop),
      lastPadBottom: parseFloat(getComputedStyle(plats[plats.length - 1]).paddingBottom),
    };
  });
  check('summary content width matches warning text chunk',
    Math.abs(layoutR10.summaryContentW - layoutR10.warningW) <= 2,
    JSON.stringify(layoutR10));
  check('platform names share a left edge',
    layoutR10.nameLefts.every((l) => Math.abs(l - layoutR10.nameLefts[0]) <= 1),
    JSON.stringify(layoutR10.nameLefts));
  check('platforms outer gaps tightened above YT / below IG',
    layoutR10.boxPadTop <= 10
    && layoutR10.firstPadTop <= 6
    && layoutR10.lastPadBottom <= 6
    && layoutR10.gapAboveFirst < 28
    && layoutR10.gapBelowLast < 28,
    JSON.stringify(layoutR10));
  // Reject11: logo glyph centers (alpha bbox inside the artwork, as rendered) line up across rows
  const glyphCenters = await page.$$eval('.platform-icon', (els) => els.map((el) => {
    const c = document.createElement('canvas');
    c.width = el.naturalWidth; c.height = el.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.drawImage(el, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (d[(y * c.width + x) * 4 + 3] > 20) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    }
    const r = el.getBoundingClientRect();
    const row = el.closest('.platform-label').getBoundingClientRect();
    return {
      x: Math.round((r.left + ((x0 + x1) / 2 / c.width) * r.width) * 100) / 100,
      dy: Math.round((r.top + ((y0 + y1) / 2 / c.height) * r.height - (row.top + row.bottom) / 2) * 100) / 100,
    };
  }));
  check('platform logos centered/aligned with each other',
    glyphCenters.every((g) => Math.abs(g.x - glyphCenters[0].x) <= 1 && Math.abs(g.dy - glyphCenters[0].dy) <= 1),
    JSON.stringify(glyphCenters));
  const againRest = await page.$eval('#again', (el) => ({
    text: el.textContent.trim(),
    cls: el.className,
    color: getComputedStyle(el).color,
    border: getComputedStyle(el).borderImageSource,
  }));
  check('upload another track is primary CTA label',
    againRest.text === 'upload another track' && againRest.cls.includes('btn-primary-cta'),
    JSON.stringify(againRest));
  check('upload another track red at rest',
    againRest.color === 'rgb(229, 90, 60)' && /frame-button-heavy-red/.test(againRest.border),
    JSON.stringify(againRest));
  await page.locator('#again').scrollIntoViewIfNeeded();
  const againBox = await page.locator('#again').boundingBox();
  await page.mouse.move(againBox.x + againBox.width / 2, againBox.y + againBox.height / 2);
  await page.waitForFunction(() => {
    const el = document.getElementById('again');
    return el && el.matches(':hover') && getComputedStyle(el).transform === 'matrix(1.04, 0, 0, 1.04, 0, 0)';
  }, null, { timeout: 5000 });
  const againHover = await page.$eval('#again', (el) => ({
    color: getComputedStyle(el).color,
    transform: getComputedStyle(el).transform,
    filter: getComputedStyle(el).filter,
    border: getComputedStyle(el).borderImageSource,
    hover: el.matches(':hover'),
  }));
  await page.mouse.move(0, 0);
  check('upload another track stays red and only scales on hover',
    againHover.color === 'rgb(229, 90, 60)'
    && /frame-button-heavy-red/.test(againHover.border)
    && againHover.transform === 'matrix(1.04, 0, 0, 1.04, 0, 0)'
    && (againHover.filter === 'none' || againHover.filter === ''),
    JSON.stringify(againHover));
  await page.screenshot({ path: `${SHOTS}result-queued-1280.jpg`, fullPage: true, quality: 70 });

  // Poll reflects changes without reload.
  let navs = 0;
  page.on('framenavigated', () => navs++);
  await update({ id, status: 'checking', youtube_result: 'clear', youtube_note: 'no match' });
  await page.waitForFunction(() => [...document.querySelectorAll('.platform-status')][0].textContent === 'Clear', null, { timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('.platform[data-result="clear"] .platform-name');
    return el && getComputedStyle(el).color === 'rgb(229, 90, 60)';
  }, null, { timeout: 5000 });
  const mid = await page.$$eval('.platform-status', (els) => els.map((e) => e.textContent));
  check('polls and updates without reload', navs === 0 && mid[0] === 'Clear' && mid[1] === 'Checking…', mid.join(' / '));
  const checkingSummary = await page.textContent('#summary');
  check('checking status folds email note into the updates line',
    /Checking now\. This page updates on its own\.\s+We.ll email you when all three are in\./.test(checkingSummary)
    && !(await page.textContent('#footnote') || '').trim(),
    checkingSummary);
  const iconSrcs = await page.$$eval('.platform-icon', (els) => els.map((e) => e.getAttribute('src')));
  check('drawn platform icons next to labels',
    iconSrcs.join() === '/icons-runtime/platform-youtube.webp,/icons-runtime/platform-tiktok.webp,/icons-runtime/platform-instagram.webp',
    iconSrcs.join(' | '));
  const clearStyle = await page.$eval('.platform[data-result="clear"]', (el) => ({
    name: getComputedStyle(el.querySelector('.platform-name')).color,
    filter: getComputedStyle(el.querySelector('.platform-icon')).filter,
  }));
  const pendingStyle = await page.$eval('.platform[data-result="pending"]', (el) => ({
    name: getComputedStyle(el.querySelector('.platform-name')).color,
    filter: getComputedStyle(el.querySelector('.platform-icon')).filter,
  }));
  check('cleared platform name+icon brand red',
    clearStyle.name === 'rgb(229, 90, 60)'
    && /invert\(0?\.52\)|invert\(52%\)/.test(clearStyle.filter)
    && /sepia\(0?\.73\)|sepia\(73%\)/.test(clearStyle.filter)
    && /hue-rotate\(338deg\)/.test(clearStyle.filter),
    JSON.stringify(clearStyle));
  check('uncleared platform name+icon stay black',
    pendingStyle.name === 'rgb(26, 26, 26)'
    && /brightness\(0\)/.test(pendingStyle.filter) && !/invert\(52%\)/.test(pendingStyle.filter),
    JSON.stringify(pendingStyle));
  const resultFonts = await page.$$eval('.lead, .platform-name, .platform-status, .warning, .verdict, a#again', (els) =>
    els.filter(Boolean).map((e) => getComputedStyle(e).fontFamily));
  check('result UI copy uses drawn display font',
    resultFonts.length > 0 && resultFonts.every((f) => /Patrick Hand/i.test(f)), resultFonts.join(' || '));
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

  // Reject9: upload another track autofills the email just used.
  await page.waitForSelector('#again');
  // Ensure session/href carries the email from the upload that landed here.
  const againHref = await page.$eval('#again', (el) => el.getAttribute('href'));
  check('upload another track href carries email query',
    againHref === '/?email=creator%40example.com' || againHref === '/?email=' + encodeURIComponent('creator@example.com'),
    againHref);
  await Promise.all([page.waitForURL((u) => u.pathname === '/' || u.pathname === ''), page.click('#again')]);
  await page.waitForSelector('#email');
  const autofilled = await page.$eval('#email', (el) => el.value);
  check('upload another track autofills prior email', autofilled === 'creator@example.com', autofilled);
  // Return to a result page for remaining checks that reuse `page` + `id`.
  await page.goto(`${ORIGIN}/r/${id}`);
  await page.waitForSelector('#verdict-box:not([hidden])');

  // Concurrent notify on a fresh done row sends exactly one.
  const fresh = crypto.randomUUID();
  await fetch(`${ORIGIN}/mock-sb/rest/v1/submissions`, { method: 'POST', headers: { apikey: KEYS.anon }, body: JSON.stringify({ id: fresh, email: 'x@example.com', storage_path: `clearance-uploads/${fresh}/a.wav` }) });
  await update({ id: fresh, status: 'done', youtube_result: 'clear', tiktok_result: 'clear', instagram_result: 'clear' });
  await Promise.all([1, 2, 3].map(() => fetch(`${ORIGIN}/api/notify`, { method: 'POST', body: JSON.stringify({ id: fresh }) })));
  check('parallel notify sends once', (await state()).emails.filter((e) => e.to[0] === 'x@example.com').length === 1);

  // All-clear verdict copy.
  // Bucket that accepts large files (the limit raised on moonshots): 60 MB lands.
  setBucketLimit(Infinity);
  const p3 = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await p3.goto(ORIGIN);
  const big2 = new URL('./big2.wav', import.meta.url).pathname;
  await writeFile(big2, Buffer.alloc(60 * 1024 * 1024));
  await p3.setInputFiles('#file', big2);
  await p3.fill('#email', 'big@example.com');
  await Promise.all([p3.waitForURL(/\/r\/[0-9a-f-]{36}$/, { timeout: 60000 }), p3.click('#submit')]);
  await rm(big2);
  check('60 MB file uploads and lands on /r/[id] when the bucket allows it', (await state()).objects.some(([, n]) => n === 60 * 1024 * 1024));
  await p3.goto(`${ORIGIN}/r/${p3.url().split('/r/')[1] || ''}`).catch(() => {});
  check('line under the logo on the result page', await p3.isVisible('nav .nav-line'));
  await p3.close();

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

  // /api/config and /api/notify say which secret is missing (names only).
  const saved = { ...env };
  for (const k of ['SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']) delete env[k];
  const cfg = await fetch(`${ORIGIN}/api/config`);
  const cfgBody = await cfg.json();
  const nt = await fetch(`${ORIGIN}/api/notify`, { method: 'POST', body: JSON.stringify({ id }) });
  const ntBody = await nt.json();
  Object.assign(env, saved);
  check('missing secrets -> 503 naming them, no key values', cfg.status === 503 && cfgBody.missing.join() === 'SUPABASE_ANON_KEY'
    && nt.status === 503 && ntBody.missing.join() === 'SUPABASE_SERVICE_ROLE_KEY' && !JSON.stringify([cfgBody, ntBody]).includes('test'), JSON.stringify(cfgBody));
  const okCfg = await fetch(`${ORIGIN}/api/config`).then((r) => r.json());
  check(`/api/config serves ${process.env.KEY_STYLE === 'new' ? 'publishable' : 'anon'} key + moonshots-style URL`, okCfg.anonKey === KEYS.anon && okCfg.supabaseUrl === env.SUPABASE_URL);

  const external = [...hosts].filter((h) => !['localhost:8787', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(h));
  const loaded = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')); });
  // Reject8 uses Patrick Hand for UI copy; Inter/Mono stay linked for brand parity but may not
  // appear in document.fonts if unused. Require Patrick Hand; note others.
  const fontsOk = loaded.includes('Patrick Hand');
  check('Patrick Hand loaded (drawn UI font)', fontsOk, [...new Set(loaded)].join(', '));
  check('browser requests only app/Supabase(+Google Fonts)', external.length === 0, [...hosts].join(', '));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
