// Glue-wide preferences: safe defaults, validation, merging. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GLUE_DEFAULTS, sanitizeGlue, mergeGlue } from '../glue-prefs.mjs';

const clone = (o) => JSON.parse(JSON.stringify(o));

test('defaults for missing, null, corrupt', () => {
  assert.deepEqual(sanitizeGlue(undefined), GLUE_DEFAULTS);
  assert.deepEqual(sanitizeGlue(null), GLUE_DEFAULTS);
  assert.deepEqual(sanitizeGlue('x'), GLUE_DEFAULTS);
  assert.deepEqual(sanitizeGlue([1]), GLUE_DEFAULTS);
  assert.deepEqual(sanitizeGlue({ theme: 'pink' }), GLUE_DEFAULTS);
  assert.deepEqual(sanitizeGlue({ notify: { ci: 'x' } }), GLUE_DEFAULTS);
  assert.deepEqual(sanitizeGlue({ notify: 5, agentDefaults: 'no', folded: 'no' }), GLUE_DEFAULTS);
  // valid fields are kept beside bad ones
  const g = sanitizeGlue({ theme: 'light', notify: { ci: false, watcher: 'x' }, titleCount: 'x', overseerModel: 'opus', bogus: 1 });
  assert.equal(g.theme, 'light');
  assert.deepEqual(g.notify, { requests: true, ci: false, watcher: true });
  assert.equal(g.titleCount, true);
  assert.equal(g.overseerModel, 'opus');
  assert.equal(g.bogus, undefined);
});

test('the defaults match the page and the server', () => {
  assert.deepEqual(GLUE_DEFAULTS, { theme: 'dark', folded: ['finished'], notify: { requests: true, ci: true, watcher: true },
    titleCount: true, agentDefaults: { model: '', effort: '', mode: 'default', worktree: false, agent: 'claude', opencodeModel: '' },
    overseerModel: 'sonnet', fallbackModel: '', seeded: false });
});

test('the OpenCode defaults: which agent, and models by their provider/model shape', () => {
  const a = sanitizeGlue({ agentDefaults: { agent: 'opencode', opencodeModel: 'openai/gpt-6' }, fallbackModel: 'anthropic/claude-sonnet-5-5' });
  assert.equal(a.agentDefaults.agent, 'opencode');
  assert.equal(a.agentDefaults.opencodeModel, 'openai/gpt-6');
  assert.equal(a.fallbackModel, 'anthropic/claude-sonnet-5-5');
  const b = sanitizeGlue({ agentDefaults: { agent: 'codex', opencodeModel: 'nope' }, fallbackModel: 'x; y' });
  assert.deepEqual([b.agentDefaults.agent, b.agentDefaults.opencodeModel, b.fallbackModel], ['claude', '', '']);
  assert.match(mergeGlue(GLUE_DEFAULTS, { fallbackModel: 'bad' }).error, /fallbackModel/);
  assert.equal(mergeGlue(GLUE_DEFAULTS, { fallbackModel: 'openai/gpt-6' }).glue.fallbackModel, 'openai/gpt-6');
});

test('sanitize keeps only the fixed queues in folded and checks each agent default', () => {
  // A repository section's fold names the repository, which another workspace's page must not read: never kept.
  const many = Array.from({ length: 80 }, (_, i) => `repo:r${i}`);
  assert.deepEqual(sanitizeGlue({ folded: many }).folded, []);
  assert.deepEqual(sanitizeGlue({ folded: ['repo:secret', 'finished', 'repo:o/x'] }).folded, ['finished']);
  assert.deepEqual(sanitizeGlue({ folded: ['finished', 7, 'x'.repeat(101), 'loose', 'loose', 'idle', 'waiting'] }).folded, ['finished', 'loose']);
  assert.deepEqual(sanitizeGlue({ folded: [] }).folded, []);
  const a = sanitizeGlue({ agentDefaults: { model: 'opus[1m]', effort: 'max', mode: 'plan', worktree: true } }).agentDefaults;
  assert.deepEqual(a, { model: 'opus[1m]', effort: 'max', mode: 'plan', worktree: true, agent: 'claude', opencodeModel: '' });
  assert.deepEqual(sanitizeGlue({ agentDefaults: { model: 'gpt', effort: 'huge', mode: 'yolo', worktree: 1 } }).agentDefaults, GLUE_DEFAULTS.agentDefaults);
});

test('a hostile object never reaches the prototype', () => {
  const evil = JSON.parse('{"__proto__":{"theme":"light"},"constructor":{"x":1},"notify":{"__proto__":{"ci":false}}}');
  const g = sanitizeGlue(evil);
  assert.deepEqual(g, GLUE_DEFAULTS);
  assert.equal(Object.getPrototypeOf(g), Object.prototype);
  assert.equal(({}).theme, undefined);
  for (const key of ['__proto__', 'constructor', 'prototype', 'toString']) {
    const r = mergeGlue(GLUE_DEFAULTS, JSON.parse(`{"${key}":"x"}`));
    assert.equal(r.ok, false);
  }
  assert.equal(mergeGlue(GLUE_DEFAULTS, JSON.parse('{"notify":{"__proto__":{"ci":false}}}')).ok, false);
  assert.equal(mergeGlue(GLUE_DEFAULTS, JSON.parse('{"agentDefaults":{"constructor":"x"}}')).ok, false);
});

test('merge accepts a valid patch and refuses a bad one', () => {
  assert.equal(mergeGlue(GLUE_DEFAULTS, { theme: 'light' }).glue.theme, 'light');
  assert.equal(mergeGlue(GLUE_DEFAULTS, { theme: 'system' }).ok, true);
  const bad = mergeGlue(GLUE_DEFAULTS, { theme: 'pink' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /theme/);
  const armed = mergeGlue(GLUE_DEFAULTS, { armed: false });
  assert.equal(armed.ok, false);
  assert.match(armed.error, /armed/);
  assert.deepEqual(mergeGlue(GLUE_DEFAULTS, { notify: { ci: false } }).glue.notify, { requests: true, ci: false, watcher: true });
  const nb = mergeGlue(GLUE_DEFAULTS, { notify: { ci: 'no' } });
  assert.equal(nb.ok, false);
  assert.match(nb.error, /notify/);
  assert.equal(mergeGlue(GLUE_DEFAULTS, { notify: { nope: true } }).ok, false);
  assert.equal(mergeGlue(GLUE_DEFAULTS, { notify: true }).ok, false);
  assert.equal(mergeGlue(GLUE_DEFAULTS, 'x').ok, false);
  assert.equal(mergeGlue(GLUE_DEFAULTS, null).ok, false);
  assert.match(mergeGlue(GLUE_DEFAULTS, { overseerModel: 'gpt' }).error, /overseerModel/);
  assert.match(mergeGlue(GLUE_DEFAULTS, { folded: 'x' }).error, /folded/);
  assert.match(mergeGlue(GLUE_DEFAULTS, { folded: ['a', 3] }).error, /folded/);
  assert.match(mergeGlue(GLUE_DEFAULTS, { folded: Array(51).fill('a').map((a, i) => a + i) }).error, /folded/);
  assert.match(mergeGlue(GLUE_DEFAULTS, { agentDefaults: { model: 'gpt' } }).error, /agentDefaults/);
  assert.equal(mergeGlue(GLUE_DEFAULTS, { agentDefaults: { worktree: true } }).glue.agentDefaults.mode, 'default');
  assert.equal(mergeGlue(GLUE_DEFAULTS, { seeded: true }).glue.seeded, true);
  assert.equal(mergeGlue(GLUE_DEFAULTS, { seeded: 'yes' }).ok, false);
  assert.equal(mergeGlue(GLUE_DEFAULTS, { titleCount: false }).glue.titleCount, false);
  assert.deepEqual(mergeGlue(GLUE_DEFAULTS, { folded: ['loose', 'finished'] }).glue.folded, ['loose', 'finished']);
  assert.deepEqual(mergeGlue(GLUE_DEFAULTS, { folded: [] }).glue.folded, []);
});

test('merge keeps only the fixed queues in folded: a mixed list is filtered, one with none of them refused', () => {
  const mixed = mergeGlue(GLUE_DEFAULTS, { folded: ['repo:secret', 'loose', 'idle', 'repo:o/x'] });
  assert.equal(mixed.ok, true, JSON.stringify(mixed));
  assert.deepEqual(mixed.glue.folded, ['loose']);
  for (const only of [['repo:secret'], ['idle', 'repo:o/x'], ['waiting']]) {
    const r = mergeGlue(GLUE_DEFAULTS, { folded: only });
    assert.equal(r.ok, false, JSON.stringify(only));
    assert.equal(r.error, 'folded can name only loose and finished.');
  }
  assert.doesNotMatch(JSON.stringify(mergeGlue({ folded: ['repo:old', 'finished'] }, { theme: 'light' }).glue), /repo:/, 'a stored one is dropped on any write');
});

test('merge neither mutates nor aliases its inputs', () => {
  const cur = clone(GLUE_DEFAULTS);
  const patch = { notify: { ci: false }, folded: ['loose'] };
  const r = mergeGlue(cur, patch);
  assert.deepEqual(cur, GLUE_DEFAULTS);
  r.glue.folded.push('finished');
  r.glue.notify.ci = true;
  assert.deepEqual(patch, { notify: { ci: false }, folded: ['loose'] });
  assert.deepEqual(GLUE_DEFAULTS.folded, ['finished']);
  assert.deepEqual(sanitizeGlue(undefined).folded, ['finished']);
  assert.notEqual(sanitizeGlue(undefined).folded, GLUE_DEFAULTS.folded);
});
