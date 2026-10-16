// The found-tracks list, shared by the upload page (under the credit) and the
// result page /v/<id>: every found track in video order with its start time,
// title, artist and a play button with the main site's icon. The track's
// audio is streamed from Real Audio's public catalog only when Play is
// pressed (preload="none" until then).

export const clock = (s) => {
  const t = Math.max(0, Math.round(s));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};

let playing = null; // { audio, button } of the one track playing

// The main site's play / pause icons (real-audio-creator TrackCard,
// public/icons-runtime/action-{play,pause}.webp), 48px, on a bare button.
const ICONS = { play: '/music/icons/action-play.webp', pause: '/music/icons/action-pause.webp' };

function setButton(button, isPlaying, match) {
  const img = document.createElement('img');
  img.className = 'play-icon';
  img.src = isPlaying ? ICONS.pause : ICONS.play;
  img.alt = '';
  img.decoding = 'async';
  button.replaceChildren(img);
  button.setAttribute('aria-label', `${isPlaying ? 'Pause' : 'Play'} ${match.title} by ${match.artist}`);
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
  button.className = 'play-btn';
  setButton(button, false, match);
  let audio = null;
  button.addEventListener('click', () => {
    if (!audio) {
      audio = new Audio();
      audio.preload = 'none';
      audio.src = match.stream_url;
      audio.addEventListener('ended', () => setButton(button, false, match));
      audio.addEventListener('pause', () => setButton(button, false, match));
      audio.addEventListener('play', () => setButton(button, true, match));
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

// Rows (with a quiet divider between them) into an <ol class="tracks">.
export function renderTracks(list, matches) {
  matches.forEach((m, i) => {
    if (i) {
      const hr = document.createElement('li');
      hr.className = 'sketch-divider divider-quiet';
      hr.setAttribute('aria-hidden', 'true');
      list.appendChild(hr);
    }
    list.appendChild(row(m));
  });
}
