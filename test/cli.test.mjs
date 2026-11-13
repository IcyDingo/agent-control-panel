// `node server.mjs daemon …` off a Mac. Run with `npm test`. Only `status` is asked here: it changes nothing on the
// machine the tests run on, whichever way the command goes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../cli.mjs';

test('off a Mac the background service is not offered, and the command says what to use', async () => {
  const said = [], error = console.error, log = console.log;
  console.error = (m) => said.push(String(m));
  console.log = () => {};
  try {
    assert.equal(await main(['daemon', 'status'], { platform: 'linux' }), 1);
    assert.equal(await main(['status'], { platform: 'linux' }), 1);
  } finally { console.error = error; console.log = log; }
  assert.equal(said.length, 2);
  assert.match(said[0], /macOS/);
  assert.match(said[0], /Start at login/);
});

test('a command that is not one of ours is still told so, on any platform', async () => {
  const error = console.error;
  console.error = () => {};
  try { assert.equal(await main(['daemon', 'restart'], { platform: 'linux' }), 2); } finally { console.error = error; }
});
