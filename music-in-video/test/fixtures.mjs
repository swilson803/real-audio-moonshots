// A synthetic catalog for the tests: seeded tracks, fingerprinted with the
// real fp.js, indexed in memory the way ms006_fp is in Postgres.
import { fingerprint } from '../public/music/fp.js';
import { PcmCollector } from '../public/music/body.js';
import { buildIndex, clustersInMemory, trackWindowInMemory } from '../src/match.js';
import { synthMusic } from './synth.mjs';

export function syntheticCatalog(n = 12, seconds = 90) {
  const tracks = Array.from({ length: n }, (_, i) => ({ tid: i + 1, audio: synthMusic(1001 + i, seconds) }));
  const fps = tracks.map((t) => ({ tid: t.tid, ...fingerprint(t.audio) }));
  const index = buildIndex(fps);
  const byTid = new Map(fps.map((f) => [f.tid, f]));
  return {
    tracks,
    fps,
    deps: {
      lookup: async (hashes, times) => clustersInMemory(index, hashes, times),
      trackWindow: async (tid, from, to) => trackWindowInMemory(byTid, tid, from, to),
    },
  };
}

// The POST /api/scan body the page would send for 16 kHz samples.
export function bodyOf(samples, durationMs = Math.round(samples.length / 16)) {
  const pcm = new PcmCollector();
  pcm.push(samples);
  const b = Buffer.concat(pcm.finish(durationMs).parts.map((p) => Buffer.from(p)));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
}
