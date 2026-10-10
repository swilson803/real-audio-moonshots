// Builds the catalog reference copy for src/refine.js (MS-007): every track in
// the index build's audio cache as raw mono 16-bit little-endian PCM at
// REFINE.RATE (8 kHz), <track_id>.s16le, plus manifest.json (track ids,
// bytes, samples, sha256, total). Local only: reads the cache made by
// scripts/build-catalog-index.mjs (no production request of any kind) and
// writes OUT; uploading OUT to the private R2 bucket is a separate, approved
// step (the Cloudflare runbook).
//
//   node scripts/build-ref-audio.mjs --cache-dir /workspace/ms006/audio-cache --out /workspace/ms007/ref
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REFINE } from '../src/refine.js';
import { refKey } from '../src/ref.js';

function decode(file) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(REFINE.RATE), '-f', 's16le', 'pipe:1']);
    const out = [];
    let err = '';
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg ${code}: ${err.trim().slice(0, 300)}`))));
  });
}

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };

export async function buildRefAudio({ cacheDir, out, threads = 4, log = console.log }) {
  const catalog = JSON.parse(await readFile(join(cacheDir, 'catalog.json'), 'utf8'));
  await mkdir(out, { recursive: true });
  const tracks = new Array(catalog.length);
  let next = 0;
  await Promise.all(Array.from({ length: threads }, async () => {
    while (next < catalog.length) {
      const i = next++;
      const t = catalog[i];
      const dest = join(out, refKey(t.track_id));
      let pcm;
      if (await exists(dest)) pcm = await readFile(dest);
      else {
        pcm = await decode(join(cacheDir, t.file));
        await writeFile(`${dest}.part`, pcm);
        await rename(`${dest}.part`, dest);
      }
      tracks[i] = {
        track_id: t.track_id, title: t.title, key: refKey(t.track_id), bytes: pcm.length,
        samples: pcm.length / 2, duration_s: Math.round((pcm.length / 2 / REFINE.RATE) * 100) / 100,
        sha256: createHash('sha256').update(pcm).digest('hex'),
      };
      log(`  [${tracks.filter(Boolean).length}/${catalog.length}] ${t.title}: ${pcm.length} B`);
    }
  }));
  const manifest = {
    format: 's16le', channels: 1, rate: REFINE.RATE, built_at: new Date().toISOString(),
    source: 'local audio cache of the MS-006 index build (no production request)',
    track_count: tracks.length, total_bytes: tracks.reduce((n, t) => n + t.bytes, 0), tracks,
  };
  await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  if (!opt('--cache-dir') || !opt('--out')) throw new Error('usage: --cache-dir DIR --out DIR [--threads N]');
  const m = await buildRefAudio({ cacheDir: opt('--cache-dir'), out: opt('--out'), threads: Number(opt('--threads') || 4) });
  console.log(`reference copy: ${m.track_count} tracks, ${m.total_bytes} bytes`);
}
