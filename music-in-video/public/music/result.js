// Result page /v/<id>: every found track in video order with its start
// time, title, artist and a stream button (tracks.js), plus the copy line.
// While the video is still being checked (MS-007: 202 from the Worker) it
// says "Still working…" and asks again until the result is there.
// Reads the scan from the Worker (moonshots). The only other request is the
// track's audio, streamed from Real Audio's public catalog when Play is
// pressed (preload="none" until then).
import { showCopyLine } from './copy.js';
import { renderTracks } from './tracks.js';

const $ = (id) => document.getElementById(id);
const id = decodeURIComponent(location.pathname.split('/')[2] || '');
const summary = $('summary');
// The upload page's words for the same wait (public/music/app.js).
const STILL_WORKING = 'Still working… this can take up to a minute.';
const POLL_MS = 3000;

function render(scan) {
  renderTracks($('tracks'), scan.matches);
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
    let res = await fetch(`/api/scans/${id}`, { cache: 'no-store' });
    while (res.status === 202) {
      summary.textContent = STILL_WORKING;
      await new Promise((r) => setTimeout(r, POLL_MS));
      res = await fetch(`/api/scans/${id}`, { cache: 'no-store' });
    }
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
