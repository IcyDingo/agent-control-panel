// A session whose Claude Code version has been deleted under it. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePs, parseLsof, versionOf, removedUnder, findRemoved } from '../versions.mjs';

const V = '/Users/me/.local/share/claude/versions/';
// ps -axo pid=,ppid=,ucomm=
const PS = `    1     0 launchd
 1165     1 Terminal
30742 30740 zsh
15793 30742 2.1.303
36587     1 2.1.306
 2326 36587 2.1.306
 4242  4241 Google Chrome He
`;
// lsof -a -p <pids> -d txt -Fpin: its program comes first, then the libraries it maps
const LSOF = `p15793
ftxt
i141529555
n${V}2.1.303
ftxt
i139879955
n/Library/Preferences/Logging/.plist-cache.loCuuDRS
p36587
ftxt
i144403309
n${V}2.1.306
p2326
ftxt
i144403309
n${V}2.1.306
p1165
ftxt
i500
n/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
`;
/** The files on disk now: 2.1.303 is gone, 2.1.306 is the one installed. */
const DISK = { [`${V}2.1.306`]: 144403309, '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal': 500 };
const inodeOf = (p) => DISK[p] ?? null;

test('ps rows give each process its parent and name', () => {
  const procs = parsePs(PS);
  assert.deepEqual(procs.get(15793), { ppid: 30742, name: '2.1.303' });
  assert.deepEqual(procs.get(4242), { ppid: 4241, name: 'Google Chrome He' });
  assert.equal(procs.get(1).ppid, 0);
});

test("lsof gives each process its program, not the libraries it maps", () => {
  const programs = parseLsof(LSOF);
  assert.deepEqual(programs.get(15793), { path: `${V}2.1.303`, inode: 141529555 });
  assert.deepEqual(programs.get(36587), { path: `${V}2.1.306`, inode: 144403309 });
  assert.equal(programs.size, 4);
});

test('a version reads from its file or folder name', () => {
  assert.equal(versionOf(`${V}2.1.303`), '2.1.303');
  assert.equal(versionOf('/Users/me/Library/Application Support/Claude/claude-code/2.1.304/6bbba6adc37/claude'), '2.1.304');
  assert.equal(versionOf('/opt/homebrew/bin/claude'), null);
});

test('a session running a deleted version is caught', () => {
  const at = { procs: parsePs(PS), programs: parseLsof(LSOF), inodeOf };
  assert.deepEqual(removedUnder(15793, at), { pid: 15793, self: true, name: '2.1.303', path: `${V}2.1.303`, version: '2.1.303' });
});

test('one on the installed version is not', () => {
  assert.equal(removedUnder(2326, { procs: parsePs(PS), programs: parseLsof(LSOF), inodeOf }), null);
});

test('a file put back at the same path is still not the program it runs', () => {
  const at = { procs: parsePs(PS), programs: parseLsof(LSOF), inodeOf: (p) => (p === `${V}2.1.303` ? 999 : inodeOf(p)) };
  assert.equal(removedUnder(15793, at)?.version, '2.1.303');
});

test('a background job is caught when the Claude Code it was started from was deleted', () => {
  const at = { procs: parsePs(PS), programs: parseLsof(LSOF), inodeOf: (p) => (p.endsWith('2.1.306') ? null : inodeOf(p)) };
  assert.deepEqual(removedUnder(2326, at), { pid: 2326, self: true, name: '2.1.306', path: `${V}2.1.306`, version: '2.1.306' });
  const daemonOnly = { ...at, inodeOf: (p) => (p.endsWith('2.1.306') ? null : inodeOf(p)), programs: new Map([...parseLsof(LSOF)].filter(([pid]) => pid !== 2326)) };
  assert.deepEqual(removedUnder(2326, daemonOnly), { pid: 36587, self: false, name: '2.1.306', path: `${V}2.1.306`, version: '2.1.306' });
});

test("a process lsof can't see is left alone", () => {
  assert.equal(removedUnder(30742, { procs: parsePs(PS), programs: parseLsof(LSOF), inodeOf: () => null }), null);
});

test('a parent loop ends', () => {
  const procs = new Map([[10, { ppid: 11, name: 'a' }], [11, { ppid: 10, name: 'b' }]]);
  assert.equal(removedUnder(10, { procs, programs: new Map(), inodeOf }), null);
});

test('one ps and one lsof cover the sessions and the processes they were started from', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    return cmd === 'ps' ? { stdout: PS } : { stdout: LSOF, err: new Error('lsof exits 1 when a pid has gone') };
  };
  const found = await findRemoved([15793, 2326, null], { run, inodeOf });
  assert.deepEqual([...found.keys()], [15793]);
  assert.equal(found.get(15793).version, '2.1.303');
  assert.equal(calls.length, 2);
  const pids = calls[1][1][calls[1][1].indexOf('-p') + 1].split(',').map(Number).sort((a, b) => a - b);
  assert.deepEqual(pids, [2326, 15793, 30742, 36587]); // not launchd, and not 30740, which ps doesn't list
});

test('nothing is flagged when ps or lsof fails', async () => {
  const run = async (cmd) => (cmd === 'ps' ? { stdout: '', err: new Error('ps failed') } : { stdout: '' });
  assert.equal((await findRemoved([15793], { run, inodeOf })).size, 0);
  assert.equal((await findRemoved([], { run: async () => { throw new Error('never'); }, inodeOf })).size, 0);
});
