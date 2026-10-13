// The catalog reference copy (MS-007): each indexed track as raw mono 16-bit
// little-endian PCM at REFINE.RATE (8 kHz), one object per track named
// <track_id>.s16le, built from the local audio cache by
// scripts/build-ref-audio.mjs. src/refine.js reads a matched track whole
// (about 1.4 MB for a 3-minute track) to find where it lines up.
//   localRef(dir)  files on disk (the scored run, tests)
//   r2Ref(...)     the private R2 bucket, read with a read-only R2 API token
//                  (S3 API, SigV4 GET); the processor container
// Both: track(trackId) -> Float32Array of the whole track.
import { createHash, createHmac } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const refKey = (trackId) => `${trackId}.s16le`;

function toFloat(bytes) {
  const pcm = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = pcm.getInt16(i * 2, true) / 32768;
  return out;
}

export function localRef(dir) {
  return { track: async (trackId) => toFloat(await readFile(join(dir, refKey(trackId)))) };
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// AWS Signature Version 4 headers for a GET with no body (R2's S3 API uses
// region "auto"). Exported for the test against AWS's published example.
export function signGet({ url, accessKeyId, secretAccessKey, region = 'auto', service = 's3', headers = {}, date = new Date() }) {
  const u = new URL(url);
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': sha256('') };
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const query = [...u.searchParams].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonical = ['GET', u.pathname, query, names.map((k) => `${k}:${lower[k]}\n`).join(''), names.join(';'), lower['x-amz-content-sha256']].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');
  return {
    ...Object.fromEntries(Object.entries(all).filter(([k]) => k !== 'host')),
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}

// endpoint: https://<account id>.r2.cloudflarestorage.com
export function r2Ref({ endpoint, bucket, accessKeyId, secretAccessKey, fetchFn = fetch }) {
  return {
    async track(trackId) {
      const url = `${endpoint.replace(/\/+$/, '')}/${bucket}/${refKey(trackId)}`;
      const res = await fetchFn(url, { headers: signGet({ url, accessKeyId, secretAccessKey }) });
      if (!res.ok) throw new Error(`reference ${refKey(trackId)}: R2 ${res.status}`);
      return toFloat(new Uint8Array(await res.arrayBuffer()));
    },
  };
}
