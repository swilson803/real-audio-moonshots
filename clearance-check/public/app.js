import { BUCKET, TYPES, getConfig, supabaseHeaders, validateEmail, validateFile } from './lib.js';

const form = document.getElementById('check-form');
const fileInput = document.getElementById('file');
const filePick = document.getElementById('file-pick');
const fileName = document.getElementById('file-name');
const fileError = document.getElementById('file-error');
const emailInput = document.getElementById('email');
const emailError = document.getElementById('email-error');
const formError = document.getElementById('form-error');
const submit = document.getElementById('submit');

const EMAIL_KEY = 'clearance-check-email';

// Reject9: prefill email from ?email= or the address just used on a prior check.
(() => {
  const params = new URLSearchParams(location.search);
  const fromQuery = params.get('email');
  const fromSession = sessionStorage.getItem(EMAIL_KEY);
  const seed = (fromQuery || fromSession || '').trim();
  if (seed && !emailInput.value) emailInput.value = seed;
})();


function showFileError(msg) {
  fileError.textContent = msg || '';
}
function showEmailError(msg) {
  emailError.textContent = msg || '';
  emailInput.classList.toggle('error', Boolean(msg));
}

const filePickLabel = filePick.querySelector('.file-pick-label');

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0];
  fileName.textContent = file ? file.name : 'No file chosen';
  filePick.classList.toggle('has-file', Boolean(file));
  if (filePickLabel) filePickLabel.textContent = file ? 'FILE UPLOADED' : 'CHOOSE FILE';
  showFileError(file ? validateFile(file) : null);
});
emailInput.addEventListener('input', () => {
  if (emailError.textContent) showEmailError(validateEmail(emailInput.value.trim()));
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  formError.textContent = '';
  const file = fileInput.files[0];
  const email = emailInput.value.trim();
  const fErr = validateFile(file);
  const eErr = validateEmail(email);
  showFileError(fErr);
  showEmailError(eErr);
  if (fErr || eErr) return;

  submit.disabled = true;
  submit.textContent = 'UPLOADING…';
  try {
    const { supabaseUrl, anonKey } = await getConfig();
    const id = crypto.randomUUID();
    const ext = file.name.split('.').pop().toLowerCase();
    const safeName = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(-120) || `upload.${ext}`;
    const objectName = `${id}/${safeName}`;
    const auth = supabaseHeaders(anonKey);

    const up = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${objectName}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': TYPES[ext], 'x-upsert': 'false' },
      body: file,
    });
    // Reject13: real storage returns HTTP 400 + EntityTooLarge / statusCode 413 body
    // (not always bare 413). Map both to the existing size inline copy.
    const upBodyText = await up.text();
    let upBody = {};
    try { upBody = JSON.parse(upBodyText); } catch { /* non-JSON */ }
    const overLimit = up.status === 413
      || String(upBody.statusCode) === '413'
      || upBody.code === 'EntityTooLarge'
      || /payload too large|exceeded the maximum allowed size/i.test(upBodyText)
      || /EntityTooLarge/i.test(upBodyText);
    if (overLimit) throw new Error('too-large');
    if (!up.ok) throw new Error(`upload ${up.status}`);

    const ins = await fetch(`${supabaseUrl}/rest/v1/submissions`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': 'application/json', Prefer: 'return=minimal', 'x-submission-id': id },
      body: JSON.stringify({ id, email, original_filename: file.name, storage_path: `${BUCKET}/${objectName}` }),
    });
    if (!ins.ok) throw new Error(`insert ${ins.status}`);

    sessionStorage.setItem(EMAIL_KEY, email);
    window.location.assign(`/r/${id}`);
  } catch (err) {
    console.error(err);
    if (err.message === 'too-large') showFileError('That file is too large for the checker. Try a smaller file.');
    else formError.textContent = err.message === 'config'
      ? 'Uploads aren’t available right now. Try again later.'
      : 'Something went wrong uploading. Try again.';
    submit.disabled = false;
    submit.textContent = 'CHECK MY TRACK';
  }
});
