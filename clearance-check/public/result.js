import { PLATFORMS, getConfig, supabaseHeaders, verdictFor } from './lib.js';

const POLL_MS = 4000;
const id = decodeURIComponent(location.pathname.split('/')[2] || '');
const $ = (x) => document.getElementById(x);
const summary = $('summary');
const verdictBox = $('verdict-box');
const verdict = $('verdict');
const platformsBox = $('platforms-box');
const list = $('platforms');
const footnote = $('footnote');

const LABEL = {
  pending: 'Checking…',
  clear: 'Clear',
  claimed: 'Claimed',
  muted: 'Muted',
  error: 'Couldn’t check',
};

// One row per platform, built once and updated in place.
const rows = {};
for (const p of PLATFORMS) {
  if (list.children.length) {
    const hr = document.createElement('li');
    hr.className = 'sketch-divider divider-quiet';
    hr.setAttribute('aria-hidden', 'true');
    list.appendChild(hr);
  }
  const li = document.createElement('li');
  li.className = 'platform';
  li.dataset.result = 'pending';
  li.innerHTML =
    `<span class="platform-label">` +
      `<img class="platform-icon" src="/icons-runtime/platform-${p.key}.webp" alt="" width="28" height="28">` +
      `<span class="platform-name"></span>` +
    `</span>` +
    `<span class="platform-status"></span>` +
    `<span class="platform-note"></span>`;
  li.querySelector('.platform-name').textContent = p.name;
  list.appendChild(li);
  rows[p.key] = li;
}

let notified = false;

function render(row) {
  platformsBox.hidden = false;
  for (const p of PLATFORMS) {
    const result = row[`${p.key}_result`];
    const li = rows[p.key];
    li.dataset.result = result || 'pending';
    const status = li.querySelector('.platform-status');
    status.dataset.result = result;
    status.textContent = result === 'pending' && row.status === 'queued' ? 'Queued' : LABEL[result] || result;
    li.querySelector('.platform-note').textContent = row[`${p.key}_note`] || '';
  }

  const allIn = PLATFORMS.every((p) => row[`${p.key}_result`] !== 'pending');
  if (allIn) {
    const v = verdictFor(row);
    verdict.textContent = v.text;
    verdict.dataset.flagged = String(v.flagged);
    verdictBox.hidden = false;
  } else {
    verdictBox.hidden = true;
  }

  if (row.status === 'failed') {
    summary.textContent = 'The check didn’t finish. Try uploading again.';
  } else if (row.status === 'done') {
    summary.textContent = row.original_filename ? `Results for ${row.original_filename}` : 'Results are in.';
    footnote.textContent = 'A copy is on its way to your email.';
  } else {
    summary.textContent = row.status === 'queued'
      ? 'Your track is in line. This page updates on its own.'
      : 'Checking now. This page updates on its own.';
    footnote.textContent = 'We’ll email you when all three are in.';
  }

  // The Worker sends the email once (status done + emailed_at null, then sets
  // emailed_at). Asking again on reload is harmless: it no-ops.
  if (row.status === 'done' && !row.emailed_at && !notified) {
    notified = true;
    fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => { notified = false; });
  }
}

async function poll() {
  let done = false;
  try {
    const { supabaseUrl, anonKey } = await getConfig();
    const res = await fetch(
      `${supabaseUrl}/rest/v1/submissions?id=eq.${encodeURIComponent(id)}` +
        '&select=status,original_filename,emailed_at,youtube_result,youtube_note,tiktok_result,tiktok_note,instagram_result,instagram_note',
      { headers: { ...supabaseHeaders(anonKey), 'x-submission-id': id }, cache: 'no-store' },
    );
    if (!res.ok) throw new Error(`select ${res.status}`);
    const [row] = await res.json();
    if (!row) {
      summary.textContent = 'We couldn’t find that check.';
      return;
    }
    render(row);
    done = row.status === 'done' || row.status === 'failed';
  } catch (err) {
    console.error(err);
    summary.textContent = 'Having trouble reaching the checker. Retrying…';
  }
  if (!done) setTimeout(poll, POLL_MS);
}

if (!/^[0-9a-f-]{36}$/i.test(id)) {
  summary.textContent = 'We couldn’t find that check.';
} else {
  poll();
}
