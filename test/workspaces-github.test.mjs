// GitHub, sealed to workspaces, end to end: the real server on a throwaway home with two profiles (~/.claude and
// ~/.claude-contract), each a workspace, and GitHub on. A stand-in `gh` knows three repositories: o/p (sorted into
// default, where the default job works), o/n (sorted into contract, where the contract job works) and o/q (sorted into
// none: only your own pull request is open there). Both jobs' pull requests have a check that failed half a minute ago,
// so the first poll notifies, through a stand-in `osascript` (or, off a Mac, `notify-send`) that logs its argv. A second contract job works in o/x, sorted
// into none: a repository only contract's sessions work in, which the default page must never be told of.
// Run with `npm test`. Starts the server on a spare port.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const PORT = 47900 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-wsgh-'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const SID_D = 'aaaaaaaa-1111-4111-8111-111111111111', SID_C = 'cccccccc-2222-4222-8222-222222222222';
const SID_X = 'cccccccc-5555-4555-8555-555555555555';
const REFUSE = 'That belongs to another workspace. Switch to it to do this.';

// A checkout per job. The panel reads the branch and the remote from these files, never from git.
function checkout(name, slug, branch) {
  const dir = path.join(home, 'code', name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/${slug}.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  return dir;
}
const workD = checkout('p', 'o/p', 'feat/p'), workC = checkout('n', 'o/n', 'feat/x'), workX = checkout('x', 'o/x', 'feat/xx');
const transcript = (text, cwd) => [
  JSON.stringify({ type: 'user', cwd, permissionMode: 'default', timestamp: '2026-11-12T10:00:00.000Z', message: { role: 'user', content: text } }),
  JSON.stringify({ type: 'assistant', cwd, timestamp: '2026-11-12T10:00:01.000Z', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Done.' }] } }),
].join('\n') + '\n';
for (const [dir, sid, cwd] of [['.claude', SID_D, workD], ['.claude-contract', SID_C, workC], ['.claude-contract', SID_X, workX]]) {
  fs.mkdirSync(path.join(home, dir, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(home, dir, 'settings.json'), '{}');
  fs.writeFileSync(path.join(home, dir, 'projects', 'p', `${sid}.jsonl`), transcript(`work in ${dir}`, cwd));
}
// One background job per profile, up and idle: the PR watcher's fix request resumes it with --bg.
const job = (sid, name, cwd) => ({ pid: null, id: sid.slice(0, 8), cwd, kind: 'background', startedAt: Date.now(), sessionId: sid, name, status: 'idle', state: 'running' });
fs.writeFileSync(path.join(home, 'roster-default.json'), JSON.stringify([job(SID_D, 'default job', workD)]));
fs.writeFileSync(path.join(home, 'roster-.claude-contract.json'), JSON.stringify([job(SID_C, 'contract job', workC), job(SID_X, 'contract side job', workX)]));

const calls = path.join(home, 'claude-calls.log'), ghCalls = path.join(home, 'gh-calls.log'), notes = path.join(home, 'osascript.log');
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs'), path = require('path');
const a = process.argv.slice(2), cfg = process.env.CLAUDE_CONFIG_DIR ?? null;
if (a[0] === 'agents') {
  const f = path.join(${JSON.stringify(home)}, 'roster-' + (cfg ? path.basename(cfg) : 'default') + '.json');
  try { process.stdout.write(fs.readFileSync(f, 'utf8')); } catch { process.stdout.write('[]'); }
  process.exit(0);
}
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ args: a, env: cfg }) + '\\n');
if (a[0] === 'auth') { console.log('{}'); process.exit(0); }
if (a[0] === '--bg') { const i = a.indexOf('--resume'); console.log('backgrounded · ' + (i >= 0 ? a[i + 1].slice(0, 8) : 'deadbeef')); process.exit(0); }
if (a[0] === '-p') {
  const v = { reply: 'Answered on ' + (cfg ? path.basename(cfg) : 'default') + '.', actions: [], look: [] };
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: JSON.stringify(v), structured_output: v }));
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });

// Each job's pull request, with a check that failed half a minute before gh is asked (fresh enough to notify on the first
// poll). o/q holds only your own pull request. The checks fail only once `ciFailing` exists: a notification follows the
// focus at the moment it is sent, so the failures must not reach the panel until the test has settled the focus (a poll
// can start as soon as the first page opens, and a fast machine finishes it while the focus is still moving).
const ciFailing = path.join(home, 'ci-failing');
fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2), has = (x) => a.includes(x), after = (x) => a[a.indexOf(x) + 1];
const failing = fs.existsSync(${JSON.stringify(ciFailing)});
fs.appendFileSync(${JSON.stringify(ghCalls)}, JSON.stringify({ args: a }) + '\\n');
const out = (v) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
const at = new Date(Date.now() - 30000).toISOString(), began = new Date(Date.now() - 90000).toISOString();
const check = (slug, run, job) => ({ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE',
  detailsUrl: 'https://github.com/' + slug + '/actions/runs/' + run + '/job/' + job, workflowName: 'CI', completedAt: at, startedAt: began });
const pr = (slug, number, title, branch, checks, login) => ({ number, title, url: 'https://github.com/' + slug + '/pull/' + number, isDraft: false,
  headRefName: branch, headRefOid: 'abc' + number, baseRefName: 'main', isCrossRepository: false, mergeable: 'MERGEABLE',
  mergeStateStatus: checks.length ? 'UNSTABLE' : 'CLEAN', reviewDecision: '', statusCheckRollup: checks, updatedAt: at, author: { login } });
const OPEN = {
  'github.com/o/n': [pr('o/n', 7, 'Contract feature', 'feat/x', failing ? [check('o/n', 123, 456)] : [], 'someone')],
  'github.com/o/p': [pr('o/p', 3, 'Private feature', 'feat/p', failing ? [check('o/p', 321, 654)] : [], 'someone')],
  'github.com/o/q': [pr('o/q', 9, 'Stray change', 'feat/q', [], 'me')],
};
if (a[0] === 'auth') { process.stderr.write('Logged in to github.com account me\\n'); process.exit(0); }
if (a[0] === 'repo' && a[1] === 'view') out({ defaultBranchRef: { name: 'main' } });
if (a[0] === 'search' && a[1] === 'prs') out([{ repository: { nameWithOwner: 'o/q' }, number: 9, author: { login: 'me' } }]);
if (a[0] === 'pr' && a[1] === 'list' && after('--state') === 'open') out(OPEN[after('-R')] ?? []);
if (a[0] === 'pr' && a[1] === 'list' && after('--state') === 'merged') out([]);
if (a[0] === 'run' && a[1] === 'list') out([]);
if (a[0] === 'run' && a[1] === 'view' && has('--log-failed')) out('CI / build\\tRun tests\\t2026-01-01T00:00:01Z not ok 1 - adds\\n');
process.stderr.write('unexpected gh call: ' + a.join(' ') + '\\n');
process.exit(1);
`, { mode: 0o755 });
// The Mac's notifier, or Linux's: both take the title and then the text as their last two arguments.
for (const name of ['osascript', 'notify-send']) fs.writeFileSync(path.join(bin, name), `#!${process.execPath}
require('fs').appendFileSync(${JSON.stringify(notes)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o755 });

const prefs = path.join(home, 'panel', 'prefs.json');
fs.mkdirSync(path.dirname(prefs));
fs.writeFileSync(prefs, JSON.stringify({ profile: 'default' }));
// o/n is contract's, o/p default's, o/q in no workspace. The focus is default.
fs.writeFileSync(path.join(home, 'panel', 'workspaces.json'), JSON.stringify({ v: 1,
  workspaces: { default: { name: 'claude', color: 'violet' }, contract: { name: 'claude-contract', color: 'blue' } }, order: ['contract', 'default'],
  repos: { 'gh:o/n': ['contract'], 'gh:o/p': ['default'] }, focus: 'default' }), { mode: 0o600 });
// What the PR watcher last did on o/n's pull request (contract's) and on o/q's (in no workspace), from before this start.
fs.writeFileSync(path.join(home, 'panel', 'watcher.json'), JSON.stringify({ v: 1, enabled: true, enabledBy: {}, done: {}, fixes: {}, capped: {}, retry: {},
  last: { 'o/n#7': { kind: 'failing', at: Date.now() - 60_000, result: 'asked', fixes: 1 }, 'o/q#9': { kind: 'failing', at: Date.now() - 60_000, result: 'tell it yourself', fixes: 0 } } }), { mode: 0o600 });

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('ACP_')));
const server = spawn(process.execPath, [SERVER], { env: { ...env, HOME: home, PATH: `${bin}:${env.PATH}`, ACP_PORT: String(PORT), ACP_PREFS: prefs }, stdio: ['ignore', 'pipe', 'pipe'] });
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
const api = (p, body, client) => fetch(BASE + p, { method: 'POST', body: JSON.stringify(body ?? {}),
  headers: { 'content-type': 'application/json', origin: BASE, 'x-acp-token': token, ...(client ? { 'x-acp-client': client } : {}) } })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));

const pages = [];
function watch(client) {
  const frames = [], ctl = new AbortController();
  fetch(`${BASE}/events?t=${token}&c=${client}`, { signal: ctl.signal }).then(async (r) => {
    let buf = '';
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString();
      for (const m of buf.matchAll(/^data: (.*)$/gm)) { try { frames.push(JSON.parse(m[1])); } catch {} }
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    }
  }).catch(() => {});
  const pg = { client, frames, latest: () => frames.findLast((f) => Array.isArray(f?.sessions)), close: () => ctl.abort() };
  pages.push(pg);
  return pg;
}
async function until(fn, ms = 15_000, every = 150) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(every)) { const v = await fn(); if (v) return v; }
  return null;
}
const lines = (f) => { try { return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
after(async () => { for (const p of pages) p.close(); if (server.exitCode === null && server.signalCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); }); fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });

// Page A shows default, page B contract. Once both jobs are on the board, a third page opens: opening one is what starts
// a GitHub poll.
const A = watch('page-a'), B = watch('page-b');
await until(() => A.latest() && B.latest());
assert.equal((await api('/api/workspace/focus', { ws: 'contract' }, B.client)).ok, true);
assert.ok(await until(() => A.latest()?.sessions.some((s) => s.sessionId === SID_D && s.inRoster) && B.latest()?.sessions.some((s) => s.sessionId === SID_C && s.inRoster)),
  'both rosters are read: ' + log);
// The desktop's focus is the workspace focused last, by any page: default, again.
assert.equal((await api('/api/workspace/focus', { ws: 'default' }, A.client)).ok, true);
// Only now do the checks fail. GitHub is asked again until both pages see them: a refresh that lands while a poll is
// still running only marks every repository due for the next beat, which can be later than a test waits.
fs.writeFileSync(ciFailing, '');
const failingIn = (pg) => pg.latest()?.github?.repos?.some((r) => r.prs?.some((p) => p.checks === 'failing'));
assert.ok(await until(async () => {
  if (failingIn(A) && failingIn(B)) return true;
  await api('/api/github/refresh', {}, A.client); // at most one a 10 s, the server's own limit
  return null;
}, 60_000, 1000), 'GitHub reports the failing checks to both pages');
watch('page-poll');
const polled = (pg) => { const f = pg.latest(); return f?.github?.repos?.some((r) => r.prs?.length) ? f : null; };
assert.ok(await until(() => polled(A) && polled(B), 20_000), `GitHub was polled: ${JSON.stringify(A.latest()?.github)} | ${JSON.stringify(lines(ghCalls))} | ${log}`);

test('the GitHub panel lists only the workspace\'s repositories', async () => {
  // Once all three repositories are polled (o/q, your own, is found by the search).
  assert.ok(await until(() => lines(ghCalls).filter((c) => c.args[0] === 'pr' && c.args.includes('open')).length >= 3), JSON.stringify(lines(ghCalls)));
  const snap = await until(() => { const f = A.latest(); return f?.github?.repos?.find((r) => r.slug === 'o/p')?.prs?.length ? f : null; });
  assert.ok(snap, JSON.stringify(A.latest()?.github));
  assert.deepEqual(snap.github.repos.map((r) => r.slug), ['o/p']);
  assert.equal(JSON.stringify(snap).includes('o/n'), false, 'page A carries o/n');
  assert.equal(JSON.stringify(snap).includes('o/x'), false, 'page A carries o/x, which only contract\'s sessions work in');
  assert.equal(snap.sessions.find((s) => s.sessionId === SID_D)?.gh?.slug, 'o/p', 'its own job sees its pull request');
  const b = B.latest();
  assert.deepEqual(b.github.repos.map((r) => r.slug), ['o/n']);
  assert.equal(b.sessions.find((s) => s.sessionId === SID_C)?.gh?.pr?.number, 7);
  assert.equal(JSON.stringify(b).includes('o/p'), false, 'page B carries o/p');
  // What a refresh answers is sealed too.
  const r = await api('/api/github/refresh', {}, A.client);
  assert.equal(r.ok, true);
  assert.equal(JSON.stringify(r).includes('o/n'), false, JSON.stringify(r));
});

test('unsorted repositories are a count', async () => {
  // Once o/x is polled too (contract's side job works in it).
  assert.ok(await until(() => lines(ghCalls).some((c) => c.args[0] === 'pr' && c.args.includes('github.com/o/x'))), JSON.stringify(lines(ghCalls)));
  const b = await until(() => { const f = B.latest(); return f?.github?.unsorted === 2 ? f : null; });
  assert.ok(b, 'page B counts o/q and o/x: ' + JSON.stringify(B.latest()?.github));
  assert.equal(JSON.stringify(b).includes('o/q'), false, 'page B names o/q');
  // Page A counts o/q (no session works in it) but not o/x, which only another workspace's sessions work in.
  const snap = A.latest();
  assert.equal(snap.github.unsorted, 1, JSON.stringify(snap.github));
  // And what neither watches is counted per workspace: each has its six, and nothing over.
  assert.equal(snap.github.more, 0, JSON.stringify(snap.github));
  assert.equal(b.github.more, 0, JSON.stringify(b.github));
  assert.equal(JSON.stringify(snap).includes('o/q'), false, 'page A names o/q');
  assert.equal(JSON.stringify(snap).includes('o/x'), false, 'page A names o/x');
});

test('a failing check in another workspace notifies by count only', async () => {
  // The focused workspace's failure, as today.
  // (The stand-in logs as each call lands, which need not be the order they were made in.)
  const own = await until(() => lines(notes).find((a) => a.at(-2) === 'Glue · CI failed'));
  assert.ok(own, 'the focused workspace notifies: ' + JSON.stringify(lines(notes)));
  assert.equal(own.at(-1), 'o/p: build failed on feat/p (#3).', 'by name, as today');
  // The other one's, by count only.
  const other = await until(() => lines(notes).find((a) => a.at(-1) === 'claude-contract: a check failed'));
  assert.ok(other, JSON.stringify(lines(notes)));
  assert.equal(other.at(-2), 'Glue');
  // The PR watcher asks the contract job to fix it, on contract's login, and says so by count only too.
  const fix = await until(() => lines(calls).find((c) => c.args[0] === '--bg' && c.args.includes(SID_C)));
  assert.ok(fix, 'the watcher asked the contract job: ' + JSON.stringify(lines(calls)));
  assert.ok(fix.env?.endsWith('.claude-contract'));
  assert.ok(await until(() => lines(notes).filter((a) => a.at(-1) === 'claude-contract: a check failed').length >= 2), JSON.stringify(lines(notes)));
  assert.ok(await until(() => lines(notes).some((a) => a.at(-2) === 'Glue · fix asked' && a.at(-1).includes('o/p'))), 'the focused one\'s fix is told as today: ' + JSON.stringify(lines(notes)));
  for (const a of lines(notes)) for (const bit of ['o/n', '#7', 'feat/x', 'contract job', 'Contract feature', 'o/q', 'o/x'])
    assert.equal(a.some((x) => x.includes(bit)), false, `a notification carries ${bit}: ${JSON.stringify(a)}`);
});

test('a run in another workspace\'s repository is not handed out', async () => {
  const no = await api('/api/github/log', { slug: 'o/n', runId: '123', jobId: '456' }, A.client);
  assert.equal(no.ok, false, JSON.stringify(no));
  assert.equal(no.error, REFUSE);
  const before = lines(calls).length;
  const hand = await api('/api/github/hand', { sessionId: SID_D, slug: 'o/n', runId: '123', jobId: '456' }, A.client);
  assert.equal(hand.ok, false, JSON.stringify(hand));
  assert.equal(lines(calls).length, before, 'nothing was sent');
  const yes = await api('/api/github/log', { slug: 'o/n', runId: '123', jobId: '456' }, B.client);
  assert.equal(yes.ok, true, JSON.stringify(yes));
  const mine = await api('/api/github/log', { slug: 'o/p', runId: '321', jobId: '654' }, A.client);
  assert.equal(mine.ok, true, JSON.stringify(mine));
});

test('each overseer reads only its own workspace\'s GitHub', async () => {
  const before = lines(calls).length;
  const r = await api('/api/overseer/say', { text: 'What is going on?' }, A.client);
  assert.equal(r.ok, true, JSON.stringify(r));
  const ask = await until(() => lines(calls).slice(before).find((c) => c.args[0] === '-p'));
  assert.ok(ask, 'it asked: ' + log);
  assert.equal(ask.env, null, 'on the default login');
  const prompt = ask.args.at(-1);
  assert.ok(prompt.includes('o/p'), prompt);
  for (const bit of ['o/n', 'o/q', 'o/x', 'Contract feature', 'Stray change']) assert.equal(prompt.includes(bit), false, `the default overseer's prompt carries ${bit}`);
});

test('the PR watcher\'s record shows only the workspace\'s own repositories\' pull requests', async () => {
  // Contract's page sees what was done on its o/n pull request; the default page does not, and neither sees o/q's, which
  // is in no workspace.
  const b = await until(() => { const f = B.latest(); return f?.watcher?.prs?.['o/n#7'] ? f : null; });
  assert.ok(b, 'page B shows o/n#7: ' + JSON.stringify(B.latest()?.watcher));
  assert.equal(Object.hasOwn(b.watcher.prs, 'o/q#9'), false, 'page B shows o/q#9: ' + JSON.stringify(b.watcher.prs));
  for (const k of Object.keys(b.watcher.prs)) assert.ok(k.startsWith('o/n#'), `page B shows ${k}`);
  const a = A.latest();
  assert.equal(Object.hasOwn(a.watcher.prs, 'o/n#7'), false, 'page A shows o/n#7: ' + JSON.stringify(a.watcher.prs));
  assert.equal(Object.hasOwn(a.watcher.prs, 'o/q#9'), false, 'page A shows o/q#9: ' + JSON.stringify(a.watcher.prs));
  for (const k of Object.keys(a.watcher.prs)) assert.ok(k.startsWith('o/p#'), `page A shows ${k}`);
});

test('Auto-fix is set for the focused workspace only', async () => {
  const on = (pg) => pg.latest()?.watcher?.enabled;
  assert.equal(on(A), true);
  assert.equal(on(B), true);
  const r = await api('/api/watcher/enabled', { on: false }, A.client);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(await until(() => on(A) === false), 'page A shows it off: ' + JSON.stringify(A.latest()?.watcher));
  assert.equal(on(B), true, 'page B still shows it on');
  assert.equal((await api('/api/watcher/enabled', { on: true }, A.client)).ok, true);
  assert.ok(await until(() => on(A) === true && on(B) === true));
});

const unsortedOf = (client) => fetch(BASE + '/api/workspace/unsorted', { headers: { 'x-acp-token': token, 'x-acp-client': client } })
  .then(async (x) => ({ status: x.status, ...(await x.json()) }));

test('the list of unsorted repositories names those in no workspace, and no other', async () => {
  const q = { key: 'gh:o/q', label: 'o/q' }, x = { key: 'gh:o/x', label: 'o/x' };
  const byKey = (a, b) => a.key.localeCompare(b.key);
  for (const [pg, want] of [[A, [q]], [B, [q, x]]]) {
    const r = await unsortedOf(pg.client);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual([...r.repos].sort(byKey), want, `page ${pg.client}`);
    assert.equal(JSON.stringify(r).includes('o/p'), false, 'it names o/p, which default holds');
    assert.equal(JSON.stringify(r).includes('o/n'), false, 'it names o/n, which contract holds');
  }
  // o/x is in no workspace, but only contract's sessions work in it: the default page is never told its name.
  assert.equal(JSON.stringify(await unsortedOf(A.client)).includes('o/x'), false, 'page A is told of o/x');
  assert.equal((await fetch(BASE + '/api/workspace/unsorted')).status, 403, 'not without the token');
  // Sorted into the other workspace, it is no longer unsorted: it is that workspace's, and not named to this page.
  assert.equal((await api('/api/workspace/assign', { key: 'gh:o/q', ws: ['contract'] }, A.client)).ok, true);
  assert.deepEqual((await unsortedOf(A.client)).repos, []);
  assert.deepEqual((await unsortedOf(B.client)).repos, [x]);
  assert.ok(await until(() => A.latest()?.github?.unsorted === 0), JSON.stringify(A.latest()?.github));
  assert.equal(JSON.stringify(A.latest()).includes('o/q'), false, 'page A names o/q');
  // Sorted into this one too (by the workspace that holds it: a page may not claim another's), it is both workspaces' and
  // still not unsorted.
  assert.equal((await api('/api/workspace/assign', { key: 'gh:o/q', ws: ['contract', 'default'] }, A.client)).ok, false);
  assert.equal((await api('/api/workspace/assign', { key: 'gh:o/q', ws: ['contract', 'default'] }, B.client)).ok, true);
  assert.deepEqual((await unsortedOf(A.client)).repos, []);
  assert.ok(await until(() => A.latest()?.github?.repos.some((r) => r.slug === 'o/q')));
});

test('with one workspace there is nothing to sort into: the list is empty', async (t) => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-wsgh1-')), port = PORT + 100;
  fs.mkdirSync(path.join(h, '.claude'));
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'), '{}');
  const pf = path.join(h, 'panel', 'prefs.json');
  fs.mkdirSync(path.dirname(pf));
  fs.writeFileSync(pf, JSON.stringify({ profile: 'default' }));
  const child = spawn(process.execPath, [SERVER], { env: { ...env, HOME: h, PATH: `${bin}:${env.PATH}`, ACP_PORT: String(port), ACP_PREFS: pf }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const ctl = new AbortController();
  t.after(async () => { ctl.abort(); if (child.exitCode === null && child.signalCode === null) await new Promise((r) => { child.once('exit', r); child.kill(); }); fs.rmSync(h, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  assert.ok(await until(() => out.includes(`127.0.0.1:${port}`)), 'it started: ' + out);
  const base = `http://127.0.0.1:${port}`, tok = (await (await fetch(base + '/')).text()).match(/[0-9a-f]{48}/)[0];
  // A page open starts the poll, which finds o/q (your own pull request).
  let last = null;
  fetch(`${base}/events?t=${tok}&c=page-solo`, { signal: ctl.signal }).then(async (r) => {
    let buf = '';
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString();
      for (const m of buf.matchAll(/^data: (.*)$/gm)) { try { const f = JSON.parse(m[1]); if (Array.isArray(f?.sessions)) last = f; } catch {} }
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    }
  }).catch(() => {});
  assert.ok(await until(() => last?.github?.repos?.some((r) => r.slug === 'o/q'), 30_000), `the lone workspace's page shows o/q: ${JSON.stringify(last?.github)} | ${out}`);
  assert.equal(last.workspaces.length, 1);
  assert.equal(last.github.unsorted, 0);
  const r = await fetch(base + '/api/workspace/unsorted', { headers: { 'x-acp-token': tok, 'x-acp-client': 'page-solo' } }).then((x) => x.json());
  assert.deepEqual(r, { ok: true, repos: [] });
});
