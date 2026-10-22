// The launchd agent that keeps the panel running without the app: its names, its plist and its install, remove and status. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { LABEL, plistPath, logPath, launchdPlist, install, remove, status } from '../daemon.mjs';

const uid = String(process.getuid());
const fakeRun = (answers = {}) => { const calls = []; const run = async (cmd, args) => { calls.push([cmd, ...args]); return answers[args[0]] ?? { stdout: '', stderr: '', err: null }; }; return Object.assign(run, { calls }); };

test('the label follows the app bundle id: plain on 4747, suffixed elsewhere', () => {
  assert.equal(LABEL(4747), 'local.agent-panel');
  assert.equal(LABEL(4800), 'local.agent-panel.4800');
  assert.equal(plistPath(4747, '/h'), '/h/Library/LaunchAgents/local.agent-panel.plist');
  assert.equal(logPath(4800, '/h'), '/h/Library/Logs/Agent Panel/daemon-4800.log');
});

test('the plist runs the server from the repo with PATH, the port and ACP_DAEMON, and launchd accepts it', () => {
  const xml = launchdPlist({ label: 'local.agent-panel', node: '/opt/node/bin/node', repo: '/tmp/a&b <c>', port: 4747, pathEnv: '/opt/node/bin:/usr/bin', log: '/tmp/d.log' });
  assert.match(xml, /<key>Label<\/key><string>local\.agent-panel<\/string>/);
  assert.match(xml, /<key>ProgramArguments<\/key><array><string>\/opt\/node\/bin\/node<\/string><string>\/tmp\/a&amp;b &lt;c&gt;\/server\.mjs<\/string><\/array>/);
  assert.match(xml, /<key>WorkingDirectory<\/key><string>\/tmp\/a&amp;b &lt;c&gt;<\/string>/);
  for (const [k, v] of [['PATH', '/opt/node/bin:/usr/bin'], ['ACP_PORT', '4747'], ['ACP_DAEMON', '1']]) assert.match(xml, new RegExp(`<key>${k}</key><string>${v.replace(/\//g, '\\/')}</string>`));
  for (const k of ['RunAtLoad', 'KeepAlive']) assert.match(xml, new RegExp(`<key>${k}</key><true/>`));
  assert.match(xml, /<key>ThrottleInterval<\/key><integer>10<\/integer>/);
  assert.match(xml, /<key>ProcessType<\/key><string>Background<\/string>/);
  assert.equal((xml.match(/<string>\/tmp\/d\.log<\/string>/g) ?? []).length, 2, 'stdout and stderr both go to the log');
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-')), 'x.plist');
  fs.writeFileSync(f, xml);
  execFileSync('plutil', ['-lint', f]); // throws when launchd would refuse it
});

test('install writes the plist and the log folder, boots the old one out, then bootstraps the new', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-')), run = fakeRun();
  const r = await install({ port: 4747, node: '/usr/local/bin/node', repo: '/r', pathEnv: '/usr/bin', home, run });
  assert.equal(r.plist, plistPath(4747, home));
  assert.equal(r.label, 'local.agent-panel');
  assert.ok(fs.existsSync(r.plist));
  assert.ok(fs.existsSync(path.dirname(logPath(4747, home))));
  assert.deepEqual(run.calls, [['launchctl', 'bootout', `gui/${uid}/local.agent-panel`], ['launchctl', 'bootstrap', `gui/${uid}`, r.plist]]);
});

test('install succeeds when there was nothing to boot out', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-'));
  const run = fakeRun({ bootout: { stdout: '', stderr: 'Boot-out failed: 3: No such process', err: new Error('exit 3') } });
  await assert.doesNotReject(install({ port: 4747, node: '/n', repo: '/r', pathEnv: '/b', home, run }));
});

test('remove boots the service out and deletes the plist; a second remove reports nothing removed', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-')), run = fakeRun();
  await install({ port: 4800, node: '/n', repo: '/r', pathEnv: '/b', home, run });
  assert.deepEqual(await remove({ port: 4800, home, run }), { removed: true });
  assert.equal(fs.existsSync(plistPath(4800, home)), false);
  assert.equal(run.calls.at(-1)[1], 'bootout');
  assert.deepEqual(await remove({ port: 4800, home, run }), { removed: false });
});

test('status reads the pid from launchctl print, and says not loaded when it fails', async () => {
  const up = fakeRun({ print: { stdout: 'local.agent-panel = {\n\tactive count = 1\n\tpid = 4242\n\tstate = running\n}', stderr: '', err: null } });
  assert.deepEqual(await status({ port: 4747, run: up }), { loaded: true, pid: 4242 });
  const down = fakeRun({ print: { stdout: '', stderr: 'Could not find service', err: new Error('exit 113') } });
  assert.deepEqual(await status({ port: 4747, run: down }), { loaded: false, pid: null });
});
