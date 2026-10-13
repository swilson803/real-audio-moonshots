// Preview-only demo mode for the upload page (MS-007 Reject 1, CTO-approved):
// /music/?demo=found and /music/?demo=none show a fixture result (fake tracks,
// fake scan id) without choosing a video and without any /api/ request, so
// a preview can be reviewed without uploading anything.
//
// Gating is an allow-list of hosts, so it fails closed: demo runs only on
//   - localhost / 127.0.0.1 / [::1] (local runs and the test harness), and
//   - this Worker's preview URLs, <version or alias>-real-audio-moonshots.
//     spencerrwilson.workers.dev (Workers Builds / versions previews).
// Everywhere else ?demo is ignored and the normal flow runs: the custom
// domain copyrighttester.real.audio, the production workers.dev URL
// real-audio-moonshots.spencerrwilson.workers.dev (no prefix, so it doesn't
// match), and any host added later. /music/ is a static asset (not
// run_worker_first), so the Worker can't pass a preview-only env flag to it
// without changing production routing; the host is all the page can know.

const PREVIEW_HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?-real-audio-moonshots\.spencerrwilson\.workers\.dev$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const DEMO_STATES = ['found', 'none'];
// Fake on its face: never a real scan id (/v/ for it answers "couldn't find").
export const DEMO_ID = 'DEMO000000';

export function demoAllowed(hostname) {
  const host = String(hostname || '').toLowerCase();
  return LOCAL_HOSTS.has(host) || PREVIEW_HOST.test(host);
}

// -> 'found' | 'none' | null, from a Location (or URL).
export function demoState(loc) {
  if (!demoAllowed(loc.hostname)) return null;
  const state = new URLSearchParams(loc.search).get('demo');
  return DEMO_STATES.includes(state) ? state : null;
}

// Fixture tracks, clearly not catalog tracks. stream_url is filled by the
// page with a local silent clip (demoAudioUrl), so Play makes no request.
export const DEMO_MATCHES = [
  { start_s: 4, end_s: 36, track_id: 'demo-0000-0000-0000-000000000001', title: 'Demo Track One (fixture)', artist: 'Demo Artist (not real)' },
  { start_s: 40, end_s: 75, track_id: 'demo-0000-0000-0000-000000000002', title: 'Demo Track Two (fixture)', artist: 'Another Demo Artist (not real)' },
];

// One second of silence as a WAV blob URL (8 kHz, 16-bit mono).
export function demoAudioUrl() {
  const n = 8000;
  const v = new DataView(new ArrayBuffer(44 + n * 2));
  const str = (at, s) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVEfmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 16000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * 2, true);
  return URL.createObjectURL(new Blob([v.buffer], { type: 'audio/wav' }));
}
