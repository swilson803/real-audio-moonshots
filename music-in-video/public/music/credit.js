// The credit block on the upload page (MS-007 Reject 1): "Where are you
// posting?", a tab per platform, and the credit box that IS the copy action.
// It mirrors real-audio-creator's download-modal AccreditationSection
// (src/components/AccreditationSection.tsx @145d66d) as plain DOM: same tabs,
// strings and copy behaviour. The credit text follows that site's
// buildCredit (supabase/functions/_shared/accreditation.ts) per track, with
// two differences: the link is this scan's /v/<id> short link (one link for
// every track; /t/<code> links need a production download), and the
// short-form credits end with Real Audio's tag on that platform. moonshots
// has no platform sound URLs or artist handles, so every tab is the
// paste-a-credit branch (no "Open sound on …" button or sound notes).
//
// The pure part (TABS, CREDIT_LOCATION, creditText) touches no DOM, so the
// unit tests import it in Node.

export const TABS = [
  { value: 'universal', label: 'YT / FB / X / Twitch', medium: 'description' },
  { value: 'tiktok', label: 'TikTok', medium: 'short', tag: '@r3al_audio' },
  { value: 'instagram', label: 'Instagram', medium: 'short', tag: '@r3al.audio' },
  { value: 'youtube_shorts', label: 'YouTube Shorts', medium: 'short', tag: '@r3al.audi0' },
];

// Where the creator pastes the credit, per medium (main's CREDIT_LOCATION).
export const CREDIT_LOCATION = { description: 'description', short: 'caption' };

// -> the credit text for one tab: a line per track (first appearance, video
// order; a track heard twice is credited once), then the link (description)
// or the platform tag at the end of the last line (short).
export function creditText(tab, matches, link) {
  const seen = new Set();
  const tracks = matches.filter((m) => !seen.has(m.track_id) && seen.add(m.track_id));
  if (tab.medium === 'description') {
    return [...tracks.map((t) => `Music: "${t.title}" by ${t.artist}`), link].join('\n');
  }
  return `${tracks.map((t) => `${t.title} ${t.artist} [real.audio]`).join('\n')} ${tab.tag}`;
}

// Synchronous copy via a hidden textarea, inside the click gesture (main's
// syncCopy). Focus returns to the box afterwards.
function syncCopy(text, anchor) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  (anchor.parentElement ?? document.body).appendChild(ta);
  try {
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    ta.remove();
    anchor.focus({ preventScroll: true });
  }
}

const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
};

// The credit box (main's CopyBlock): shows the credit; a brand-red "Copy"
// overlay on hover; a click flips it to "Copied!" at once (not waiting on the
// clipboard), held for at least 2 s and, while the pointer is still on the
// box, until it leaves.
function copyBlock(text) {
  const box = el('button', 'download-accred');
  box.type = 'button';
  const shown = el('span', 'accred-text', text);
  const overlay = el('span', 'accred-overlay', 'Copy');
  overlay.setAttribute('aria-hidden', 'true');
  const status = el('span', 'sr-only');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  box.append(shown, overlay, status);

  let hover = false;
  let minElapsed = true;
  let timer;
  const set = (copied) => {
    box.dataset.copied = String(copied);
    box.setAttribute('aria-label', copied ? 'Copied!' : 'Copy credit');
    overlay.textContent = copied ? 'Copied!' : 'Copy';
    status.textContent = copied ? 'Copied!' : '';
  };
  set(false);
  box.addEventListener('pointerenter', () => { hover = true; });
  box.addEventListener('pointerleave', () => {
    hover = false;
    if (minElapsed) set(false);
  });
  box.addEventListener('click', () => {
    set(true);
    minElapsed = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      minElapsed = true;
      if (!hover) set(false);
    }, 2000);
    // Copy synchronously first; the async Clipboard API can sit unresolved
    // with no prompt, so it is only the fallback.
    if (syncCopy(text, box)) return;
    navigator.clipboard?.writeText(text).catch((err) => console.error('clipboard write failed', err));
  });
  return box;
}

// Fills `root` with the heading, tabs and the selected tab's credit.
export function mountCredit(root, matches, link) {
  const heading = el('h3', 'credit-heading', 'Where are you posting?');
  const list = el('div', 'credit-tabs');
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', 'Where are you posting?');
  const panel = el('div', 'credit-panel');
  panel.id = 'credit-panel';
  panel.setAttribute('role', 'tabpanel');

  const tabs = TABS.map((t) => {
    const b = el('button', 'accred-tab', t.label);
    b.type = 'button';
    b.id = `credit-tab-${t.value}`;
    b.dataset.value = t.value;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', panel.id);
    return b;
  });

  const select = (i, focus = false) => {
    tabs.forEach((b, j) => {
      const on = i === j;
      b.setAttribute('aria-selected', String(on));
      b.dataset.state = on ? 'active' : 'inactive';
      b.tabIndex = on ? 0 : -1;
    });
    if (focus) tabs[i].focus();
    const tab = TABS[i];
    panel.setAttribute('aria-labelledby', tabs[i].id);
    panel.dataset.value = tab.value;
    panel.replaceChildren(
      el('p', 'credit-where', `Paste in your ${CREDIT_LOCATION[tab.medium]}:`),
      copyBlock(creditText(tab, matches, link)),
    );
  };

  tabs.forEach((b, i) => {
    b.addEventListener('click', () => select(i));
    // Radix Tabs' default keyboard: arrows move and select, Home/End jump.
    b.addEventListener('keydown', (e) => {
      const n = tabs.length;
      const to = { ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 }[e.key];
      if (to === undefined) return;
      e.preventDefault();
      select(to, true);
    });
  });
  list.append(...tabs);
  root.replaceChildren(heading, list, panel);
  select(0);
}
