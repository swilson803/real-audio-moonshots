// Extra NEGATIVE videos for tuning (nothing should be found), made offline
// with the same ffmpeg recipe as make-test-videos.mjs:
//   RA_TEST_neg_speech_*   one LibriSpeech speaker each, voice only
//   RA_TEST_neg_synth_*    a speaker over synthetic non-catalog music
//   RA_TEST_neg_loo_*      a speaker over a REAL catalog track, judged with
//                          that track left out of the index
//                          (exclude_track_ids): real music that isn't ours
//   RA_TEST_neg_loo_loud_* the same with the music 6 dB above the voice
//
//   node scripts/make-negatives.mjs --catalog-dir /workspace/ms006/audio-cache \
//     --speech-dir /workspace/ms006/librispeech/LibriSpeech/test-clean \
//     --out /workspace/ms006/videos-dev-neg [--seed 7100]
//
// Speakers are whole LibriSpeech speaker folders (one voice per video).
// Never use seed 6006 (the acceptance seed).
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listAudio, music, video, voice } from './make-test-videos.mjs';
import { rng, synthMusic, wavBytes } from '../test/synth.mjs';

const pick = (list, r) => list.splice(Math.floor(r() * list.length), 1)[0];

async function makeNegatives({ catalogDir, speechDir, outDir, seed = 7100, log = console.log }) {
  if (seed === 6006 || seed === 6007) throw new Error('seed 6006/6007 belong to the acceptance/dev sets');
  const r = rng(seed);
  const catalog = JSON.parse(await readFile(join(catalogDir, 'catalog.json'), 'utf8')).filter((t) => !(t.duration_s < 60));
  const speakers = (await readdir(speechDir)).sort();
  const tmp = join(outDir, '.tmp');
  await mkdir(tmp, { recursive: true });
  const videos = [];
  const one = async (name, levelDb, musicSrc, from, extra = {}) => {
    const spk = pick(speakers, r);
    const v = await voice(await listAudio(join(speechDir, spk)), 60, r, tmp, `${name}.voice`);
    const stems = musicSrc ? [await music(musicSrc, from, 50, 3 + r() * 5, levelDb, tmp, `${name}.music`)] : [];
    const file = `${name}.mp4`;
    await video(v, stems, 60, join(outDir, file));
    videos.push({ file, kind: 'no_music', expect: [], speaker: spk, level_db: musicSrc ? levelDb : null, ...extra });
    log(`made ${file}`);
  };
  for (let i = 1; i <= 4; i++) await one(`RA_TEST_neg_speech_${i}`, null, null, 0);
  for (const [i, level] of [-6, -12, -20].entries()) {
    const src = join(tmp, `synth${i}.wav`);
    await writeFile(src, wavBytes(synthMusic(seed + 50 + i, 58)));
    await one(`RA_TEST_neg_synth_${i + 1}`, level, src, 0);
  }
  const pool = [...catalog];
  for (const [i, level] of [-6, -12, -12, -20, -20, -20].entries()) {
    const t = pick(pool, r);
    await one(`RA_TEST_neg_loo_${i + 1}`, level, join(catalogDir, t.file), Math.max(0, r() * ((t.duration_s ?? 60) - 55)),
      { exclude_track_ids: [t.track_id], left_out: `${t.artist} - ${t.title}` });
  }
  for (let i = 1; i <= 2; i++) {
    const t = pick(pool, r);
    await one(`RA_TEST_neg_loo_loud_${i}`, 6, join(catalogDir, t.file), Math.max(0, r() * ((t.duration_s ?? 60) - 55)),
      { exclude_track_ids: [t.track_id], left_out: `${t.artist} - ${t.title}` });
  }
  await rm(tmp, { recursive: true, force: true });
  await writeFile(join(outDir, 'manifest.json'), JSON.stringify({ seed, made: new Date().toISOString(), videos }, null, 2));
  return videos;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
  await mkdir(opt('--out'), { recursive: true });
  await makeNegatives({ catalogDir: opt('--catalog-dir'), speechDir: opt('--speech-dir'), outDir: opt('--out'), seed: Number(opt('--seed') || 7100) });
}
