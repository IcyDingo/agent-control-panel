// GitHub and the overseer, end to end: the real server, with a stand-in `claude` (the roster, the overseer's `claude -p`
// and the restart a confirmed message takes) and a stand-in `gh` (one pull request on the session's branch, with a
// failing check, and that check's log). Run with `npm test`. Starts the server on a spare port under a throwaway home.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const PORT = 47700 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-home-'));
const SID = 'abcdef12-3456-4789-8abc-def012345678', ID8 = SID.slice(0, 8);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// A checkout of github.com/o/n on feat/x. The panel reads the branch and the remote from these files, never from git.
const repo = path.join(home, 'code', 'n');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feat/x\n');
fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/o/n.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');

// The session's conversation, in that checkout, so a reply has something to resume.
fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
fs.writeFileSync(path.join(home, '.claude', 'projects', 'p', `${SID}.jsonl`), [
  JSON.stringify({ type: 'user', cwd: repo, permissionMode: 'default', timestamp: '2026-11-12T10:00:00.000Z', message: { role: 'user', content: 'build feature x' } }),
  JSON.stringify({ type: 'assistant', cwd: repo, timestamp: '2026-11-12T10:00:01.000Z', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Pushed; CI is running.' }] } }),
].join('\n') + '\n');

// One background job, up and idle, with no process of its own on the roster: a message to it resumes it with --bg,
// which is the one path through reply() that needs neither a pseudo-terminal nor a stop to settle.
const roster = path.join(home, 'roster.json');
fs.writeFileSync(roster, JSON.stringify([{ pid: null, id: ID8, cwd: repo, kind: 'background', startedAt: Date.now(), sessionId: SID, name: 'feature x', status: 'idle', state: 'running' }]));

// What the overseer answers, one per `claude -p` call, in turn (the last repeats).
const tellAnswer = { reply: 'I propose telling it to fix the build.', actions: [{ type: 'tell', session: ID8, text: 'Please fix the failing build.', why: 'CI failed' }], look: [] };
const slashAnswer = { reply: 'I propose compacting it.', actions: [{ type: 'tell', session: ID8, text: '/compact now', why: 'Its context is long' }], look: [] };
const answers = path.join(home, 'answers.json'), counter = path.join(home, 'counter');
fs.writeFileSync(answers, JSON.stringify([tellAnswer, tellAnswer, slashAnswer]));

// The stand-ins log every call as a JSON line: its folder and its argv.
const claudeCalls = path.join(home, 'claude-calls.log'), ghCalls = path.join(home, 'gh-calls.log');
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === 'agents') { process.stdout.write(fs.readFileSync(${JSON.stringify(roster)}, 'utf8')); process.exit(0); }
fs.appendFileSync(${JSON.stringify(claudeCalls)}, JSON.stringify({ cwd: process.cwd(), args: a }) + '\\n');
if (a[0] === 'auth') { console.log('{}'); process.exit(0); }
if (a[0] === '-p') {
  let n = 0;
  try { n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) || 0; } catch {}
  fs.writeFileSync(${JSON.stringify(counter)}, String(++n));
  const all = JSON.parse(fs.readFileSync(${JSON.stringify(answers)}, 'utf8'));
  const v = all[Math.min(n, all.length) - 1];
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: JSON.stringify(v), structured_output: v }));
  process.exit(0);
}
if (a[0] === '--bg') { console.log('backgrounded · ${ID8} · feature x'); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });

// A check that failed long ago enough not to raise a desktop notification on the first poll (that would run osascript).
const check = { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/n/actions/runs/123/job/456',
  workflowName: 'CI', completedAt: '2026-01-01T00:05:00Z', startedAt: '2026-01-01T00:00:00Z' };
const pr = { number: 7, title: 'Feature x', url: 'https://github.com/o/n/pull/7', isDraft: false, headRefName: 'feat/x', headRefOid: 'abc1234', baseRefName: 'main',
  isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', reviewDecision: '', statusCheckRollup: [check], updatedAt: '2026-01-01T00:05:00Z' };
const failedLog = [
  'CI / build\tRun tests\t2026-01-01T00:00:00Z npm test',
  'CI / build\tRun tests\t2026-01-01T00:00:01Z not ok 1 - adds',
  'CI / build\tRun tests\t2026-01-01T00:00:02Z ##[error]Process completed with exit code 1.',
].join('\n') + '\n';
fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2), has = (x) => a.includes(x), after = (x) => a[a.indexOf(x) + 1];
fs.appendFileSync(${JSON.stringify(ghCalls)}, JSON.stringify({ cwd: process.cwd(), args: a }) + '\\n');
const out = (v) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
if (a[0] === 'repo' && a[1] === 'view') out({ defaultBranchRef: { name: 'main' } });
if (a[0] === 'pr' && a[1] === 'list' && after('--state') === 'open') out(${JSON.stringify([pr])});
if (a[0] === 'pr' && a[1] === 'list' && after('--state') === 'merged') out([]);
if (a[0] === 'run' && a[1] === 'list') out([]);
if (a[0] === 'run' && a[1] === 'view' && has('--log-failed')) out(${JSON.stringify(failedLog)});
process.stderr.write('unexpected gh call: ' + a.join(' ') + '\\n');
process.exit(1);
`, { mode: 0o755 });

const prefs = path.join(home, 'panel', 'prefs.json');
fs.mkdirSync(path.dirname(prefs));
fs.writeFileSync(prefs, JSON.stringify({ profile: 'default' }));

// GitHub is on: the stand-in gh is first on PATH, ahead of any real one.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && k !== 'ACP_GITHUB'));
const server = spawn(process.execPath, [SERVER], { env: { ...env, HOME: home, PATH: `${bin}:${env.PATH}`, ACP_PORT: String(PORT), ACP_PREFS: prefs }, stdio: ['ignore', 'pipe', 'pipe'] });
// Should this process die before after() runs, the server must not outlive it.
process.on('exit', () => { try { server.kill(); } catch {} });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start: ' + log)), 10_000);
  server.stdout.on('data', () => { if (log.includes(BASE)) { clearTimeout(t); resolve(); } });
  server.on('exit', () => reject(new Error('server exited: ' + log)));
});
const token = (await (await fetch(BASE + '/')).text()).match(/[0-9a-f]{48}/)[0];
const post = (p, body, t = token) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-acp-token': t }, body: JSON.stringify(body ?? {}) });
const api = (p, body) => post(p, body).then((r) => r.json());
// The PR watcher would ask the job to fix its failing PR by itself (test/watcher.test.mjs covers that): here it is off, so
// what reaches claude is what the overseer's cards send. Turning it off goes through its route, behind the token.
assert.equal((await post('/api/watcher/enabled', { on: false }, 'nope')).status, 403);
assert.deepEqual(await api('/api/watcher/enabled', { on: false }), { ok: true, enabled: false });

// A page watching: frames arrive as they are sent. Opened only once the session is on the board (below), since opening
// it is what starts the first GitHub poll.
const frames = [];
const watcher = new AbortController();
function watch() {
  fetch(`${BASE}/events?t=${token}`, { signal: watcher.signal }).then(async (r) => {
    let buf = '';
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString();
      for (const m of buf.matchAll(/^data: (.*)$/gm)) { try { frames.push(JSON.parse(m[1])); } catch {} }
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    }
  }).catch(() => {});
}
/** Polls `fn` until it gives something truthy, or `ms` runs out (then null). */
async function until(fn, ms = 15_000, every = 200) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(every)) { const v = await fn(); if (v) return v; }
  return null;
}
/** One snapshot, from a page that opens and closes. */
const snapshot = async () => {
  const c = new AbortController();
  const r = await fetch(`${BASE}/events?t=${token}`, { signal: c.signal });
  const reader = r.body.getReader();
  let buf = '';
  for (;;) { const { value } = await reader.read(); buf += Buffer.from(value).toString(); const m = buf.match(/^data: (.*)$/m); if (m) { c.abort(); return JSON.parse(m[1]); } }
};
const latest = () => frames.findLast((f) => Array.isArray(f?.sessions));
const calls = (file) => { try { return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

/** Says something to the overseer and waits for its answer: the overseer turn after yours. */
async function say(text) {
  const before = (await api('/api/overseer/turns', {})).turns.length;
  const r = await api('/api/overseer/say', { text });
  assert.equal(r.ok, true, JSON.stringify(r));
  const turn = await until(async () => {
    const { turns } = await api('/api/overseer/turns', {});
    return turns.length >= before + 2 && turns.at(-1).who === 'overseer' ? turns.at(-1) : null;
  });
  assert.ok(turn, 'the overseer answers');
  return turn;
}

// The server writes what it has not saved yet as it goes: its folder is removed once it has exited.
after(async () => { watcher.abort(); if (server.exitCode === null && server.signalCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); }); fs.rmSync(home, { recursive: true, force: true }); });

test('GitHub shows the pull request on the session\'s branch with its failing check, on the board and on the session', async () => {
  // The roster is read at start; the board has the session once it is in.
  const first = await until(async () => (await snapshot()).sessions.find((s) => s.sessionId === SID && s.inRoster), 10_000, 300);
  assert.ok(first, 'the session shows up: ' + log);
  assert.equal(first.git?.branch, 'feat/x');

  watch();
  let snap = await until(() => { const f = latest(); return f?.github?.repos?.[0]?.prs?.length ? f : null; }, 6000);
  if (!snap) { await api('/api/github/refresh', {}); snap = await until(() => { const f = latest(); return f?.github?.repos?.[0]?.prs?.length ? f : null; }, 10_000); }
  assert.ok(snap, `GitHub was polled: ${JSON.stringify(latest()?.github)} | gh calls: ${JSON.stringify(calls(ghCalls))} | ${log}`);

  assert.equal(snap.github.gh, 'ok');
  const r = snap.github.repos[0];
  assert.equal(r.slug, 'o/n');
  assert.equal(r.defaultBranch, 'main');
  assert.equal(r.error, null);
  assert.equal(r.prs.length, 1);
  assert.equal(r.prs[0].number, 7);
  assert.equal(r.prs[0].branch, 'feat/x');
  assert.equal(r.prs[0].checks, 'failing');
  assert.deepEqual(r.prs[0].failing, [{ name: 'build', url: check.detailsUrl, runId: 123, jobId: 456 }]);
  assert.deepEqual(r.prs[0].sessions, [SID]);

  const s = snap.sessions.find((x) => x.sessionId === SID);
  assert.equal(s.gh?.slug, 'o/n');
  assert.equal(s.gh.pr?.number, 7);
  assert.equal(s.gh.pr.checks, 'failing');
  assert.deepEqual(s.gh.pr.failing, ['build']);
  assert.deepEqual(s.gh.failed, { runId: 123, jobId: 456, workflow: 'build', url: check.detailsUrl, on: 'pr' });

  // gh is asked about github.com/o/n by name, from the panel's own folder rather than a checkout.
  const gh = calls(ghCalls);
  assert.ok(gh.some((c) => c.args.join(' ') === 'repo view github.com/o/n --json defaultBranchRef'), JSON.stringify(gh));
  assert.ok(gh.some((c) => c.args[0] === 'pr' && c.args.includes('open') && c.args.includes('github.com/o/n')), JSON.stringify(gh));
  assert.ok(gh.every((c) => fs.realpathSync(c.cwd) === fs.realpathSync(path.dirname(prefs))), JSON.stringify(gh.map((c) => c.cwd)));
});

test('the failing check\'s log comes back trimmed, with a message that would hand it to the agent', async () => {
  const r = await api('/api/github/log', { slug: 'o/n', runId: '123', jobId: '456' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.match(r.text, /^Error: Process completed with exit code 1\./, 'the error line comes first');
  assert.match(r.text, /== CI \/ build › Run tests ==/);
  assert.match(r.text, /not ok 1 - adds/);
  assert.doesNotMatch(r.text, /2026-01-01T/, 'timestamps are cut');
  assert.equal(r.url, check.detailsUrl);
  assert.match(r.message, /^build failed on feat\/x \(pull request #7\) in o\/n\./);
  assert.ok(r.message.includes(r.text), 'the message carries the log');
  assert.ok(r.message.endsWith(`The full run: ${check.detailsUrl}`));
  const view = calls(ghCalls).find((c) => c.args[0] === 'run' && c.args[1] === 'view');
  assert.deepEqual(view?.args, ['run', 'view', '-R', 'github.com/o/n', '--job', '456', '--log-failed']);

  // A run the panel is not showing as failed is refused without asking gh.
  const n = calls(ghCalls).length;
  const bad = await api('/api/github/log', { slug: 'o/n', runId: '999' });
  assert.equal(bad.ok, false);
  assert.equal(calls(ghCalls).length, n);
});

let firstTurn;
test('a message to the overseer comes back as a turn proposing a tell, asked with no tools and its own schema', async () => {
  const turn = firstTurn = await say('What should I do about the failing build?');
  assert.equal(turn.error, undefined, JSON.stringify(turn));
  assert.equal(turn.text, 'I propose telling it to fix the build.');
  assert.equal(turn.actions.length, 1);
  const a = turn.actions[0];
  assert.equal(a.type, 'tell');
  assert.equal(a.state, 'proposed');
  assert.equal(a.sessionId, SID);
  assert.equal(a.target, 'feature x');
  assert.equal(a.text, 'Please fix the failing build.');
  assert.equal(a.why, 'CI failed');
  assert.equal(a.how, 'restart', 'with no process, a message resumes it in the background');
  assert.equal(a.expired, false);

  const p = calls(claudeCalls).filter((c) => c.args[0] === '-p');
  assert.equal(p.length, 1);
  const args = p[0].args, at = (flag) => args[args.indexOf(flag) + 1];
  assert.ok(args.includes('--json-schema'));
  assert.equal(JSON.parse(at('--json-schema')).required.join(','), 'reply,actions,look');
  assert.ok(args.includes('--system-prompt'));
  assert.match(at('--system-prompt'), /^You are the overseer in Glue/);
  assert.ok(args.includes('--tools'));
  assert.equal(at('--tools'), '', '--tools is given an empty list');
  assert.ok(args.includes('--disallowedTools'));
  assert.equal(at('--disallowedTools'), 'Bash');
  assert.equal(at('--session-id').length, 36);
  assert.equal(fs.realpathSync(p[0].cwd), fs.realpathSync(path.join(home, 'panel', 'overseer', 'cwd')), 'from an empty folder of its own');
  // The board it was shown: the session by its short id, on its branch, with GitHub's pull request.
  const prompt = args.at(-1);
  assert.equal(args.at(-2), '--');
  assert.match(prompt, /<board>/);
  assert.ok(prompt.includes(`[${ID8}] "feature x"`), prompt);
  assert.ok(prompt.includes('PR #7 checks failing (build)'), prompt);
  assert.ok(prompt.includes('o/n (default branch main)'), prompt);
  assert.match(prompt, /<you>What should I do about the failing build\?<\/you>$/);

  const snap = await until(() => { const f = latest(); return f?.overseer?.proposed === 1 ? f : null; }, 5000);
  assert.ok(snap, 'the board counts one proposal: ' + JSON.stringify(latest()?.overseer));
  assert.equal(snap.overseer.busy, null);
});

test('a declined proposal is marked declined; a confirmed one resumes the job in the background with the message', async () => {
  const a1 = firstTurn.actions[0];
  const d = await api('/api/overseer/act', { turnId: firstTurn.id, actionId: a1.id, decision: 'decline' });
  assert.equal(d.ok, true, JSON.stringify(d));
  assert.equal(d.action.state, 'declined');
  const again = await api('/api/overseer/act', { turnId: firstTurn.id, actionId: a1.id, decision: 'run' });
  assert.equal(again.ok, false);
  assert.equal(again.conflict, true, 'each is decided once');
  assert.equal(calls(claudeCalls).filter((c) => c.args[0] === '--bg').length, 0, 'nothing was sent');

  const turn = await say('Then tell it after all.');
  const a2 = turn.actions[0];
  assert.equal(a2.state, 'proposed');
  // The second ask shows the first proposal's outcome.
  const prompt = calls(claudeCalls).filter((c) => c.args[0] === '-p').at(-1).args.at(-1);
  assert.ok(prompt.includes('proposed tell to "feature x": declined'), prompt);

  const r = await api('/api/overseer/act', { turnId: turn.id, actionId: a2.id, decision: 'run' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.action.state, 'done');
  assert.equal(r.action.result, 'It was restarted in the background with your message.');

  const bg = calls(claudeCalls).filter((c) => c.args[0] === '--bg');
  assert.equal(bg.length, 1, JSON.stringify(calls(claudeCalls)));
  // Still listed by Claude Code with no option picked: it wakes as itself, under the same id.
  assert.deepEqual(bg[0].args, ['--bg', '--resume', SID, '--', 'Please fix the failing build.']);
  assert.equal(fs.realpathSync(bg[0].cwd), fs.realpathSync(repo), 'from its own folder');

  const { turns } = await api('/api/overseer/turns', {});
  assert.equal(turns.find((t) => t.id === firstTurn.id).actions[0].state, 'declined');
  assert.equal(turns.find((t) => t.id === turn.id).actions[0].state, 'done');
  const snap = await until(() => { const f = latest(); return f?.overseer?.proposed === 0 && f.sessions.find((s) => s.sessionId === SID)?.sent?.length ? f : null; }, 5000);
  assert.ok(snap, 'nothing is left to decide, and the session shows what was sent');
  assert.equal(snap.sessions.find((s) => s.sessionId === SID).sent.at(-1).text, 'Please fix the failing build.');
});

test('the overseer routes need the token', async () => {
  const n = calls(claudeCalls).filter((c) => c.args[0] === '-p').length;
  for (const p of ['/api/overseer/say', '/api/overseer/turns', '/api/overseer/act', '/api/github/log']) {
    const r = await post(p, { text: 'hello' }, '0'.repeat(48));
    assert.equal(r.status, 403, p);
  }
  const noOrigin = await fetch(BASE + '/api/overseer/say', { method: 'POST', headers: { 'content-type': 'application/json', 'x-acp-token': token }, body: '{"text":"hi"}' });
  assert.equal(noOrigin.status, 403, 'and a same-origin Origin');
  await pause(300);
  assert.equal(calls(claudeCalls).filter((c) => c.args[0] === '-p').length, n, 'nothing was asked');
});

test('a proposed tell that starts with / is kept as invalid, and cannot be run', async () => {
  const turn = await say('Its context looks long.');
  const a = turn.actions[0];
  assert.equal(a.type, 'tell');
  assert.equal(a.state, 'invalid');
  assert.equal(a.text, '/compact now');
  assert.match(a.result, /starts with \/ or !/);
  const r = await api('/api/overseer/act', { turnId: turn.id, actionId: a.id, decision: 'run' });
  assert.equal(r.ok, false);
  assert.match(r.error, /^The panel won't run this one\./);
  assert.equal(calls(claudeCalls).filter((c) => c.args[0] === '--bg').length, 1, 'nothing more was sent');
  assert.equal(fs.readFileSync(counter, 'utf8'), '3', 'three asks in all');
});

test('the PR watcher, turned on, asks the job on the failing branch to fix it, with the failing log', async () => {
  const before = calls(claudeCalls).length;
  assert.deepEqual(await api('/api/watcher/enabled', { on: true }), { ok: true, enabled: true });
  const sent = await until(() => calls(claudeCalls).slice(before).find((c) => c.args[0] === '--bg' && /PR watcher/.test(c.args.at(-1))));
  assert.ok(sent, 'the watcher sent a fix request: ' + JSON.stringify(calls(claudeCalls).slice(before)));
  assert.deepEqual(sent.args.slice(0, 4), ['--bg', '--resume', SID, '--']);
  assert.match(sent.args.at(-1), /^build failed on feat\/x \(pull request #7\) in o\/n\./, 'it carries the failing log');
  assert.match(sent.args.at(-1), /fix 1 of 3/);
  const st = await until(() => latest()?.watcher?.prs?.['o/n#7']);
  assert.equal(st.fixes, 1);
  assert.equal(st.kind, 'failing');
  // Nothing is asked again for the same commit.
  await api('/api/watcher/enabled', { on: true });
  await pause(500);
  assert.equal(calls(claudeCalls).slice(before).filter((c) => /PR watcher/.test(c.args.at(-1) ?? '')).length, 1);
});
