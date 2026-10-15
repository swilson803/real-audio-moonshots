// Preview-only demo mode (public/music/demo.js): which hosts may run it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_ID, DEMO_MATCHES, demoAllowed, demoState } from '../../public/music/demo.js';

test('production hosts never run the demo', () => {
  for (const host of [
    'copyrighttester.real.audio',
    'COPYRIGHTTESTER.REAL.AUDIO',
    'www.copyrighttester.real.audio',
    'real-audio-moonshots.spencerrwilson.workers.dev',
    'library.real.audio',
    'real.audio',
  ]) assert.equal(demoAllowed(host), false, host);
});

test('look-alike and malformed hosts are refused', () => {
  for (const host of [
    '-real-audio-moonshots.spencerrwilson.workers.dev',
    'abc--real-audio-moonshots.spencerrwilson.workers.dev.evil.com',
    'abc-real-audio-moonshots.spencerrwilson.workers.dev.evil.com',
    'abc-real-audio-moonshots.someoneelse.workers.dev',
    'abc-real-audio-moonshotsXspencerrwilson.workers.dev',
    'abc.real-audio-moonshots.spencerrwilson.workers.dev',
    'abc-clearance-check.spencerrwilson.workers.dev',
    'localhost.evil.com',
    'evil-localhost',
    '127.0.0.2',
    '',
    undefined,
  ]) assert.equal(demoAllowed(host), false, String(host));
});

test('local runs and this Worker\'s preview URLs may run it', () => {
  for (const host of [
    'localhost',
    '127.0.0.1',
    '[::1]',
    '0a1b2c3d-real-audio-moonshots.spencerrwilson.workers.dev',
    'claude-ms-007-r1-credit-flow-real-audio-moonshots.spencerrwilson.workers.dev',
  ]) assert.equal(demoAllowed(host), true, host);
});

test('demoState: only ?demo=found / ?demo=none, only on an allowed host', () => {
  const at = (u) => demoState(new URL(u));
  assert.equal(at('http://localhost:8797/music/?demo=found'), 'found');
  assert.equal(at('http://localhost:8797/music/?demo=none'), 'none');
  assert.equal(at('https://0a1b2c3d-real-audio-moonshots.spencerrwilson.workers.dev/music/?demo=found'), 'found');
  assert.equal(at('http://localhost:8797/music/'), null);
  assert.equal(at('http://localhost:8797/music/?demo=FOUND'), null);
  assert.equal(at('http://localhost:8797/music/?demo=error'), null);
  assert.equal(at('https://copyrighttester.real.audio/music/?demo=found'), null);
  assert.equal(at('https://copyrighttester.real.audio/music/?demo=none'), null);
  assert.equal(at('https://real-audio-moonshots.spencerrwilson.workers.dev/music/?demo=found'), null);
});

test('the fixtures are plainly fake', () => {
  assert.equal(DEMO_ID, 'DEMO000000');
  assert.ok(DEMO_MATCHES.length === 2);
  for (const m of DEMO_MATCHES) {
    assert.match(m.title, /\(fixture\)$/);
    assert.match(m.artist, /\(not real\)$/);
    assert.match(m.track_id, /^demo-/);
    assert.equal(m.stream_url, undefined); // the page supplies a local silent clip
  }
});
