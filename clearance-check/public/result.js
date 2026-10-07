import { PLATFORMS, getConfig, supabaseHeaders, verdictFor } from './lib.js';

const POLL_MS = 4000;
const id = decodeURIComponent(location.pathname.split('/')[2] || '');
const $ = (x) => document.getElementById(x);
const summary = $('summary');
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

// Reject3: Spencer's PASSED / FAILED stamps replace the pass/fail text in the
// headline and next to each platform. Alt text keeps the exact result.
const STAMP = { passed: '/brand-assets/stamps/passed.webp', failed: '/brand-assets/stamps/failed.webp' };
const STAMPED = { clear: 'passed', claimed: 'failed', muted: 'failed' };

// Put a stamp in el (reusing it if it's already the same one).
function setStamp(el, kind, alt, cls) {
  const img = el.querySelector('img.stamp');
  if (img && img.dataset.kind === kind && img.alt === alt) return;
  const next = document.createElement('img');
  next.className = `stamp ${cls}`;
  next.src = STAMP[kind];
  next.alt = alt;
  next.title = alt;
  next.dataset.kind = kind;
  el.replaceChildren(next);
}

// Reject5: a platform's FAILED stamp carries that platform's context (the bot's
// note, else the result) in Creator's branded hover tooltip (.download-nudge-tip,
// re-anchored like its .source-badge-tip). Touch has no :hover, so a tap toggles
// it open, and a tap anywhere else closes it (same as Creator's SourceBadge).
function setFailedStamp(el, alt, context) {
  const btn = el.querySelector('.platform-stamp');
  if (btn && btn.dataset.alt === alt && btn.dataset.context === context) return;
  const next = document.createElement('button');
  next.type = 'button';
  next.className = 'platform-stamp';
  next.dataset.alt = alt;
  next.dataset.context = context;
  const img = document.createElement('img');
  img.className = 'stamp stamp-platform';
  img.src = STAMP.failed;
  img.alt = alt;
  img.dataset.kind = 'failed';
  const tip = document.createElement('span');
  tip.className = 'download-nudge-tip platform-stamp-tip';
  tip.setAttribute('role', 'tooltip');
  tip.textContent = context;
  next.append(img, tip);
  next.setAttribute('aria-label', `${alt}: ${context}`);
  next.addEventListener('click', () => {
    const open = !next.classList.contains('is-open');
    document.querySelectorAll('.platform-stamp.is-open').forEach((b) => b.classList.remove('is-open'));
    next.classList.toggle('is-open', open);
  });
  el.replaceChildren(next);
}
document.addEventListener('pointerdown', (e) => {
  document.querySelectorAll('.platform-stamp.is-open').forEach((b) => {
    if (!b.contains(e.target)) b.classList.remove('is-open');
  });
});

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
      `<img class="platform-icon" src="/icons-runtime/platform-${p.key}.webp" alt="">` +
      `<span class="platform-name"></span>` +
    `</span>` +
    `<span class="platform-status"></span>`;
  li.querySelector('.platform-name').textContent = p.name;
  list.appendChild(li);
  rows[p.key] = li;
}

function render(row) {
  platformsBox.hidden = false;
  for (const p of PLATFORMS) {
    const result = row[`${p.key}_result`];
    const li = rows[p.key];
    li.dataset.result = result || 'pending';
    const status = li.querySelector('.platform-status');
    status.dataset.result = result;
    if (STAMPED[result] === 'failed') setFailedStamp(status, LABEL[result], row[`${p.key}_note`] || LABEL[result]);
    else if (STAMPED[result]) setStamp(status, STAMPED[result], LABEL[result], 'stamp-platform');
    else status.textContent = result === 'pending' && row.status === 'queued' ? 'Queued' : LABEL[result] || result;
  }

  const allIn = PLATFORMS.every((p) => row[`${p.key}_result`] !== 'pending');
  if (allIn) {
    const v = verdictFor(row);
    setStamp(verdict, v.flagged ? 'failed' : 'passed', v.headline, 'stamp-headline');
    verdict.dataset.flagged = String(v.flagged);
  } else {
    // Until all three are in, the red half of the headline is the progress.
    verdict.textContent = row.status === 'failed' ? LABEL.error : row.status === 'queued' ? 'Queued' : LABEL.pending;
    delete verdict.dataset.flagged;
  }

  if (row.status === 'failed') {
    summary.textContent = 'The check didn’t finish. Try uploading again.';
    footnote.textContent = '';
  } else if (row.status === 'done') {
    if (row.original_filename) {
      // Reject1: track name in brand red.
      const track = document.createElement('span');
      track.className = 'track-name';
      track.textContent = row.original_filename;
      summary.replaceChildren('Results for ', track);
    } else {
      summary.textContent = 'Results are in.';
    }
    footnote.textContent = 'A copy is on its way to your email.';
  } else {
    // Reject9: fold email note into the status line (no separate footnote).
    const base = row.status === 'queued'
      ? 'Your track is in line. This page updates on its own.'
      : 'Checking now. This page updates on its own.';
    summary.textContent = base + ' We’ll email you when all three are in.';
    footnote.textContent = '';
  }
}

async function poll() {
  let done = false;
  try {
    const { supabaseUrl, anonKey } = await getConfig();
    const res = await fetch(
      `${supabaseUrl}/rest/v1/submissions?id=eq.${encodeURIComponent(id)}` +
        '&select=status,original_filename,youtube_result,youtube_note,tiktok_result,tiktok_note,instagram_result,instagram_note',
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

const EMAIL_KEY = 'clearance-check-email';
const again = document.getElementById('again');
if (again) {
  const saved = sessionStorage.getItem(EMAIL_KEY);
  if (saved) again.href = `/?email=${encodeURIComponent(saved)}`;
}
