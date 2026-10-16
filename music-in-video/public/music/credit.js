// The credit block on the upload page (MS-007): "Where are you posting?", a
// tab per platform, and the credit box that IS the copy action. It mirrors
// real-audio-creator's AccreditationSection as plain DOM: same tabs, strings
// and copy behaviour. The credit text follows that site's one-link credit
// system (CF-040, supabase/functions/_shared/accreditation.ts @c43a043),
// where a whole video's music is credited by one link, as its stacks are:
//   description (YT / FB / X / Twitch): one line, CREDIT_PREFIX + the link
//     (buildStackCredit). Our one link is this scan's /v/<id> page, which
//     lists every track; always on the production host, as CF-040's credit
//     links always point at library.real.audio.
//   short (TikTok / Instagram / YouTube Shorts): "music from @<Real Audio's
//     handle there> - " then "<track> <artist>" per track, comma-separated
//     (buildStackShortCredit). moonshots has no artist handles, so <artist>
//     is always the artist's name (CF-040's fallback).
// No sound branch (CF-040: a post carries one sound, not a set of them).
//
// The pure part (TABS, CREDIT_LOCATION, creditLink, creditText) touches no
// DOM, so the unit tests import it in Node.

// CF-040's REAL_AUDIO_HANDLES (note the zero in YouTube's).
export const REAL_AUDIO_HANDLES = { tiktok: 'r3al_audio', instagram: 'r3al.audio', youtube: 'r3al.audi0' };

export const TABS = [
  { value: 'universal', label: 'YT / FB / X / Twitch', medium: 'description' },
  { value: 'tiktok', label: 'TikTok', medium: 'short', handle: REAL_AUDIO_HANDLES.tiktok },
  { value: 'instagram', label: 'Instagram', medium: 'short', handle: REAL_AUDIO_HANDLES.instagram },
  { value: 'youtube_shorts', label: 'YouTube Shorts', medium: 'short', handle: REAL_AUDIO_HANDLES.youtube },
];

// Where the creator pastes the credit, per medium (main's CREDIT_LOCATION).
export const CREDIT_LOCATION = { description: 'description', short: 'caption' };

// CF-040's CREDIT_PREFIX: the description credit is this, then one link.
export const CREDIT_PREFIX = 'music in this video: ';

// The scan's credit link: always the production host, wherever the page runs.
export const CREDIT_ORIGIN = 'https://copyrighttester.real.audio';
export const creditLink = (id) => `${CREDIT_ORIGIN}/v/${id}`;

// -> the credit text for one tab. Tracks in video order, each once (a track
// heard twice is credited at its first appearance).
export function creditText(tab, matches, link) {
  if (tab.medium === 'description') return `${CREDIT_PREFIX}${link}`;
  const seen = new Set();
  const pairs = matches.filter((m) => !seen.has(m.track_id) && seen.add(m.track_id)).map((t) => `${t.title} ${t.artist}`);
  const lead = `music from @${tab.handle}`;
  return pairs.length ? `${lead} - ${pairs.join(', ')}` : lead;
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

// The credit box (main's CopyBlock): shows the credit; a brand-red "COPY"
// overlay on hover (all caps, Reject 5); a click flips it to "Copied!" at once (not waiting on the
// clipboard), held for at least 2 s and, while the pointer is still on the
// box, until it leaves.
function copyBlock(text, wrapLink) {
  const box = el('button', 'download-accred');
  box.type = 'button';
  const shown = el('span', wrapLink ? 'accred-text accred-text--link' : 'accred-text', text);
  const overlay = el('span', 'accred-overlay', 'COPY');
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
    overlay.textContent = copied ? 'Copied!' : 'COPY';
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
      copyBlock(creditText(tab, matches, link), tab.medium === 'description'),
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
