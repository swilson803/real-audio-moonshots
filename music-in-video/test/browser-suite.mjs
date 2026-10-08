// The MS-006 browser checks, shared by test/e2e.mjs (synthetic media, fake
// moonshots) and test/e2e-real.mjs (real index). Chrome via Playwright:
//  - every video in `videos` goes through /music/ at 1280 and its result is
//    compared with the manifest (track_id in order, start within +-1 s,
//    nothing extra; no-music videos get the no-match message and no link);
//  - the two-track and no-music videos are re-run at 375 / 768 / 1280 for
//    screenshots, overflow, the copy line, COPY (one tap at 375), the result
//    page rows and the Play button;
//  - production Tracks audio requested by Play is answered from local files
//    (`catalog`), so it costs no egress; those requests are recorded.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PROD_HOST = 'uprfsmwbsvzuoiyfgtgx.supabase.co';
export const PROD_TRACKS_PREFIX = `https://${PROD_HOST}/storage/v1/object/public/Tracks/`;
const near = (a, b) => Math.abs(a - b) <= 1;
const AUDIO_TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac' };
const typeOf = (file) => AUDIO_TYPES[(file.match(/\.\w+$/)?.[0] || '').toLowerCase()] || 'application/octet-stream';
const same = (a, b) => { try { return decodeURI(a) === decodeURI(b); } catch { return a === b; } };

// Pass rule per manifest kind.
export function judge(video, found, matches) {
  const want = video.expect;
  if (!want.length) return !found;
  return found && matches.length === want.length
    && matches.every((m, i) => m.track_id === want[i].track_id && near(m.start_s, want[i].start_s));
}

/**
 * @param origin     the local Worker origin
 * @param videos     manifest entries to upload ({ file, kind, expect, … })
 * @param videosDir  where the files are
 * @param catalog    [{ track_id, stream_url, file }] local audio for Play
 * @param shotsDir   screenshots
 * @param labelFor   optional (file) => x-scan-label for its POST /api/scan
 * @param check      (name, ok, detail) => void
 */
export async function runBrowserSuite({ origin, videos, videosDir, catalog, shotsDir, labelFor = null, check }) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/google/chrome/chrome' });
  const browserRequests = [];
  const playRequests = [];
  const results = [];
  let label = null;

  async function newPage(viewport, extra = {}) {
    const context = await browser.newContext({ viewport, ...extra });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    // Keep each Audio the result page plays, to check it really plays.
    await context.addInitScript(() => {
      window.__audios = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (...a) { window.__audios.push(this); return play.apply(this, a); };
    });
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
    page.on('request', (r) => browserRequests.push({ method: r.method(), url: r.url(), bytes: r.postDataBuffer()?.length ?? 0 }));
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    return page;
  }

  async function upload(page, file) {
    label = labelFor ? labelFor(file) : null;
    const before = browserRequests.length;
    await page.goto(`${origin}/music/`);
    await page.setInputFiles('#file', join(videosDir, file));
    const t0 = Date.now();
    await page.click('#submit');
    await page.waitForFunction(() => !document.getElementById('found').hidden || !document.getElementById('none').hidden || document.getElementById('form-error').textContent, null, { timeout: 300000 });
    const ms = Date.now() - t0;
    const sent = browserRequests.slice(before).filter((r) => new URL(r.url).pathname === '/api/scan').reduce((n, r) => n + r.bytes, 0);
    if (await page.isVisible('#found')) {
      const link = await page.getAttribute('#open-result', 'href');
      const id = link.split('/v/')[1];
      const scan = await (await page.request.get(`${origin}/api/scans/${id}`)).json();
      return { found: true, link, id, scan, ms, sent, label };
    }
    if (await page.isVisible('#none')) return { found: false, ms, sent, label, linkShown: await page.isVisible('#found') };
    return { error: await page.textContent('#form-error'), ms, sent, label };
  }
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  try {
    // 1. Every video at 1280.
    const page = await newPage({ width: 1280, height: 900 });
    for (const v of videos) {
      const size = (await stat(join(videosDir, v.file))).size;
      const r = await upload(page, v.file);
      const matches = r.found ? r.scan.matches : [];
      const got = matches.map((m) => ({ track_id: m.track_id, title: m.title, start_s: m.start_s }));
      const want = v.expect.map((e) => ({ track_id: e.track_id, title: e.title, start_s: e.start_s }));
      const pass = !r.error && judge(v, Boolean(r.found), matches);
      results.push({ file: v.file, kind: v.kind, variant: v.variant ?? null, got, want, pass, error: r.error ?? null, ms: r.ms, bytes_sent: r.sent, video_bytes: size, scan_id: r.id ?? null, label: r.label });
      if (!['quiet', 'dev', 'sweep'].includes(v.kind)) check(`${v.file} (${v.kind})`, pass, r.error || `got ${JSON.stringify(got)} want ${JSON.stringify(want)}; ${r.ms} ms`);
      check(`${v.file}: the video was not uploaded`, r.sent > 0 && r.sent < 1e6 && r.sent < size / 10, `sent ${r.sent} B, video ${size} B`);
    }
    for (const kind of ['quiet', 'dev', 'sweep']) {
      const set = results.filter((x) => x.kind === kind);
      if (!set.length) continue;
      for (const x of set) console.log(`  ${x.file}${x.variant ? ` (${x.variant})` : ''}: ${x.pass ? 'ok  ' : 'MISS'} got ${JSON.stringify(x.got.map((g) => [g.title, g.start_s]))} want ${JSON.stringify(x.want.map((w) => [w.title, w.start_s]))}`);
      const ok = set.filter((x) => x.pass).length;
      if (kind === 'quiet') check(`quiet bed -20 dB: >= 8/10 found with the right start`, ok >= 8 && set.length >= 10, `${ok}/${set.length}`);
      else console.log(`  ${kind}: ${ok}/${set.length}`);
    }

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

          const btn = p.locator('.play-btn').first();
          if (width === 375) await btn.tap(); else await btn.click();
          await p.waitForFunction(() => window.__audios[0] && window.__audios[0].currentTime > 0.5, null, { timeout: 20000 }).catch(() => {});
          const audio = await p.evaluate(() => ({ src: window.__audios[0]?.src, t: window.__audios[0]?.currentTime ?? 0 }));
          const wantUrl = r.scan.matches[0]?.stream_url;
          check(`stream button plays at ${width}`, audio.t > 0.5 && same(audio.src, wantUrl), JSON.stringify(audio));
          await p.screenshot({ path: `${shotsDir}/result-playing-${width}.png`, fullPage: true });
          if (width === 375) await p.tap('#copy'); else await p.click('#copy');
          check(`result page COPY at ${width}`, (await p.evaluate(() => navigator.clipboard.readText())) === `music in this video: ${r.link}`);
        }
      }
      if (none) {
        const n = await upload(p, none.file);
        await p.screenshot({ path: `${shotsDir}/upload-none-${width}.png`, fullPage: true });
        check(`no-match message and no link at ${width}`, n.found === false && !n.linkShown && (await p.textContent('#none')).includes('We didn’t find any Real Audio music in this video.'));
      }
      await p.context().close();
    }

    const p404 = await newPage({ width: 375, height: 700 });
    await p404.goto(`${origin}/v/Zzzzzzzzzz`);
    await p404.waitForFunction(() => document.getElementById('summary').textContent !== 'Loading…');
    check('unknown result link says so', (await p404.textContent('#summary')).includes('couldn’t find'));

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
  } finally {
    await browser.close();
  }
  return { results, playRequests, browserRequests };
}
