// POST /api/scan body (MS-007), shared by the page (encode), the Worker
// (checks it before queueing) and the processor (decode). The page sends the
// video's soundtrack as it already reads it: mono, 16 kHz, 16-bit, about
// 1.9 MB a minute (38.4 MB for 20 minutes). The picture never leaves the
// device, and the soundtrack is deleted once checked. Layout, little-endian:
//   bytes 0-3   'MS7A'
//   u32         BODY_VERSION
//   u32         sample rate (fp.js SAMPLE_RATE)
//   u32         duration_ms (of the video's audio track)
//   u32         n, the number of samples
//   int16 x n   the samples
import { SAMPLE_RATE } from './fp.js';

export const BODY_VERSION = 1;
export const HEADER_BYTES = 20;
export const MAX_DURATION_MS = 20 * 60 * 1000 + 5000; // 20 minutes, plus slack for container rounding
const MAGIC = 0x4137534d; // 'MS7A' read as a little-endian u32

// The page pushes each resampled chunk as it decodes, so the soundtrack is
// only ever held once, as 16-bit samples.
export class PcmCollector {
  constructor() {
    this.chunks = [];
    this.n = 0;
  }

  push(samples) {
    const out = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      out[i] = Math.round(s * 32767);
    }
    this.chunks.push(out);
    this.n += out.length;
  }

  // -> the body as a list of parts (a Blob in the page, joined in Node).
  finish(durationMs) {
    const head = new DataView(new ArrayBuffer(HEADER_BYTES));
    head.setUint32(0, MAGIC, true);
    head.setUint32(4, BODY_VERSION, true);
    head.setUint32(8, SAMPLE_RATE, true);
    head.setUint32(12, Math.round(durationMs), true);
    head.setUint32(16, this.n, true);
    const parts = [head.buffer, ...this.chunks.map((c) => c.buffer)];
    this.chunks = [];
    return { parts, bytes: HEADER_BYTES + this.n * 2, durationMs: Math.round(durationMs) };
  }
}

// The header alone: { version, sampleRate, durationMs, n } or null if it isn't
// one, or the length doesn't add up (the Worker checks this before storing).
export function readScanHeader(buf, byteLength = buf.byteLength) {
  if (buf.byteLength < HEADER_BYTES) return null;
  const v = new DataView(buf, 0, HEADER_BYTES);
  if (v.getUint32(0, true) !== MAGIC) return null;
  const head = { version: v.getUint32(4, true), sampleRate: v.getUint32(8, true), durationMs: v.getUint32(12, true), n: v.getUint32(16, true) };
  return byteLength === HEADER_BYTES + head.n * 2 ? head : null;
}

// -> { version, sampleRate, durationMs, samples: Float32Array } or null.
export function decodeScanBody(buf) {
  const head = readScanHeader(buf);
  if (!head) return null;
  const pcm = new Int16Array(buf.slice(HEADER_BYTES));
  const samples = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) samples[i] = pcm[i] / 32768;
  return { ...head, samples };
}
