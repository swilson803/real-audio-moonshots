// Read a video's soundtrack in the browser and fingerprint it as it decodes.
// The video never leaves the device: the file is read in slices, its audio is
// decoded, downmixed, resampled to 16 kHz and fed straight into the
// fingerprinter, so not even the raw audio is kept.
//
// MP4 / MOV / M4V with AAC: mp4box.js demuxes slice by slice (the moov box is
// read first wherever it sits, so a moov at the end costs nothing) and
// WebCodecs decodes.
// Anything else (WebM, or a browser without WebCodecs): the whole file goes to
// decodeAudioData, under a size cap.

import { createFile, MP4BoxBuffer } from './vendor/mp4box/mp4box.all.mjs';
import { Fingerprinter, QUERY, Resampler, SAMPLE_RATE } from './fp.js';

const MAX_SECONDS = 20 * 60;
const SLICE = 4 * 1024 * 1024;
const WHOLE_FILE_MAX = 1024 * 1024 * 1024; // decodeAudioData holds the whole file
const DESCRIPTOR_DECODER_CONFIG = 4;
const DESCRIPTOR_DECODER_SPECIFIC = 5;

export class ExtractError extends Error {
  constructor(code) {
    super(code);
    this.code = code; // 'no-audio' | 'too-long' | 'too-large' | 'unreadable'
  }
}

const isMp4 = (file) => /\.(mp4|mov|m4v)$/i.test(file.name) || /^video\/(mp4|quicktime|x-m4v)$/.test(file.type);

// -> fp.js QUERY fingerprint (peaks, hash-peak flags, hashes) + durationMs
export async function fingerprintVideo(file, onProgress = () => {}) {
  if (isMp4(file) && typeof AudioDecoder !== 'undefined') {
    const viaMp4 = await viaWebCodecs(file, onProgress);
    if (viaMp4) return viaMp4;
  }
  return viaDecodeAudioData(file, onProgress);
}

function mono(planes) {
  if (planes.length === 1) return planes[0];
  const out = new Float32Array(planes[0].length);
  for (const p of planes) for (let i = 0; i < out.length; i++) out[i] += p[i] / planes.length;
  return out;
}

function finish(fp, durationMs) {
  return { ...fp.finish(), durationMs: Math.round(durationMs) };
}

// Top-level boxes [{ type, start, size }] from their headers alone.
async function topLevelBoxes(file) {
  const boxes = [];
  for (let pos = 0; pos + 8 <= file.size;) {
    const head = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (size === 1) size = Number(head.getBigUint64(8));
    else if (size === 0) size = file.size - pos;
    if (size < 8) break;
    boxes.push({ type, start: pos, size: Math.min(size, file.size - pos) });
    pos += size;
  }
  return boxes;
}

// Returns null when this path can't handle the file (not an ISO file, no AAC
// track, codec unsupported), so the caller falls back.
async function viaWebCodecs(file, onProgress) {
  const boxes = await topLevelBoxes(file);
  const moov = boxes.find((b) => b.type === 'moov');
  if (!moov) return null;

  const mp4 = createFile();
  let info;
  mp4.onReady = (i) => { info = i; };
  mp4.onError = () => {};
  const append = async (start, end) => {
    for (let pos = start; pos < end; pos += SLICE) {
      const buf = await file.slice(pos, Math.min(end, pos + SLICE)).arrayBuffer();
      mp4.appendBuffer(MP4BoxBuffer.fromArrayBuffer(buf, pos));
      await waitForDecoder();
    }
  };
  let decoder = null;
  const waitForDecoder = async () => {
    while (decoder && decoder.state === 'configured' && decoder.decodeQueueSize > 64) {
      await new Promise((r) => decoder.addEventListener('dequeue', r, { once: true }));
    }
  };

  // The moov box first, wherever it is in the file (often at the end).
  await append(moov.start, moov.start + moov.size);
  if (!info) return null;
  const track = info.audioTracks?.[0];
  if (!track) throw new ExtractError('no-audio');
  const durationSec = track.duration / track.timescale || info.duration / info.timescale;
  if (durationSec > MAX_SECONDS + 5) throw new ExtractError('too-long');

  const entry = mp4.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0];
  const esds = entry.esds ?? entry.wave?.esds;
  const dsi = esds?.esd?.findDescriptor(DESCRIPTOR_DECODER_CONFIG)?.findDescriptor(DESCRIPTOR_DECODER_SPECIFIC)?.data;
  if (!track.codec.startsWith('mp4a') || !dsi) return null;
  const config = {
    codec: track.codec,
    sampleRate: track.audio.sample_rate,
    numberOfChannels: track.audio.channel_count,
    description: dsi,
  };
  if (!(await AudioDecoder.isConfigSupported(config)).supported) return null;

  const fp = new Fingerprinter(QUERY);
  let resampler = null;
  let decodeError = null;
  decoder = new AudioDecoder({
    output(data) {
      resampler ??= new Resampler(data.sampleRate, SAMPLE_RATE);
      const planes = [];
      for (let c = 0; c < data.numberOfChannels; c++) {
        const p = new Float32Array(data.numberOfFrames);
        data.copyTo(p, { planeIndex: c, format: 'f32-planar' });
        planes.push(p);
      }
      data.close();
      fp.push(resampler.push(mono(planes)));
    },
    error(e) { decodeError = e; },
  });
  decoder.configure(config);

  let decoded = 0;
  mp4.onSamples = (id, _user, samples) => {
    for (const s of samples) {
      decoder.decode(new EncodedAudioChunk({
        type: 'key',
        timestamp: (s.cts * 1e6) / s.timescale,
        duration: (s.duration * 1e6) / s.timescale,
        data: s.data,
      }));
    }
    decoded = samples[samples.length - 1].number + 1;
    mp4.releaseUsedSamples(id, decoded);
    onProgress(Math.min(1, decoded / track.nb_samples));
  };
  mp4.setExtractionOptions(track.id, null, { nbSamples: 200 });
  mp4.start();

  // Then every other box in file order (mdat, or moof/mdat fragments).
  for (const b of boxes) {
    if (b === moov || decodeError) continue;
    await append(b.start, b.start + b.size);
  }
  mp4.flush();
  await decoder.flush();
  decoder.close();
  if (decodeError) throw new ExtractError('unreadable');
  if (!decoded) throw new ExtractError('no-audio');
  return finish(fp, durationSec * 1000);
}

async function viaDecodeAudioData(file, onProgress) {
  if (file.size > WHOLE_FILE_MAX) throw new ExtractError('too-large');
  const ctx = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  let audio;
  try {
    audio = await ctx.decodeAudioData(await file.arrayBuffer()); // resampled to 16 kHz
  } catch {
    throw new ExtractError('no-audio');
  }
  if (audio.duration > MAX_SECONDS + 5) throw new ExtractError('too-long');
  const planes = [];
  for (let c = 0; c < audio.numberOfChannels; c++) planes.push(audio.getChannelData(c));
  const samples = mono(planes);
  const fp = new Fingerprinter(QUERY);
  const step = SAMPLE_RATE * 30;
  for (let i = 0; i < samples.length; i += step) {
    fp.push(samples.subarray(i, i + step));
    onProgress(Math.min(1, (i + step) / samples.length));
    await new Promise((r) => setTimeout(r)); // let the progress text paint
  }
  return finish(fp, audio.duration * 1000);
}
