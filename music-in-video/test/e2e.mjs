// Browser end-to-end on synthetic media, fully local:
//  - a synthetic catalog (seeded WAVs) and synthetic voice clips are written
//    to a temp dir, and scripts/make-test-videos.mjs turns them into the same
//    RA_TEST_ videos phase 2 makes from the real catalog (two tracks, no
//    music x2, 10 quiet beds at -20 dB incl. .mov, moov-at-end and WebM);
//  - each video goes through the real upload page in Chrome (mp4box.js +
//    WebCodecs or decodeAudioData, the real fingerprinter), the real Worker,
//    and a fake moonshots Supabase (test/harness.mjs);
//  - production audio requests from the Play button are answered locally
//    (Playwright route), so nothing reaches any Supabase project.
// Screenshots go to SHOTS (default /tmp/ms006_shots).
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { start } from './harness.mjs';
import { makeVideos } from '../scripts/make-test-videos.mjs';
import { PROD_TRACKS_PREFIX } from '../scripts/lib/targets.mjs';
import { synthMusic, synthSpeech, wavBytes } from './synth.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const SHOTS = process.env.SHOTS || '/tmp/ms006_shots';
const WORK = '/tmp/ms006_e2e';
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

// 1. Synthetic catalog, voice clips, and the test videos.
await rm(WORK, { recursive: true, force: true });
await mkdir(join(WORK, 'catalog'), { recursive: true });
await mkdir(join(WORK, 'speech'), { recursive: true });
await mkdir(SHOTS, { recursive: true });
const catalog = [];
for (let i = 1; i <= 12; i++) {
  const file = join(WORK, 'catalog', `${i}.wav`);
  await writeFile(file, wavBytes(synthMusic(1000 + i, 100)));
  catalog.push({ track_id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`, title: `RA_TEST Track ${i}`, artist: `RA_TEST Artist ${(i % 4) + 1}`, file, stream_url: `${PROD_TRACKS_PREFIX}tracks/RA_TEST/${i}.wav` });
}
for (let i = 0; i < 24; i++) await writeFile(join(WORK, 'speech', `clip${String(i).padStart(2, '0')}.wav`), wavBytes(synthSpeech(700 + i, 6 + (i % 5))));
const speechFiles = Array.from({ length: 24 }, (_, i) => join(WORK, 'speech', `clip${String(i).padStart(2, '0')}.wav`));
console.log('making test videos…');
const manifest = await makeVideos({ catalog, speechFiles, outDir: join(WORK, 'videos'), only: ['two_tracks', 'no_music', 'quiet'], log: () => {} });

// 2. Harness + browser.
const server = await start({ catalog });
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/google/chrome/chrome' });
const pageRequests = [];
const scanUploads = [];
async function newPage(viewport, extra = {}) {
  const context = await browser.newContext({ viewport, ...extra });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin });
  // Keep each Audio the result page makes, to check it really plays.
  await context.addInitScript(() => {
    window.__audios = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...a) { window.__audios.push(this); return play.apply(this, a); };
  });
  await context.route('https://uprfsmwbsvzuoiyfgtgx.supabase.co/**', async (route) => {
    const url = route.request().url();
    const track = catalog.find((t) => t.stream_url === url);
    if (!track || route.request().method() !== 'GET') return route.abort();
    await route.fulfill({ status: 200, body: await readFile(track.file), headers: { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'none' } });
  });
  const page = await context.newPage();
  page.on('request', (r) => {
    pageRequests.push({ method: r.method(), url: r.url() });
    if (new URL(r.url()).pathname === '/api/scan') scanUploads.push(r.postDataBuffer()?.length ?? 0);
  });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  return page;
}

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
async function upload(page, file) {
  await page.goto(`${server.origin}/music/`);
  await page.setInputFiles('#file', join(WORK, 'videos', file));
  await page.click('#submit');
  await page.waitForFunction(() => !document.getElementById('found').hidden || !document.getElementById('none').hidden || document.getElementById('form-error').textContent, null, { timeout: 120000 });
  if (await page.isVisible('#found')) {
    const link = await page.getAttribute('#open-result', 'href');
    const id = link.split('/v/')[1];
    const scan = await (await page.request.get(`${server.origin}/api/scans/${id}`)).json();
    return { found: true, link, scan };
  }
  if (await page.isVisible('#none')) return { found: false };
  return { error: await page.textContent('#form-error') };
}
const near = (a, b) => Math.abs(a - b) <= 1;

try {
  // 3. Every video through the page at 1280.
  const page = await newPage({ width: 1280, height: 900 });
  let quietOk = 0;
  const quietLog = [];
  for (const v of manifest) {
    const size = (await stat(join(WORK, 'videos', v.file))).size;
    const before = scanUploads.length;
    const t0 = Date.now();
    const r = await upload(page, v.file);
    const ms = Date.now() - t0;
    const sent = scanUploads.slice(before).reduce((a, b) => a + b, 0);
    if (r.error) {
      check(`${v.file}: page error`, false, r.error);
      continue;
    }
    const got = r.found ? r.scan.matches.map((m) => ({ title: m.title, start_s: m.start_s })) : [];
    const want = v.expect.map((e) => ({ title: e.title, start_s: e.start_s }));
    const ok = got.length === want.length && got.every((g, i) => g.title === want[i].title && near(g.start_s, want[i].start_s));
    const detail = `got ${JSON.stringify(got)} want ${JSON.stringify(want)}; ${ms} ms; sent ${sent} B for a ${size} B video`;
    if (v.kind === 'quiet') {
      if (ok) quietOk++;
      quietLog.push(`${v.file} ${v.variant}: ${ok ? 'ok' : 'MISS'} ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    } else {
      check(`${v.file} (${v.kind})`, ok, detail);
    }
    check(`${v.file}: the video was not uploaded`, sent > 0 && sent < size / 10 && sent < 1e6, `sent ${sent} B, video ${size} B`);
  }
  console.log(quietLog.join('\n'));
  check('quiet bed -20 dB: >= 8/10 found with the right start (synthetic)', quietOk >= 8, `${quietOk}/10`);

  // 4. Screenshots and UI checks at 375 / 768 / 1280.
  for (const width of [375, 768, 1280]) {
    const touch = width === 375 ? { hasTouch: true, isMobile: true } : {};
    const p = await newPage({ width, height: width === 375 ? 812 : 1000 }, touch);
    await p.goto(`${server.origin}/music/`);
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: `${SHOTS}/upload-${width}.png`, fullPage: true });
    check(`upload page fits ${width}`, await noOverflow(p));
    await p.setInputFiles('#file', join(WORK, 'videos', 'RA_TEST_two_tracks.mp4'));
    await p.screenshot({ path: `${SHOTS}/upload-chosen-${width}.png`, fullPage: true });

    const r = await upload(p, 'RA_TEST_two_tracks.mp4');
    await p.screenshot({ path: `${SHOTS}/upload-found-${width}.png`, fullPage: true });
    check(`found state fits ${width}`, await noOverflow(p));
    const line = (await p.textContent('#copy-line')).trim();
    check(`copy line reads "music in this video: <link>" at ${width}`, line === `music in this video: ${r.link}`, line);

    // One tap / click on COPY puts exactly the line on the clipboard.
    if (width === 375) await p.tap('#copy'); else await p.click('#copy');
    const clip = await p.evaluate(() => navigator.clipboard.readText());
    check(`COPY is one ${width === 375 ? 'tap' : 'click'} at ${width}`, clip === `music in this video: ${r.link}`, clip);
    check(`COPY confirms at ${width}`, (await p.textContent('#copy')) === 'COPIED');

    // Result page.
    await p.goto(r.link);
    await p.waitForSelector('#tracks .track');
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: `${SHOTS}/result-${width}.png`, fullPage: true });
    check(`result page fits ${width}`, await noOverflow(p));
    const rows = await p.$$eval('#tracks .track', (els) => els.map((el) => ({
      time: el.querySelector('.track-time').textContent,
      title: el.querySelector('.track-title').textContent,
      artist: el.querySelector('.track-artist').textContent,
    })));
    const want = manifest.find((m) => m.file === 'RA_TEST_two_tracks.mp4').expect;
    const clock = (s) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
    check(`result rows in order with start, title, artist at ${width}`,
      rows.length === 2 && rows.every((row, i) => row.title === want[i].title && row.artist === want[i].artist
        && Math.abs(Number(row.time.split(':')[0]) * 60 + Number(row.time.split(':')[1]) - want[i].start_s) <= 1),
      `${JSON.stringify(rows)} want ${want.map((w) => `${clock(w.start_s)} ${w.title}`).join(', ')}`);

    // Stream button: plays the track's catalog URL.
    const btn = p.locator('.play-btn').first();
    if (width === 375) await btn.tap(); else await btn.click();
    await p.waitForFunction(() => window.__audios[0] && window.__audios[0].currentTime > 0.5, null, { timeout: 15000 }).catch(() => {});
    const audio = await p.evaluate(() => ({ src: window.__audios[0]?.src, t: window.__audios[0]?.currentTime ?? 0 }));
    check(`stream button plays at ${width}`, audio.t > 0.5 && audio.src === catalog.find((c) => c.title === want[0].title).stream_url, JSON.stringify(audio));
    await p.screenshot({ path: `${SHOTS}/result-playing-${width}.png`, fullPage: true });
    if (width === 375) await p.tap('#copy'); else await p.click('#copy');
    check(`result page COPY at ${width}`, (await p.evaluate(() => navigator.clipboard.readText())) === `music in this video: ${r.link}`);

    // No match.
    const n = await upload(p, 'RA_TEST_no_music_speech.mp4');
    await p.screenshot({ path: `${SHOTS}/upload-none-${width}.png`, fullPage: true });
    check(`no-match message at ${width}`, n.found === false && (await p.textContent('#none')).includes('We didn’t find any Real Audio music in this video.'));
    await p.context().close();
  }

  // Unknown result link.
  const p404 = await newPage({ width: 375, height: 700 });
  await p404.goto(`${server.origin}/v/Zzzzzzzzzz`);
  await p404.waitForFunction(() => document.getElementById('summary').textContent !== 'Loading…');
  check('unknown result link says so', (await p404.textContent('#summary')).includes('couldn’t find'));
  await p404.screenshot({ path: `${SHOTS}/result-unknown-375.png`, fullPage: true });

  // 5. Every request: this site, or production public Tracks audio (GET).
  const bad = pageRequests.filter(({ method, url }) => {
    const u = new URL(url);
    if (u.origin === server.origin) return false;
    return !(u.host === 'uprfsmwbsvzuoiyfgtgx.supabase.co' && method === 'GET' && url.startsWith(PROD_TRACKS_PREFIX));
  });
  const hosts = [...new Set(pageRequests.map((r) => new URL(r.url).host))];
  check('browser requests: only this site, plus production Tracks audio GETs from Play', bad.length === 0, `hosts ${hosts.join(', ')}${bad.length ? `; bad ${JSON.stringify(bad.slice(0, 3))}` : ''}`);
  const workerHosts = [...new Set(server.workerRequests.map((r) => r.split(' ')[1].split('/')[0]))];
  check('Worker requests: only moonshots', workerHosts.every((h) => h === 'kucwpmtkctafzkivuqtu.supabase.co'), workerHosts.join(', '));
} finally {
  await browser.close();
  await server.close();
}

await writeFile(`${SHOTS}/e2e-results.json`, JSON.stringify(results, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed; screenshots in ${SHOTS}`);
process.exit(failed.length ? 1 : 0);
