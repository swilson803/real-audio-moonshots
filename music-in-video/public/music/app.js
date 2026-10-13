// Upload page: read the chosen video's soundtrack on this device, send only
// the soundtrack (never the picture), then wait while the server checks it:
// "Still working…" until the result, however long that takes. Shows the
// result link and the copy line, as in MS-006.
import { ExtractError, readSoundtrack } from './extract.js';
import { showCopyLine } from './copy.js';

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
// Checking normally takes a few seconds; a cold start (the processor or the
// catalog database waking up) can take much longer, and the server retries
// it. Past STILL_WORKING_MS the page says so and keeps waiting: there is no
// client-side time limit, and every job ends done or failed on the server.
const STILL_WORKING_MS = 5000;
const STILL_WORKING = 'Still working… this can take up to a minute.';
// Poll every POLL_MS, slowing to POLL_MAX_MS.
const POLL_MS = 2000;
const POLL_MAX_MS = 5000;
const FAILED = 'Something went wrong. Try again.';

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

// POST the soundtrack with upload progress -> the job id.
function upload(body, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/scan');
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status !== 202) return reject(new Error(`scan ${xhr.status}`));
      try { resolve(JSON.parse(xhr.responseText).id); } catch (err) { reject(err); }
    };
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.send(new Blob(body.parts, { type: 'application/octet-stream' }));
  });
}

// Until the job is done or failed. A poll that fails (network, a busy
// server) is just tried again.
async function waitFor(id) {
  for (let wait = POLL_MS; ; wait = Math.min(POLL_MAX_MS, wait + 1000)) {
    await new Promise((r) => setTimeout(r, wait));
    try {
      const res = await fetch(`/api/scans/${id}/status`, { cache: 'no-store' });
      if (!res.ok) continue;
      const s = await res.json();
      if (s.status === 'done' || s.status === 'failed') return s;
    } catch { /* try again */ }
  }
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
  const reading = (p) => { statusEl.textContent = `Reading the soundtrack… ${Math.round(p * 100)}%`; };
  try {
    // Reading is the first half of the progress, sending the second.
    let body = await readSoundtrack(file, (p) => reading(p / 2));
    const headers = {};
    // Test videos (RA_TEST_...) are labelled so their scans can be cleared.
    if (/^RA_TEST_[A-Za-z0-9._-]{1,80}$/.test(file.name)) headers['x-scan-label'] = file.name;
    const id = await upload(body, headers, (p) => reading(0.5 + p / 2));
    body = null;
    statusEl.textContent = 'Matching against the Real Audio catalog…';
    const slow = setTimeout(() => { statusEl.textContent = STILL_WORKING; }, STILL_WORKING_MS);
    let result;
    try {
      result = await waitFor(id);
    } finally {
      clearTimeout(slow);
    }
    statusEl.textContent = '';
    if (result.status === 'failed') throw new ExtractError(MESSAGES[result.error] ? result.error : 'failed');
    showResult({ found: result.found, id, matches: result.matches ?? [] });
  } catch (error) {
    console.error(error);
    statusEl.textContent = '';
    formError.textContent = (error instanceof ExtractError && MESSAGES[error.code]) || FAILED;
  } finally {
    submit.disabled = false;
    submit.textContent = 'FIND MY MUSIC';
    // Done with the video: drop the page's only reference to it.
    if (form.hidden) fileInput.value = '';
  }
});
