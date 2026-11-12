// The PR watcher: which problems of a pull request on an agent's branch it acts on, whom it tells and how, once per
// commit, at most three times, and what it remembers across a restart. Fakes stand in for GitHub, the sessions and
// reply(); nothing here calls gh or Claude Code. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWatcher, problemsOf, messageOf, MAX_FIXES, STUCK_MS } from '../watcher.mjs';

const T0 = Date.parse('2026-11-12T12:00:00Z'), MIN = 60_000;
const pr = (over = {}) => ({ number: 12, title: 'Fix login', url: 'https://github.com/o/n/pull/12', branch: 'fix/login', sha: 'aaa', draft: false,
  checks: 'passing', counts: {}, failing: [], mergeable: 'MERGEABLE', mergeState: 'CLEAN', review: null, runningSince: null, mine: false, sessions: ['S1'], ...over });

function harness({ prs = [pr()], kind = 'background', file, sendResult = { ok: true, sent: true }, log = null } = {}) {
  const world = { prs, kind, sendResult, clock: T0 };
  const sent = [], suggested = [], notes = [], notified = [], logs = [];
  const w = createWatcher({
    file: file ?? path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')), 'watcher.json'),
    github: () => ({ repos: [{ slug: 'o/n', prs: world.prs }] }),
    session: (id) => (world.kind === 'gone' ? null : { kind: world.kind, name: 'fix-login', live: true, id }),
    send: async (id, text) => { sent.push({ id, text }); return typeof world.sendResult === 'function' ? world.sendResult() : world.sendResult; },
    suggest: (id, text, why, say) => { suggested.push({ id, text, why, say }); return { state: 'proposed' }; },
    failedLog: async () => (log ? { ok: true, message: log } : { ok: false, error: 'no log' }),
    notify: (title, text) => notified.push({ title, text }), note: (type, f) => notes.push({ type, ...f }),
    now: () => world.clock, log: (m) => logs.push(m),
  });
  return { w, world, sent, suggested, notes, notified, logs };
}

test('a pull request is wrong when it fails, conflicts, has changes requested or has checks stuck', () => {
  assert.deepEqual(problemsOf(pr(), 'o/n', T0), []);
  assert.deepEqual(problemsOf(pr({ checks: 'failing' }), 'o/n', T0).map((p) => p.key), ['o/n#12@aaa:failing']);
  assert.deepEqual(problemsOf(pr({ mergeState: 'DIRTY' }), 'o/n', T0).map((p) => p.kind), ['conflict']);
  assert.deepEqual(problemsOf(pr({ review: 'CHANGES_REQUESTED', sha: 'bbb' }), 'o/n', T0).map((p) => p.key), ['o/n#12:changes']);
  assert.deepEqual(problemsOf(pr({ checks: 'running', runningSince: T0 - 10 * MIN }), 'o/n', T0), [], 'running ten minutes is not stuck');
  assert.deepEqual(problemsOf(pr({ checks: 'running', runningSince: T0 - STUCK_MS - MIN }), 'o/n', T0).map((p) => p.kind), ['stuck']);
  assert.deepEqual(problemsOf(pr({ checks: 'failing', mergeState: 'DIRTY' }), 'o/n', T0).map((p) => p.kind), ['failing', 'conflict'], 'worst first');
});

test('a message never starts with a slash or a bang, and says what to do and which fix it is', () => {
  for (const kind of ['failing', 'conflict', 'changes', 'stuck']) {
    const m = messageOf(kind, pr({ failing: [{ name: 'build' }] }), 'o/n', { attempt: 2 });
    assert.doesNotMatch(m, /^[/!]/);
    assert.match(m, /push to fix\/login/);
    assert.match(m, /fix 2 of 3/);
  }
  assert.match(messageOf('failing', pr(), 'o/n', { log: 'build failed on fix/login. LOG', attempt: 1 }), /^build failed on fix\/login\. LOG/);
});

test('a background session on a failing branch is asked to fix it, with the failing log, once per commit', async () => {
  const h = harness({ prs: [pr({ checks: 'failing', failing: [{ name: 'build', runId: 5, jobId: 6 }] })], log: 'CI failed. The log.' });
  await h.w.check();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].id, 'S1');
  assert.match(h.sent[0].text, /^CI failed\. The log\./);
  assert.equal(h.notes[0].type, 'fix-sent');
  assert.equal(h.notified.length, 1);
  await h.w.check();
  assert.equal(h.sent.length, 1, 'the same commit is not asked about twice');
  h.world.prs = [pr({ checks: 'failing', sha: 'bbb', failing: [{ name: 'build' }] })];
  await h.w.check();
  assert.equal(h.sent.length, 2, 'a new commit that fails again is');
  assert.deepEqual(h.w.status().prs['o/n#12'], { kind: 'failing', at: T0, result: 'asked', fixes: 2 });
});

test('at most three fixes are asked per pull request, then you are told once', async () => {
  const h = harness();
  for (const sha of ['a1', 'a2', 'a3', 'a4', 'a5']) { h.world.prs = [pr({ checks: 'failing', sha })]; await h.w.check(); }
  assert.equal(h.sent.length, MAX_FIXES);
  assert.equal(h.notes.filter((n) => n.type === 'fix-capped').length, 1);
  assert.match(h.notified.at(-1).text, /Over to you/);
});

test('a terminal session listed by Claude Code gets a card to confirm; one known only from hooks gets an alert', async () => {
  const t = harness({ prs: [pr({ mergeState: 'DIRTY' })], kind: 'interactive' });
  await t.w.check();
  assert.equal(t.sent.length, 0);
  assert.equal(t.suggested.length, 1);
  assert.match(t.suggested[0].text, /merge conflicts/);
  assert.match(t.suggested[0].say, /closes Claude there/);
  const h = harness({ prs: [pr({ review: 'CHANGES_REQUESTED' })], kind: null });
  await h.w.check();
  assert.equal(h.sent.length + h.suggested.length, 0);
  assert.equal(h.notes[0].type, 'fix-alert');
  assert.match(h.notified[0].text, /tell it in its terminal/);
});

test('changes requested is asked about once, and again only after the review changed and came back', async () => {
  const h = harness({ prs: [pr({ review: 'CHANGES_REQUESTED' })] });
  await h.w.check();
  h.world.prs = [pr({ review: 'CHANGES_REQUESTED', sha: 'new' })];
  await h.w.check();
  assert.equal(h.sent.length, 1, 'a new commit under the same review is not asked again');
  h.world.prs = [pr({ review: 'APPROVED', sha: 'new' })]; await h.w.check();
  h.world.prs = [pr({ review: 'CHANGES_REQUESTED', sha: 'newer' })]; await h.w.check();
  assert.equal(h.sent.length, 2);
});

test('a message that does not go through is tried again five minutes later, and you hear of it once', async () => {
  let ok = false;
  const h = harness({ prs: [pr({ checks: 'failing' })], sendResult: () => (ok ? { ok: true, sent: true } : { ok: false, error: 'busy' }) });
  await h.w.check();
  h.world.clock += MIN; await h.w.check();
  assert.equal(h.sent.length, 1, 'not again within five minutes');
  h.world.clock += 5 * MIN; await h.w.check();
  assert.equal(h.sent.length, 2);
  assert.equal(h.notes.filter((n) => n.type === 'fix-failed').length, 1);
  ok = true; h.world.clock += 6 * MIN; await h.w.check();
  assert.equal(h.sent.length, 3);
  assert.equal(h.w.status().prs['o/n#12'].result, 'asked');
});

test('what it asked survives a restart, in a private file, and off asks nothing', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'watch-')), 'watcher.json');
  const a = harness({ prs: [pr({ checks: 'failing' })], file });
  await a.w.check();
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const b = harness({ prs: [pr({ checks: 'failing' })], file });
  await b.w.check();
  assert.equal(b.sent.length, 0, 'not asked again after a restart');
  b.w.setEnabled(false);
  b.world.prs = [pr({ checks: 'failing', sha: 'zzz' })];
  await b.w.check();
  assert.equal(b.sent.length, 0);
  assert.equal(harness({ prs: [pr({ checks: 'failing', sha: 'zzz' })], file }).w.status().enabled, false, 'off is remembered too');
});

test('a pull request with no agent on its branch is left alone', async () => {
  const h = harness({ prs: [pr({ checks: 'failing', sessions: [], mine: true })] });
  await h.w.check();
  assert.equal(h.sent.length + h.suggested.length + h.notes.length, 0);
});
