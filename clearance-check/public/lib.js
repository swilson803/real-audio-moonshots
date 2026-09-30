// Shared client helpers. The Supabase URL and anon key come from the Worker
// (/api/config) so the page never hard-codes a project; the Worker only ever
// serves the moonshots project.

export const BUCKET = 'clearance-uploads';

// Extension -> the MIME type we upload with. Browsers report m4a/wav under
// several names (or none), so the extension decides and the bucket's
// allowed_mime_types (audio/mpeg, audio/wav, audio/mp4, ...) always match.
export const TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' };

// Supabase key headers. A legacy anon/service_role key is a JWT and goes in
// both apikey and Authorization. The newer sb_publishable_/sb_secret_ keys are
// not JWTs: sending one as a Bearer token is rejected, so they go in apikey
// only and the API gateway supplies the role.
export function supabaseHeaders(key) {
  return key.startsWith('eyJ') ? { apikey: key, Authorization: `Bearer ${key}` } : { apikey: key };
}

export const PLATFORMS = [
  { key: 'youtube', name: 'YouTube' },
  { key: 'tiktok', name: 'TikTok' },
  { key: 'instagram', name: 'Instagram' },
];

export function validateFile(file) {
  if (!file) return 'Choose an audio file.';
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (!TYPES[ext]) return 'That file type isn’t supported. Use MP3, WAV, or M4A.';
  if (file.size === 0) return 'That file is empty.';
  return null;
}

export function validateEmail(email) {
  if (!email) return 'Enter your email.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Enter a valid email.';
  return null;
}

let configPromise;
export function getConfig() {
  configPromise ??= fetch('/api/config').then((r) => {
    if (!r.ok) throw new Error('config');
    return r.json();
  });
  return configPromise;
}

// Verdict copy, shared with the Worker's results email (src/email.js).
export function verdictFor(row) {
  const flagged = PLATFORMS.filter((p) => row[`${p.key}_result`] !== 'clear');
  // headline: the red half of "Your result:" on the page and email (Reject2).
  if (flagged.length === 0) return { flagged: false, headline: 'PASSED', text: 'Looks clear on all three.' };
  const parts = flagged.map((p) => {
    const r = row[`${p.key}_result`];
    return r === 'error' ? `${p.name} couldn’t be checked` : `${p.name} ${r} it`;
  });
  return { flagged: true, headline: 'FAILED', text: `Heads up: ${joinList(parts)}.` };
}

function joinList(a) {
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}
