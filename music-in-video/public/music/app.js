// Upload page: read the chosen video's soundtrack on this device, send only
// its fingerprint to the Worker, show the result link and the copy line.
import { ExtractError, fingerprintVideo } from './extract.js';
import { showCopyLine } from './copy.js';
import { encodeScanBody } from './body.js';

const $ = (id) => document.getElementById(id);
const form = $('scan-form');
const fileInput = $('file');
const filePick = $('file-pick');
const filePickLabel = filePick.querySelector('.file-pick-label');
const fileName = $('file-name');
const fileError = $('file-error');
const statusEl = $('status');
const formError = $('form-error');
const submit = $('submit');

const TYPES = /\.(mp4|mov|m4v|webm)$/i;
// Matching normally takes a few seconds; the first scan after the catalog
// database has been idle can take much longer (the Worker retries it). Past
// STILL_WORKING_MS the page says so and keeps waiting.
const STILL_WORKING_MS = 5000;
const STILL_WORKING = 'Still working… this can take up to a minute.';
const BUSY = 'The Real Audio catalog is taking too long to answer. Try again in a minute.';

const MESSAGES = {
  'no-audio': 'We couldn’t find a soundtrack in that video.',
  'too-long': 'That video is longer than 20 minutes. Try a shorter one.',
  'too-large': 'That video is too large to read here. Try an MP4 or MOV.',
  unreadable: 'We couldn’t read that video. Try exporting it as MP4.',
};

function validate(file) {
  if (!file) return 'Choose a video file.';
  if (!TYPES.test(file.name)) return 'That file type isn’t supported. Use MP4, MOV, M4V or WebM.';
  if (file.size === 0) return 'That file is empty.';
  return null;
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileName.textContent = file ? file.name : 'No file chosen';
  filePick.classList.toggle('has-file', Boolean(file));
  filePickLabel.textContent = file ? 'VIDEO CHOSEN' : 'CHOOSE VIDEO';
  fileError.textContent = file ? validate(file) || '' : '';
});

function showResult(result) {
  form.hidden = true;
  if (!result.found) {
    $('none').hidden = false;
    return;
  }
  const n = result.matches.length;
  $('found-summary').textContent = `We found ${n} Real Audio track${n === 1 ? '' : 's'} in your video.`;
  const link = `${location.origin}/v/${result.id}`;
  showCopyLine($('copy-line'), $('copy'), link);
  $('open-result').href = link;
  $('found').hidden = false;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';
  const file = fileInput.files[0];
  const err = validate(file);
  fileError.textContent = err || '';
  if (err) return;

  submit.disabled = true;
  submit.textContent = 'LISTENING…';
  statusEl.textContent = 'Reading the soundtrack…';
  try {
    const fp = await fingerprintVideo(file, (p) => {
      statusEl.textContent = `Reading the soundtrack… ${Math.round(p * 100)}%`;
    });
    statusEl.textContent = 'Matching against the Real Audio catalog…';
    const headers = { 'Content-Type': 'application/octet-stream' };
    // Test videos (RA_TEST_...) are labelled so their scans can be cleared.
    if (/^RA_TEST_[A-Za-z0-9._-]{1,80}$/.test(file.name)) headers['x-scan-label'] = file.name;
    const slow = setTimeout(() => { statusEl.textContent = STILL_WORKING; }, STILL_WORKING_MS);
    let res;
    try {
      res = await fetch('/api/scan', { method: 'POST', headers, body: encodeScanBody(fp) });
    } finally {
      clearTimeout(slow);
    }
    if (res.status === 503 && (await res.clone().json().catch(() => ({}))).error === 'busy') throw new Error('busy');
    if (!res.ok) throw new Error(`scan ${res.status}`);
    statusEl.textContent = '';
    showResult(await res.json());
  } catch (error) {
    console.error(error);
    statusEl.textContent = '';
    if (error instanceof ExtractError) formError.textContent = MESSAGES[error.code];
    else formError.textContent = error.message === 'busy' ? BUSY : 'Something went wrong. Try again.';
  } finally {
    submit.disabled = false;
    submit.textContent = 'FIND MY MUSIC';
    // Done with the video: drop the page's only reference to it.
    if (form.hidden) fileInput.value = '';
  }
});
