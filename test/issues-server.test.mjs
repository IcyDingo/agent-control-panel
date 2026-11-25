// Issues end to end: the real server on a throwaway home, with a stand-in `claude` (roster, launches) and `gh` (open and
// merged pull requests). An issue and its items are made through the routes; the first pick-up makes the issue's space
// and goes through the form (a launch that names the item); later pick-ups start at once in a worktree of their own;
// the agent is linked to its item, its branch recorded, and when a pull request from that branch merges (after the agent
// left the board) the item is done. Run with `npm test`. Starts the server on a spare port.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-issues-'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const sidOf = (id8) => `${id8}-0000-4000-8000-000000000000`;

// A checkout of github.com/o/shop, on branch feat-x (the agent's), and its transcripts.
const repo = path.join(home, 'code', 'shop');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.writeFileSync(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/feat-x\n');
fs.writeFileSync(path.join(repo, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:o/shop.git\n');
const projects = path.join(home, '.claude', 'projects', 'p');
fs.mkdirSync(projects, { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');
const transcript = (sid, said) => fs.writeFileSync(path.join(projects, `${sid}.jsonl`), [
  JSON.stringify({ parentUuid: null, type: 'user', cwd: repo, timestamp: new Date().toISOString(), message: { role: 'user', content: 'go' } }),
  JSON.stringify({ parentUuid: null, type: 'assistant', cwd: repo, timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: said }] } }),
].join('\n') + '\n');

const rosterFile = path.join(home, 'roster.json'), roster = [];
const setRoster = (fn) => { fn(roster); fs.writeFileSync(rosterFile, JSON.stringify(roster)); };
const job = (id8, name, over = {}) => ({ pid: null, id: id8, cwd: repo, kind: 'background', startedAt: Date.now(), sessionId: sidOf(id8), name, status: 'busy', state: 'running', ...over });
setRoster(() => {});

const calls = path.join(home, 'claude-calls.log'), counter = path.join(home, 'counter'), prsFile = path.join(home, 'prs.json');
const setPrs = (v) => fs.writeFileSync(prsFile, JSON.stringify(v));
setPrs({ open: [], merged: [] });
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
if (a[0] === 'agents') { process.stdout.write(fs.readFileSync(${JSON.stringify(rosterFile)}, 'utf8')); process.exit(0); }
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ cwd: process.cwd(), args: a }) + '\\n');
if (a[0] === 'auth') { console.log('{}'); process.exit(0); }
if (a[0] === '--bg') {
  let n = 0; try { n = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) || 0; } catch {}
  fs.writeFileSync(${JSON.stringify(counter)}, String(++n));
  console.log('backgrounded · c' + String(n).padStart(7, '0'));
  process.exit(0);
}
process.exit(1);
`, { mode: 0o755 });
fs.writeFileSync(path.join(bin, 'gh'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2), after = (x) => a[a.indexOf(x) + 1];
const out = (v) => { process.stdout.write(JSON.stringify(v)); process.exit(0); };
const prs = JSON.parse(fs.readFileSync(${JSON.stringify(prsFile)}, 'utf8'));
const at = new Date().toISOString();
if (a[0] === 'auth') { process.stderr.write('Logged in to github.com account me\\n'); process.exit(0); }
if (a[0] === 'repo' && a[1] === 'view') out({ defaultBranchRef: { name: 'main' }, viewerDefaultMergeMethod: 'MERGE' });
if (a[0] === 'search') out([]);
if (a[0] === 'pr' && a[1] === 'list' && after('--state') === 'open') out(prs.open.map((p) => ({ number: p.number, title: 'x', url: 'https://github.com/o/shop/pull/' + p.number, isDraft: false,
  headRefName: p.branch, headRefOid: 'abc' + p.number, baseRefName: 'main', isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  reviewDecision: '', statusCheckRollup: [], updatedAt: at, author: { login: 'me' } })));
if (a[0] === 'pr' && a[1] === 'list' && after('--state') === 'merged') out(prs.merged.map((p) => ({ number: p.number, title: 'x', url: 'https://github.com/o/shop/pull/' + p.number,
  headRefName: p.branch, baseRefName: 'main', mergedAt: at, mergeCommit: { oid: 'm' + p.number }, author: { login: 'me' } })));
if (a[0] === 'run' && a[1] === 'list') out([]);
process.exit(1);
`, { mode: 0o755 });

const prefs = path.join(home, 'panel', 'prefs.json');
fs.mkdirSync(path.dirname(prefs));
fs.writeFileSync(prefs, JSON.stringify({ profile: 'default', glue: { notify: { requests: false, ci: false, watcher: false }, followUps: false } }));
fs.writeFileSync(path.join(home, 'panel', 'watcher.json'), JSON.stringify({ v: 1, enabled: false }));
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
const api = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-acp-token': token }, body: JSON.stringify(body ?? {}) })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));
async function until(fn, ms = 15_000, every = 150) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(every)) { const v = await fn(); if (v) return v; }
  return null;
}
const snapshot = async () => {
  const c = new AbortController();
  const r = await fetch(`${BASE}/events?t=${token}`, { signal: c.signal });
  const reader = r.body.getReader();
  let buf = '';
  for (;;) { const { value } = await reader.read(); buf += Buffer.from(value).toString(); const m = buf.match(/^data: (.*)$/m); if (m) { c.abort(); return JSON.parse(m[1]); } }
};
const logged = () => { try { return fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const launches = () => logged().filter((c) => c.args[0] === '--bg' && !c.args.includes('--resume'));
const issueAt = async (id) => (await snapshot()).issues.find((x) => x.id === id);
after(async () => { if (server.exitCode === null && server.signalCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); }); fs.rmSync(home, { recursive: true, force: true }); });

let issue, a, b, space;

test('issues and their items are made through the routes and reach the page', async () => {
  const r = await api('/api/issue/create', { title: 'Checkout on the v2 API' });
  assert.equal(r.ok, true, JSON.stringify(r));
  issue = r.id;
  a = (await api('/api/issue/item/add', { issue, text: 'Cart endpoint' })).id;
  b = (await api('/api/issue/item/add', { issue, text: 'Cart page' })).id;
  assert.equal((await api('/api/issue/item/add', { issue: 'nope', text: 'x' })).ok, false);
  const got = await issueAt(issue);
  assert.deepEqual(got.items.map((x) => [x.text, x.state]), [['Cart endpoint', 'todo'], ['Cart page', 'todo']]);
  assert.equal((await api('/api/issue/move', { issue, item: b, before: a })).ok, true);
  assert.deepEqual((await issueAt(issue)).items.map((x) => x.text), ['Cart page', 'Cart endpoint']);
  assert.equal((await api('/api/issue/move', { issue, item: b })).ok, true);
});

test('a first pick-up needs the form; preparing it makes the issue\'s space once, with the issue\'s title as its goal', async () => {
  assert.deepEqual(await api('/api/issue/pickup', { issue, item: a }), { status: 200, ok: true, needsForm: true });
  const [p1, p2] = await Promise.all([api('/api/issue/prepare', { issue, item: a }), api('/api/issue/prepare', { issue, item: a })]);
  assert.equal(p1.ok && p2.ok, true, JSON.stringify([p1, p2]));
  assert.equal(p1.space, p2.space, 'one space for two calls at once');
  space = p1.space;
  assert.equal(p1.prompt, 'Cart endpoint\n\nThis is part of: Checkout on the v2 API.');
  const sp = (await snapshot()).spaces.filter((x) => x.name.startsWith('Checkout on the v2 API'));
  assert.deepEqual(sp.map((x) => [x.id, x.goal]), [[space, 'Checkout on the v2 API']]);
  assert.deepEqual([(await issueAt(issue)).space, (await issueAt(issue)).owns], [space, true]);
});

test('the form\'s launch starts the item in a worktree of its own, and keeps the folder and choices on the issue', async () => {
  const r = await api('/api/launch', { prompt: 'Cart endpoint\n\nThis is part of: Checkout on the v2 API.', cwd: repo, model: 'sonnet', mode: 'default', space, issue: { issue, item: a } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const args = launches().at(-1).args;
  assert.ok(args.includes('--worktree'), 'a worktree of its own, whatever Settings says');
  assert.match(args[args.indexOf('--worktree') + 1], new RegExp(`^issue-${a}`));
  const it = (await issueAt(issue)).items.find((x) => x.id === a);
  assert.deepEqual([it.state, it.launchId], ['working', r.id]);
  const got = await issueAt(issue);
  assert.equal(got.folder, repo);
  assert.equal(got.choices.model, 'sonnet');
  // It shows up: linked to its item, in its space, and its branch (not the default one) is recorded.
  transcript(sidOf(r.id), 'On it.');
  setRoster((ro) => ro.push(job(r.id, 'Cart endpoint')));
  const linked = await until(async () => (await issueAt(issue)).items.find((x) => x.id === a && x.sessionId === sidOf(r.id)));
  assert.ok(linked, 'the item is linked to its agent: ' + log.slice(-400));
  assert.ok(await until(async () => (await snapshot()).sessions.find((s) => s.sessionId === sidOf(r.id))?.space === space), 'in the issue\'s space');
  assert.ok(await until(async () => (await issueAt(issue)).items.find((x) => x.id === a)?.branches.includes('feat-x')), 'its branch recorded');
});

test('a later pick-up starts at once, in the issue\'s folder and space, with the kept choices and the item as its prompt', async () => {
  const n = launches().length;
  const r = await api('/api/issue/pickup', { issue, item: b });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(launches().length, n + 1);
  const c = launches().at(-1), args = c.args;
  assert.equal(fs.realpathSync(c.cwd), fs.realpathSync(repo));
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.match(args[args.indexOf('--worktree') + 1], new RegExp(`^issue-${b}`));
  assert.equal(args.at(-1), 'Cart page\n\nThis is part of: Checkout on the v2 API.');
  assert.equal((await issueAt(issue)).items.find((x) => x.id === b).state, 'working');
  assert.match((await api('/api/issue/pickup', { issue, item: b })).error, /already/, 'not twice while its agent is on it');
});

test('two pick-ups of one item at once start one agent; the form cannot start a second one either', async () => {
  const c = (await api('/api/issue/item/add', { issue, text: 'Coupons' })).id, n = launches().length;
  const rs = await Promise.all([api('/api/issue/pickup', { issue, item: c }), api('/api/issue/pickup', { issue, item: c })]);
  assert.equal(rs.filter((r) => r.ok && r.id).length, 1, JSON.stringify(rs));
  assert.equal(launches().length, n + 1, 'one launch, not two');
  const r = await api('/api/launch', { prompt: 'x', cwd: repo, model: '', mode: 'default', space, issue: { issue, item: c } });
  assert.equal(r.ok, false);
  assert.match(r.error, /already/);
  assert.equal(launches().length, n + 1);
  assert.equal((await api('/api/issue/item/delete', { issue, item: c })).ok, true);
});

test('notes travel with a pick-up: the item, its note, which issue it is part of, then the issue\'s notes as context', async () => {
  const d = (await api('/api/issue/item/add', { issue, text: 'Empty cart state' })).id;
  assert.equal((await api('/api/issue/notes', { issue, notes: 'Use the v2 API.\nTotals come from /api/cart/totals.' })).ok, true);
  assert.equal((await api('/api/issue/item/note', { issue, item: d, note: 'Match the Figma frame "Cart v3".' })).ok, true);
  const got = await issueAt(issue);
  assert.equal(got.notes, 'Use the v2 API.\nTotals come from /api/cart/totals.');
  assert.equal(got.items.find((x) => x.id === d).note, 'Match the Figma frame "Cart v3".');
  const p = await api('/api/issue/prepare', { issue, item: d });
  const want = 'Empty cart state\n\nMatch the Figma frame "Cart v3".\n\nThis is part of: Checkout on the v2 API.\n\nContext for this issue:\nUse the v2 API.\nTotals come from /api/cart/totals.';
  assert.equal(p.prompt, want);
  assert.equal((await api('/api/issue/pickup', { issue, item: d })).ok, true);
  assert.equal(launches().at(-1).args.at(-1), want, 'the agent gets the same');
  assert.equal((await api('/api/issue/notes', { issue, notes: '' })).ok, true, 'notes can be cleared');
  assert.equal((await api('/api/issue/item/delete', { issue, item: d })).ok, true);
});

test('files: attached to an issue and an item, served only with the token, listed in a pick-up\'s task, the agent may read their folder', async () => {
  const up = (q, bytes, headers = {}) => fetch(`${BASE}/api/issue/upload?${new URLSearchParams(q)}`, { method: 'POST', headers: { origin: BASE, 'x-acp-token': token, 'content-type': 'application/octet-stream', ...headers }, body: bytes })
    .then(async (r) => ({ status: r.status, ...(await r.json()) }));
  const e = (await api('/api/issue/item/add', { issue, text: 'Totals row' })).id;
  const a = await up({ issue, name: 'cart v3.png' }, Buffer.from('PNGDATA'));
  assert.equal(a.ok, true, JSON.stringify(a));
  const b = await up({ issue, item: e, name: '../spec.pdf' }, Buffer.from('%PDF-1.4'));
  assert.equal(b.ok, true, JSON.stringify(b));
  assert.equal((await up({ issue, name: 'x.txt' }, Buffer.from('x'), { 'x-acp-token': 'nope' })).status, 403, 'the page\'s token only');
  assert.equal((await up({ issue: 'nope', name: 'x.txt' }, Buffer.from('x'))).ok, false);
  const got = await issueAt(issue);
  assert.deepEqual(got.files.map((f) => [f.name, f.size]), [['cart v3.png', 7]]);
  assert.deepEqual(got.items.find((x) => x.id === e).files.map((f) => f.name), ['spec.pdf']);
  // Served to the page with its token; nothing without it.
  const served = await fetch(`${BASE}/issue-file?${new URLSearchParams({ t: token, issue, file: a.id })}`);
  assert.equal(served.status, 200);
  assert.equal(await served.text(), 'PNGDATA');
  assert.match(served.headers.get('content-type'), /image\/png/);
  assert.equal((await fetch(`${BASE}/issue-file?${new URLSearchParams({ issue, file: a.id })}`)).status, 403);
  // A pick-up lists the files' paths, item's then issue's, and the agent may read their folder.
  const p = await api('/api/issue/prepare', { issue, item: e });
  const issuePath = p.prompt.match(/Files for this issue:\n- (.+)/)[1], itemPath = p.prompt.match(/Files for this item:\n- (.+)/)[1];
  assert.equal(fs.readFileSync(issuePath, 'utf8'), 'PNGDATA');
  assert.equal(fs.readFileSync(itemPath, 'utf8'), '%PDF-1.4');
  assert.ok(itemPath.endsWith('spec.pdf') && !itemPath.includes('..'));
  assert.equal((await api('/api/issue/pickup', { issue, item: e })).ok, true);
  const args = launches().at(-1).args, dir = args[args.indexOf('--add-dir') + 1];
  assert.ok(args.includes('--add-dir'), 'read access to the files');
  assert.ok(issuePath.startsWith(dir + path.sep) && itemPath.startsWith(dir + path.sep), 'their folder');
  assert.ok(args.indexOf('--add-dir') < args.indexOf('--'), 'before the task');
  // Removing a file, or the item, takes its bytes too.
  assert.equal((await api('/api/issue/file/remove', { issue, file: a.id })).ok, true);
  assert.equal(fs.existsSync(issuePath), false);
  assert.equal((await api('/api/issue/item/delete', { issue, item: e })).ok, true);
  assert.equal(fs.existsSync(itemPath), false);
});

test('when a pull request from its branch merges, after its agent left the board, the item is done', async () => {
  setPrs({ open: [{ number: 12, branch: 'feat-x' }], merged: [] });
  await api('/api/github/refresh', {});
  await pause(1500);
  setRoster((ro) => { ro.length = 0; }); // the agent is cleared
  await pause(1500);
  setPrs({ open: [], merged: [{ number: 12, branch: 'feat-x' }] });
  await api('/api/github/refresh', {});
  const done = await until(async () => { await api('/api/github/refresh', {}); const it = (await issueAt(issue)).items.find((x) => x.id === a); return it?.state === 'done' ? it : null; }, 25_000, 1000);
  assert.ok(done, 'done by the merge: ' + log.slice(-600));
  assert.deepEqual([done.doneBy, done.pr], ['merge', 12]);
});

test('tick and back; renaming the issue renames the space it made; a linked space keeps its name; a space that goes unlinks it', async () => {
  assert.equal((await api('/api/issue/tick', { issue, item: b, on: true })).ok, true);
  assert.equal((await issueAt(issue)).items.find((x) => x.id === b).state, 'done');
  assert.equal((await api('/api/issue/tick', { issue, item: b, on: false })).ok, true);
  assert.equal((await api('/api/issue/back', { issue, item: b })).ok, true);
  assert.equal((await issueAt(issue)).items.find((x) => x.id === b).state, 'todo');
  assert.equal((await api('/api/issue/rename', { id: issue, title: 'Checkout, v2' })).ok, true);
  assert.deepEqual((await snapshot()).spaces.filter((x) => x.id === space).map((x) => [x.name, x.goal]), [['Checkout, v2', 'Checkout, v2']]);
  // Linked to a space of the owner's: never renamed; its goal set only when it had none.
  const mine = (await api('/api/space/create', { name: 'Billing' })).id, goaled = (await api('/api/space/create', { name: 'Docs', goal: 'Write the docs' })).id;
  const other = (await api('/api/issue/create', { title: 'Invoices' })).id;
  assert.equal((await api('/api/issue/link', { issue: other, space: mine })).ok, true);
  assert.equal((await api('/api/issue/rename', { id: other, title: 'Monthly invoices' })).ok, true);
  let sp = (await snapshot()).spaces.find((x) => x.id === mine);
  assert.deepEqual([sp.name, sp.goal], ['Billing', 'Invoices'], 'not renamed; its empty goal took the title when linked');
  assert.equal((await api('/api/issue/link', { issue: other, space: goaled })).ok, true);
  assert.equal((await snapshot()).spaces.find((x) => x.id === goaled).goal, 'Write the docs', 'a goal it had stays');
  assert.equal((await api('/api/space/goal', { id: mine, goal: 'Set by hand' })).ok, true);
  assert.equal((await snapshot()).spaces.find((x) => x.id === mine).goal, 'Set by hand');
  assert.equal((await api('/api/space/delete', { id: space })).ok, true);
  assert.deepEqual([(await issueAt(issue)).space, (await issueAt(issue)).owns], [null, false]);
  assert.equal((await api('/api/issue/delete', { id: other })).ok, true);
  assert.equal(await issueAt(other), undefined);
});
