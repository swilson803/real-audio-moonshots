// A video's POST /api/scan body made the way the upload page makes it
// (public/music/extract.js), in Node: the audio track decoded at its own
// rate, the channels averaged, fp.js's Resampler to 16 kHz, then body.js's
// PcmCollector. ffmpeg stands in for the browser's decoders (WebCodecs AAC,
// or decodeAudioData for WebM, which resamples with the browser's own
// resampler: the one place this differs).
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Resampler, SAMPLE_RATE } from '../../public/music/fp.js';
import { PcmCollector } from '../../public/music/body.js';

const run = promisify(execFile);

async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels,duration:format=duration', '-of', 'json', file]);
  const j = JSON.parse(stdout);
  const s = j.streams?.[0];
  if (!s) throw new Error(`${file}: no audio track`);
  return { rate: Number(s.sample_rate), channels: Number(s.channels), durationS: Number(s.duration ?? j.format.duration) };
}

// -> { body: ArrayBuffer, bytes, durationMs }
export async function soundtrackBody(file) {
  const { rate, channels, durationS } = await probe(file);
  const resampler = new Resampler(rate, SAMPLE_RATE);
  const pcm = new PcmCollector();
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a:0', '-f', 'f32le', 'pipe:1']);
    let rest = Buffer.alloc(0);
    let err = '';
    const frameBytes = 4 * channels;
    ff.stdout.on('data', (d) => {
      const buf = rest.length ? Buffer.concat([rest, d]) : d;
      const frames = Math.floor(buf.length / frameBytes);
      rest = buf.subarray(frames * frameBytes);
      const mono = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += buf.readFloatLE((i * channels + c) * 4);
        mono[i] = s / channels;
      }
      pcm.push(resampler.push(mono));
    });
    ff.stderr.on('data', (d) => { err += d; });
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}: ${err.trim().slice(0, 300)}`))));
  });
  const { parts, bytes, durationMs } = pcm.finish(durationS * 1000);
  const body = Buffer.concat(parts.map((p) => Buffer.from(p)));
  return { body: body.buffer.slice(body.byteOffset, body.byteOffset + body.length), bytes, durationMs };
}
