// E2E against the local harness (fake Supabase + fake Resend). Walks the
// MS-002 and MS-004 DONE WHEN lines and writes screenshots to docs/screenshots/.
import { createRequire } from 'node:module';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { start, env, KEYS, setBucketLimit, runCron, failResend } from './harness.mjs';

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
  watchNotify(p);
  return p;
})(browser.newPage);
const hosts = new Set();
// MS-004: the browser must never ask the Worker to send.
const notifyCalls = [];
const watchNotify = (p) => p.on('request', (r) => { if (new URL(r.url()).pathname === '/api/notify') notifyCalls.push(r.url()); });
const SITE = env.SITE_URL;
const insertRow = async (email, extra = {}) => {
  const rid = crypto.randomUUID();
  await fetch(`${ORIGIN}/mock-sb/rest/v1/submissions`, { method: 'POST', headers: { apikey: KEYS.anon }, body: JSON.stringify({ id: rid, email, storage_path: `clearance-uploads/${rid}/a.wav` }) });
  if (Object.keys(extra).length) await update({ id: rid, ...extra });
  return rid;
};
const ALL_CLEAR = { youtube_result: 'clear', tiktok_result: 'clear', instagram_result: 'clear' };
const emailsTo = async (to) => (await state()).emails.filter((e) => e.to[0] === to);
const rowOf = async (rid) => (await state()).rows.find((r) => r.id === rid);

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
  // Reject9: icons natural aspect (YT wider than square TT/IG); YT/IG equal height
  // Reject12: TikTok ~10% taller than YT/IG
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
  const naturalAspect = iconGeom.every((g) => {
    const expected = g.nw / g.nh;
    const actual = g.w / g.h;
    return Math.abs(expected - actual) < 0.05;
  });
  const yt = iconGeom.find((g) => /youtube/.test(g.src));
  const tt = iconGeom.find((g) => /tiktok/.test(g.src));
  const ig = iconGeom.find((g) => /instagram/.test(g.src));
  check('YT/IG icons equal height with natural aspect',
    yt && ig && Math.abs(yt.h - ig.h) < 0.5 && naturalAspect && yt.w > yt.h,
    JSON.stringify(iconGeom));
  check('TikTok icon ~10% taller than YT/IG',
    tt && yt && Math.abs(tt.h / yt.h - 1.1) < 0.02,
    JSON.stringify({ tt: tt && tt.h, yt: yt && yt.h, ratio: tt && yt && tt.h / yt.h }));
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
  await page.waitForFunction(() => document.querySelector('.platform-status img.stamp')?.alt === 'Clear', null, { timeout: 10000 });
  await page.waitForFunction(() => {
    const el = document.querySelector('.platform[data-result="clear"] .platform-name');
    return el && getComputedStyle(el).color === 'rgb(229, 90, 60)';
  }, null, { timeout: 5000 });
  // Reject3: a stamped status reads as its alt text.
  const mid = await page.$$eval('.platform-status', (els) => els.map((e) => e.querySelector('img.stamp')?.alt ?? e.textContent));
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
  const resultFonts = await page.$$eval('.lead, .platform-name, .platform-status, .warning, h1.headline, a#again', (els) =>
    els.filter(Boolean).map((e) => getComputedStyle(e).fontFamily));
  check('result UI copy uses drawn display font',
    resultFonts.length > 0 && resultFonts.every((f) => /Patrick Hand/i.test(f)), resultFonts.join(' || '));
  check('no verdict before all three', !(await page.$eval('#verdict', (el) => 'flagged' in el.dataset))
    && (await page.textContent('#verdict')) === 'Checking…', await page.textContent('#verdict'));
  check('warning visible while checking', await warning());
  check('no email before done', (await state()).emails.length === 0);
  // MS-004: a row that isn't done sends nothing, however often the cron runs.
  await runCron();
  await runCron();
  check('cron sends nothing for a checking row', (await state()).emails.length === 0 && (await rowOf(id)).emailed_at === null);

  // Done row: per-platform results + verdict on the page. The page itself
  // never sends; only the cron does.
  await update({ id, status: 'done', tiktok_result: 'muted', tiktok_note: 'muted at 0:12', instagram_result: 'clear' });
  await page.waitForSelector('#verdict[data-flagged]', { timeout: 10000 });
  const done = await page.$$eval('.platform-status', (els) => els.map((e) => e.querySelector('img.stamp')?.alt ?? e.textContent));
  const verdict = await page.$eval('#verdict', (el) => el.querySelector('img.stamp')?.alt ?? el.textContent);
  check('done row shows per-platform results', done.join('/') === 'Clear/Muted/Clear', done.join(' / '));
  check('flagged result reads FAILED', verdict === 'FAILED', verdict);
  // MS-004 Reject1 (Spencer): headline, track name, no verdict box, red italic email note, bigger CTA.
  const r1 = await page.evaluate(() => {
    const cs = (el) => getComputedStyle(el);
    const label = document.querySelector('h1.headline .headline-label');
    const v = document.getElementById('verdict');
    const track = document.querySelector('#summary .track-name');
    const foot = document.getElementById('footnote');
    const again = document.getElementById('again');
    return {
      h1: document.querySelector('h1.headline').textContent.trim(),
      labelColor: cs(label).color, labelSize: cs(label).fontSize, labelFont: cs(label).fontFamily,
      verdictColor: cs(v).color, verdictSize: cs(v).fontSize,
      track: track?.textContent, trackColor: track && cs(track).color,
      box: Boolean(document.getElementById('verdict-box') || document.querySelector('.box-sketched-heavy')),
      foot: foot.textContent, footColor: cs(foot).color, footStyle: cs(foot).fontStyle,
      againSize: cs(again).fontSize,
    };
  });
  const h1Lines = await page.$eval('h1.headline', (el) => Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)));
  check('headline on one line: black "Your result:" then red FAILED, same size, drawn font',
    h1Lines === 1 && r1.h1 === 'Your result:' && r1.labelColor === 'rgb(26, 26, 26)' && r1.verdictColor === 'rgb(229, 90, 60)'
    && r1.labelSize === r1.verdictSize && /Patrick Hand/.test(r1.labelFont), JSON.stringify(r1));
  // Reject3: Spencer's stamps replace PASSED/FAILED text in the headline and per platform.
  await page.waitForFunction(() => [...document.querySelectorAll('img.stamp')].every((i) => i.complete && i.naturalWidth > 0));
  const stamps = await page.evaluate(() => {
    const h = document.querySelector('#verdict img.stamp');
    const label = document.querySelector('h1.headline .headline-label').getBoundingClientRect();
    const hr = h?.getBoundingClientRect();
    return {
      headline: h && { src: h.getAttribute('src'), alt: h.alt, h: hr.height, font: parseFloat(getComputedStyle(h.parentElement).fontSize), sameLine: hr.top < label.bottom && hr.bottom > label.top },
      rows: [...document.querySelectorAll('.platform-status')].map((e) => { const i = e.querySelector('img.stamp'); return i ? `${i.getAttribute('src').split('/').pop()}:${i.alt}:${Math.round(i.getBoundingClientRect().height)}` : `text:${e.textContent}`; }),
    };
  });
  check('headline stamp FAILED replaces text, same line as "Your result:"',
    stamps.headline?.src === '/brand-assets/stamps/failed.webp' && stamps.headline.alt === 'FAILED' && stamps.headline.sameLine
    && Math.abs(stamps.headline.h - stamps.headline.font * 1.3) < 2, JSON.stringify(stamps.headline));
  check('platform rows: PASSED stamp for Clear, FAILED stamp for Muted',
    stamps.rows.join() === 'passed.webp:Clear:32,failed.webp:Muted:32,passed.webp:Clear:32', stamps.rows.join(' | '));
  check('track name in brand red', r1.track === 'my song.mp3' && r1.trackColor === 'rgb(229, 90, 60)', JSON.stringify(r1));
  check('button-looking verdict box removed', !r1.box);
  check('"A copy is on its way to your email." brand red + italic',
    r1.foot === 'A copy is on its way to your email.' && r1.footColor === 'rgb(229, 90, 60)' && r1.footStyle === 'italic', JSON.stringify(r1));
  check('upload another track slightly bigger (20px, base CTA 16px)', r1.againSize === '20px', r1.againSize);
  check('warning visible when done', await warning());
  await page.waitForTimeout(500);
  check('open result page on a done row sends nothing by itself', (await state()).emails.length === 0 && notifyCalls.length === 0);
  await page.screenshot({ path: `${SHOTS}result-done-flagged-1280.jpg`, fullPage: true, quality: 70 });

  // MS-004: with no page open, the cron sends exactly one email.
  await page.goto('about:blank');
  await runCron();
  s = await state();
  const mail = s.emails[0];
  check('cron sends exactly one email for the done row (no page open)', s.emails.length === 1 && mail.to.length === 1 && mail.to[0] === 'creator@example.com', `${s.emails.length} email(s)`);
  check('email has the three platform results',
    ['YouTube', 'TikTok', 'Instagram'].every((n) => mail.html.includes(n) && mail.text.includes(n))
    && mail.text.includes('YouTube: Clear (no match)') && mail.text.includes('TikTok: Muted (muted at 0:12)') && mail.text.includes('Instagram: Clear')
    && mail.html.includes('Muted') && mail.html.includes('muted at 0:12'), mail.text);
  check('email has verdict + result link from SITE_URL',
    mail.html.includes('Your result: <span style="color:#E55A3C;">FAILED</span>') && mail.text.includes('Your result: FAILED') && mail.html.includes(`href="${SITE}/r/${id}"`) && mail.text.includes(`${SITE}/r/${id}`));
  check('email sends with Idempotency-Key', mail.idempotencyKey === `clearance-result:${id}`, mail.idempotencyKey);
  check('emailed_at set', Boolean((await rowOf(id)).emailed_at));
  const stamp = (await rowOf(id)).emailed_at;

  // Done again, more cron runs, reloads: nothing more.
  await update({ id, status: 'checking' });
  await update({ id, status: 'done' });
  await runCron();
  await runCron();
  await page.goto(`${ORIGIN}/r/${id}`);
  await page.waitForSelector('#verdict[data-flagged]');
  await page.reload();
  await page.waitForSelector('#verdict[data-flagged]');
  await page.reload();
  await page.waitForSelector('#verdict[data-flagged]');
  await page.waitForTimeout(500);
  await runCron();
  check('done again / reloads / more cron runs send nothing more',
    (await state()).emails.length === 1 && notifyCalls.length === 0 && (await rowOf(id)).emailed_at === stamp);
  const nt = await fetch(`${ORIGIN}/api/notify`, { method: 'POST', body: JSON.stringify({ id }) });
  check('/api/notify endpoint is gone', nt.status === 404);

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
  await page.waitForSelector('#verdict[data-flagged]');

  // Overlapping cron runs on a fresh done row send exactly one.
  const fresh = await insertRow('x@example.com', { status: 'done', ...ALL_CLEAR });
  await Promise.all([runCron(), runCron(), runCron()]);
  check('overlapping cron runs send once', (await emailsTo('x@example.com')).length === 1);

  // Rows that aren't done never send, even with every result filled in.
  const notDone = [];
  for (const st of ['queued', 'checking', 'failed']) notDone.push(await insertRow(`${st}@example.com`, st === 'queued' ? {} : { status: st, ...ALL_CLEAR }));
  await runCron();
  await runCron();
  const nd = await state();
  check('queued / checking / failed rows send nothing',
    nd.emails.filter((e) => /^(queued|checking|failed)@/.test(e.to[0])).length === 0
    && notDone.every((rid) => nd.rows.find((r) => r.id === rid).emailed_at === null));

  // A failed Resend send releases the claim; the next run sends exactly one.
  const flaky = await insertRow('flaky@example.com', { status: 'done', ...ALL_CLEAR });
  failResend(1);
  await runCron();
  const afterFail = (await rowOf(flaky)).emailed_at;
  await runCron();
  await runCron();
  check('Resend failure releases the claim, retry sends once',
    afterFail === null && (await emailsTo('flaky@example.com')).length === 1 && Boolean((await rowOf(flaky)).emailed_at));

  // Missing SITE_URL or secrets: cron skips cleanly (no send, no crash), then sends once configured.
  const later = await insertRow('later@example.com', { status: 'done', ...ALL_CLEAR });
  let crashed = false;
  for (const drop of ['SITE_URL', 'RESEND_API_KEY', KEYS.service.startsWith('eyJ') ? 'SUPABASE_SERVICE_ROLE_KEY' : 'SUPABASE_SECRET_KEY']) {
    const partial = { ...env };
    delete partial[drop];
    await runCron(partial).catch(() => { crashed = true; });
  }
  const skipped = (await emailsTo('later@example.com')).length === 0 && (await rowOf(later)).emailed_at === null;
  await runCron();
  check('missing SITE_URL / secrets: no send, no crash; sends once configured',
    !crashed && skipped && (await emailsTo('later@example.com')).length === 1);

  // The email reads as Real Audio: result-page colour + type in the license email's structure.
  const flaggedMail = mail;
  const clearMail = (await emailsTo('x@example.com'))[0];
  const markers = [
    ['cream ground', /background:#FFF8E0/],
    ['brand red', /#E55A3C/],
    ['ink', /#1A1A1A/],
    ['Patrick Hand with mono fallback', /'Patrick Hand',Menlo,Consolas/],
    ['boxed REAL AUDIO wordmark', /border:2px solid #1A1A1A;[^"]*">REAL&nbsp;AUDIO</],
    ['2px ink rules', /height:2px;background:#1A1A1A;/],
    ['black "Your result:" + red verdict, same line', /color:#1A1A1A;">Your result: <span style="color:#E55A3C;">/],
    ['track name in red', /Results for <span style="color:#E55A3C;">/],
    ['table-wrapped red button', /bgcolor="#E55A3C" style="border:2px solid #1A1A1A;"/],
    ['warning in a red box', /border:2px solid #E55A3C;[^"]*">This reflects right now/],
    ['hidden preview line', /display:none;overflow:hidden/],
  ];
  const missingMarkers = markers.filter(([, re]) => !re.test(flaggedMail.html)).map(([n]) => n);
  check('email markup: cream / red / ink / Patrick Hand, license-email structure', missingMarkers.length === 0, missingMarkers.join(', '));
  check('email has no images (no logo or platform icons)', !/<img/i.test(flaggedMail.html) && !/<img/i.test(clearMail.html));
  check('email headline: red FAILED when flagged, red PASSED when clear',
    /color:#E55A3C;">FAILED</.test(flaggedMail.html) && /color:#E55A3C;">PASSED</.test(clearMail.html));
  check('email: every "Clear" red, no verdict box',
    [...clearMail.html.matchAll(/color:([^;"]+);?">Clear</g)].every((m) => m[1] === '#E55A3C')
    && [...clearMail.html.matchAll(/>Clear</g)].length === 3 && !/border:3px/.test(clearMail.html));
  const shots = [['email-flagged-600', flaggedMail, 600], ['email-clear-600', clearMail, 600], ['email-375', flaggedMail, 375]];
  let emailOverflow = [];
  for (const [n, m, w] of shots) {
    const ep = await browser.newPage({ viewport: { width: w, height: 900 } });
    await ep.setContent(m.html, { waitUntil: 'networkidle' });
    await ep.evaluate(() => document.fonts.ready);
    const o = await ep.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (o > 0) emailOverflow.push(`${n}: ${o}`);
    await ep.screenshot({ path: `${SHOTS}${n}.jpg`, fullPage: true, quality: 80 });
    await ep.close();
  }
  check('email renders without sideways scroll at 600 and 375', emailOverflow.length === 0, emailOverflow.join(', '));

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
  await p2.waitForSelector('#verdict[data-flagged]');
  const clearHead = await p2.$eval('#verdict img.stamp', (i) => `${i.getAttribute('src')}:${i.alt}`);
  check('all-clear headline shows the PASSED stamp', clearHead === '/brand-assets/stamps/passed.webp:PASSED', clearHead);
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
    await p.waitForSelector('#verdict[data-flagged]');
    await p.waitForLoadState('networkidle');
    const o2 = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    await p.screenshot({ path: `${SHOTS}result-${w}.jpg`, fullPage: true, quality: 70 });
    check(`no horizontal overflow at ${w}`, o1 <= 0 && o2 <= 0, `landing ${o1}, result ${o2}`);
    await p.close();
  }

  // /api/config says which secret is missing (names only).
  const saved = { ...env };
  for (const k of ['SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY']) delete env[k];
  const cfg = await fetch(`${ORIGIN}/api/config`);
  const cfgBody = await cfg.json();
  Object.assign(env, saved);
  check('missing secrets -> 503 naming them, no key values', cfg.status === 503 && cfgBody.missing.join() === 'SUPABASE_ANON_KEY'
    && !JSON.stringify(cfgBody).includes('test'), JSON.stringify(cfgBody));
  const okCfg = await fetch(`${ORIGIN}/api/config`).then((r) => r.json());
  check(`/api/config serves ${process.env.KEY_STYLE === 'new' ? 'publishable' : 'anon'} key + moonshots-style URL`, okCfg.anonKey === KEYS.anon && okCfg.supabaseUrl === env.SUPABASE_URL);

  const external = [...hosts].filter((h) => !['localhost:8787', 'fonts.googleapis.com', 'fonts.gstatic.com'].includes(h));
  const loaded = await page.evaluate(async () => { await document.fonts.ready; return [...document.fonts].filter((f) => f.status === 'loaded').map((f) => f.family.replace(/"/g, '')); });
  // Reject8 uses Patrick Hand for UI copy; Inter/Mono stay linked for brand parity but may not
  // appear in document.fonts if unused. Require Patrick Hand; note others.
  const fontsOk = loaded.includes('Patrick Hand');
  check('Patrick Hand loaded (drawn UI font)', fontsOk, [...new Set(loaded)].join(', '));
  check('browser requests only app/Supabase(+Google Fonts)', external.length === 0, [...hosts].join(', '));
  check('result page never called /api/notify', notifyCalls.length === 0, notifyCalls.join(', '));
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
