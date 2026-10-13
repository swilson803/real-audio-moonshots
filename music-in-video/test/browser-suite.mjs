// The browser checks (MS-006's, carried into MS-007), shared by test/e2e.mjs
// (synthetic media, fake moonshots) and test/e2e-real.mjs (real index).
// Chrome via Playwright:
//  - every video in `videos` goes through /music/ at 1280 and its result is
//    compared with the manifest (track_id in order, start within +-1 s,
//    nothing extra; no-music videos get the no-match message and no link);
//    what was sent must be the soundtrack body (body.js), never the video;
//  - the two-track and no-music videos are re-run at 281 / 320 / 375 / 768 /
//    1280 for screenshots, overflow, the step frames (VIDEO CHOSEN thin, FIND
//    MY MUSIC thick), FIND MY MUSIC never covered, the red results lines, the
//    credit block (per-platform tabs, text, copy: one tap on phones), the
//    found tracks under it, "check another video", and the /v/ page (rows,
//    Play, its copy line);
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
import { CREDIT_LOCATION, TABS, creditText } from '../public/music/credit.js';

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
      const foundId = await page.getAttribute('#found', 'data-scan-id');
      const scan = await (await page.request.get(`${origin}/api/scans/${foundId}`)).json();
      return { found: true, link: `${origin}/v/${foundId}`, id: foundId, scan, ms, body, label };
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

    // 2. UI at 281 / 320 / 375 / 768 / 1280 with the two-track and no-music
    // videos (MS-007 Reject 1): step frames, FIND MY MUSIC never covered,
    // the red results lines, the credit block (tabs, text, copy), the found
    // tracks under it, "check another video", then the /v/ page as before.
    const two = videos.find((v) => v.kind === 'two_tracks');
    const none = videos.find((v) => v.kind === 'no_music');
    const RED = 'rgb(229, 90, 60)';
    const host = new URL(origin).host;
    const frameOf = (page, sel) => page.$eval(sel, (el) => getComputedStyle(el).borderImageSource.match(/frame-[\w-]+/)?.[0] ?? null);
    const rectOf = (page, sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y + scrollY, r.width, r.height].map(Math.round).join(','); });
    // A 3x3 grid on FIND MY MUSIC: every point must hit it (or its text).
    const submitHits = (page) => page.evaluate(() => {
      const b = document.getElementById('submit');
      b.scrollIntoView({ block: 'center' });
      const r = b.getBoundingClientRect();
      const miss = [];
      for (const fx of [0.1, 0.5, 0.9]) for (const fy of [0.2, 0.5, 0.8]) {
        const e = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
        if (!(e && (e === b || b.contains(e)))) miss.push(`${fx},${fy}:${e ? e.id || e.className || e.tagName : null}`);
      }
      return miss;
    });
    const steps = async (page, chosen) => {
      const pick = await frameOf(page, '#file-pick');
      const cta = await frameOf(page, '#submit');
      return chosen ? pick === 'frame-button-light-red' && cta === 'frame-search-heavy-red' : pick === 'frame-button-heavy-red' && cta === 'frame-search-light-red';
    };
    const settle = (page) => page.waitForTimeout(250); // the 120-150 ms frame / overlay transitions
    for (const width of [281, 320, 375, 768, 1280]) {
      const mobile = width <= 375;
      const touch = mobile ? { hasTouch: true, isMobile: true } : {};
      const press = (page, sel) => (mobile ? page.tap(sel) : page.click(sel));
      const p = await newPage({ width, height: mobile ? 812 : 1000 }, touch);
      await p.goto(`${origin}/music/`);
      await p.evaluate(() => document.fonts.ready);
      await p.screenshot({ path: `${shotsDir}/upload-rest-${width}.png`, fullPage: true });
      check(`upload page fits ${width}`, await noOverflow(p));
      check(`upload page hint at ${width}`, (await p.textContent('#file-hint')).trim() === 'MP4, MOV, M4V or WebM, up to 20 minutes. Only the soundtrack is sent, and it’s deleted once checked.');
      check(`before a video: CHOOSE VIDEO thick, FIND MY MUSIC thin at ${width}`, await steps(p, false), `${await frameOf(p, '#file-pick')} / ${await frameOf(p, '#submit')}`);
      const ctaHeight = await p.$eval('#submit', (el) => el.getBoundingClientRect().height);
      check(`FIND MY MUSIC on one line at ${width}`, ctaHeight <= 72, `${ctaHeight}px`);
      let miss = await submitHits(p);
      check(`FIND MY MUSIC not covered, no video, at ${width}`, !miss.length, miss.join(' '));
      const rects = [await rectOf(p, '#file-pick'), await rectOf(p, '#submit')];

      await p.setInputFiles('#file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not a video') });
      await settle(p);
      await p.screenshot({ path: `${shotsDir}/upload-invalid-${width}.png`, fullPage: true });
      check(`an unusable file keeps the frames (and shows why) at ${width}`, (await steps(p, false)) && (await p.textContent('#file-error')).includes('isn’t supported'));
      miss = await submitHits(p);
      check(`FIND MY MUSIC not covered, error line, at ${width}`, !miss.length, miss.join(' '));

      if (two) {
        await p.setInputFiles('#file', join(videosDir, two.file));
        await settle(p);
        await p.mouse.move(0, 0);
        await p.screenshot({ path: `${shotsDir}/upload-chosen-${width}.png`, fullPage: true });
        check(`video chosen: VIDEO CHOSEN thin, FIND MY MUSIC thick at ${width}`, (await steps(p, true)) && (await p.textContent('#file-pick')).trim() === 'VIDEO CHOSEN', `${await frameOf(p, '#file-pick')} / ${await frameOf(p, '#submit')}`);
        const after = [await rectOf(p, '#file-pick'), await rectOf(p, '#submit')];
        // The file name line under the button can change the CTA's y; its
        // x, width and height must not move.
        const xwh = (r) => r.split(',').filter((_, i) => i !== 1).join(',');
        check(`the frame swap moves nothing at ${width}`, rects[0] === after[0] && xwh(rects[1]) === xwh(after[1]), `${rects.join(' ')} -> ${after.join(' ')}`);
        miss = await submitHits(p);
        check(`FIND MY MUSIC not covered, video chosen, at ${width}`, !miss.length, miss.join(' '));
        if (!mobile) {
          await p.hover('#file-pick');
          miss = await submitHits(p);
          check(`FIND MY MUSIC not covered, video button hovered, at ${width}`, !miss.length, miss.join(' '));
          await p.mouse.move(0, 0);
        }

        // FIND MY MUSIC with Playwright's actionability checks (a real tap
        // on phones), as the Tester's run did.
        const t0 = Date.now();
        let pressed = true;
        await press(p, '#submit').catch(() => { pressed = false; });
        check(`FIND MY MUSIC takes one ${mobile ? 'tap' : 'click'} at ${width}`, pressed);
        await p.waitForFunction(() => document.getElementById('submit').textContent === 'LISTENING…' || !document.getElementById('found').hidden, null, { timeout: 30000 }).catch(() => {});
        if (await p.isVisible('#scan-form')) await p.screenshot({ path: `${shotsDir}/upload-listening-${width}.png`, fullPage: true });
        await p.waitForFunction(() => !document.getElementById('found').hidden || !document.getElementById('none').hidden || document.getElementById('form-error').textContent, null, { timeout: 600000 });
        const id = await p.getAttribute('#found', 'data-scan-id');
        const scan = id ? await (await p.request.get(`${origin}/api/scans/${id}`)).json() : null;
        check(`two-track video found at ${width}`, Boolean(scan) && judge(two, true, scan.matches), `${Date.now() - t0} ms`);
        if (scan) {
          const link = `${origin}/v/${id}`;
          await p.mouse.move(0, 0);
          await p.evaluate(() => document.fonts.ready);
          const n = two.expect.length;
          check(`found line in brand red at ${width}`,
            (await p.textContent('#found-summary')) === `We found ${n} Real Audio tracks in your video.` && (await p.$eval('#found-summary', (el) => getComputedStyle(el).color)) === RED);
          const order = await p.evaluate(() => [...document.querySelectorAll('#found > *')].map((el) => el.id || el.className));
          check(`found: summary, credit, tracks, then the button at ${width}`, order.join('|') === 'found-summary|credit|found-tracks-box|actions', order.join('|'));
          const another = await p.$eval('#found .actions', (el) => ({
            n: el.children.length, cls: el.firstElementChild.className, text: el.textContent.trim(), href: el.firstElementChild.getAttribute('href'),
          }));
          check(`only "check another video" at ${width} (no see your tracks)`,
            another.n === 1 && another.text === 'check another video' && another.href === '/music/' && !(await p.$('#open-result')) && !/see your tracks/i.test(await p.textContent('#found')), JSON.stringify(another));
          const btn = '#found .actions .btn-primary-cta';
          const rest = await p.$eval(btn, (el) => ({ color: getComputedStyle(el).color, frame: getComputedStyle(el).borderImageSource.match(/frame-[\w-]+/)?.[0] }));
          check(`"check another video" brand red at rest at ${width}`, another.cls === 'btn-primary-cta' && rest.color === RED && rest.frame === 'frame-button-heavy-red', JSON.stringify(rest));
          if (!mobile) {
            await p.hover(btn);
            await settle(p);
            const hov = await p.$eval(btn, (el) => { const cs = getComputedStyle(el); return { t: cs.transform, f: cs.filter, color: cs.color, frame: cs.borderImageSource.match(/frame-[\w-]+/)?.[0] }; });
            await p.screenshot({ path: `${shotsDir}/found-another-hover-${width}.png`, fullPage: true });
            check(`"check another video" only grows on hover at ${width}`, /^matrix\(1\.04, 0, 0, 1\.04/.test(hov.t) && hov.f === 'none' && hov.color === RED && hov.frame === 'frame-button-heavy-red', JSON.stringify(hov));
            await p.mouse.move(0, 0);
          }

          // The credit block.
          const tabs = await p.$$eval('#credit [role="tab"]', (els) => els.map((el) => ({ label: el.textContent, selected: el.getAttribute('aria-selected') })));
          check(`credit block heading and tabs at ${width}`,
            (await p.textContent('#credit .credit-heading')) === 'Where are you posting?'
            && tabs.map((t) => t.label).join('|') === TABS.map((t) => t.label).join('|')
            && tabs.map((t) => t.selected).join('|') === 'true|false|false|false', JSON.stringify(tabs));
          const shortName = { universal: 'yt', tiktok: 'tiktok', instagram: 'instagram', youtube_shorts: 'shorts' };
          const creditLink = `${host}/v/${id}`;
          for (const t of TABS) {
            await press(p, `#credit-tab-${t.value}`);
            await p.mouse.move(0, 0);
            await settle(p);
            const got = await p.evaluate(() => ({
              where: document.querySelector('#credit .credit-where').textContent,
              text: document.querySelector('#credit .accred-text').textContent,
              selected: document.querySelector('#credit [aria-selected="true"]').dataset.value,
            }));
            const want = creditText(t, scan.matches, creditLink);
            check(`${t.label} tab: "Paste in your ${CREDIT_LOCATION[t.medium]}:" and its credit at ${width}`,
              got.selected === t.value && got.where === `Paste in your ${CREDIT_LOCATION[t.medium]}:` && got.text === want, JSON.stringify(got));
            check(`${t.label} tab fits ${width}`, await noOverflow(p));
            await p.screenshot({ path: `${shotsDir}/found-${shortName[t.value]}-${width}.png`, fullPage: true });
          }
          if (!mobile) {
            await p.focus('#credit-tab-youtube_shorts');
            const keys = [];
            for (const k of ['ArrowRight', 'End', 'ArrowLeft', 'Home']) {
              await p.keyboard.press(k);
              keys.push(await p.evaluate(() => `${document.activeElement.dataset.value}/${document.querySelector('#credit [aria-selected="true"]').dataset.value}`));
            }
            check(`credit tabs by keyboard at ${width}`, keys.join(' ') === 'universal/universal youtube_shorts/youtube_shorts instagram/instagram universal/universal', keys.join(' '));
          }
          for (const t of [TABS[0], TABS[1]]) {
            await press(p, `#credit-tab-${t.value}`);
            await p.mouse.move(0, 0);
            await settle(p);
            if (!mobile && t === TABS[0]) {
              await p.hover('#credit .download-accred');
              await settle(p);
              const ov = await p.$eval('#credit .accred-overlay', (el) => ({ text: el.textContent, opacity: getComputedStyle(el).opacity }));
              check(`credit box shows "Copy" on hover at ${width}`, ov.text === 'Copy' && ov.opacity === '1', JSON.stringify(ov));
              await p.screenshot({ path: `${shotsDir}/found-copy-hover-${width}.png`, fullPage: true });
            }
            await p.evaluate(() => navigator.clipboard.writeText(''));
            await press(p, '#credit .download-accred');
            const t1 = Date.now();
            const clip = await p.evaluate(() => navigator.clipboard.readText());
            const want = creditText(t, scan.matches, creditLink);
            check(`${t.label} credit copies in one ${mobile ? 'tap' : 'click'} at ${width}`, clip === want, JSON.stringify(clip));
            await settle(p);
            const st = await p.$eval('#credit .download-accred', (el) => ({ label: el.getAttribute('aria-label'), copied: el.dataset.copied, overlay: el.querySelector('.accred-overlay').textContent, status: el.querySelector('[role="status"]').textContent }));
            check(`${t.label} credit says "Copied!" at ${width}`, st.label === 'Copied!' && st.copied === 'true' && st.overlay === 'Copied!' && st.status === 'Copied!', JSON.stringify(st));
            if (t === TABS[0]) await p.screenshot({ path: `${shotsDir}/found-copied-${width}.png`, fullPage: true });
            if (!mobile) {
              await p.waitForTimeout(Math.max(0, 1500 - (Date.now() - t1)));
              const held = await p.getAttribute('#credit .download-accred', 'aria-label');
              await p.waitForTimeout(Math.max(0, 2200 - (Date.now() - t1)));
              const stillHovered = await p.getAttribute('#credit .download-accred', 'aria-label');
              await p.mouse.move(0, 0);
              await settle(p);
              const left = await p.getAttribute('#credit .download-accred', 'aria-label');
              check(`"Copied!" holds 2 s and while hovered, then "Copy" at ${width}`, held === 'Copied!' && stillHovered === 'Copied!' && left === 'Copy credit', `${held} / ${stillHovered} / ${left}`);
            } else {
              await p.waitForTimeout(Math.max(0, 2300 - (Date.now() - t1)));
              check(`"Copied!" resets after 2 s at ${width}`, (await p.getAttribute('#credit .download-accred', 'aria-label')) === 'Copy credit');
            }
          }

          // Found tracks under the credit.
          const secs = (t) => t.split(':').reduce((a, b) => a * 60 + Number(b), 0);
          const readRows = (page, sel) => page.$$eval(`${sel} .track`, (els) => els.map((el) => ({
            time: el.querySelector('.track-time').textContent,
            title: el.querySelector('.track-title').textContent,
            artist: el.querySelector('.track-artist').textContent,
          })));
          const rowsOk = (rows) => rows.length === two.expect.length && rows.every((row, i) => row.title === two.expect[i].title && row.artist === two.expect[i].artist && near(secs(row.time), two.expect[i].start_s));
          const found = await readRows(p, '#found-tracks');
          check(`found tracks with start times under the credit at ${width}`, rowsOk(found), `${JSON.stringify(found)} want ${JSON.stringify(two.expect.map((w) => [w.start_s, w.title, w.artist]))}`);
          const before = await p.evaluate(() => window.__audios.length);
          await press(p, '#found-tracks .play-btn');
          await p.waitForFunction((k) => window.__audios[k] && window.__audios[k].currentTime > 0.5, before, { timeout: 20000 }).catch(() => {});
          const played = await p.evaluate((k) => ({ src: window.__audios[k]?.src, t: window.__audios[k]?.currentTime ?? 0 }), before);
          check(`found track plays at ${width}`, played.t > 0.5 && same(played.src, scan.matches[0]?.stream_url), JSON.stringify(played));
          await p.evaluate((k) => window.__audios[k]?.pause(), before);
          check(`found state fits ${width}`, await noOverflow(p));

          // The /v/ page, unchanged.
          await p.goto(link);
          await p.waitForSelector('#tracks .track');
          await p.evaluate(() => document.fonts.ready);
          await p.screenshot({ path: `${shotsDir}/v-result-${width}.png`, fullPage: true });
          check(`result page fits ${width}`, await noOverflow(p));
          const rows = await readRows(p, '#tracks');
          check(`result rows in order with start, title, artist at ${width}`, rowsOk(rows), JSON.stringify(rows));
          check(`result summary at ${width}`, (await p.textContent('#summary')) === `${two.expect.length} Real Audio tracks are in this video, in order.`);
          const line = (await p.textContent('#copy-line')).trim();
          check(`result page copy line reads "music in this video: <link>" at ${width}`, line === `music in this video: ${link}`, line);
          const vbtn = p.locator('.play-btn').first();
          if (mobile) await vbtn.tap(); else await vbtn.click();
          await p.waitForFunction(() => window.__audios[0] && window.__audios[0].currentTime > 0.5, null, { timeout: 20000 }).catch(() => {});
          const audio = await p.evaluate(() => ({ src: window.__audios[0]?.src, t: window.__audios[0]?.currentTime ?? 0 }));
          check(`stream button plays at ${width}`, audio.t > 0.5 && same(audio.src, scan.matches[0]?.stream_url), JSON.stringify(audio));
          await p.screenshot({ path: `${shotsDir}/v-result-playing-${width}.png`, fullPage: true });
          await press(p, '#copy');
          check(`result page COPY at ${width}`, (await p.evaluate(() => navigator.clipboard.readText())) === `music in this video: ${link}`);
          check(`result page COPY confirms at ${width}`, (await p.textContent('#copy')) === 'COPIED');

          const hp = await newPage({ width, height: 900 });
          await hp.goto(link);
          await hp.waitForSelector('#tracks .track');
          await hp.evaluate(() => document.fonts.ready);
          await headerChecks(hp, 'result page', width);
          await hp.context().close();
        }
      }
      if (none) {
        const n = await upload(p, none.file);
        await p.mouse.move(0, 0);
        await settle(p);
        await p.screenshot({ path: `${shotsDir}/none-${width}.png`, fullPage: true });
        const lead = await p.$eval('#none .result-lead', (el) => ({ text: el.textContent, color: getComputedStyle(el).color }));
        const nbtn = await p.$eval('#none .actions .btn-primary-cta', (el) => ({ text: el.textContent, color: getComputedStyle(el).color }));
        check(`no-match message in brand red, no link at ${width}`, n.found === false && !n.linkShown && lead.text === 'We didn’t find any Real Audio music in this video.' && lead.color === RED, JSON.stringify(lead));
        check(`no-match "check another video" brand red at ${width}`, nbtn.text === 'check another video' && nbtn.color === RED, JSON.stringify(nbtn));
        check(`no-match state fits ${width}`, await noOverflow(p));
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
          const id = await p.getAttribute('#found', 'data-scan-id');
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
