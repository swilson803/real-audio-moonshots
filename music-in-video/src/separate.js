// The processor's music/speech separation (MS-007): runs processor/
// separate.py (Demucs htdemucs) on the soundtrack and returns the music
// stem. Node-only (the processor container, the local runs).
//   demucsSeparator({ python }) -> async (samples16k: Float32Array) => Float32Array
// After each run, separate.last = { cpu_ms, peak_mb } of the Python process.
import { spawn } from 'node:child_process';

const SCRIPT = new URL('../processor/separate.py', import.meta.url).pathname;

export function demucsSeparator({ python = process.env.SEPARATION_PYTHON || 'python3', threads } = {}) {
  const separate = (samples) => new Promise((resolve, reject) => {
    const env = { ...process.env, ...(threads ? { SEPARATION_THREADS: String(threads) } : {}) };
    const py = spawn(python, [SCRIPT], { env });
    const out = [];
    let err = '';
    py.stdout.on('data', (d) => out.push(d));
    py.stderr.on('data', (d) => { err += d; });
    py.on('error', reject);
    py.on('close', (code) => {
      if (code !== 0) return reject(new Error(`separation failed (${code}): ${err.trim().slice(-300)}`));
      try { separate.last = JSON.parse(err.trim().split('\n').at(-1)); } catch { separate.last = null; }
      const b = Buffer.concat(out);
      const pcm = new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2));
      return resolve(Float32Array.from(pcm, (s) => s / 32768));
    });
    py.stdin.on('error', () => {});
    // Back to the uploaded integers exactly (body.js decodes them as k / 32768).
    const pcm = Int16Array.from(samples, (s) => Math.max(-32768, Math.min(32767, Math.round(s * 32768))));
    py.stdin.end(Buffer.from(pcm.buffer));
  });
  separate.last = null;
  return separate;
}
