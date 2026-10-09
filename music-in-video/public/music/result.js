// Result page /v/<id>: every found track in video order with its start
// time, title, artist and a stream button, plus the copy line.
// Reads the scan from the Worker (moonshots). The only other request is the
// track's audio, streamed from Real Audio's public catalog when Play is
// pressed (preload="none" until then).
import { showCopyLine } from './copy.js';

const $ = (id) => document.getElementById(id);
const id = decodeURIComponent(location.pathname.split('/')[2] || '');
const summary = $('summary');

const clock = (s) => {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

let playing = null; // { audio, button } of the one track playing

// Icon plus a word; narrow screens hide the word (the aria-label stays).
function setButton(button, isPlaying) {
  const word = document.createElement('span');
  word.className = 'play-word';
  word.textContent = isPlaying ? ' pause' : ' play';
  button.replaceChildren(isPlaying ? '❚❚' : '▶', word);
  button.setAttribute('aria-pressed', String(isPlaying));
}

function row(match) {
  const li = document.createElement('li');
  li.className = 'track';
  const time = document.createElement('span');
  time.className = 'track-time';
  time.textContent = clock(match.start_s);
  const text = document.createElement('span');
  text.className = 'track-text';
  const title = document.createElement('span');
  title.className = 'track-title';
  title.textContent = match.title;
  const artist = document.createElement('span');
  artist.className = 'track-artist';
  artist.textContent = match.artist;
  text.append(title, artist);

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn-default play-btn';
  button.setAttribute('aria-label', `Play ${match.title} by ${match.artist}`);
  setButton(button, false);
  let audio = null;
  button.addEventListener('click', () => {
    if (!audio) {
      audio = new Audio();
      audio.preload = 'none';
      audio.src = match.stream_url;
      audio.addEventListener('ended', () => setButton(button, false));
      audio.addEventListener('pause', () => setButton(button, false));
      audio.addEventListener('play', () => setButton(button, true));
    }
    if (playing && playing.audio !== audio) playing.audio.pause();
    if (audio.paused) {
      playing = { audio, button };
      audio.play().catch(() => { button.textContent = 'can’t play'; });
    } else {
      audio.pause();
    }
  });
  li.append(time, text, button);
  return li;
}

function render(scan) {
  const list = $('tracks');
  scan.matches.forEach((m, i) => {
    if (i) {
      const hr = document.createElement('li');
      hr.className = 'sketch-divider divider-quiet';
      hr.setAttribute('aria-hidden', 'true');
      list.appendChild(hr);
    }
    list.appendChild(row(m));
  });
  const n = scan.matches.length;
  summary.textContent = `${n} Real Audio track${n === 1 ? ' is' : 's are'} in this video, in order.`;
  $('tracks-box').hidden = false;
  showCopyLine($('copy-line'), $('copy'), `${location.origin}/v/${scan.id}`);
  $('copy-box').hidden = false;
}

async function load() {
  if (!/^[0-9A-Za-z]{10}$/.test(id)) {
    summary.textContent = 'We couldn’t find that video’s music.';
    return;
  }
  try {
    const res = await fetch(`/api/scans/${id}`, { cache: 'no-store' });
    if (res.status === 404) {
      summary.textContent = 'We couldn’t find that video’s music.';
      return;
    }
    if (!res.ok) throw new Error(`scan ${res.status}`);
    render(await res.json());
  } catch (err) {
    console.error(err);
    summary.textContent = 'Having trouble loading this. Refresh to try again.';
  }
}

load();
