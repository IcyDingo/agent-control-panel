// What a handle, a text, a link and a pair of coordinates may be on the hub. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, text, optionalText, link, coordsText } from '../hub/validate.mjs';

test('handles follow GitHub rules, lowercased, and reserved words are refused', () => {
  assert.equal(handle('Alice-1'), 'alice-1');
  assert.equal(handle('a'.repeat(39)), 'a'.repeat(39));
  for (const bad of ['a'.repeat(40), '-a', 'a-', 'a_b', '', 'me', 'API', 'Universe', 42]) assert.equal(handle(bad), null, String(bad));
});

test('text is tidied and bounded; a link is https and short; coordinates parse', () => {
  assert.equal(text('  hello   there\u0007 ', 40), 'hello there');
  assert.equal(text('x'.repeat(41), 40), null);
  assert.equal(text('', 40), null);
  assert.equal(optionalText('', 160), '');
  assert.equal(link(''), '');
  assert.equal(link('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  for (const bad of ['ftp://x', 'javascript:alert(1)', 'https://x y', 'https://' + 'x'.repeat(200)]) assert.equal(link(bad), null, bad);
  assert.deepEqual(coordsText('412, -88'), { x: 412, y: -88 });
  assert.deepEqual(coordsText(' -3 7 '), { x: -3, y: 7 });
  for (const bad of ['412', '1e7, 0', '1.5, 2', '@alice', 'x, y']) assert.equal(coordsText(bad), null, bad);
});

test('a non-string is refused everywhere, and a long text keeps its line breaks', () => {
  for (const f of [handle, (v) => text(v, 40), (v) => optionalText(v, 40), link, coordsText]) assert.equal(f(42), null);
  assert.equal(optionalText(null, 40), null);
  assert.equal(text('a\n\n b \t c', 40), 'a b c', 'a short text is one line');
  assert.equal(text(' one  line\ntwo\u0000 ', 1000), 'one line\ntwo', 'a long one keeps \\n');
  assert.equal(text('é', 5), 'é', 'NFC');
});
