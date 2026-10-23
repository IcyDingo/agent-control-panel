// Repositories added by hand: the file beside world.json, what World counts from it, `node server.mjs world add|remove|list`
// and the panel's /api/world/repos. Spawns real processes for the last two.
process.env.TZ = 'UTC';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { readRepos, addRepos, removeRepo, findRepos, reposOf } from '../world-repos.mjs';
import { createWorld } from '../world.mjs';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'world-repos-')));
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const T0 = Date.now() - 3600_000;
const at = (sec) => `${Math.floor(T0 / 1000) + sec} +0000`;
const git = (repo, args, sec = 10) =>
  execFileSync('git', ['-C', repo, ...args], { env: { ...GIT_ENV, GIT_AUTHOR_DATE: at(sec), GIT_COMMITTER_DATE: at(sec) }, stdio: 'pipe' }).toString();
const run = (cmd, args, opts = {}) => new Promise((resolve) =>
  execFile(cmd, args, { env: GIT_ENV, ...opts }, (err, stdout, stderr) => resolve({ err, stdout: String(stdout), stderr: String(stderr) })));
/** A repository of mine with one commit of `lines` lines, at `dir` (made if need be). */
function repo(dir = tmp(), lines = 3) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'me@example.com']);
  git(dir, ['config', 'user.name', 'Me']);
  fs.writeFileSync(path.join(dir, 'a.txt'), Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') + '\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'add a.txt']);
  return fs.realpathSync(dir);
}
/** A World that has seen no agent session; `reposFile` is where the repositories added by hand are kept. */
function bareWorld(reposFile, { gitPlace = () => null, configDirs = [tmp()] } = {}) {
  const file = path.join(tmp(), 'world', 'world.json');
  const world = createWorld({ file, configDirs, run, gitPlace, now: () => T0, reposFile });
  world.open();
  return { world, file };
}

test('a repository added by hand is counted, with no agent session', async () => {
  const r = repo(), reposFile = path.join(tmp(), 'repos.json');
  const { world } = bareWorld(reposFile);
  await world.scan({ git: true });
  assert.equal(world.summary().today.commits, 0, 'nothing is counted until it is added');
  assert.deepEqual(addRepos(reposFile, r).added, [r]);
  await world.scan({ git: true });
  const t = world.summary().today;
  assert.deepEqual([t.commits, t.added], [1, 3]);
  assert.deepEqual(world.repos(), [{ path: r, by: 'hand' }]);
});

test('the repositories file is beside world.json unless told otherwise', () => {
  const dir = tmp();
  const file = path.join(dir, 'world.json');
  const world = createWorld({ file, configDirs: [], run, gitPlace: () => null, now: () => T0 });
  world.open();
  const r = repo();
  addRepos(path.join(dir, 'repos.json'), r);
  assert.deepEqual(world.repos(), [{ path: r, by: 'hand' }]);
});

test('a folder adds every repository under it, 3 levels deep, not inside node_modules', () => {
  const root = tmp(), file = path.join(tmp(), 'repos.json');
  const near = repo(path.join(root, 'near')), deep = repo(path.join(root, 'a', 'b', 'deep'));
  const tooDeep = path.join(root, 'a', 'b', 'c', 'd'); // 4 levels
  repo(tooDeep);
  repo(path.join(root, 'node_modules', 'dep'));
  repo(path.join(root, '.hidden', 'secret'));
  const outer = repo(path.join(root, 'outer'));
  repo(path.join(root, 'outer', 'inner')); // inside a repository found: not descended into
  fs.mkdirSync(path.join(root, 'wt'));
  fs.writeFileSync(path.join(root, 'wt', '.git'), 'gitdir: /elsewhere\n'); // a linked worktree: `.git` is a file
  fs.mkdirSync(path.join(root, 'empty'));
  const wt = fs.realpathSync(path.join(root, 'wt'));
  const found = findRepos(root).sort();
  assert.deepEqual(found, [deep, near, outer, wt].sort());
  assert.deepEqual(addRepos(file, root).added.sort(), found);
  assert.deepEqual(readRepos(file), { added: found, removed: [] });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(addRepos(file, root).added.sort(), found, 'adding again changes nothing');
  assert.deepEqual(readRepos(file).added, found);
});

test('a folder that is a repository adds itself, and a path that is not a folder adds nothing', () => {
  const r = repo(), file = path.join(tmp(), 'repos.json');
  const calls = [];
  assert.deepEqual(addRepos(file, r, { find: (d) => { calls.push(d); return []; } }).added, [r]);
  assert.deepEqual(calls, [], 'find is not asked about a repository');
  assert.deepEqual(addRepos(file, path.join(r, 'a.txt')).added, []);
  assert.deepEqual(addRepos(file, path.join(r, 'missing')).added, []);
  assert.deepEqual(readRepos(file).added, [r]);
});

test('paths are stored real, and a symlink is the same repository', () => {
  const r = repo(), link = path.join(tmp(), 'link'), file = path.join(tmp(), 'repos.json');
  fs.symlinkSync(r, link);
  assert.deepEqual(addRepos(file, link).added, [r]);
  assert.deepEqual(readRepos(file).added, [r]);
  assert.equal(removeRepo(file, link), true);
  assert.deepEqual(readRepos(file), { added: [], removed: [r] });
});

test('removing puts a path on removed and off added; adding takes it off removed', () => {
  const a = repo(), b = repo(), file = path.join(tmp(), 'repos.json');
  assert.deepEqual(readRepos(file), { added: [], removed: [] }, 'no file');
  addRepos(file, a); addRepos(file, b);
  assert.equal(removeRepo(file, a), true);
  assert.deepEqual(readRepos(file), { added: [b], removed: [a] });
  assert.equal(removeRepo(file, a), false, 'already removed');
  assert.deepEqual(addRepos(file, a).added, [a]);
  assert.deepEqual(readRepos(file), { added: [b, a], removed: [] });
  for (const text of ['nope', '[]', 'null', '{"added":"x","removed":[1,null,"/p"]}']) {
    fs.writeFileSync(file, text);
    const j = readRepos(file);
    assert.ok(Array.isArray(j.added) && Array.isArray(j.removed), text);
    assert.ok([...j.added, ...j.removed].every((p) => typeof p === 'string'), text);
  }
});

test('a repository removed by hand stays removed when an agent works in it again', async () => {
  const r = repo(), reposFile = path.join(tmp(), 'repos.json'), configDir = tmp();
  fs.mkdirSync(path.join(configDir, 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'projects', 'p', 's.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 5000).toISOString(), cwd: r, message: { id: 'm1', role: 'assistant', usage: { output_tokens: 10 } } }) + '\n');
  const { world, file } = bareWorld(reposFile, { gitPlace: (d) => (d.startsWith(r) ? { repo: r } : null), configDirs: [configDir] });
  await world.scan({ git: true });
  assert.equal(world.summary().today.commits, 1, 'found from the agent session');
  assert.deepEqual(world.repos(), [{ path: r, by: 'agent' }]);
  removeRepo(reposFile, r);
  assert.deepEqual(world.repos(), []);
  fs.appendFileSync(path.join(configDir, 'projects', 'p', 's.jsonl'),
    JSON.stringify({ type: 'assistant', timestamp: new Date(T0 + 9000).toISOString(), cwd: r, message: { id: 'm2', role: 'assistant', usage: { output_tokens: 10 } } }) + '\n');
  fs.writeFileSync(path.join(r, 'b.txt'), 'more\n');
  git(r, ['add', '-A'], 60);
  git(r, ['commit', '-q', '-m', 'second'], 60);
  await world.scan({ git: true });
  assert.equal(world.summary().today.commits, 1, 'the new commit is not counted');
  assert.deepEqual(world.repos(), []);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).repos.includes(r), true, 'what the sessions found is kept, only not counted');
  addRepos(reposFile, r);
  await world.scan({ git: true });
  assert.equal(world.summary().today.commits, 2, 'added back by hand, it counts again');
  assert.deepEqual(world.repos(), [{ path: r, by: 'hand' }]);
});

test('working-tree activity follows the same set', async () => {
  const r = repo(), reposFile = path.join(tmp(), 'repos.json');
  addRepos(reposFile, r);
  const { world, file } = bareWorld(reposFile);
  await world.scan({ git: true });
  assert.equal(typeof JSON.parse(fs.readFileSync(file, 'utf8')).trees[r], 'string', 'the tree of a repository added by hand is looked at');
});

test('reposOf lists the found and the added, minus the removed, marking where each came from', () => {
  assert.deepEqual(reposOf(['/a', '/b', '/c'], { added: ['/b', '/d'], removed: ['/c', '/e'] }),
    [{ path: '/a', by: 'agent' }, { path: '/b', by: 'hand' }, { path: '/d', by: 'hand' }]);
});

// ---------------------------------------------------------------- the command line
test('node server.mjs world add, list, remove', () => {
  const prefs = tmp(), root = tmp();
  const a = repo(path.join(root, 'a')), b = repo(path.join(root, 'sub', 'b'));
  const cli = (...args) => execFileSync(process.execPath, ['server.mjs', ...args], {
    env: { ...process.env, ACP_PREFS: path.join(prefs, 'prefs.json') }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const fail = (...args) => { try { cli(...args); } catch (e) { return { code: e.status, out: String(e.stdout) + String(e.stderr) }; } assert.fail(`${args.join(' ')} should fail`); };
  assert.equal(cli('world', 'list'), 'No repositories yet.');
  assert.equal(cli('world', 'add', root), `Added ${a}\nAdded ${b}`);
  assert.deepEqual(readRepos(path.join(prefs, 'world', 'repos.json')).added.sort(), [a, b]);
  assert.equal(cli('world', 'list'), `${a} (added by hand)\n${b} (added by hand)`);
  // a repository an agent session found shows up in the list too
  const c = repo(path.join(root, 'c'));
  fs.mkdirSync(path.join(prefs, 'world'), { recursive: true });
  fs.writeFileSync(path.join(prefs, 'world', 'world.json'), JSON.stringify({ v: 2, repos: [c, a] }));
  assert.equal(cli('world', 'list'), `${c} (found from an agent session)\n${a} (added by hand)\n${b} (added by hand)`);
  assert.equal(cli('world', 'remove', a), `Removed ${a}`);
  assert.equal(cli('world', 'remove', c), `Removed ${c}`);
  assert.equal(cli('world', 'list'), `${b} (added by hand)`);
  assert.match(cli('world', 'remove', a), /not on the list/i);
  assert.match(fail('world', 'add', path.join(root, 'nowhere')).out, /not a folder/i);
  assert.match(fail('world', 'add', path.join(root, 'sub', 'b', '.git', 'hooks')).out, /no repository/i);
  assert.equal(fail('world', 'frobnicate').code, 2);
  assert.match(fail('world', 'add').out, /usage: /);
});

// ---------------------------------------------------------------- the panel
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });
const until = async (check, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

test('the panel lists and changes them', async (t) => {
  const port = await freePort(), prefs = tmp(), root = tmp();
  const a = repo(path.join(root, 'a'));
  const child = spawn(process.execPath, ['server.mjs'], { env: { ...process.env, ACP_PORT: String(port), ACP_PREFS: path.join(prefs, 'prefs.json'), ACP_DAEMON: '' }, stdio: 'ignore' });
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  assert.ok(await until(() => fetch(base).then((r) => r.ok, () => false)), 'the server did not start');
  const token = /const TOKEN = '([0-9a-f]+)'/.exec(await (await fetch(base)).text())[1];
  const post = async (body, headers = {}) => {
    const r = await fetch(`${base}/api/world/repos`, { method: 'POST', headers: { 'content-type': 'application/json', origin: base, 'x-acp-token': token, ...headers }, body: JSON.stringify(body) });
    return { status: r.status, ...(await r.json()) };
  };
  assert.equal((await post({}, { 'x-acp-token': 'wrong' })).status, 403);
  assert.equal((await post({}, { origin: 'http://evil.example' })).status, 403);
  assert.deepEqual((await post({})).repos, []);
  const added = await post({ add: root });
  assert.equal(added.ok, true);
  assert.deepEqual(added.repos.map((x) => [x.path, x.by]), [[a.replace(os.homedir(), '~'), 'hand']]);
  assert.deepEqual(readRepos(path.join(prefs, 'world', 'repos.json')).added, [a]);
  assert.equal((await post({ add: path.join(root, 'nowhere') })).status, 422);
  assert.equal((await post({ add: path.join(root, 'a', '.git', 'hooks') })).status, 422, 'no repository there');
  const gone = await post({ remove: added.repos[0].path });
  assert.deepEqual(gone.repos, []);
  assert.deepEqual(readRepos(path.join(prefs, 'world', 'repos.json')), { added: [], removed: [a] });
  assert.equal((await post({ remove: 5 })).status, 422);
});
