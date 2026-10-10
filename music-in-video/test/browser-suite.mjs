// The browser checks (MS-006's, carried into MS-007), shared by test/e2e.mjs
// (synthetic media, fake moonshots) and test/e2e-real.mjs (real index).
// Chrome via Playwright:
//  - every video in `videos` goes through /music/ at 1280 and its result is
//    compared with the manifest (track_id in order, start within +-1 s,
//    nothing extra; no-music videos get the no-match message and no link);
//    what was sent must be the soundtrack body (body.js), never the video;
//  - the two-track and no-music videos are re-run at 375 / 768 / 1280 for
//    screenshots, overflow, the copy line, COPY (one tap at 375), the result
//    page rows and the Play button;
//  - the header on both pages is plain brand type (DOM + one-colour pixels);
//  - with `faults` (the synthetic harness): slow paths behind the queue
//    (cold container + database timeouts, a crash mid-job, a 90 s job, retries
//    used up) show "Still working…" and then a result or the error line,
//    never a timeout; the result page shows its working state, then rows;
//  - production Tracks audio requested by Play is answered from local files
//    (`catalog`), so it costs no egress; those requests are recorded;
//  - with `cloud`: no upload is left in the bucket afterwards.
import { mkdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const run = promisify(execFile);
const PROD_HOST = 'uprfsmwbsvzuoiyfgtgx.supabase.co';
export const PROD_TRACKS_PREFIX = `https://${PROD_HOST}/storage/v1/object/public/Tracks/`;
const near = (a, b) => Math.abs(a - b) <= 1;
const AUDIO_TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac' };
const typeOf = (file) => AUDIO_TYPES[(file.match(/\.\w+$/)?.[0] || '').toLowerCase()] || 'application/octet-stream';
const same = (a, b) => { try { return decodeURI(a) === decodeURI(b); } catch { return a === b; } };
const STILL_WORKING = 'Still working… this can take up to a minute.';
const FAILED = 'Something went wrong. Try again.';
// Anything that reads like a timeout, anywhere on a page, at any time.
const TIMEOUT_TEXT = /time[sd]? ?out|taking too long|timed/i;
const BRAND_RED = [229, 90, 60]; // --color-red #E55A3C

// Pass rule per manifest kind.
export function judge(video, found, matches) {
  const want = video.expect;
  if (!want.length) return !found;
  return found && matches.length === want.length
    && matches.every((m, i) => m.track_id === want[i].track_id && near(m.start_s, want[i].start_s));
}

async function durationOf(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
}

/**
 * @param origin     the local Worker origin
 * @param videos     manifest entries to upload ({ file, kind, expect, … })
 * @param videosDir  where the files are
 * @param catalog    [{ track_id, stream_url, file }] local audio for Play
 * @param shotsDir   screenshots
 * @param labelFor   optional (file) => x-scan-label for its POST /api/scan
 * @param check      (name, ok, detail) => void
 * @param cloud      optional test/local-cloud.mjs instance: uploads left,
 *                   queue / container controls
 * @param faults     optional { db, shotsDir }: the fake moonshots' controls
 *                   (test/fake-moonshots.mjs) for the slow-path checks (needs
 *                   cloud)
 */
export async function runBrowserSuite({ origin, videos, videosDir, catalog, shotsDir, labelFor = null, check, cloud = null, faults = null }) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/google/chrome/chrome' });
  const browserRequests = [];
  const playRequests = [];
  const results = [];
  let label = null;

  async function newPage(viewport, extra = {}) {
    const context = await browser.newContext({ viewport, ...extra });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    await context.addInitScript((re) => {
      // Keep each Audio the result page plays, to check it really plays.
      window.__audios = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...a) { window.__audios.push(this); return play.apply(this, a); };
      // Every error line, and any timeout-like text, the page ever shows.
      window.__errors = [];
      window.__timeouts = [];
      const rx = new RegExp(re, 'i');
      new MutationObserver(() => {
        const err = document.getElementById('form-error')?.textContent;
        if (err && window.__errors.at(-1) !== err) window.__errors.push(err);
        const text = document.body?.innerText || '';
        if (rx.test(text)) window.__timeouts.push(text.match(rx)[0]);
      }).observe(document, { childList: true, characterData: true, subtree: true });
    }, TIMEOUT_TEXT.source);
    await context.route(`https://${PROD_HOST}/**`, async (route) => {
      const req = route.request();
      const track = catalog.find((t) => same(t.stream_url, req.url()));
      playRequests.push({ method: req.method(), url: req.url(), served: Boolean(track && req.method() === 'GET') });
      if (!track || req.method() !== 'GET') return route.abort();
      await route.fulfill({ status: 200, body: await readFile(track.file), headers: { 'Content-Type': typeOf(track.file), 'Accept-Ranges': 'none' } });
    });
    if (labelFor) {
      await context.route('**/api/scan', (route) => route.continue({ headers: { ...route.request().headers(), 'x-scan-label': label } }));
    }
    const page = await context.newPage();
    page.on('request', (r) => {
      const body = r.postDataBuffer();
      browserRequests.push({ method: r.method(), url: r.url(), bytes: body?.length ?? 0, magic: body ? body.subarray(0, 4).toString('latin1') : null, n: body && body.length >= 20 ? body.readUInt32LE(16) : null });
    });
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    return page;
  }
  const seen = (page) => page.evaluate(() => ({ errors: window.__errors, timeouts: window.__timeouts }));

  async function upload(page, file) {
    label = labelFor ? labelFor(file) : null;
    const before = browserRequests.length;
    await page.goto(`${origin}/music/`);
    await page.setInputFiles('#file', join(videosDir, file));
    const t0 = Date.now();
    const posted = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/scan', { timeout: 300000 }).catch(() => null);
    await page.click('#submit');
    await page.waitForFunction(() => !document.getElementById('found').hidden || !document.getElementById('none').hidden || document.getElementById('form-error').textContent, null, { timeout: 600000 });
    const ms = Date.now() - t0;
    const id = (await (await posted)?.json().catch(() => null))?.id ?? null;
    const sent = browserRequests.slice(before).filter((r) => new URL(r.url).pathname === '/api/scan');
    const body = { bytes: sent.reduce((n, r) => n + r.bytes, 0), magic: sent[0]?.magic ?? null, n: sent[0]?.n ?? null };
    if (await page.isVisible('#found')) {
      const link = await page.getAttribute('#open-result', 'href');
      const scan = await (await page.request.get(`${origin}/api/scans/${link.split('/v/')[1]}`)).json();
      return { found: true, link, id: link.split('/v/')[1], scan, ms, body, label };
    }
    if (await page.isVisible('#none')) return { found: false, id, ms, body, label, linkShown: await page.isVisible('#found') };
    return { error: await page.textContent('#form-error'), id, ms, body, label };
  }
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const leftInBucket = async () => (cloud ? (await cloud.idle(), cloud.uploadsLeft()) : []);

  // The header: plain brand type. DOM, then pixels, on a plain white
  // background (for this measurement only): every inked pixel lies on the
  // line from white to brand red (anti-aliased edges), none is darker than
  // brand red, and inside the glyphs (3x3 fully inked) every pixel IS brand
  // red. MS-006's hatched headline fails the last two (46% of its interior
  // pixels off; /workspace/ms007/build/header-evidence); a stripe or band of
  // another tone would too.
  async function headerChecks(page, name, width) {
    const dom = await page.$eval('h1.headline', (el) => {
      const cs = getComputedStyle(el);
      return {
        text: el.textContent.trim(), imgs: el.querySelectorAll('img').length, text_h1: el.classList.contains('text-h1'),
        font: cs.fontFamily, color: cs.color, weight: cs.fontWeight, size: cs.fontSize,
        background: cs.backgroundImage, clip: cs.backgroundClip, fill: cs.webkitTextFillColor, stroke: cs.webkitTextStrokeWidth, shadow: cs.textShadow,
      };
    });
    check(`${name} header is text in the brand type at ${width}`,
      dom.text === 'Music in this video' && dom.imgs === 0 && dom.text_h1 && /Patrick Hand/.test(dom.font) && dom.color === 'rgb(229, 90, 60)'
      && dom.fill === 'rgb(229, 90, 60)' && dom.weight === '700' && dom.size === (width >= 768 ? '64px' : '40px')
      && dom.background === 'none' && dom.clip === 'border-box' && dom.stroke === '0px' && dom.shadow === 'none',
      JSON.stringify(dom));
    await page.addStyleTag({ content: 'html, body, .page, .surface-sketched { background: #fff !important; }' });
    const png = await page.locator('h1.headline').screenshot({ path: `${shotsDir}/header-${name.replace(/ /g, '-')}-${width}.png` });
    const px = await page.evaluate(async ({ b64, red }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const W = img.width;
      const H = img.height;
      const c = document.createElement('canvas');
      c.width = W;
      c.height = H;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, W, H).data;
      const v = red.map((x) => x - 255);
      const vv = v.reduce((sum, x) => sum + x * x, 0);
      const alpha = new Float32Array(W * H);
      let ink = 0;
      let offHue = 0;
      let darker = 0;
      for (let i = 0, k = 0; i < d.length; i += 4, k++) {
        const q = [d[i] - 255, d[i + 1] - 255, d[i + 2] - 255];
        const a = (q[0] * v[0] + q[1] * v[1] + q[2] * v[2]) / vv;
        alpha[k] = a;
        if (Math.hypot(...q) < 40) continue;
        ink++;
        if (Math.hypot(q[0] - a * v[0], q[1] - a * v[1], q[2] - a * v[2]) > 24) offHue++;
        if (a > 1.06) darker++;
      }
      let interior = 0;
      let offInterior = 0;
      for (let y = 1; y < H - 1; y++) {
        for (let x = 1; x < W - 1; x++) {
          let solid = true;
          for (let dy = -1; dy <= 1 && solid; dy++) for (let dx = -1; dx <= 1; dx++) if (alpha[(y + dy) * W + x + dx] < 0.6) { solid = false; break; }
          if (!solid) continue;
          interior++;
          if (Math.abs(alpha[y * W + x] - 1) > 0.06) offInterior++;
        }
      }
      return { ink, offHue, darker, interior, offInterior };
    }, { b64: png.toString('base64'), red: BRAND_RED });
    check(`${name} header renders in one colour, no stripe or banding, at ${width}`,
      px.ink > 500 && px.interior > 50 && px.offHue / px.ink < 0.005 && px.darker / px.ink < 0.005 && px.offInterior / px.interior < 0.01,
      JSON.stringify(px));
  }

  try {
    // 1. Every video at 1280.
    const page = await newPage({ width: 1280, height: 900 });
    for (const v of videos) {
      const path = join(videosDir, v.file);
      const size = (await stat(path)).size;
      const r = await upload(page, v.file);
      const matches = r.found ? r.scan.matches : [];
      const got = matches.map((m) => ({ track_id: m.track_id, title: m.title, start_s: m.start_s }));
      const want = v.expect.map((e) => ({ track_id: e.track_id, title: e.title, start_s: e.start_s }));
      const pass = !r.error && judge(v, Boolean(r.found), matches);
      results.push({ file: v.file, kind: v.kind, variant: v.variant ?? null, got, want, pass, error: r.error ?? null, ms: r.ms, bytes_sent: r.body.bytes, video_bytes: size, scan_id: r.id ?? null, label: r.label });
      if (!['quiet', 'dev', 'sweep'].includes(v.kind)) check(`${v.file} (${v.kind})`, pass, r.error || `got ${JSON.stringify(got)} want ${JSON.stringify(want)}; ${r.ms} ms`);
      const seconds = r.body.n / 16000;
      check(`${v.file}: only the soundtrack was sent (16 kHz mono PCM body), not the video`,
        r.body.magic === 'MS7A' && r.body.bytes === 20 + 2 * r.body.n && Math.abs(seconds - await durationOf(path)) < 1,
        `sent ${r.body.bytes} B (${seconds.toFixed(2)} s of 16 kHz audio), video ${size} B`);
    }
    for (const kind of ['quiet', 'dev', 'sweep']) {
      const set = results.filter((x) => x.kind === kind);
      if (!set.length) continue;
      for (const x of set) console.log(`  ${x.file}${x.variant ? ` (${x.variant})` : ''}: ${x.pass ? 'ok  ' : 'MISS'} got ${JSON.stringify(x.got.map((g) => [g.title, g.start_s]))} want ${JSON.stringify(x.want.map((w) => [w.title, w.start_s]))}`);
      const ok = set.filter((x) => x.pass).length;
      if (kind === 'quiet') check(`quiet bed -20 dB: >= 8/10 found with the right start`, ok >= 8 && set.length >= 10, `${ok}/${set.length}`);
      else console.log(`  ${kind}: ${ok}/${set.length}`);
    }
    const s1 = await seen(page);
    check('no timeout text and no error line during the uploads', s1.timeouts.length === 0 && s1.errors.length === 0, JSON.stringify(s1));
    await page.context().close();

    // 2. UI at 375 / 768 / 1280 with the two-track and no-music videos.
    const two = videos.find((v) => v.kind === 'two_tracks');
    const none = videos.find((v) => v.kind === 'no_music');
    for (const width of [375, 768, 1280]) {
      const touch = width === 375 ? { hasTouch: true, isMobile: true } : {};
      const p = await newPage({ width, height: width === 375 ? 812 : 1000 }, touch);
      await p.goto(`${origin}/music/`);
      await p.evaluate(() => document.fonts.ready);
      await p.screenshot({ path: `${shotsDir}/upload-${width}.png`, fullPage: true });
      check(`upload page fits ${width}`, await noOverflow(p));
      check(`upload page hint at ${width}`, (await p.textContent('#file-hint')).trim() === 'MP4, MOV, M4V or WebM, up to 20 minutes. Only the soundtrack is sent, and it’s deleted once checked.');
      if (two) {
        await p.setInputFiles('#file', join(videosDir, two.file));
        await p.screenshot({ path: `${shotsDir}/upload-chosen-${width}.png`, fullPage: true });
        const r = await upload(p, two.file);
        await p.screenshot({ path: `${shotsDir}/upload-found-${width}.png`, fullPage: true });
        check(`found state fits ${width}`, r.found && (await noOverflow(p)));
        if (r.found) {
          const line = (await p.textContent('#copy-line')).trim();
          check(`copy line reads "music in this video: <link>" at ${width}`, line === `music in this video: ${r.link}`, line);
          if (width === 375) await p.tap('#copy'); else await p.click('#copy');
          const clip = await p.evaluate(() => navigator.clipboard.readText());
          check(`COPY is one ${width === 375 ? 'tap' : 'click'} at ${width}`, clip === `music in this video: ${r.link}`, clip);
          check(`COPY confirms at ${width}`, (await p.textContent('#copy')) === 'COPIED');

          await p.goto(r.link);
          await p.waitForSelector('#tracks .track');
          await p.evaluate(() => document.fonts.ready);
          await p.screenshot({ path: `${shotsDir}/result-${width}.png`, fullPage: true });
          check(`result page fits ${width}`, await noOverflow(p));
          const rows = await p.$$eval('#tracks .track', (els) => els.map((el) => ({
            time: el.querySelector('.track-time').textContent,
            title: el.querySelector('.track-title').textContent,
            artist: el.querySelector('.track-artist').textContent,
          })));
          const secs = (t) => t.split(':').reduce((a, b) => a * 60 + Number(b), 0);
          check(`result rows in order with start, title, artist at ${width}`,
            rows.length === two.expect.length && rows.every((row, i) => row.title === two.expect[i].title && row.artist === two.expect[i].artist && near(secs(row.time), two.expect[i].start_s)),
            `${JSON.stringify(rows)} want ${JSON.stringify(two.expect.map((w) => [w.start_s, w.title, w.artist]))}`);
          check(`result summary at ${width}`, (await p.textContent('#summary')) === `${two.expect.length} Real Audio tracks are in this video, in order.`);

          const btn = p.locator('.play-btn').first();
          if (width === 375) await btn.tap(); else await btn.click();
          await p.waitForFunction(() => window.__audios[0] && window.__audios[0].currentTime > 0.5, null, { timeout: 20000 }).catch(() => {});
          const audio = await p.evaluate(() => ({ src: window.__audios[0]?.src, t: window.__audios[0]?.currentTime ?? 0 }));
          const wantUrl = r.scan.matches[0]?.stream_url;
          check(`stream button plays at ${width}`, audio.t > 0.5 && same(audio.src, wantUrl), JSON.stringify(audio));
          await p.screenshot({ path: `${shotsDir}/result-playing-${width}.png`, fullPage: true });
          if (width === 375) await p.tap('#copy'); else await p.click('#copy');
          check(`result page COPY at ${width}`, (await p.evaluate(() => navigator.clipboard.readText())) === `music in this video: ${r.link}`);

          const hp = await newPage({ width, height: 900 });
          await hp.goto(r.link);
          await hp.waitForSelector('#tracks .track');
          await hp.evaluate(() => document.fonts.ready);
          await headerChecks(hp, 'result page', width);
          await hp.context().close();
        }
      }
      if (none) {
        const n = await upload(p, none.file);
        await p.screenshot({ path: `${shotsDir}/upload-none-${width}.png`, fullPage: true });
        check(`no-match message and no link at ${width}`, n.found === false && !n.linkShown && (await p.textContent('#none')).includes('We didn’t find any Real Audio music in this video.'));
      }
      const hp = await newPage({ width, height: 900 });
      await hp.goto(`${origin}/music/`);
      await hp.evaluate(() => document.fonts.ready);
      await headerChecks(hp, 'upload page', width);
      await hp.context().close();
      await p.context().close();
    }

    const p404 = await newPage({ width: 375, height: 700 });
    await p404.goto(`${origin}/v/Zzzzzzzzzz`);
    await p404.waitForFunction(() => document.getElementById('summary').textContent !== 'Loading…');
    check('unknown result link says so', (await p404.textContent('#summary')).includes('couldn’t find'));
    await p404.context().close();

    // 2b. Slow paths behind the queue (synthetic harness): the page shows
    // "Still working…", never an error or a timeout, then the right result;
    // one scan row; the upload deleted.
    if (faults && cloud && two) {
      const { db, shotsDir: fShots } = faults;
      await mkdir(fShots, { recursive: true });
      const scenarios = [
        // A 75 s video is two parallel lookups, so the processor's read
        // retries (3 tries each) absorb these; a database that stays busy
        // past them (503 -> the queue retries the job) is covered by the unit
        // tests, a queue retry here by the crash case.
        [375, 'cold container (20 s) and four database statement timeouts', () => { cloud.control.coldStartMs = 20000; db.statementTimeouts({ next: 4, delayMs: 2000 }); }],
        [768, 'the container crashes mid-job once (then an 8 s job)', () => { cloud.control.crashNext = 1; cloud.control.delayMs = 8000; }],
        [1280, 'a 90 s job', () => { cloud.control.delayMs = 90000; }],
      ];
      for (const [width, what, arm] of scenarios) {
        const touch = width === 375 ? { hasTouch: true, isMobile: true } : {};
        const p = await newPage({ width, height: width === 375 ? 812 : 1000 }, touch);
        await p.goto(`${origin}/music/`);
        await p.evaluate(() => document.fonts.ready);
        const inserts = db.scanInserts;
        const deliveries = cloud.control.deliveries.length;
        arm();
        await p.setInputFiles('#file', join(videosDir, two.file));
        const t0 = Date.now();
        await p.click('#submit');
        await p.waitForFunction((s) => document.getElementById('status').textContent === s, STILL_WORKING, { timeout: 120000 });
        const at = Date.now() - t0;
        await p.screenshot({ path: `${fShots}/still-working-${width}.png`, fullPage: true });
        await p.waitForFunction(() => !document.getElementById('found').hidden || !document.getElementById('none').hidden || document.getElementById('form-error').textContent, null, { timeout: 300000 });
        const ms = Date.now() - t0;
        await p.screenshot({ path: `${fShots}/result-${width}.png`, fullPage: true });
        let got = [];
        let ok = false;
        if (await p.isVisible('#found')) {
          const id = (await p.getAttribute('#open-result', 'href')).split('/v/')[1];
          const scan = await (await p.request.get(`${origin}/api/scans/${id}`)).json();
          got = scan.matches.map((m) => [m.title, m.start_s]);
          ok = judge(two, true, scan.matches);
        }
        const s = await seen(p);
        check(`${what} (${width}): "Still working…" then the right result`, ok, `still working at ${at} ms; ${JSON.stringify(got)} after ${ms} ms; ${cloud.control.deliveries.length - deliveries} deliveries`);
        check(`${what} (${width}): no error, no timeout text`, s.errors.length === 0 && s.timeouts.length === 0, JSON.stringify(s));
        check(`${what} (${width}): one scan row; upload deleted`, db.scanInserts === inserts + 1 && (await leftInBucket()).length === 0, `${db.scanInserts - inserts} inserts`);
        Object.assign(cloud.control, { coldStartMs: 0, crashNext: 0, delayMs: 0 });
        db.statementTimeouts({});
        await p.context().close();
      }

      // Retries used up (every attempt crashes): the dead-letter queue fails
      // the job and the page says so plainly: an error, never a timeout.
      {
        const p = await newPage({ width: 1280, height: 1000 });
        await p.goto(`${origin}/music/`);
        const dead = cloud.control.deadLetters;
        cloud.control.crashAlways = true;
        await p.setInputFiles('#file', join(videosDir, two.file));
        await p.click('#submit');
        await p.waitForFunction(() => document.getElementById('form-error').textContent || !document.getElementById('found').hidden, null, { timeout: 300000 });
        await p.screenshot({ path: `${fShots}/retries-used-up-1280.png`, fullPage: true });
        const s = await seen(p);
        cloud.control.crashAlways = false;
        check('retries used up: the job fails via the dead-letter queue and the page shows the error line, no timeout',
          (await p.textContent('#form-error')).trim() === FAILED && cloud.control.deadLetters === dead + 1 && s.timeouts.length === 0 && (await leftInBucket()).length === 0,
          JSON.stringify({ ...s, deadLetters: cloud.control.deadLetters - dead }));
        await p.context().close();
      }

      // The result page's working state: opened while the job is held.
      {
        const p = await newPage({ width: 1280, height: 1000 });
        await p.goto(`${origin}/music/`);
        const release = cloud.control.holdJobs();
        await p.setInputFiles('#file', join(videosDir, two.file));
        const posted = p.waitForResponse((r) => new URL(r.url()).pathname === '/api/scan');
        await p.click('#submit');
        const { id } = await (await posted).json();
        const v = await newPage({ width: 1280, height: 1000 });
        await v.goto(`${origin}/v/${id}`);
        await v.waitForFunction((s) => document.getElementById('summary').textContent === s, STILL_WORKING, { timeout: 30000 });
        await v.evaluate(() => document.fonts.ready);
        await v.screenshot({ path: `${fShots}/result-page-still-working-1280.png`, fullPage: true });
        const hidden = await v.evaluate(() => document.getElementById('tracks-box').hidden && document.getElementById('copy-box').hidden);
        release();
        await v.waitForSelector('#tracks .track', { timeout: 120000 });
        await v.screenshot({ path: `${fShots}/result-page-done-1280.png`, fullPage: true });
        const rows = await v.$$eval('#tracks .track .track-title', (els) => els.map((el) => el.textContent));
        const s = await seen(v);
        check('result page: "Still working…" while the job runs, then the rows', hidden && JSON.stringify(rows) === JSON.stringify(two.expect.map((e) => e.title)) && s.timeouts.length === 0, JSON.stringify({ rows, ...s }));
        await p.waitForFunction(() => !document.getElementById('found').hidden, null, { timeout: 120000 });
        await v.context().close();
        await p.context().close();
      }
    }

    // 3. Browser requests: this site, or production Tracks GETs (routed locally).
    const bad = browserRequests.filter(({ method, url }) => {
      const u = new URL(url);
      if (u.origin === origin) return false;
      return !(u.host === PROD_HOST && method === 'GET' && url.startsWith(PROD_TRACKS_PREFIX));
    });
    const hosts = [...new Set(browserRequests.map((r) => new URL(r.url).host))];
    check('browser requests: only this site, plus production Tracks audio GETs from Play (answered locally)', bad.length === 0,
      `hosts ${hosts.join(', ')}${bad.length ? `; bad ${JSON.stringify(bad.slice(0, 3))}` : ''}`);
    check('every Play request was answered from the local cache (no production egress)', playRequests.every((r) => r.served), `${playRequests.length} Play requests`);
    if (cloud) {
      const left = await leftInBucket();
      check('no uploaded soundtrack is kept: the upload bucket is empty', left.length === 0, left.join(', '));
    }
  } finally {
    await browser.close();
  }
  return { results, playRequests, browserRequests };
}
