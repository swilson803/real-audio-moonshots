// Makes the MS-006 test videos (RA_TEST_*) with local ffmpeg, plus a
// manifest.json of what each should find. Nothing is uploaded anywhere; the
// videos contain catalog audio, so they stay in test-videos/ (gitignored)
// and are regenerated from the seed, never committed.
//
//   node --env-file=.env scripts/make-test-videos.mjs --speech-dir DIR [options]
//
//   --speech-dir DIR      voice-over clips (.flac / .wav, read recursively);
//                         LibriSpeech test-clean (CC BY 4.0) for the real run
//   --catalog-dir DIR     use DIR/catalog.json ([{ track_id, title, artist, file }])
//                         instead of reading production (anon GET of the
//                         chosen tracks' public audio only; needs
//                         PROD_SUPABASE_ANON_KEY)
//   --two-tracks ID,ID    the two catalog tracks for the two-track video
//                         (default: picked from the seed)
//   --seed N              acceptance seed (default 6006); dev videos use N+1
//   --sweep               also make 5 videos at each of -12/-16/-20/-24/-28 dB
//   --out DIR             default test-videos/
//
// Videos:
//   RA_TEST_two_tracks.mp4     75 s, voice throughout; track A at 0:04 (from
//                              0:30 into it), track B at 0:40 (from 1:00),
//                              32 s each, 12 dB under the voice
//   RA_TEST_no_music_speech.mp4      voice only
//   RA_TEST_no_music_other.mp4       voice + synthetic non-catalog music
//   RA_TEST_quiet_01..10       acceptance: 60 s, voice throughout, one
//                              different catalog track each, 45 s from a
//                              random point, entering at 2-10 s, 20 dB
//                              under the voice. 03 is .mov, 06 has its moov
//                              at the end, 09 is WebM (VP9/Opus).
//   RA_TEST_dev_quiet_01..10   same recipe, dev seed: for tuning thresholds,
//                              so the acceptance videos are never tuned on
// Levels: each stem's integrated loudness is measured (EBU R128) and set with
// a linear gain: voice at -16 LUFS, music at -16 LUFS minus the level.
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { rng, synthMusic, wavBytes } from '../test/synth.mjs';
import { fetchActiveTracks, prodReader } from './lib/targets.mjs';

const run = promisify(execFile);
const VOICE_LUFS = -16;

async function ffmpeg(args) {
  await run('ffmpeg', ['-v', 'error', '-y', ...args], { maxBuffer: 1 << 26 });
}

async function lufs(file) {
  const { stderr } = await run('ffmpeg', ['-nostats', '-i', file, '-af', 'ebur128', '-f', 'null', '-'], { maxBuffer: 1 << 26 });
  const m = stderr.match(/Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+|-inf) LUFS/);
  if (!m || m[1] === '-inf') throw new Error(`no loudness for ${file}`);
  return Number(m[1]);
}

async function duration(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
}

async function listAudio(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await listAudio(p)));
    else if (/\.(flac|wav)$/i.test(e.name)) out.push(p);
  }
  return out.sort();
}

// Voice-over of `seconds`, from seeded clips laid end to end, at VOICE_LUFS.
async function voice(speechFiles, seconds, r, tmp, name) {
  const picked = [];
  let total = 0;
  while (total < seconds) {
    const f = speechFiles[Math.floor(r() * speechFiles.length)];
    picked.push(f);
    total += await duration(f);
  }
  const list = join(tmp, `${name}.txt`);
  await writeFile(list, picked.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'));
  const raw = join(tmp, `${name}.raw.wav`);
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-ac', '1', '-ar', '48000', '-t', String(seconds), raw]);
  const out = join(tmp, `${name}.wav`);
  await ffmpeg(['-i', raw, '-af', `volume=${(VOICE_LUFS - (await lufs(raw))).toFixed(2)}dB`, out]);
  return out;
}

// A music stem: `len` s of `src` from `from`, short fades, at
// VOICE_LUFS + levelDb, delayed to start at `at`.
async function music(src, from, len, at, levelDb, tmp, name) {
  const cut = join(tmp, `${name}.cut.wav`);
  await ffmpeg(['-ss', String(from), '-t', String(len), '-i', src, '-ac', '2', '-ar', '48000',
    '-af', `afade=t=in:d=0.3,afade=t=out:st=${len - 0.5}:d=0.5`, cut]);
  const gain = VOICE_LUFS + levelDb - (await lufs(cut));
  const out = join(tmp, `${name}.wav`);
  await ffmpeg(['-i', cut, '-af', `volume=${gain.toFixed(2)}dB,adelay=${Math.round(at * 1000)}:all=1`, out]);
  return out;
}

// Mix the voice with any music stems and encode with a plain video track.
async function video(voiceWav, musicWavs, seconds, out, variant = 'mp4') {
  const inputs = [voiceWav, ...musicWavs].flatMap((f) => ['-i', f]);
  const n = 1 + musicWavs.length;
  const mix = n === 1
    ? '[0:a]aformat=channel_layouts=stereo,alimiter=limit=0.95[a]'
    : `${[...Array(n).keys()].map((i) => `[${i}:a]`).join('')}amix=inputs=${n}:normalize=0:duration=first,aformat=channel_layouts=stereo,alimiter=limit=0.95[a]`;
  const color = ['-f', 'lavfi', '-i', `color=c=0x1a1a1a:s=1280x720:r=30:d=${seconds}`];
  const vIndex = n;
  const common = [...inputs, ...color, '-filter_complex', mix, '-map', `${vIndex}:v`, '-map', '[a]', '-t', String(seconds)];
  if (variant === 'webm') {
    await ffmpeg([...common, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '300k', '-c:a', 'libopus', '-b:a', '128k', out]);
  } else {
    const faststart = variant === 'moov-at-end' ? [] : ['-movflags', '+faststart'];
    await ffmpeg([...common, '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', ...faststart,
      ...(variant === 'mov' ? ['-f', 'mov'] : []), out]);
  }
}

// A catalog entry's local audio file: given, or fetched once on first use.
const fileOf = async (t) => t.file ?? (t.file = await t.fetchFile());

const expectOf = (t, at) => ({ track_id: t.track_id, title: t.title, artist: t.artist, start_s: at });
const pickDistinct = (list, n, r) => {
  const pool = [...list];
  const out = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  return out;
};

// One quiet-bed video: a catalog track (local file) under the voice.
async function quietVideo({ track, speechFiles, r, levelDb, name, variant, tmp, outDir }) {
  const at = 2 + r() * 8;
  const len = 45;
  const src = await fileOf(track);
  const from = Math.max(0, r() * Math.max(0, (await duration(src)) - len - 2));
  const v = await voice(speechFiles, 60, r, tmp, `${name}.voice`);
  const m = await music(src, from, len, at, levelDb, tmp, `${name}.music`);
  const ext = variant === 'webm' ? 'webm' : variant === 'mov' ? 'mov' : 'mp4';
  const file = `${name}.${ext}`;
  await video(v, [m], 60, join(outDir, file), variant);
  return { file, kind: 'quiet', level_db: levelDb, variant, from_s: Math.round(from * 100) / 100, expect: [expectOf(track, Math.round(at * 100) / 100)] };
}

// catalog: [{ track_id, title, artist, file }] with local audio files, or
// fetchFile() instead of file to download only the tracks actually used.
export async function makeVideos({ catalog, speechFiles, outDir, seed = 6006, twoTracks = null, sweep = false, only = null, log = console.log }) {
  if (catalog.length < 10) throw new Error(`need at least 10 catalog tracks, have ${catalog.length}`);
  await mkdir(outDir, { recursive: true });
  const tmp = join(outDir, '.tmp');
  await mkdir(tmp, { recursive: true });
  const manifest = [];
  const want = (name) => !only || only.includes(name);

  if (want('two_tracks')) {
    const r = rng(seed);
    const [a, b] = twoTracks ? twoTracks.map((id) => catalog.find((t) => t.track_id === id)) : pickDistinct(catalog, 2, r);
    if (!a || !b) throw new Error('--two-tracks: track not in the catalog');
    const v = await voice(speechFiles, 75, r, tmp, 'two.voice');
    const ma = await music(await fileOf(a), 30, 32, 4, -12, tmp, 'two.a');
    const mb = await music(await fileOf(b), 60, 32, 40, -12, tmp, 'two.b');
    await video(v, [ma, mb], 75, join(outDir, 'RA_TEST_two_tracks.mp4'));
    manifest.push({ file: 'RA_TEST_two_tracks.mp4', kind: 'two_tracks', level_db: -12, expect: [expectOf(a, 4), expectOf(b, 40)] });
    log('made RA_TEST_two_tracks.mp4');
  }

  if (want('no_music')) {
    const r = rng(seed + 100);
    await video(await voice(speechFiles, 60, r, tmp, 'none.voice'), [], 60, join(outDir, 'RA_TEST_no_music_speech.mp4'));
    manifest.push({ file: 'RA_TEST_no_music_speech.mp4', kind: 'no_music', expect: [] });
    const other = join(tmp, 'other.wav');
    await writeFile(other, wavBytes(synthMusic(seed + 200, 58)));
    const m = await music(other, 0, 55, 3, -12, tmp, 'none.other');
    await video(await voice(speechFiles, 60, r, tmp, 'none2.voice'), [m], 60, join(outDir, 'RA_TEST_no_music_other.mp4'));
    manifest.push({ file: 'RA_TEST_no_music_other.mp4', kind: 'no_music', expect: [] });
    log('made RA_TEST_no_music_*.mp4');
  }

  const VARIANTS = { 3: 'mov', 6: 'moov-at-end', 9: 'webm' };
  for (const [prefix, s] of [['RA_TEST_quiet', seed], ['RA_TEST_dev_quiet', seed + 1]]) {
    if (!want(prefix.includes('dev') ? 'dev' : 'quiet')) continue;
    const r = rng(s + 300);
    const tracks = pickDistinct(catalog, 10, r);
    for (let i = 0; i < 10; i++) {
      const name = `${prefix}_${String(i + 1).padStart(2, '0')}`;
      manifest.push(await quietVideo({ track: tracks[i], speechFiles, r, levelDb: -20, name, variant: VARIANTS[i + 1] || 'mp4', tmp, outDir }));
      log(`made ${name}`);
    }
  }

  if (sweep) {
    const r = rng(seed + 400);
    for (const level of [-12, -16, -20, -24, -28]) {
      for (const [i, track] of pickDistinct(catalog, 5, r).entries()) {
        const name = `RA_TEST_sweep_${-level}db_${i + 1}`;
        manifest.push(await quietVideo({ track, speechFiles, r, levelDb: level, name, variant: 'mp4', tmp, outDir }));
      }
      log(`made sweep ${level} dB`);
    }
  }

  await rm(tmp, { recursive: true, force: true });
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ seed, made: new Date().toISOString(), videos: manifest }, null, 2));
  return manifest;
}

// Production catalog with lazy downloads: only the tracks the seed picks
// (the two-track pair, 10 acceptance, 10 dev, and the sweep's) are fetched.
async function prodCatalog(dir) {
  const read = prodReader(process.env.PROD_SUPABASE_ANON_KEY);
  await mkdir(dir, { recursive: true });
  return (await fetchActiveTracks(read)).map((t) => ({
    ...t,
    async fetchFile() {
      const file = join(dir, `${t.track_id}${(t.stream_url.match(/\.\w+$/) || ['.audio'])[0]}`);
      await writeFile(file, Buffer.from(await (await read(t.stream_url)).arrayBuffer()));
      return file;
    },
  }));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  const outDir = opt('--out') || new URL('../test-videos/', import.meta.url).pathname;
  const speechDir = opt('--speech-dir');
  if (!speechDir) throw new Error('--speech-dir is required');
  const speechFiles = await listAudio(speechDir);
  let catalog;
  if (opt('--catalog-dir')) {
    const dir = opt('--catalog-dir');
    const list = JSON.parse(await readFile(join(dir, 'catalog.json'), 'utf8'));
    catalog = list.map((t) => ({ ...t, file: join(dir, t.file) }));
  } else {
    catalog = await prodCatalog(join(outDir, '.catalog'));
  }
  await makeVideos({
    catalog,
    speechFiles,
    outDir,
    seed: Number(opt('--seed') || 6006),
    twoTracks: opt('--two-tracks')?.split(','),
    sweep: args.includes('--sweep'),
  });
}
