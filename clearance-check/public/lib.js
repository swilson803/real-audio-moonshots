// Shared client helpers. The Supabase URL and anon key come from the Worker
// (/api/config) so the page never hard-codes a project; the Worker only ever
// serves the moonshots project.

export const MAX_BYTES = 50 * 1024 * 1024; // matches the clearance-uploads bucket limit
export const BUCKET = 'clearance-uploads';

// Extension -> the MIME type we upload with. Browsers report m4a/wav under
// several names (or none), so the extension decides and the bucket's
// allowed_mime_types (audio/mpeg, audio/wav, audio/mp4, ...) always match.
export const TYPES = { mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4' };

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
  if (file.size > MAX_BYTES) return 'That file is over 50 MB. Use a smaller file.';
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

// Verdict copy, shared shape with the Worker's email (src/verdict.js).
export function verdictFor(row) {
  const flagged = PLATFORMS.filter((p) => row[`${p.key}_result`] !== 'clear');
  if (flagged.length === 0) return { flagged: false, text: 'Looks clear on all three.' };
  const parts = flagged.map((p) => {
    const r = row[`${p.key}_result`];
    return r === 'error' ? `${p.name} couldn’t be checked` : `${p.name} ${r} it`;
  });
  return { flagged: true, text: `Heads up: ${joinList(parts)}.` };
}

function joinList(a) {
  if (a.length <= 1) return a.join('');
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}
