// The upload page's credit text (MS-007 Reject 1, public/music/credit.js),
// per platform tab, against real-audio-creator's buildCredit @145d66d.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CREDIT_LOCATION, TABS, creditText } from '../../public/music/credit.js';

const tab = (value) => TABS.find((t) => t.value === value);
const LINK = 'copyrighttester.real.audio/v/FufSgHvR3u';
const fight = { track_id: 't1', title: 'fight', artist: 'Carson Allen', start_s: 4 };
const fire = { track_id: 't2', title: 'Fire Walk with Me', artist: 'BBGuns', start_s: 40 };
const yue = { track_id: 't3', title: 'a musical middle finger to pretension', artist: 'yue!', start_s: 7.45 };

// Main's buildCredit (supabase/functions/_shared/accreditation.ts @145d66d),
// pinned: description and short, for one track.
const mainBuildCredit = (medium, trackName, who, downloadCode) => ({
  description: `Music: "${trackName}" by ${who}\nlibrary.real.audio/t/${downloadCode}`,
  short: `${trackName} ${who} [real.audio]`,
})[medium];

test('the tabs, their order and words are the main site\'s modal', () => {
  assert.deepEqual(TABS.map((t) => t.label), ['YT / FB / X / Twitch', 'TikTok', 'Instagram', 'YouTube Shorts']);
  assert.equal(TABS[0].value, 'universal');
  assert.deepEqual(TABS.map((t) => t.medium), ['description', 'short', 'short', 'short']);
  assert.deepEqual(CREDIT_LOCATION, { description: 'description', short: 'caption' });
});

test('Real Audio\'s tag per platform', () => {
  assert.equal(tab('tiktok').tag, '@r3al_audio');
  assert.equal(tab('instagram').tag, '@r3al.audio');
  assert.equal(tab('youtube_shorts').tag, '@r3al.audi0');
  assert.equal(tab('universal').tag, undefined);
});

test('description, one track: main\'s two lines with the scan link', () => {
  assert.equal(creditText(tab('universal'), [fight], LINK), 'Music: "fight" by Carson Allen\ncopyrighttester.real.audio/v/FufSgHvR3u');
  assert.equal(creditText(tab('universal'), [fight], LINK),
    mainBuildCredit('description', 'fight', 'Carson Allen', 'X').replace('library.real.audio/t/X', LINK));
});

test('description, two tracks: a line each in video order, then the one link', () => {
  assert.equal(creditText(tab('universal'), [fight, fire], LINK),
    'Music: "fight" by Carson Allen\nMusic: "Fire Walk with Me" by BBGuns\ncopyrighttester.real.audio/v/FufSgHvR3u');
});

test('short-form: main\'s line per track, the platform tag once at the end', () => {
  assert.equal(creditText(tab('tiktok'), [fight, fire], LINK),
    'fight Carson Allen [real.audio]\nFire Walk with Me BBGuns [real.audio] @r3al_audio');
  assert.equal(creditText(tab('instagram'), [yue], LINK), 'a musical middle finger to pretension yue! [real.audio] @r3al.audio');
  assert.equal(creditText(tab('youtube_shorts'), [yue], LINK), 'a musical middle finger to pretension yue! [real.audio] @r3al.audi0');
  assert.equal(creditText(tab('tiktok'), [yue], LINK), `${mainBuildCredit('short', yue.title, yue.artist)} @r3al_audio`);
});

test('a track heard twice is credited once, at its first appearance', () => {
  const again = { ...fight, start_s: 80 };
  assert.equal(creditText(tab('universal'), [fight, fire, again], LINK),
    'Music: "fight" by Carson Allen\nMusic: "Fire Walk with Me" by BBGuns\ncopyrighttester.real.audio/v/FufSgHvR3u');
  assert.equal(creditText(tab('instagram'), [fight, again], LINK), 'fight Carson Allen [real.audio] @r3al.audio');
});

test('names pass through as text, unchanged', () => {
  const odd = { track_id: 't9', title: 'Say "Hi" & <wave> 🌊', artist: 'Ñoño & Co', start_s: 1 };
  assert.equal(creditText(tab('universal'), [odd], LINK), `Music: "Say "Hi" & <wave> 🌊" by Ñoño & Co\n${LINK}`);
  assert.equal(creditText(tab('tiktok'), [odd], LINK), 'Say "Hi" & <wave> 🌊 Ñoño & Co [real.audio] @r3al_audio');
});
