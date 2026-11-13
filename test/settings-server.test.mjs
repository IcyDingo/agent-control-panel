// Settings, end to end: the real server on a throwaway home with two profiles (~/.claude and ~/.claude-contract), each
// a workspace. Settings is the one place a page learns more of another workspace than { id, name, color, waiting }, and
// only through GET /api/settings: its name, colour, order, sign-in state, hooks and login command, and the repositories
// Glue knows. Never its account, sessions or pull requests, and nothing of it in an SSE frame: a change is told with an
// empty `settings` event. Run with `npm test`. Starts the server on a spare port.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const PORT = 48000 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-set-'));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const SID_D = 'aaaaaaaa-1111-4111-8111-111111111111', SID_C = 'cccccccc-2222-4222-8222-222222222222';
const SID_U = 'bbbbbbbb-7777-4777-8777-777777777777';

const work = path.join(home, 'code', 'w'), workC = path.join(home, 'code', 'contract-w');
for (const d of [work, workC]) fs.mkdirSync(d, { recursive: true });
const transcript = (text, cwd) => [
  JSON.stringify({ type: 'user', cwd, permissionMode: 'default', timestamp: '2026-11-12T10:00:00.000Z', message: { role: 'user', content: text } }),
  JSON.stringify({ type: 'assistant', cwd, timestamp: '2026-11-12T10:00:01.000Z', message: { role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'Done.' }] } }),
].join('\n') + '\n';
for (const [dir, sid, cwd] of [['.claude', SID_D, work], ['.claude-contract', SID_C, workC]]) {
  fs.mkdirSync(path.join(home, dir, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(home, dir, 'settings.json'), '{}');
  fs.writeFileSync(path.join(home, dir, 'projects', 'p', `${sid}.jsonl`), transcript(`work in ${dir}`, cwd));
}
// Each profile's account: the plain one's config sits in the home folder, contract's in its own folder.
const EMAIL_D = 'default-person@example.test', EMAIL_C = 'contract-person@example.test';
fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: EMAIL_D, organizationName: 'Default Org' } }));
fs.writeFileSync(path.join(home, '.claude-contract', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: EMAIL_C, organizationName: 'Contract Org' } }));
const job = (sid, name, cwd) => ({ pid: null, id: sid.slice(0, 8), cwd, kind: 'background', startedAt: Date.now(), sessionId: sid, name, status: 'idle', state: 'running' });
fs.writeFileSync(path.join(home, 'roster-default.json'), JSON.stringify([job(SID_D, 'default job', work)]));
fs.writeFileSync(path.join(home, 'roster-.claude-contract.json'), JSON.stringify([job(SID_C, 'contract job', workC)]));

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
// Signed in on contract only, as someone a page shown the plain profile must not learn of.
if (a[0] === 'auth') { console.log(cfg && path.basename(cfg) === '.claude-contract' ? JSON.stringify({ loggedIn: true, email: ${JSON.stringify(EMAIL_C)}, orgName: 'Contract Org', subscriptionType: 'max' }) : '{}'); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
// Stand-ins for what Settings runs: the real launchctl and open must never be called from a test. launchctl knows no
// service (print fails, as it does when nothing is loaded); each logs its arguments.
const standIns = (dir, logs) => {
  for (const [name, code] of [['launchctl', 'process.exit(process.argv[2] === "print" ? 113 : 0);'], ['open', ''], ['osascript', '']]) {
    fs.writeFileSync(path.join(dir, name), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(path.join(logs, name + '.log'))}, JSON.stringify(process.argv.slice(2)) + '\\n');\n${code}\n`, { mode: 0o755 });
  }
};
standIns(bin, home);
const calledOf = (dir, name) => { try { return fs.readFileSync(path.join(dir, name + '.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

const prefs = path.join(home, 'panel', 'prefs.json');
fs.mkdirSync(path.dirname(prefs));
fs.writeFileSync(prefs, JSON.stringify({ profile: 'default', setupDone: true }));
const wsFile = path.join(home, 'panel', 'workspaces.json');

const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE') && !k.startsWith('ACP_')));
const server = spawn(process.execPath, [SERVER], { env: { ...env, HOME: home, PATH: `${bin}:${env.PATH}`, ACP_PORT: String(PORT), ACP_PREFS: prefs, ACP_GITHUB: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
const REFUSE = 'That belongs to another workspace. Switch to it to do this.';
const api = (p, body, client) => fetch(BASE + p, { method: 'POST', body: JSON.stringify(body ?? {}),
  headers: { 'content-type': 'application/json', origin: BASE, 'x-acp-token': token, ...(client ? { 'x-acp-client': client } : {}) } })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));
const get = (p, client) => fetch(BASE + p, { headers: { 'x-acp-token': token, ...(client ? { 'x-acp-client': client } : {}) } })
  .then(async (r) => ({ status: r.status, ...(await r.json()) }));

/** A page watching as `client`: its snapshots parsed, and everything it was sent, as sent. */
const pages = [];
function watch(client) {
  const frames = [], ctl = new AbortController(), pg = { client, frames, raw: '' };
  fetch(`${BASE}/events?t=${token}&c=${client}`, { signal: ctl.signal }).then(async (r) => {
    let buf = '';
    for await (const chunk of r.body) {
      const text = Buffer.from(chunk).toString();
      pg.raw += text;
      buf += text;
      // Snapshots are the unnamed frames; a named event (`event: x`) is kept in `raw` only.
      for (const block of buf.split('\n\n').slice(0, -1)) {
        if (/^event: /m.test(block)) continue;
        const m = /^data: (.*)$/m.exec(block);
        if (m) { try { frames.push(JSON.parse(m[1])); } catch {} }
      }
      buf = buf.slice(buf.lastIndexOf('\n\n') + 2);
    }
  }).catch(() => {});
  Object.assign(pg, { latest: () => frames.findLast((f) => Array.isArray(f?.sessions)), close: () => ctl.abort() });
  pages.push(pg);
  return pg;
}
async function until(fn, ms = 10_000, every = 100) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(every)) { const v = await fn(); if (v) return v; }
  return null;
}
const hookPost = (kind, e) => fetch(BASE + '/hook/' + kind, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(e) });
const SETTINGS_EVENT = 'event: settings\ndata: {}\n\n';

// Page A stays on the plain profile's workspace; page B looks at contract.
const A = watch('page-a'), B = watch('page-b');
await until(() => A.latest() && B.latest());
assert.equal((await api('/api/workspace/focus', { ws: 'contract' }, B.client)).ok, true);
assert.ok(await until(() => B.latest()?.workspace?.id === 'contract' && B.latest().sessions.some((s) => s.sessionId === SID_C && s.inRoster)), 'page B shows contract: ' + log);
assert.ok(await until(() => A.latest()?.sessions.some((s) => s.sessionId === SID_D && s.inRoster)), 'page A shows default: ' + log);

after(async () => { for (const p of pages) p.close(); if (server.exitCode === null && server.signalCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); }); fs.rmSync(home, { recursive: true, force: true }); });

test('settings shows both workspaces, the email only for the focus', async () => {
  const r = await get('/api/settings', A.client);
  assert.equal(r.ok, true, JSON.stringify(r));
  const byId = Object.fromEntries(r.workspaces.map((w) => [w.id, w]));
  assert.deepEqual(Object.keys(byId).sort(), ['contract', 'default']);
  for (const w of r.workspaces) {
    assert.equal(typeof w.name, 'string');
    assert.ok(w.name);
    assert.equal(typeof w.color, 'string');
    assert.equal(typeof w.order, 'number');
    assert.equal(w.connected, false, JSON.stringify(w));
    assert.equal(typeof w.loginCommand, 'string');
  }
  assert.equal(byId.default.here, true);
  assert.equal(byId.contract.here, false);
  assert.equal(byId.contract.loginCommand, 'CLAUDE_CONFIG_DIR=~/.claude-contract claude auth login');
  assert.equal(Object.hasOwn(byId.contract, 'account'), false, 'no account for another workspace');
  assert.equal(byId.default.account?.email, EMAIL_D);
  // Nothing but the allowed fields, for every workspace and repository.
  for (const w of r.workspaces) for (const k of Object.keys(w)) assert.ok(['id', 'name', 'color', 'order', 'here', 'signedIn', 'connected', 'loginCommand', 'account'].includes(k), k);
  for (const x of r.repos) assert.deepEqual(Object.keys(x).sort(), ['key', 'label', 'stored', 'ws']);
  assert.ok([true, false, null].includes(byId.contract.signedIn));
  assert.deepEqual(Object.keys(r).filter((k) => k !== 'status').sort(), ['about', 'github', 'glue', 'ok', 'overseer', 'repos', 'watcher', 'workspaces']);
  assert.deepEqual(Object.keys(r.about).sort(), ['commit', 'dataDir', 'logDir', 'service', 'uninstall', 'update', 'version']);
  assert.equal(typeof r.watcher.enabled, 'boolean');
  assert.ok(Array.isArray(r.overseer.models) && r.overseer.models.includes(r.overseer.model), JSON.stringify(r.overseer));
  assert.deepEqual(Object.keys(r.github).sort(), ['login', 'state']);
  const text = JSON.stringify(r);
  assert.ok(text.includes(EMAIL_D), 'the focus\'s own email');
  for (const bit of [EMAIL_C, 'Contract Org', SID_C, SID_C.slice(0, 8), 'contract job']) assert.equal(text.includes(bit), false, `settings carries ${bit}: ${text}`);
  // From contract's page it is the other way round.
  const b = JSON.stringify(await get('/api/settings', B.client));
  assert.equal(b.includes(EMAIL_D), false, b);
  assert.equal((await fetch(BASE + '/api/settings')).status, 403, 'not without the token');
  assert.equal((await fetch(BASE + '/api/glue')).status, 403, 'not without the token');
});

test('nothing from settings reaches an SSE frame', async () => {
  const dirS = path.join(home, 'code', 'secret-contract-repo'), key = `dir:${dirS}`;
  fs.mkdirSync(dirS, { recursive: true });
  assert.deepEqual(await api('/api/settings/assign', { key, ws: ['contract'] }, B.client), { status: 200, ok: true });
  const at = A.raw.length;
  await pause(1000);
  const r = await get('/api/settings', A.client);
  assert.ok(r.repos.some((x) => x.key === key && x.label === 'secret-contract-repo' && x.stored && x.ws.join() === 'contract'), JSON.stringify(r.repos));
  await pause(1000);
  const seen = A.raw.slice(at);
  for (const bit of [key, 'secret-contract-repo', EMAIL_C]) assert.equal(seen.includes(bit), false, `page A's stream carries ${bit}`);
  // The whole of page A's stream, from the start.
  assert.equal(A.raw.includes('secret-contract-repo'), false);
  assert.equal(A.raw.includes(EMAIL_C), false);
});

test('every change nudges every page with an empty settings event', async () => {
  const a = A.raw.length, b = B.raw.length;
  const name = (await get('/api/settings', A.client)).workspaces.find((w) => w.id === 'default').name;
  assert.equal((await api('/api/workspace/update', { id: 'default', name: 'Home' }, A.client)).ok, true);
  assert.ok(await until(() => A.raw.slice(a).includes(SETTINGS_EVENT) && B.raw.slice(b).includes(SETTINGS_EVENT)), 'both pages are nudged');
  // The event carries nothing: every `settings` event in either stream is the empty one.
  for (const pg of [A, B]) for (const m of pg.raw.matchAll(/^event: settings\n(.*)\n/gm)) assert.equal(m[1], 'data: {}');
  assert.equal((await api('/api/workspace/update', { id: 'default', name }, A.client)).ok, true);
});

test('rename, reorder and connect work on the other workspace', async () => {
  const before = (await get('/api/settings', A.client)).workspaces.find((w) => w.id === 'contract');
  const r = await api('/api/workspace/update', { id: 'contract', name: 'Work' }, A.client);
  assert.deepEqual(r, { status: 200, ok: true });
  assert.ok(await until(() => B.latest()?.workspace.name === 'Work'), 'page B sees its new name');
  assert.equal((await api('/api/workspace/update', { id: 'nope', name: 'x' }, A.client)).error, 'No such workspace.');
  assert.equal((await api('/api/workspace/update', { id: 'contract', name: before.name }, A.client)).ok, true);

  const order = A.latest().workspaces.map((w) => w.id);
  const flipped = [...order].reverse();
  assert.deepEqual(await api('/api/workspace/reorder', { ids: flipped }, A.client), { status: 200, ok: true });
  assert.ok(await until(() => A.latest()?.workspaces.map((w) => w.id).join() === flipped.join()), `the order flips: ${JSON.stringify(A.latest()?.workspaces)}`);
  assert.deepEqual((await get('/api/settings', A.client)).workspaces.map((w) => [w.id, w.order]), flipped.map((id, i) => [id, i]));
  for (const ids of [['default'], ['default', 'default'], ['default', 'nope'], 'default', null]) {
    assert.equal((await api('/api/workspace/reorder', { ids }, A.client)).ok, false, JSON.stringify(ids));
  }
  assert.equal((await api('/api/workspace/reorder', { ids: order }, A.client)).ok, true);

  const plain = path.join(home, '.claude', 'settings.json'), other = path.join(home, '.claude-contract', 'settings.json');
  const plainBefore = fs.readFileSync(plain);
  const c = await api('/api/profile/connect', { id: 'contract' }, A.client);
  assert.equal(c.ok, true, JSON.stringify(c));
  assert.notEqual(fs.readFileSync(other, 'utf8'), '{}', 'contract\'s settings gained the hooks');
  assert.ok(fs.readFileSync(other, 'utf8').includes(`127.0.0.1:${PORT}/hook/`));
  assert.deepEqual(fs.readFileSync(plain), plainBefore, 'the plain profile\'s settings are untouched');
  assert.equal(JSON.stringify(c).includes(EMAIL_C), false);
  assert.equal((await get('/api/settings', A.client)).workspaces.find((w) => w.id === 'contract').connected, true);
  assert.equal((await api('/api/profile/connect', { id: 'nope' }, A.client)).error, 'No such workspace.');
  // Signing in another workspace: an unknown one is refused before anything opens.
  assert.equal((await api('/api/setup/login', { what: 'claude', ws: 'nope' }, A.client)).error, 'No such workspace.');
});

test('settings assign is unrestricted, the page route is not', async () => {
  assert.deepEqual(await api('/api/settings/assign', { key: 'gh:o/n', ws: ['contract'] }, B.client), { status: 200, ok: true });
  const page = await api('/api/workspace/assign', { key: 'gh:o/n', ws: ['default', 'contract'] }, A.client);
  assert.equal(page.ok, false, JSON.stringify(page));
  assert.equal(page.error, REFUSE);
  const r = await api('/api/settings/assign', { key: 'gh:o/n', ws: ['default', 'contract'] }, A.client);
  assert.deepEqual(r, { status: 200, ok: true });
  const repo = (await get('/api/settings', A.client)).repos.find((x) => x.key === 'gh:o/n');
  assert.deepEqual({ ...repo, ws: [...repo.ws].sort() }, { key: 'gh:o/n', label: 'o/n', ws: ['contract', 'default'], stored: true });
  // Taking it out of a workspace the page isn't shown works here too.
  assert.equal((await api('/api/settings/assign', { key: 'gh:o/n', ws: ['default'] }, A.client)).ok, true);
  assert.deepEqual((await get('/api/settings', A.client)).repos.find((x) => x.key === 'gh:o/n').ws, ['default']);
  // Nonsense is refused.
  assert.equal((await api('/api/settings/assign', { key: 'whatever', ws: ['default'] }, A.client)).ok, false);
  assert.equal((await api('/api/settings/assign', { key: 'gh:o/n', ws: ['nope'] }, A.client)).error, 'No such workspace.');
  assert.equal((await api('/api/settings/assign', { key: 'gh:o/n', ws: 'default' }, A.client)).ok, false);
});

test('forget on a key known only from a session is a no-op', async () => {
  const dirU = path.join(home, 'code', 'u'), key = `dir:${dirU}`;
  fs.mkdirSync(dirU, { recursive: true });
  assert.equal((await hookPost('event', { session_id: SID_U, transcript_path: path.join(home, '.claude', 'projects', 'p', `${SID_U}.jsonl`), cwd: dirU,
    hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, permission_mode: 'default' })).status, 200);
  const repo = await until(async () => (await get('/api/settings', A.client)).repos.find((x) => x.key === key));
  assert.deepEqual(repo, { key, label: 'u', ws: [], stored: false });
  const saved = fs.readFileSync(wsFile, 'utf8');
  assert.deepEqual(await api('/api/settings/assign', { key, ws: [] }, A.client), { status: 200, ok: true });
  assert.deepEqual((await get('/api/settings', A.client)).repos.find((x) => x.key === key), { key, label: 'u', ws: [], stored: false });
  assert.equal(fs.readFileSync(wsFile, 'utf8'), saved, 'nothing was written');
});

test('glue prefs: seed once, then patch', async () => {
  // The other keys in prefs.json (the last focused profile, the checklist being done) are kept on every write.
  const kept = JSON.parse(fs.readFileSync(prefs, 'utf8'));
  assert.equal(typeof kept.profile, 'string');
  const g = await get('/api/glue', A.client);
  assert.equal(g.ok, true, JSON.stringify(g));
  assert.equal(g.glue.seeded, false);
  assert.equal(g.glue.theme, 'dark');
  const a = A.raw.length;
  const s = await api('/api/glue/seed', { theme: 'light' }, A.client);
  assert.equal(s.ok, true, JSON.stringify(s));
  assert.equal(s.glue.theme, 'light');
  assert.equal(s.glue.seeded, true);
  assert.ok(await until(() => A.raw.slice(a).includes(SETTINGS_EVENT)), 'a seed nudges');
  const again = await api('/api/glue/seed', { theme: 'dark' }, A.client);
  assert.equal(again.ok, false, JSON.stringify(again));
  assert.equal((await get('/api/glue', A.client)).glue.theme, 'light');
  const p = await api('/api/settings/glue', { patch: { theme: 'system' } }, A.client);
  assert.equal(p.ok, true, JSON.stringify(p));
  assert.equal(p.glue.theme, 'system');
  assert.equal((await get('/api/settings', A.client)).glue.theme, 'system');
  const bad = await api('/api/settings/glue', { patch: { armed: false } }, A.client);
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'armed is not a Glue setting.');
  const saved = JSON.parse(fs.readFileSync(prefs, 'utf8'));
  assert.equal(saved.profile, kept.profile);
  assert.equal(saved.setupDone, true);
  assert.equal(saved.glue.theme, 'system');
  assert.equal(fs.statSync(prefs).mode & 0o777, 0o600, 'prefs.json is 0600');
});

// ---------------------------------------------------------------- About & maintenance, alerts, agent defaults

test('about: the version, the commit, the folders and the service (none installed)', async () => {
  const r = await get('/api/settings', A.client);
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  assert.equal(r.about.version, pkg.version);
  assert.equal(r.about.dataDir, path.dirname(prefs), 'the prefs folder');
  assert.equal(r.about.logDir, path.join(home, 'Library', 'Logs', 'Glue'));
  assert.deepEqual(r.about.service, { installed: false, running: false, pid: null });
  assert.equal(r.about.update, 'git pull && ./install.sh');
  assert.equal(r.about.uninstall, './install.sh --uninstall');
  // The short sha, read from the .git files (this checkout may be a linked worktree), as git itself says.
  const root = fileURLToPath(new URL('..', import.meta.url));
  const want = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assert.equal(r.about.commit, want);
  assert.ok(calledOf(home, 'launchctl').every((a) => a[0] === 'print'), 'only asked launchd about the service');
});

test('restart is refused without an installed service, and kicks it when there is one', async () => {
  const none = await api('/api/settings/restart', {}, A.client);
  assert.equal(none.ok, false);
  assert.equal(none.error, "The background service isn't installed.");
  assert.equal(calledOf(home, 'launchctl').some((a) => a[0] === 'kickstart'), false, 'nothing was kicked');
  const plist = path.join(home, 'Library', 'LaunchAgents', `local.glue.${PORT}.plist`);
  fs.mkdirSync(path.dirname(plist), { recursive: true });
  fs.writeFileSync(plist, '<plist/>');
  try {
    assert.equal((await get('/api/settings', A.client)).about.service.installed, true, 'installed is the plist');
    assert.deepEqual(await api('/api/settings/restart', {}, A.client), { status: 200, ok: true });
    const kick = await until(() => calledOf(home, 'launchctl').find((a) => a[0] === 'kickstart'));
    assert.deepEqual(kick, ['kickstart', '-k', `gui/${process.getuid()}/local.glue.${PORT}`]);
  } finally { fs.rmSync(plist, { force: true }); }
});

test('reveal shows the data or the logs in Finder', async () => {
  assert.deepEqual(await api('/api/settings/reveal', { what: 'data' }, A.client), { status: 200, ok: true });
  assert.deepEqual(calledOf(home, 'open').at(-1), ['-R', prefs]);
  assert.equal((await api('/api/settings/reveal', { what: 'elsewhere' }, A.client)).ok, false);
  assert.equal((await api('/api/settings/reveal', {}, A.client)).ok, false);
  assert.equal(calledOf(home, 'open').length, 1, 'a bad request opens nothing');
  // No log yet: nothing to show.
  assert.equal((await api('/api/settings/reveal', { what: 'logs' }, A.client)).ok, false);
  const logFile = path.join(home, 'Library', 'Logs', 'Glue', `daemon-${PORT}.log`);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, 'x\n');
  assert.deepEqual(await api('/api/settings/reveal', { what: 'logs' }, A.client), { status: 200, ok: true });
  assert.deepEqual(calledOf(home, 'open').at(-1), ['-R', logFile]);
  const r = await fetch(BASE + '/api/settings/reveal', { method: 'POST', body: '{"what":"data"}', headers: { 'content-type': 'application/json', origin: BASE } });
  assert.equal(r.status, 403, 'not without the token');
});

test('turning Auto-fix on or off, or choosing the overseer model, nudges every page', async () => {
  const was = await get('/api/settings', A.client);
  const a = A.raw.length, b = B.raw.length;
  assert.equal((await api('/api/watcher/enabled', { on: !was.watcher.enabled }, A.client)).ok, true);
  assert.ok(await until(() => A.raw.slice(a).includes(SETTINGS_EVENT) && B.raw.slice(b).includes(SETTINGS_EVENT)), 'Auto-fix nudges');
  assert.equal((await get('/api/settings', A.client)).watcher.enabled, !was.watcher.enabled);
  await api('/api/watcher/enabled', { on: was.watcher.enabled }, A.client);
  const model = was.overseer.models.find((m) => m !== was.overseer.model), c = A.raw.length;
  assert.equal((await api('/api/overseer/model', { model }, A.client)).ok, true);
  assert.ok(await until(() => A.raw.slice(c).includes(SETTINGS_EVENT)), 'the overseer model nudges');
  assert.equal((await get('/api/settings', A.client)).overseer.model, model);
  // A refused one changes nothing, so it tells nothing.
  await pause(600);
  const d = A.raw.length;
  assert.equal((await api('/api/overseer/model', { model: 'gpt' }, A.client)).ok, false);
  await pause(600);
  assert.equal(A.raw.slice(d).includes(SETTINGS_EVENT), false, 'a refused model nudges nothing');
  await api('/api/overseer/model', { model: was.overseer.model }, A.client);
});

test('connected means every hook entry is there, not that the file mentions the panel', async () => {
  const file = path.join(home, '.claude', 'settings.json'), url = `127.0.0.1:${PORT}/hook/`;
  const connectedNow = async () => (await get('/api/settings', A.client)).workspaces.find((w) => w.id === 'default').connected;
  const was = fs.readFileSync(file, 'utf8');
  try {
    // The URL, but not in a hook entry.
    fs.writeFileSync(file, JSON.stringify({ env: { NOTE: `see http://${url}event` }, hooks: { Stop: [{ hooks: [{ type: 'command', command: `echo ${url}` }] }] } }));
    assert.equal(await connectedNow(), false, 'a mention is not a hook');
    // One event of them is not all of them.
    fs.writeFileSync(file, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'http', url: `http://${url}event` }] }] } }));
    assert.equal(await connectedNow(), false, 'only one event');
    // What hooks.example.json asks for, pointed at this panel.
    const wanted = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../hooks.example.json', import.meta.url)), 'utf8').replaceAll('127.0.0.1:4747/', `127.0.0.1:${PORT}/`));
    fs.writeFileSync(file, JSON.stringify(wanted));
    assert.equal(await connectedNow(), true);
    fs.writeFileSync(file, 'not json');
    assert.equal(await connectedNow(), false);
  } finally { fs.writeFileSync(file, was); }
});

test('a session that first works in a new repository nudges once, not on every tick', async () => {
  const dir = path.join(home, 'code', 'brand-new-repo');
  fs.mkdirSync(dir, { recursive: true });
  await pause(1500);
  const a = A.raw.length;
  assert.equal((await hookPost('event', { session_id: 'dddddddd-8888-4888-8888-888888888888', transcript_path: path.join(home, '.claude', 'projects', 'p', 'dddddddd-8888-4888-8888-888888888888.jsonl'), cwd: dir,
    hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/x' }, permission_mode: 'default' })).status, 200);
  assert.ok(await until(() => A.raw.slice(a).includes(SETTINGS_EVENT)), 'a new repository nudges');
  assert.ok((await get('/api/settings', A.client)).repos.some((x) => x.key === `dir:${dir}`));
  const b = A.raw.length;
  await pause(2500); // a few roster and snapshot ticks later
  assert.equal(A.raw.slice(b).includes(SETTINGS_EVENT), false, 'no more nudges while nothing changed');
});

// ---------------------------------------------------------------- servers of their own

let nextPort = 48200 + Math.floor(Math.random() * 600);
/** A throwaway home with one profile (a single workspace) and stand-ins on PATH, started on a spare port. `gh` adds a
 *  stand-in GitHub CLI that reports the pull requests in `open.json`. */
function solo({ gh = false } = {}) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-solo-'));
  const dir = path.join(h, 'code', 'p');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/feat/p\n');
  fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/o/p.git\n');
  const sid = 'eeeeeeee-9999-4999-8999-999999999999';
  fs.mkdirSync(path.join(h, '.claude', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(h, '.claude', 'settings.json'), '{}');
  fs.writeFileSync(path.join(h, '.claude', 'projects', 'p', `${sid}.jsonl`), transcript('work', dir));
  fs.writeFileSync(path.join(h, 'roster.json'), JSON.stringify([job(sid, 'the job', dir)]));
  const b = path.join(h, 'bin');
  fs.mkdirSync(b);
  fs.writeFileSync(path.join(b, 'claude'), `#!${process.execPath}
const fs = require('fs'), a = process.argv.slice(2);
if (a[0] === 'agents') { try { process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(h, 'roster.json'))}, 'utf8')); } catch { process.stdout.write('[]'); } process.exit(0); }
if (a[0] === 'auth') { console.log('{}'); process.exit(0); }
if (a[0] === '--bg') { console.log('backgrounded · deadbeef'); process.exit(0); }
process.exit(1);
`, { mode: 0o755 });
  standIns(b, h);
  if (gh) fs.writeFileSync(path.join(b, 'gh'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2), after = (x) => a[a.indexOf(x) + 1];
const out = (v) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
const at = new Date(Date.now() - 30000).toISOString(), began = new Date(Date.now() - 90000).toISOString();
const failing = (n) => ({ number: n, title: 'Feature ' + n, url: 'https://github.com/o/p/pull/' + n, isDraft: false, headRefName: 'feat/p', headRefOid: 'abc' + n,
  baseRefName: 'main', isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'UNSTABLE', reviewDecision: '', updatedAt: at, author: { login: 'someone' },
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/p/actions/runs/' + n + '1/job/' + n + '2', workflowName: 'CI', completedAt: at, startedAt: began }] });
if (a[0] === 'auth') { process.stderr.write('Logged in to github.com account me\\n'); process.exit(0); }
if (a[0] === 'repo' && a[1] === 'view') out({ defaultBranchRef: { name: 'main' } });
if (a[0] === 'search' && a[1] === 'prs') out([]);
if (a[0] === 'pr' && a[1] === 'list' && after('--state') === 'open') out(JSON.parse(fs.readFileSync(${JSON.stringify(path.join(h, 'open.json'))}, 'utf8')).map(failing));
if (a[0] === 'pr' && a[1] === 'list') out([]);
if (a[0] === 'run' && a[1] === 'list') out([]);
process.stderr.write('unexpected gh call: ' + a.join(' ') + '\\n');
process.exit(1);
`, { mode: 0o755 });
  fs.writeFileSync(path.join(h, 'open.json'), '[3]');
  const prefsFile = path.join(h, 'panel', 'prefs.json');
  fs.mkdirSync(path.dirname(prefsFile));
  fs.writeFileSync(prefsFile, JSON.stringify({ profile: 'default', setupDone: true }));
  return { home: h, dir, bin: b, prefs: prefsFile, running: null, async start() {
    const port = nextPort++, base = `http://127.0.0.1:${port}`;
    const e = { ...env, HOME: h, PATH: `${b}:${env.PATH}`, ACP_PORT: String(port), ACP_PREFS: prefsFile, ...(gh ? {} : { ACP_GITHUB: 'off' }) };
    const proc = spawn(process.execPath, [SERVER], { env: e, stdio: ['ignore', 'pipe', 'pipe'] });
    process.on('exit', () => { try { proc.kill(); } catch {} });
    const s = { port, base, proc, log: '', pages: [] };
    proc.stdout.on('data', (d) => { s.log += d; });
    proc.stderr.on('data', (d) => { s.log += d; });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('server did not start: ' + s.log)), 10_000);
      proc.stdout.on('data', () => { if (s.log.includes(base)) { clearTimeout(t); resolve(); } });
      proc.on('exit', () => reject(new Error('server exited: ' + s.log)));
    });
    s.token = (await (await fetch(base + '/')).text()).match(/[0-9a-f]{48}/)[0];
    s.api = (p, body) => fetch(base + p, { method: 'POST', body: JSON.stringify(body ?? {}), headers: { 'content-type': 'application/json', origin: base, 'x-acp-token': s.token, 'x-acp-client': 'solo-page' } })
      .then(async (r) => ({ status: r.status, ...(await r.json()) }));
    s.page = () => { // a page watching: everything it is sent, and its newest snapshot
      const ctl = new AbortController(), pg = { raw: '', frames: [] };
      fetch(`${base}/events?t=${s.token}&c=solo-page`, { signal: ctl.signal }).then(async (r) => {
        for await (const chunk of r.body) {
          pg.raw += Buffer.from(chunk).toString();
          pg.frames = [...pg.raw.matchAll(/^data: (.*)$/gm)].map((m) => { try { return JSON.parse(m[1]); } catch { return null; } }).filter((f) => Array.isArray(f?.sessions));
        }
      }).catch(() => {});
      pg.latest = () => pg.frames.at(-1); pg.close = () => ctl.abort();
      s.pages.push(pg);
      return pg;
    };
    s.stop = async () => { for (const p of s.pages) p.close(); if (proc.exitCode === null && proc.signalCode === null) await new Promise((r) => { proc.once('exit', r); proc.kill(); }); };
    this.running = s;
    return s;
  }, async done() { await this.running?.stop(); fs.rmSync(h, { recursive: true, force: true }); } };
}

test('answering here is never persisted', async () => {
  const s = solo();
  try {
    let srv = await s.start(), page = srv.page();
    assert.ok(await until(() => page.latest()), 'a first snapshot: ' + srv.log);
    assert.equal(page.latest().armed, true);
    assert.equal((await srv.api('/api/arm', { armed: false })).armed, false);
    assert.ok(await until(() => page.latest().armed === false), 'it is paused');
    await srv.stop();
    // The same prefs again: the server starts with answering on.
    srv = await s.start();
    page = srv.page();
    assert.ok(await until(() => page.latest()), 'a first snapshot after the restart: ' + srv.log);
    assert.equal(page.latest().armed, true, 'answering is on again');
    assert.equal('armed' in JSON.parse(fs.readFileSync(s.prefs, 'utf8')), false, 'prefs.json never held it');
  } finally { await s.done(); }
});

test('the notification toggles silence their events', { skip: process.platform !== 'darwin' && 'notifications are macOS only' }, async () => {
  const s = solo({ gh: true });
  try {
    const srv = await s.start();
    // Before any page opens (a page is what starts the GitHub poll): CI alerts off, and the PR watcher off so that is
    // not what notifies.
    assert.equal((await srv.api('/api/settings/glue', { patch: { notify: { ci: false } } })).ok, true);
    assert.equal((await srv.api('/api/watcher/enabled', { on: false })).ok, true);
    const page = srv.page();
    assert.ok(await until(() => page.latest()?.github?.repos?.some((r) => r.prs?.length), 20_000), 'GitHub was polled: ' + srv.log);
    await pause(1500);
    assert.deepEqual(calledOf(s.home, 'osascript'), [], 'nothing is logged with CI alerts off');
    // On again, and a new failure (another pull request: a failure is told once).
    assert.equal((await srv.api('/api/settings/glue', { patch: { notify: { ci: true } } })).ok, true);
    fs.writeFileSync(path.join(s.home, 'open.json'), '[3, 4]');
    assert.equal((await srv.api('/api/github/refresh')).ok, true);
    const told = await until(() => calledOf(s.home, 'osascript').find((a) => a.at(-2) === 'Glue · CI failed'), 20_000);
    assert.ok(told, 'it logs as before: ' + JSON.stringify(calledOf(s.home, 'osascript')) + srv.log);
    assert.match(told.at(-1), /#4/);
  } finally { await s.done(); }
});

test('a launch into a new folder with one workspace nudges every page', async () => {
  const s = solo();
  try {
    const srv = await s.start(), page = srv.page();
    assert.ok(await until(() => page.latest()), 'a first snapshot: ' + srv.log);
    const dir = path.join(s.home, 'code', 'fresh');
    fs.mkdirSync(dir);
    await pause(1500);
    const a = page.raw.length;
    const r = await srv.api('/api/launch', { prompt: 'go', cwd: dir, model: '', mode: 'default' });
    assert.equal(r.ok, true, JSON.stringify(r) + srv.log);
    assert.ok(await until(() => page.raw.slice(a).includes(SETTINGS_EVENT)), 'the new assignment nudges');
  } finally { await s.done(); }
});

test('a new workspace\'s overseer starts on the Glue default', async () => {
  const p = await api('/api/settings/glue', { patch: { overseerModel: 'haiku' } }, A.client);
  assert.equal(p.ok, true, JSON.stringify(p));
  fs.mkdirSync(path.join(home, '.claude-new', 'projects', 'p'), { recursive: true });
  const seen = await until(() => A.latest()?.workspaces?.some((w) => w.id === 'new'), 15_000);
  assert.ok(seen, 'the workspace appears: ' + log);
  const file = path.join(path.dirname(prefs), 'overseer-new.json');
  assert.ok(await until(() => fs.existsSync(file)), 'its overseer file is made');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).model, 'haiku');
  // Not through any page's focus: the existing workspaces keep what they chose.
  assert.equal((await api('/api/overseer/model', { model: 'opus' }, A.client)).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).model, 'haiku', 'a workspace\'s own choice is its own');
});

test('setup done is a plain flag the page sets', async () => {
  const s = solo();
  try {
    fs.writeFileSync(s.prefs, JSON.stringify({ profile: 'default' })); // a first run: setupDone absent
    let srv = await s.start(), page = srv.page();
    assert.ok(await until(() => page.latest()), 'a first snapshot: ' + srv.log);
    assert.equal(page.latest().setup.done, false, 'not done on a first run');
    assert.equal((await srv.api('/api/setup/done', { done: true })).ok, true);
    assert.ok(await until(() => page.latest().setup.done === true), 'the snapshot says done');
    assert.equal(JSON.parse(fs.readFileSync(s.prefs, 'utf8')).setupDone, true, 'kept in prefs.json');
    await srv.stop();
    srv = await s.start();
    page = srv.page();
    assert.ok(await until(() => page.latest()), 'a first snapshot after the restart: ' + srv.log);
    assert.equal(page.latest().setup.done, true, 'still done after a restart');
  } finally { await s.done(); }
});
