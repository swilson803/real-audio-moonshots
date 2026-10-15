// The upload page's credit text (public/music/credit.js), per platform tab,
// against real-audio-creator's one-link credit system (CF-040,
// supabase/functions/_shared/accreditation.ts @c43a043).
import test from 'node:test';
import assert from 'node:assert/strict';
import { CREDIT_LOCATION, CREDIT_PREFIX, REAL_AUDIO_HANDLES, TABS, creditLink, creditText } from '../../public/music/credit.js';

const tab = (value) => TABS.find((t) => t.value === value);
const LINK = creditLink('FufSgHvR3u');
const fight = { track_id: 't1', title: 'fight', artist: 'Carson Allen', start_s: 4 };
const fire = { track_id: 't2', title: 'Fire Walk with Me', artist: 'BBGuns', start_s: 40 };
const yue = { track_id: 't3', title: 'a musical middle finger to pretension', artist: 'yue!', start_s: 7.45 };

// CF-040's builders, pinned (c43a043).
const CF040 = {
  CREDIT_PREFIX: 'music in this video: ',
  buildStackCredit: (stackUrl) => `music in this video: ${stackUrl}`,
  buildStackShortCredit: (pairs, realAudioHandle) => {
    const lead = `music from @${realAudioHandle}`;
    return pairs.length ? `${lead} - ${pairs.join(', ')}` : lead;
  },
  REAL_AUDIO_HANDLES: { tiktok: 'r3al_audio', instagram: 'r3al.audio', youtube: 'r3al.audi0' },
};

test('the tabs, their order and words are the main site\'s modal', () => {
  assert.deepEqual(TABS.map((t) => t.label), ['YT / FB / X / Twitch', 'TikTok', 'Instagram', 'YouTube Shorts']);
  assert.equal(TABS[0].value, 'universal');
  assert.deepEqual(TABS.map((t) => t.medium), ['description', 'short', 'short', 'short']);
  assert.deepEqual(CREDIT_LOCATION, { description: 'description', short: 'caption' });
});

test('CF-040\'s prefix and Real Audio handles, per platform', () => {
  assert.equal(CREDIT_PREFIX, CF040.CREDIT_PREFIX);
  assert.deepEqual(REAL_AUDIO_HANDLES, CF040.REAL_AUDIO_HANDLES);
  assert.equal(tab('tiktok').handle, 'r3al_audio');
  assert.equal(tab('instagram').handle, 'r3al.audio');
  assert.equal(tab('youtube_shorts').handle, 'r3al.audi0');
});

test('the credit link is the scan page on the production host, with https', () => {
  assert.equal(LINK, 'https://copyrighttester.real.audio/v/FufSgHvR3u');
});

test('description: one line, the prefix then the one link, however many tracks', () => {
  for (const ms of [[fight], [fight, fire], [fight, fire, yue]]) {
    assert.equal(creditText(tab('universal'), ms, LINK), 'music in this video: https://copyrighttester.real.audio/v/FufSgHvR3u');
    assert.equal(creditText(tab('universal'), ms, LINK), CF040.buildStackCredit(LINK));
  }
});

test('short-form: "music from @<handle> - " then "<track> <artist>" pairs, comma-separated', () => {
  assert.equal(creditText(tab('tiktok'), [fight, fire], LINK), 'music from @r3al_audio - fight Carson Allen, Fire Walk with Me BBGuns');
  assert.equal(creditText(tab('instagram'), [yue], LINK), 'music from @r3al.audio - a musical middle finger to pretension yue!');
  assert.equal(creditText(tab('youtube_shorts'), [yue], LINK), 'music from @r3al.audi0 - a musical middle finger to pretension yue!');
  for (const [value, handle] of [['tiktok', 'tiktok'], ['instagram', 'instagram'], ['youtube_shorts', 'youtube']]) {
    assert.equal(creditText(tab(value), [fight, fire], LINK),
      CF040.buildStackShortCredit(['fight Carson Allen', 'Fire Walk with Me BBGuns'], CF040.REAL_AUDIO_HANDLES[handle]));
  }
});

test('a track heard twice is credited once, at its first appearance', () => {
  const again = { ...fight, start_s: 80 };
  assert.equal(creditText(tab('tiktok'), [fight, fire, again], LINK), 'music from @r3al_audio - fight Carson Allen, Fire Walk with Me BBGuns');
  assert.equal(creditText(tab('instagram'), [fight, again], LINK), 'music from @r3al.audio - fight Carson Allen');
});

test('names pass through as text, unchanged', () => {
  const odd = { track_id: 't9', title: 'Say "Hi" & <wave> 🌊', artist: 'Ñoño & Co', start_s: 1 };
  assert.equal(creditText(tab('tiktok'), [odd], LINK), 'music from @r3al_audio - Say "Hi" & <wave> 🌊 Ñoño & Co');
});
