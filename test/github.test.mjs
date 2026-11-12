// github: which repository a folder is, what gh says about its pull requests and default-branch runs, and when that is
// worth a notification. A fake `run` stands in for gh, with a clock that only moves when told to and temp git folders.
// Nothing here calls the real gh or the network. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { originOf, parseRemote, slugOf, rollup, classify, trimLog, createGithub } from '../github.mjs';

const T0 = Date.parse('2026-11-12T12:00:00Z');
const SEC = 1000, MIN = 60 * SEC;
const iso = (t) => new Date(t).toISOString();
const GH = '/usr/local/bin/gh';
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-data-'));

/** The server's small(): the start of a regular file, trimmed. */
function small(f, max = 4096) {
  const fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${f} is not a file`);
    const buf = Buffer.alloc(max);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, max, 0)).trim();
  } finally { fs.closeSync(fd); }
}

/** A checkout whose origin is on github.com. `head` is what refs/remotes/origin/HEAD names; null leaves it out. */
function checkout({ slug = 'someone/demo', head = 'main', url } = {}) {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'gh-repo-'));
  const common = path.join(top, '.git');
  fs.mkdirSync(path.join(common, 'refs', 'remotes', 'origin'), { recursive: true });
  fs.writeFileSync(path.join(common, 'config'),
    `[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = ${url ?? `git@github.com:${slug}.git`}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`);
  if (head) fs.writeFileSync(path.join(common, 'refs', 'remotes', 'origin', 'HEAD'), `ref: refs/remotes/origin/${head}\n`);
  return { top, common };
}

const ok = (data) => ({ err: null, stdout: JSON.stringify(data), stderr: '' });
const fail = (code, stderr = '', extra = {}) => ({ err: Object.assign(new Error(`Command failed: gh\n${stderr}`), { code, ...extra }), stdout: '', stderr });

const check = (over = {}) => ({ __typename: 'CheckRun', name: 'build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'SUCCESS',
  startedAt: iso(T0 - 3 * MIN), completedAt: iso(T0 - 2 * MIN), detailsUrl: 'https://github.com/someone/demo/actions/runs/100/job/200', ...over });
const status = (over = {}) => ({ __typename: 'StatusContext', context: 'ci/legacy', state: 'SUCCESS', startedAt: iso(T0 - 2 * MIN),
  targetUrl: 'https://ci.example.com/build/1', ...over });
const pr = (over = {}) => ({ number: 7, title: 'Fix the login', url: 'https://github.com/someone/demo/pull/7', isDraft: false, headRefName: 'fix/login',
  headRefOid: 'aaa111', baseRefName: 'main', isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '',
  statusCheckRollup: [check()], updatedAt: iso(T0 - MIN), ...over });
const merged = (over = {}) => ({ number: 7, title: 'Fix the login', url: 'https://github.com/someone/demo/pull/7', headRefName: 'fix/login', baseRefName: 'main',
  mergedAt: iso(T0 - 2 * MIN), mergeCommit: { oid: 'm1' }, ...over });
const ghRun = (over = {}) => ({ databaseId: 500, workflowName: 'CI', displayTitle: 'Merge pull request #7', status: 'completed', conclusion: 'success',
  headBranch: 'main', headSha: 'm1', event: 'push', url: 'https://github.com/someone/demo/actions/runs/500', createdAt: iso(T0 - 3 * MIN),
  updatedAt: iso(T0 - MIN), attempt: 1, ...over });

/** What gh is asked, by kind: 'pr open', 'pr merged', 'run list', 'run view', 'repo view'. */
const kindOf = (args) => (args[0] === 'pr' ? `pr ${args[args.indexOf('--state') + 1]}` : `${args[0]} ${args[1]}`);
const slugIn = (args) => (args[0] === 'repo' ? args[2] : args[args.indexOf('-R') + 1]).replace(/^github\.com\//, '');

/**
 * A watcher over a fake gh. `w.open`, `w.merged`, `w.runs` are what gh answers; `w.hook(args)` may answer instead.
 * `clock.t` is now; tick() and advance() move things along.
 */
function harness({ targets, file, world = {}, repo = checkout(), ...over } = {}) {
  const w = { open: [], merged: [], runs: [], defaultBranch: 'main', log: '', hook: null, ...world };
  const calls = [], notes = [], events = [], logs = [];
  const clock = { t: T0 };
  let changes = 0;
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts, at: clock.t });
    const hooked = w.hook?.(args, opts);
    if (hooked) return hooked;
    const kind = kindOf(args);
    if (kind === 'pr open') return ok(w.open);
    if (kind === 'pr merged') return ok(w.merged);
    if (kind === 'run list') return ok(w.runs);
    if (kind === 'repo view') return ok({ defaultBranchRef: { name: w.defaultBranch } });
    if (kind === 'run view') return { err: null, stdout: w.log, stderr: '' };
    return fail(1, `unknown command ${args.join(' ')}`);
  };
  const gh = createGithub({
    file, run, read: small, ghPath: () => GH,
    targets: () => targets ?? [{ sessionId: 'S1', common: repo.common, branch: 'fix/login', at: 10 }],
    notify: (title, text) => notes.push({ title, text }), onEvent: (e) => events.push(e), onChange: () => { changes++; },
    cwd: DATA, env: { PATH: '/usr/bin:/bin', HOME: DATA }, now: () => clock.t, log: (m) => logs.push(m), ...over,
  });
  const polls = () => calls.filter((c) => kindOf(c.args) === 'pr open').length;
  return {
    gh, w, calls, notes, events, logs, clock, repo, polls, changes: () => changes,
    kinds: () => calls.map((c) => kindOf(c.args)),
    tick: (watched = true) => gh.tick({ watched }),
    advance: (ms) => { clock.t += ms; },
  };
}

// ---------------------------------------------------------------- which repository a folder is

test('every form a github.com remote comes in names its repository', () => {
  const want = { owner: 'someone', name: 'demo', slug: 'someone/demo' };
  for (const url of [
    'https://github.com/someone/demo', 'https://github.com/someone/demo.git', 'https://github.com/someone/demo/', 'http://github.com/someone/demo.git',
    'https://user@github.com/someone/demo.git', 'https://GitHub.COM/someone/demo', 'https://www.github.com/someone/demo',
    'git@github.com:someone/demo.git', 'git@github.com:someone/demo', 'github.com:someone/demo.git',
    'ssh://git@github.com/someone/demo.git', 'ssh://git@github.com:22/someone/demo', 'ssh://git@ssh.github.com:443/someone/demo.git',
    'git://github.com/someone/demo.git', 'git+ssh://git@github.com/someone/demo.git', '  https://github.com/someone/demo.git  ',
  ]) assert.deepEqual(parseRemote(url), want, url);
  assert.deepEqual(parseRemote('git@github.com:Some-One/my.repo_2.git'), { owner: 'Some-One', name: 'my.repo_2', slug: 'Some-One/my.repo_2' });
});

test('anything that is not a github.com owner/name is not tracked', () => {
  for (const url of [
    null, undefined, '', 'https://gitlab.com/someone/demo.git', 'git@gitlab.com:someone/demo.git', 'git@work-github:someone/demo.git',
    'https://github.example.com/someone/demo', 'https://github.com.evil.io/someone/demo', 'https://github.com/someone',
    'https://github.com/someone/demo/tree/main', 'https://github.com/-someone/demo', 'https://github.com/some_one/demo',
    `https://github.com/${'a'.repeat(40)}/demo`, 'https://github.com/someone/..', 'https://github.com/someone/.', 'https://github.com/someone/de mo',
    '/srv/git/demo.git', 'file:///srv/git/demo.git', '../demo',
  ]) assert.equal(parseRemote(url), null, String(url));
});

test('a tokened URL never reaches url', () => {
  const token = 'ghp_SECRETsecretSECRET0123456789';
  const parsed = parseRemote(`https://x-access-token:${token}@github.com/someone/demo.git`);
  assert.deepEqual(parsed, { owner: 'someone', name: 'demo', slug: 'someone/demo' });
  // All the way through: the config holds the token, the board shows only the rebuilt URL.
  const repo = checkout({ url: `https://someone:${token}@github.com/someone/demo.git` });
  const h = harness({ repo });
  return h.tick().then(() => {
    const s = h.gh.state();
    assert.equal(s.repos[0].url, 'https://github.com/someone/demo');
    assert.equal(JSON.stringify(s).includes(token), false);
    assert.equal(JSON.stringify(h.gh.forSession(repo.common, 'fix/login')).includes(token), false);
    assert.equal(h.calls.some((c) => JSON.stringify(c).includes(token)), false, 'nor is it passed to gh');
  });
});

test("origin's url is read past quotes, comments, other remotes and pushurl", () => {
  assert.equal(originOf('[remote "origin"]\n\turl = https://github.com/a/b.git\n'), 'https://github.com/a/b.git');
  assert.equal(originOf('[remote "upstream"]\n\turl = git@github.com:up/b.git\n[remote "origin"]\n\tpushurl = git@github.com:push/b.git\n\turl = git@github.com:a/b.git\n'),
    'git@github.com:a/b.git');
  assert.equal(originOf('[remote "origin"]\n\turl = "https://github.com/a/b.git" ; a comment\n'), 'https://github.com/a/b.git');
  assert.equal(originOf('[remote "origin"]\n\turl = https://github.com/a/b.git # a comment\n'), 'https://github.com/a/b.git');
  assert.equal(originOf('[remote "origin"]\n\t# url = git@github.com:old/b.git\n\t; url = git@github.com:older/b.git\n\turl = git@github.com:a/b.git\n'), 'git@github.com:a/b.git');
  assert.equal(originOf('[remote "origin"]\n\tURL=git@github.com:a/b.git\n\turl = git@github.com:second/b.git\n'), 'git@github.com:a/b.git', 'the first url, keys in any case');
  assert.equal(originOf('[Remote "origin"] url = git@github.com:a/b.git\n'), 'git@github.com:a/b.git', 'a key on the header line');
  assert.equal(originOf('[remote "Origin"]\n\turl = git@github.com:a/b.git\n'), null, 'subsection names are case sensitive');
  assert.equal(originOf('[remote.origin]\n\turl = git@github.com:a/b.git\n'), null);
  assert.equal(originOf('[remote "origin"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n[branch "main"]\n\turl = git@github.com:a/b.git\n'), null);
  assert.equal(originOf('[url "git@github.com:"]\n\tinsteadOf = https://github.com/\n[include]\n\tpath = other\n'), null);
  assert.equal(originOf(''), null);
  assert.equal(originOf(null), null);
});

test("a linked worktree's repository is found through its common git dir", () => {
  const { top, common } = checkout({ slug: 'someone/demo' });
  // What `git worktree add` leaves: a .git file naming the worktree's own git dir, whose commondir points back.
  const gitDir = path.join(common, 'worktrees', 'wt');
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(gitDir, 'commondir'), '../..\n');
  fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/fix/login\n');
  const wt = path.join(top, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gitDir}\n`);
  // As readPlace resolves it.
  const named = path.resolve(wt, small(path.join(wt, '.git')).match(/^gitdir:\s*(.+)$/m)[1].trim());
  const shared = path.resolve(named, small(path.join(named, 'commondir')));
  assert.equal(shared, common);
  assert.equal(slugOf(shared, small), 'someone/demo');
  assert.equal(slugOf(named, small), null, "the worktree's own git dir has no config");
  assert.equal(slugOf(path.join(top, 'nowhere'), small), null);
  assert.equal(slugOf(null, small), null);
  assert.equal(slugOf(common, () => { throw new Error('EACCES'); }), null);
  assert.equal(slugOf(checkout({ url: 'git@gitlab.com:someone/demo.git' }).common, small), null);
});

// ---------------------------------------------------------------- reading what gh says

test('checks roll up to failing, else running, else passing, else none', () => {
  const cases = [
    [[], 'none', { pass: 0, fail: 0, pending: 0 }],
    [undefined, 'none', { pass: 0, fail: 0, pending: 0 }],
    [[check(), check({ name: 'lint' })], 'passing', { pass: 2, fail: 0, pending: 0 }],
    [[check(), check({ name: 'lint', status: 'IN_PROGRESS', conclusion: '' })], 'running', { pass: 1, fail: 0, pending: 1 }],
    [[check({ status: 'QUEUED', conclusion: '', startedAt: '0001-01-01T00:00:00Z', completedAt: '0001-01-01T00:00:00Z' })], 'running', { pass: 0, fail: 0, pending: 1 }],
    [[check({ conclusion: 'FAILURE' }), check({ name: 'lint', status: 'IN_PROGRESS', conclusion: '' })], 'failing', { pass: 0, fail: 1, pending: 1 }],
    [[check({ conclusion: 'TIMED_OUT' })], 'failing', { pass: 0, fail: 1, pending: 0 }],
    [[check({ conclusion: 'STARTUP_FAILURE' })], 'failing', { pass: 0, fail: 1, pending: 0 }],
    [[check({ conclusion: 'SKIPPED' }), check({ name: 'b', conclusion: 'NEUTRAL' }), check({ name: 'c', conclusion: 'CANCELLED' })], 'none', { pass: 0, fail: 0, pending: 0 }],
    [[check({ conclusion: 'SKIPPED' }), check({ name: 'lint' })], 'passing', { pass: 1, fail: 0, pending: 0 }],
    [[status()], 'passing', { pass: 1, fail: 0, pending: 0 }],
    [[status({ state: 'FAILURE' })], 'failing', { pass: 0, fail: 1, pending: 0 }],
    [[status({ state: 'ERROR' })], 'failing', { pass: 0, fail: 1, pending: 0 }],
    [[status({ state: 'PENDING' })], 'running', { pass: 0, fail: 0, pending: 1 }],
    [[status({ state: 'EXPECTED' })], 'running', { pass: 0, fail: 0, pending: 1 }],
    [[{ context: 'no-typename', state: 'failure' }], 'failing', { pass: 0, fail: 1, pending: 0 }],
    [[check({ status: 'completed', conclusion: 'failure' })], 'failing', { pass: 0, fail: 1, pending: 0 }],
    [[null, 'junk', check()], 'passing', { pass: 1, fail: 0, pending: 0 }],
  ];
  for (const [contexts, checks, counts] of cases) {
    const r = rollup(contexts);
    assert.equal(r.checks, checks, JSON.stringify(contexts));
    assert.deepEqual(r.counts, counts, JSON.stringify(contexts));
  }
});

test('a check re-run counts once, by its latest run', () => {
  const failedThenPassed = [check({ conclusion: 'FAILURE', startedAt: iso(T0 - 10 * MIN), completedAt: iso(T0 - 9 * MIN) }), check({ startedAt: iso(T0 - 5 * MIN) })];
  assert.equal(rollup(failedThenPassed).checks, 'passing');
  assert.equal(rollup([...failedThenPassed].reverse()).checks, 'passing', 'order does not matter');
  const rerunning = [check({ conclusion: 'FAILURE', startedAt: iso(T0 - 10 * MIN) }), check({ status: 'IN_PROGRESS', conclusion: '', startedAt: iso(T0 - MIN), completedAt: null })];
  assert.equal(rollup(rerunning).checks, 'running');
  // The same name in two workflows is two checks.
  assert.deepEqual(rollup([check({ workflowName: 'A', conclusion: 'FAILURE' }), check({ workflowName: 'B' })]).counts, { pass: 1, fail: 1, pending: 0 });
});

test("a failing check names its run and job, and when it finished", () => {
  const r = rollup([
    check({ name: 'build', conclusion: 'FAILURE', completedAt: iso(T0 - 7 * MIN), detailsUrl: 'https://github.com/o/n/actions/runs/123/job/456' }),
    check({ name: 'test', conclusion: 'FAILURE', completedAt: iso(T0 - 4 * MIN), detailsUrl: 'https://github.com/o/n/actions/runs/124' }),
    status({ context: 'ext', state: 'ERROR', startedAt: iso(T0 - 20 * MIN) }),
  ]);
  assert.deepEqual(r.failing, [
    { name: 'build', url: 'https://github.com/o/n/actions/runs/123/job/456', runId: 123, jobId: 456 },
    { name: 'test', url: 'https://github.com/o/n/actions/runs/124', runId: 124, jobId: null },
    { name: 'ext', url: 'https://ci.example.com/build/1', runId: null, jobId: null },
  ]);
  assert.equal(r.finishedAt, T0 - 4 * MIN);
});

test('a failed gh call says why', () => {
  const kind = (r, ctx) => classify(r, ctx)?.kind;
  assert.equal(classify({ err: null, stdout: '[]', stderr: '' }), null);
  assert.equal(kind({ err: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }), 'missing');
  assert.equal(kind({ err: Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }) }, { cwd: DATA }), 'missing', 'the folder is there: gh is not');
  assert.equal(kind(fail(4, 'To get started with GitHub CLI, please run:  gh auth login')), 'signed-out');
  assert.equal(kind(fail(4, '')), 'signed-out');
  assert.equal(kind(fail(1, 'HTTP 401: Bad credentials (https://api.github.com/graphql)')), 'signed-out');
  assert.equal(kind(fail(1, 'GraphQL: API rate limit exceeded for user ID 1.')), 'rate');
  assert.equal(kind(fail(1, 'HTTP 403: You have exceeded a secondary rate limit.')), 'rate');
  assert.equal(kind(fail(1, 'HTTP 429: Too Many Requests')), 'rate');
  assert.equal(kind(fail(1, 'GraphQL: Could not resolve to a Repository with the name \'o/n\'. (repository)')), 'not-found');
  assert.equal(kind(fail(1, 'HTTP 404: Not Found (https://api.github.com/repos/o/n)')), 'not-found');
  assert.equal(kind(fail(null, '', { killed: true, signal: 'SIGTERM' })), 'timeout');
  assert.equal(kind(fail('ERR_CHILD_PROCESS_STDIO_MAXBUFFER', '')), 'too-large');
  assert.equal(kind(fail(1, 'error connecting to api.github.com\ndial tcp: lookup api.github.com: no such host')), 'offline');
  const other = classify(fail(1, '\n  something odd happened\nsecond line'));
  assert.deepEqual(other, { kind: 'error', text: 'something odd happened' });
  assert.ok(classify(fail(1, 'x'.repeat(500))).text.length <= 200);
  assert.equal(classify(fail(1, '')).text, 'Command failed: gh', 'no stderr: the error message');
  assert.match(classify(fail(4, '')).text, /not signed in/);
});

test("ENOENT from a cwd that is gone is not read as gh being missing", () => {
  const gone = path.join(DATA, 'no-such-folder');
  const r = classify({ err: Object.assign(new Error('spawn /usr/local/bin/gh ENOENT'), { code: 'ENOENT' }), stdout: '', stderr: '' }, { cwd: gone });
  assert.equal(r.kind, 'no-cwd');
  assert.match(r.text, /folder/);
});

test('a failed log is cut to its failed steps, errors on top', () => {
  const BOM = '﻿';
  const lines = [
    `build\tSet up job\t${BOM}2026-11-12T11:58:00.0000000Z Current runner version: '2.320.0'`,
    `build\tRun tests\t${BOM}2026-11-12T11:58:01.1234567Z ##[group]Run npm test`,
    'build\tRun tests\t2026-11-12T11:58:01.2000000Z npm test',
    'build\tRun tests\t2026-11-12T11:58:01.3000000Z ##[endgroup]',
    ...Array.from({ length: 80 }, (_, i) => `build\tRun tests\t2026-11-12T11:58:02.0000000Z \x1b[32mok ${i}\x1b[0m`),
    'build\tRun tests\t2026-11-12T11:58:03.0000000Z \x1b[31mnot ok 81 - login keeps the session\x1b[0m\r',
    'build\tRun tests\t2026-11-12T11:58:03.1000000Z ##[error]Process completed with exit code 1.',
    ...Array.from({ length: 10 }, (_, i) => `build\tRun tests\t2026-11-12T11:58:04.0000000Z cleanup ${i}`),
    `lint\tUNKNOWN STEP\t2026-11-12T11:58:05.0000000Z ##[error]${'x'.repeat(400)}`,
  ];
  const r = trimLog(lines.join('\n'));
  assert.deepEqual(r.steps.map(({ job, step }) => ({ job, step })), [{ job: 'build', step: 'Set up job' }, { job: 'build', step: 'Run tests' }, { job: 'lint', step: '' }]);
  const tests = r.steps[1];
  assert.equal(tests.lines, 60, 'the last 60 lines of a step');
  assert.equal(r.truncated, true);
  assert.ok(r.text.startsWith('Error: Process completed with exit code 1.\nError: xxx'), 'error lines hoisted');
  assert.match(r.text, /== build › Run tests ==/);
  assert.match(r.text, /== lint ==/, 'UNKNOWN STEP is left unnamed');
  assert.match(r.text, /not ok 81 - login keeps the session\n/);
  assert.match(r.text, /cleanup 2\n/, 'a few lines after the last error are kept');
  assert.doesNotMatch(r.text, /cleanup 3/, 'but not the clean-up that follows it');
  assert.doesNotMatch(r.text, /﻿|\x1b|2026-11-12T|##\[|\r/);
  assert.doesNotMatch(r.text, /ok 0\n/, 'the head of a long step is dropped');
  assert.ok(r.text.split('\n').every((l) => l.length <= 301), 'long lines are cut');
  assert.deepEqual(trimLog(''), { text: '', steps: [], truncated: false });
  // A BOM in front of the job name must not split its lines into a group of their own.
  assert.equal(trimLog(`${BOM}job\tstep\tone\njob\tstep\ttwo`).steps.length, 1);
});

test('a log over the limit gives each failed step an equal share from its end', () => {
  const lines = [];
  for (const step of ['one', 'two', 'three']) for (let i = 0; i < 60; i++) lines.push(`job\t${step}\t${step} line ${i} ${'y'.repeat(180)}`);
  const r = trimLog(lines.join('\n'));
  assert.equal(r.truncated, true);
  assert.ok(r.text.length <= 12_000, String(r.text.length));
  for (const step of ['one', 'two', 'three']) {
    assert.match(r.text, new RegExp(`== job › ${step} ==`));
    assert.match(r.text, new RegExp(`${step} line 59 `), `the end of ${step} is kept`);
  }
  assert.ok(trimLog(lines.join('\n'), { max: 3000 }).text.length <= 3000);
});

// ---------------------------------------------------------------- the watcher

test('every gh call names the repository on github.com and runs outside it', async () => {
  const h = harness();
  await h.tick();
  assert.deepEqual(h.kinds().sort(), ['pr merged', 'pr open', 'run list']);
  for (const c of h.calls) {
    assert.equal(c.cmd, GH);
    assert.equal(slugIn(c.args), 'someone/demo');
    assert.ok(c.args.includes('github.com/someone/demo'));
    assert.equal(c.opts.cwd, DATA);
    assert.equal(c.opts.timeout, 12_000);
    assert.equal(c.opts.env.GH_PROMPT_DISABLED, '1');
    assert.equal(c.opts.env.GH_NO_UPDATE_NOTIFIER, '1');
    assert.equal(c.opts.env.PATH, '/usr/bin:/bin');
  }
  const runList = h.calls.find((c) => kindOf(c.args) === 'run list').args;
  assert.equal(runList[runList.indexOf('--branch') + 1], 'main', 'the default branch from origin/HEAD');
  assert.equal(h.gh.state().gh, 'ok');
  assert.equal(h.gh.state().hint, null);
});

test('with no origin/HEAD the default branch is asked for once', async () => {
  const h = harness({ repo: checkout({ head: null }), world: { defaultBranch: 'trunk' } });
  await h.tick();
  h.advance(MIN);
  await h.tick();
  assert.equal(h.kinds().filter((k) => k === 'repo view').length, 1);
  const runList = h.calls.find((c) => kindOf(c.args) === 'run list').args;
  assert.equal(runList[runList.indexOf('--branch') + 1], 'trunk');
  assert.equal(h.gh.state().repos[0].defaultBranch, 'trunk');
});

test('only branches agents are on are kept, and pull requests from forks are dropped', async () => {
  const h = harness({ world: { open: [
    pr(),
    pr({ number: 8, headRefName: 'someone-elses-branch', url: 'u8' }),
    pr({ number: 9, headRefName: 'fix/login', isCrossRepository: true, url: 'u9' }),
  ] } });
  await h.tick();
  const prs = h.gh.state().repos[0].prs;
  assert.deepEqual(prs.map((p) => p.number), [7]);
  assert.deepEqual(prs[0], {
    number: 7, title: 'Fix the login', url: 'https://github.com/someone/demo/pull/7', branch: 'fix/login', sha: 'aaa111', draft: false,
    checks: 'passing', counts: { pass: 1, fail: 0, pending: 0 }, failing: [], mergeable: 'MERGEABLE', mergeState: 'CLEAN', review: null,
    updatedAt: T0 - MIN, sessions: ['S1'],
  });
  assert.deepEqual(h.events, [], 'pull requests already open at the first poll are not news');
});

test('at the first poll an old failure shows but stays silent', async () => {
  const h = harness({ world: {
    open: [pr({ statusCheckRollup: [check({ conclusion: 'FAILURE', startedAt: iso(T0 - 25 * MIN), completedAt: iso(T0 - 20 * MIN) })] })],
    runs: [ghRun({ conclusion: 'failure', updatedAt: iso(T0 - 30 * MIN) })],
  } });
  await h.tick();
  assert.deepEqual(h.notes, []);
  assert.deepEqual(h.events.filter((e) => /failed/.test(e.type)), []);
  const r = h.gh.state().repos[0];
  assert.equal(r.prs[0].checks, 'failing');
  assert.equal(r.runs[0].state, 'failing');
  h.advance(MIN);
  await h.tick();
  assert.deepEqual(h.notes, [], 'and stays told-about on the next poll');
});

test('a failure that finished in the last fifteen minutes notifies even at the first poll', async () => {
  const h = harness({ world: {
    open: [pr({ statusCheckRollup: [check({ conclusion: 'FAILURE', completedAt: iso(T0 - 5 * MIN) })] })],
    runs: [ghRun({ id: 501, conclusion: 'failure', updatedAt: iso(T0 - 14 * MIN) })],
  } });
  await h.tick();
  assert.deepEqual(h.notes.map((n) => n.title), ['Agent Panel · CI failed', 'Agent Panel · CI failed']);
  assert.deepEqual(h.notes.map((n) => n.text), ['someone/demo: build failed on fix/login (#7).', 'someone/demo: CI failed on main.']);
  assert.deepEqual(h.events.map((e) => e.type), ['ci-failed', 'main-failed']);
  assert.deepEqual(h.events[0], { type: 'ci-failed', slug: 'someone/demo', text: 'build failed on #7 (fix/login) in someone/demo.', branch: 'fix/login',
    pr: 7, url: 'https://github.com/someone/demo/pull/7', sessions: ['S1'], runId: 100 });
});

test('once watching, a new failure notifies once however long it stays failing', async () => {
  const h = harness({ world: { open: [pr()] } });
  await h.tick();
  h.w.open = [pr({ statusCheckRollup: [check({ conclusion: 'FAILURE', completedAt: iso(T0 - 2 * 60 * MIN) })] })]; // old, but found while watching
  for (let i = 0; i < 4; i++) { h.advance(MIN); await h.tick(); }
  assert.equal(h.notes.length, 1);
  // A new commit that fails is a new failure.
  h.w.open = [pr({ headRefOid: 'bbb222', statusCheckRollup: [check({ conclusion: 'FAILURE' })] })];
  h.advance(MIN); await h.tick();
  h.advance(MIN); await h.tick();
  assert.equal(h.notes.length, 2);
});

test('passing again re-arms the alert; a re-run in progress does not', async () => {
  const failing = () => pr({ statusCheckRollup: [check({ conclusion: 'FAILURE' })] });
  const h = harness({ world: { open: [pr()] } });
  await h.tick();
  const step = async (open) => { h.w.open = [open]; h.advance(MIN); await h.tick(); };
  await step(failing());
  assert.equal(h.notes.length, 1);
  await step(pr({ statusCheckRollup: [check({ status: 'IN_PROGRESS', conclusion: '' })] }));
  await step(failing());
  assert.equal(h.notes.length, 1, 'a re-run that fails again is the same failure');
  assert.deepEqual(h.events.map((e) => e.type), ['ci-failed']);
  await step(pr({ statusCheckRollup: [check({ status: 'IN_PROGRESS', conclusion: '' })] }));
  await step(pr());
  assert.deepEqual(h.events.map((e) => e.type), ['ci-failed', 'ci-recovered'], 'recovered from failing, across the re-run');
  await step(failing());
  assert.equal(h.notes.length, 2, 'the same commit failing after it passed is news again');
});

test('more than three failures at once notify three times and once more to count the rest', async () => {
  const h = harness({ targets: [1, 2, 3, 4, 5].map((n) => ({ sessionId: `S${n}`, common: checkout().common, branch: `b${n}`, at: 1 })) });
  h.w.open = [1, 2, 3, 4, 5].map((n) => pr({ number: n, headRefName: `b${n}`, statusCheckRollup: [check({ conclusion: 'FAILURE' })] }));
  await h.tick();
  assert.equal(h.notes.length, 4);
  assert.equal(h.notes[3].text, '2 more checks failed in someone/demo.');
  assert.equal(h.events.filter((e) => e.type === 'ci-failed').length, 5, 'the feed hears of all of them');
});

test('what was told about survives a restart, in a private file', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-seen-')), 'sub', 'github.json');
  const repo = checkout();
  const world = { open: [pr({ statusCheckRollup: [check({ conclusion: 'FAILURE', completedAt: iso(T0 - 3 * MIN) })] })] };
  const a = harness({ file, repo, world });
  await a.tick();
  assert.equal(a.notes.length, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.v, 1);
  assert.deepEqual(Object.keys(saved.seen), ['someone/demo#pr7@aaa111']);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['github.json'], 'no temp file left behind');
  a.gh.stop();
  // The panel restarts within the fifteen minutes: the same failure is not told twice.
  const b = harness({ file, repo, world });
  b.clock.t = T0 + 2 * MIN;
  await b.tick();
  assert.deepEqual(b.notes, []);
  assert.equal(b.gh.state().repos[0].prs[0].checks, 'failing');
  // A file that is not ours is ignored, not trusted.
  fs.writeFileSync(file, 'not json');
  const c = harness({ file, repo, world });
  await c.tick();
  assert.equal(c.notes.length, 1);
});

test('a pull request opened, merged or closed is told to the feed', async () => {
  const h = harness({ targets: [{ sessionId: 'S1', common: checkout().common, branch: 'fix/login', at: 1 }, { sessionId: 'S2', common: checkout().common, branch: 'feat/api', at: 1 }] });
  await h.tick();
  h.w.open = [pr(), pr({ number: 8, headRefName: 'feat/api', url: 'https://github.com/someone/demo/pull/8' })];
  h.advance(MIN); await h.tick();
  assert.deepEqual(h.events.map((e) => [e.type, e.pr, e.sessions]), [['pr-opened', 7, ['S1']], ['pr-opened', 8, ['S2']]]);
  assert.equal(h.events[0].text, 'Pull request #7 was opened for fix/login in someone/demo.');
  h.events.length = 0;
  const before = h.calls.length;
  h.w.open = [];
  h.w.merged = [merged()];
  h.advance(MIN); await h.tick();
  assert.ok(h.calls.slice(before).some((c) => kindOf(c.args) === 'pr merged'), 'the merged list is asked for when a followed one leaves');
  assert.deepEqual(h.events.map((e) => [e.type, e.pr, e.branch, e.sessions]), [['pr-merged', 7, 'fix/login', ['S1']], ['pr-closed', 8, 'feat/api', ['S2']]]);
  assert.equal(h.events[0].text, 'Pull request #7 (fix/login) was merged in someone/demo.');
  assert.equal(h.events[1].text, 'Pull request #8 (feat/api) was closed without merging in someone/demo.');
  h.events.length = 0;
  h.advance(MIN); await h.tick();
  assert.deepEqual(h.events, [], 'told once');
});

test("a run on the default branch is attributed to the pull request whose merge commit it ran on", async () => {
  const h = harness({ world: {
    merged: [merged(), merged({ number: 6, headRefName: 'old', mergeCommit: { oid: 'm0' }, mergedAt: iso(T0 - 60 * MIN) })],
    runs: [
      ghRun({ conclusion: 'failure', updatedAt: iso(T0 - MIN) }),
      ghRun({ databaseId: 501, workflowName: 'Fork CI', event: 'pull_request', headSha: 'zzz', conclusion: 'failure' }),
      ghRun({ databaseId: 502, workflowName: 'Nightly', event: 'schedule', headSha: 'm0', conclusion: 'failure', updatedAt: iso(T0 - MIN) }),
    ],
  } });
  await h.tick();
  assert.deepEqual(h.notes.map((n) => n.text), ['someone/demo: CI failed on main after #7.'], 'a scheduled run shows but does not notify');
  assert.deepEqual(h.events.map((e) => [e.type, e.pr, e.runId, e.sessions]), [['main-failed', 7, 500, ['S1']]]);
  assert.equal(h.events[0].text, 'CI failed on main in someone/demo after #7.');
  const r = h.gh.state().repos[0];
  assert.deepEqual(r.runs.map((x) => [x.id, x.workflow, x.pr, x.sessions]), [[502, 'Nightly', 6, []], [500, 'CI', 7, ['S1']]], "a fork's pull_request run on a branch named main is dropped; ties go to the newer id");
  assert.deepEqual(r.merged.map((m) => [m.number, m.sha]), [[7, 'm1'], [6, 'm0']]);
  assert.equal(h.gh.knows('someone/demo', 500), true);
  assert.equal(h.gh.knows('someone/demo', 501), false);
  // The session whose pull request was the merge is offered the failed run.
  assert.deepEqual(h.gh.forSession(h.repo.common, 'fix/login').failed,
    { runId: 500, jobId: null, workflow: 'CI', url: 'https://github.com/someone/demo/actions/runs/500', on: 'main' });
  // It passes again.
  h.w.runs = [ghRun({ databaseId: 503, createdAt: iso(T0), updatedAt: iso(T0 + MIN) }), ...h.w.runs];
  h.advance(MIN); await h.tick();
  assert.deepEqual(h.events.slice(1).map((e) => [e.type, e.runId]), [['main-recovered', 503]]);
  assert.equal(h.gh.state().repos[0].runs[0].state, 'passing');
});

test('the pace follows whether a page is open and whether CI is running', async () => {
  const h = harness();
  const pollsAfter = async (ms, watched) => { const n = h.polls(); h.advance(ms); await h.tick(watched); return h.polls() - n; };
  await h.tick(true);
  assert.equal(h.polls(), 1, 'a new repository polls at once');
  assert.equal(await pollsAfter(59 * SEC, true), 0);
  assert.equal(await pollsAfter(1 * SEC, true), 1, 'page open, idle: a minute');
  assert.equal(await pollsAfter(4 * MIN + 59 * SEC, false), 0);
  assert.equal(await pollsAfter(1 * SEC, false), 1, 'no page, idle: five minutes');
  h.w.open = [pr({ statusCheckRollup: [check({ status: 'IN_PROGRESS', conclusion: '' })] })];
  assert.equal(await pollsAfter(5 * MIN, false), 1);
  assert.equal(await pollsAfter(19 * SEC, true), 0);
  assert.equal(await pollsAfter(1 * SEC, true), 1, 'page open, running: twenty seconds');
  assert.equal(await pollsAfter(59 * SEC, false), 0);
  assert.equal(await pollsAfter(1 * SEC, false), 1, 'no page, running: a minute');
  h.w.open = [];
  h.w.runs = [ghRun({ status: 'in_progress', conclusion: '' })];
  assert.equal(await pollsAfter(MIN, true), 1);
  assert.equal(await pollsAfter(20 * SEC, true), 1, 'a default-branch run in progress counts as running too');
});

test('errors back off from a minute, doubling to fifteen; rate limits wait fifteen and a missing repository an hour', async () => {
  const h = harness();
  h.w.hook = () => fail(1, 'something broke');
  await h.tick();
  assert.deepEqual(h.gh.state().repos[0].error, { kind: 'error', text: 'something broke' });
  const gaps = [];
  let last = h.clock.t;
  for (let i = 0; i < 6; i++) {
    const n = h.polls();
    while (h.polls() === n) { h.advance(10 * SEC); await h.tick(); }
    gaps.push((h.clock.t - last) / MIN);
    last = h.clock.t;
  }
  assert.deepEqual(gaps, [1, 2, 4, 8, 15, 15]);
  h.w.hook = null;
  h.advance(15 * MIN); await h.tick();
  assert.equal(h.gh.state().repos[0].error, null, 'an answer clears it');
  h.advance(MIN); await h.tick();
  h.w.hook = () => fail(1, 'GraphQL: API rate limit exceeded for user ID 1.');
  h.advance(MIN); await h.tick();
  assert.equal(h.gh.state().repos[0].error.kind, 'rate');
  let n = h.polls();
  h.advance(14 * MIN + 59 * SEC); await h.tick();
  assert.equal(h.polls(), n);
  h.advance(SEC); await h.tick();
  assert.equal(h.polls(), n + 1);
  h.w.hook = () => fail(1, 'HTTP 404: Not Found (https://api.github.com/repos/someone/demo)');
  h.advance(15 * MIN); await h.tick();
  assert.equal(h.gh.state().repos[0].error.kind, 'not-found');
  n = h.polls();
  h.advance(59 * MIN); await h.tick();
  assert.equal(h.polls(), n);
  h.advance(MIN); await h.tick();
  assert.equal(h.polls(), n + 1);
  assert.equal(h.gh.state().gh, 'ok', 'gh answered: it is there and signed in');
});

test('a beat that arrives during a poll does nothing', async () => {
  const h = harness();
  const waiting = [];
  h.w.hook = (args) => (kindOf(args) === 'pr open' ? new Promise((resolve) => waiting.push(() => resolve(ok([])))) : null);
  const first = h.tick();
  await new Promise((r) => setImmediate(r));
  const callsSoFar = h.calls.length;
  h.advance(5 * MIN);
  await h.tick();
  await h.gh.refresh();
  assert.equal(h.calls.length, callsSoFar, 'no second poll alongside the first');
  waiting.forEach((go) => go());
  await first;
  assert.equal(h.polls(), 1);
  assert.equal(h.gh.state().gh, 'ok');
});

test('at most six repositories are watched, the most recently active; the rest are counted', async () => {
  const targets = Array.from({ length: 8 }, (_, i) => ({ sessionId: `S${i}`, common: checkout({ slug: `owner/r${i}` }).common, branch: 'main', at: 100 + i }));
  targets.push({ sessionId: 'S7b', common: checkout({ slug: 'owner/r7' }).common, branch: 'other', at: 1 }); // a second worktree of one repo
  targets.push({ sessionId: 'X', common: checkout({ url: 'git@gitlab.com:x/y.git' }).common, branch: 'main', at: 999 }); // not GitHub
  targets.push({ sessionId: 'Y', common: null, branch: null, at: 999 }); // not a repository
  const h = harness({ targets });
  await h.tick();
  const s = h.gh.state();
  assert.deepEqual(s.repos.map((r) => r.slug), ['owner/r7', 'owner/r6', 'owner/r5', 'owner/r4', 'owner/r3', 'owner/r2']);
  assert.equal(s.more, 2);
  assert.deepEqual([...new Set(h.calls.map((c) => slugIn(c.args)))].sort(), ['owner/r2', 'owner/r3', 'owner/r4', 'owner/r5', 'owner/r6', 'owner/r7']);
  assert.equal(h.polls(), 6, 'one poll per repository, however many worktrees');
  assert.equal(h.gh.forSession(targets[0].common, 'main'), null, 'one not watched has nothing to say');
});

test('with no sessions on the board nothing runs', async () => {
  const h = harness({ targets: [] });
  await h.tick();
  await h.gh.refresh();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.gh.state(), { gh: 'unknown', hint: null, more: 0, repos: [] });
});

test('a session on the default branch, or detached, gets no pull request', async () => {
  const repo = checkout();
  const h = harness({ repo, targets: [
    { sessionId: 'S1', common: repo.common, branch: 'fix/login', at: 1 },
    { sessionId: 'S2', common: repo.common, branch: 'main', at: 1 },
    { sessionId: 'S3', common: repo.common, branch: null, at: 1 },
  ], world: {
    open: [pr({ statusCheckRollup: [check({ conclusion: 'FAILURE' })], reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }),
           pr({ number: 9, headRefName: 'main', url: 'u9' })], // a same-repo pull request from main itself
    runs: [ghRun({ databaseId: 600, conclusion: 'failure', headSha: 'nomerge' })],
  } });
  await h.tick();
  assert.deepEqual(h.gh.forSession(repo.common, 'fix/login'), {
    slug: 'someone/demo', url: 'https://github.com/someone/demo',
    pr: { number: 7, url: 'https://github.com/someone/demo/pull/7', draft: false, checks: 'failing', failing: ['build'], mergeState: 'BLOCKED', review: 'REVIEW_REQUIRED' },
    main: 'failing',
    failed: { runId: 100, jobId: 200, workflow: 'build', url: 'https://github.com/someone/demo/actions/runs/100/job/200', on: 'pr' },
  });
  assert.deepEqual(h.gh.forSession(repo.common, 'main'), {
    slug: 'someone/demo', url: 'https://github.com/someone/demo', pr: null, main: 'failing',
    failed: { runId: 600, jobId: null, workflow: 'CI', url: 'https://github.com/someone/demo/actions/runs/500', on: 'main' },
  });
  assert.deepEqual(h.gh.forSession(repo.common, null), { slug: 'someone/demo', url: 'https://github.com/someone/demo', pr: null, main: 'failing', failed: null });
  assert.equal(h.gh.forSession(repo.common, 'feat/unrelated').failed, null, "another branch's session is not handed main's failure");
  assert.equal(h.gh.forSession(null, 'main'), null);
  assert.equal(h.gh.forSession(checkout({ slug: 'someone/other' }).common, 'main'), null);
});

test("a failed run's log is fetched, cut and composed into the message that hands it over", async () => {
  const h = harness({ world: {
    open: [pr({ statusCheckRollup: [check({ conclusion: 'FAILURE' })] })],
    log: 'build\tRun tests\t﻿2026-11-12T11:58:03.0000000Z not ok 1 - login\nbuild\tRun tests\t2026-11-12T11:58:03.1000000Z ##[error]Process completed with exit code 1.\n',
  } });
  await h.tick();
  assert.equal(h.gh.knows('someone/demo', 100), true);
  assert.equal(h.gh.knows('someone/demo', '100'), true);
  assert.equal(h.gh.knows('someone/demo', 999), false);
  assert.equal(h.gh.knows('someone/other', 100), false);
  assert.deepEqual(await h.gh.failedLog({ slug: 'someone/demo', runId: 999 }), { ok: false, error: 'That run is not one the panel is showing as failed.' });
  const r = await h.gh.failedLog({ slug: 'someone/demo', runId: 100 });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://github.com/someone/demo/actions/runs/100/job/200');
  assert.equal(r.text, 'Error: Process completed with exit code 1.\n\n== build › Run tests ==\nnot ok 1 - login\nError: Process completed with exit code 1.');
  assert.equal(r.message, 'build failed on fix/login (pull request #7) in someone/demo. This is the failing part of its log. Find the cause and fix it.\n\n'
    + '```\n' + r.text + '\n```\n\nThe full run: https://github.com/someone/demo/actions/runs/100/job/200');
  const call = h.calls.at(-1);
  assert.deepEqual(call.args, ['run', 'view', '-R', 'github.com/someone/demo', '--job', '200', '--log-failed'], 'one job, when its id is known');
  assert.equal(call.opts.timeout, 60_000);
  assert.equal(call.opts.maxBuffer, 64 << 20);
  assert.equal(call.opts.cwd, DATA);
  // Backticks in a log cannot close the fence.
  h.w.log = 'job\tstep\t```\nrm -rf /\n```';
  assert.doesNotMatch((await h.gh.failedLog({ slug: 'someone/demo', runId: 100 })).message.split('\n').slice(3, -3).join('\n'), /```/);
});

test('a log too large to read says so, without trying again', async () => {
  const h = harness({ world: { open: [pr({ statusCheckRollup: [check({ conclusion: 'FAILURE' })] })] } });
  await h.tick();
  const before = h.calls.length;
  h.w.hook = (args) => (args[1] === 'view' ? fail('ERR_CHILD_PROCESS_STDIO_MAXBUFFER', '') : null);
  assert.deepEqual(await h.gh.failedLog({ slug: 'someone/demo', runId: 100 }),
    { ok: false, error: 'That log is too large to fetch here. Open it on GitHub.', url: 'https://github.com/someone/demo/actions/runs/100/job/200' });
  assert.equal(h.calls.length, before + 1);
});

test("a job's log asked for too early falls back to the run's, and a run still going says so", async () => {
  const h = harness({ world: { open: [pr({ statusCheckRollup: [check({ conclusion: 'FAILURE' })] })] } });
  await h.tick();
  const before = h.calls.length;
  h.w.hook = (args) => (args[1] === 'view' ? fail(1, 'run 100 is still in progress; logs will be available when it is complete') : null);
  assert.deepEqual(await h.gh.failedLog({ slug: 'someone/demo', runId: 100 }),
    { ok: false, error: 'That run is still going. Its log is ready once it finishes.', url: 'https://github.com/someone/demo/actions/runs/100/job/200' });
  assert.deepEqual(h.calls.slice(before).map((c) => c.args), [
    ['run', 'view', '-R', 'github.com/someone/demo', '--job', '200', '--log-failed'],
    ['run', 'view', '100', '-R', 'github.com/someone/demo', '--log-failed'],
  ]);
  h.w.hook = (args) => (args[1] === 'view' ? fail(1, 'log not found: 100') : null);
  assert.match((await h.gh.failedLog({ slug: 'someone/demo', runId: 100 })).error, /no log for that run/);
  h.w.hook = null;
  h.w.log = '';
  assert.match((await h.gh.failedLog({ slug: 'someone/demo', runId: 100 })).error, /names no failed step/);
});

test('signed out: one repository is tried every five minutes, and refresh tries now, at most every ten seconds', async () => {
  const targets = [{ sessionId: 'A', common: checkout({ slug: 'o/a' }).common, branch: 'x', at: 2 }, { sessionId: 'B', common: checkout({ slug: 'o/b' }).common, branch: 'x', at: 1 }];
  const h = harness({ targets });
  h.w.hook = () => fail(4, 'To get started with GitHub CLI, please run:  gh auth login');
  await h.tick();
  assert.equal(h.gh.state().gh, 'signed-out');
  assert.equal(h.gh.state().hint, 'Run gh auth login in a terminal to see pull requests and CI here.');
  assert.deepEqual([...new Set(h.calls.map((c) => slugIn(c.args)))], ['o/a'], 'the other repository would only say the same');
  const count = () => h.calls.length;
  let n = count();
  h.advance(4 * MIN); await h.tick();
  assert.equal(count(), n, 'nothing until five minutes have passed');
  h.advance(MIN); await h.tick();
  assert.equal(h.polls(), 2, 'then one try');
  n = count();
  h.advance(SEC); await h.gh.refresh();
  assert.equal(h.polls(), 3, 'refresh tries at once');
  h.advance(5 * SEC); await h.gh.refresh();
  assert.equal(h.polls(), 3, 'but not twice in ten seconds');
  h.w.hook = null; // signed in now
  h.advance(5 * SEC); await h.gh.refresh();
  assert.equal(h.gh.state().gh, 'ok');
  assert.equal(h.gh.state().hint, null);
  assert.deepEqual(h.gh.state().repos.map((r) => [r.slug, r.checkedAt]), [['o/a', h.clock.t], ['o/b', h.clock.t]], 'and both are polled');
});

test('signed out, then gh answering with any other error, is no longer signed out', async () => {
  const targets = [{ sessionId: 'A', common: checkout({ slug: 'o/a' }).common, branch: 'x', at: 2 }, { sessionId: 'B', common: checkout({ slug: 'o/b' }).common, branch: 'x', at: 1 }];
  const h = harness({ targets });
  h.w.hook = () => fail(4, '');
  await h.tick();
  assert.equal(h.gh.state().gh, 'signed-out');
  h.w.hook = (args) => (slugIn(args) === 'o/a' ? fail(1, 'HTTP 404: Not Found') : null);
  h.advance(5 * MIN); await h.tick();
  const s = h.gh.state();
  assert.equal(s.gh, 'ok');
  assert.equal(s.repos[0].error.kind, 'not-found');
  assert.equal(s.repos[1].error, null, 'and the next repository is polled in the same beat');
  assert.ok(s.repos[1].checkedAt);
});

test('gh missing: nothing is asked, and the binary is looked for again every ten minutes', async () => {
  let looks = 0, where = null;
  const h = harness({ ghPath: () => { looks++; return where; } });
  await h.tick();
  assert.equal(h.gh.state().gh, 'missing');
  assert.equal(h.gh.state().hint, 'Install the GitHub CLI (gh) to see pull requests and CI here.');
  assert.equal(h.calls.length, 0);
  h.advance(9 * MIN); await h.tick();
  assert.equal(looks, 1);
  h.advance(MIN); await h.tick();
  assert.equal(looks, 2);
  assert.equal(h.calls.length, 0);
  // Found, but it is not really there: ENOENT from the spawn, with the folder present.
  where = '/opt/homebrew/bin/gh';
  h.w.hook = () => fail('ENOENT', '');
  h.advance(10 * MIN); await h.tick();
  assert.equal(looks, 3);
  assert.equal(h.gh.state().gh, 'missing');
  const n = h.calls.length;
  h.advance(5 * MIN); await h.tick();
  assert.equal(h.calls.length, n);
  h.w.hook = null;
  await h.gh.refresh();
  assert.equal(looks, 4, 'refresh looks again at once');
  assert.equal(h.gh.state().gh, 'ok');
  assert.equal(h.calls.at(-1).cmd, '/opt/homebrew/bin/gh');
});

test('a cwd that is gone is shown as an error on the repository, not as gh missing', async () => {
  const h = harness({ cwd: path.join(DATA, 'gone') });
  h.w.hook = () => fail('ENOENT', '');
  await h.tick();
  const s = h.gh.state();
  assert.equal(s.gh, 'unknown');
  assert.equal(s.repos[0].error.kind, 'no-cwd');
  assert.equal(s.hint, null);
});

test('an answer the watcher cannot read is an error on the repository, never a thrown tick', async () => {
  const h = harness({ world: { open: [null] } });
  await h.tick(); // resolves
  assert.equal(h.gh.state().repos[0].error.kind, 'error');
  assert.equal(h.logs.length, 1);
  h.w.hook = (args) => (kindOf(args) === 'pr open' ? { err: null, stdout: 'not json', stderr: '' } : null);
  h.advance(MIN); await h.tick();
  assert.equal(h.gh.state().repos[0].error.kind, 'error');
  const logged = [];
  const thrower = createGithub({ run: async () => ok([]), read: small, targets: () => { throw new Error('boom'); }, log: (m) => logged.push(m), cwd: DATA });
  await thrower.tick({ watched: true }); // resolves
  assert.deepEqual(logged, ['github: boom']);
});

test('state() is the same object until something changes, and onChange says when it does', async () => {
  const h = harness();
  const a = h.gh.state();
  assert.equal(h.gh.state(), a);
  await h.tick();
  assert.ok(h.changes() >= 1);
  const b = h.gh.state();
  assert.notEqual(b, a);
  assert.equal(h.gh.state(), b);
});

test('off makes no calls', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gh-off-')), 'github.json');
  let looks = 0;
  const h = harness({ off: true, file, ghPath: () => { looks++; return GH; } });
  await h.tick();
  await h.gh.refresh();
  h.advance(60 * MIN);
  await h.tick(false);
  assert.deepEqual(await h.gh.failedLog({ slug: 'someone/demo', runId: 100 }), { ok: false, error: 'That run is not one the panel is showing as failed.' });
  h.gh.stop();
  assert.equal(h.calls.length, 0);
  assert.equal(looks, 0);
  assert.equal(h.gh.forSession(h.repo.common, 'fix/login'), null);
  assert.equal(h.gh.knows('someone/demo', 100), false);
  assert.deepEqual(h.gh.state(), { gh: 'off', hint: null, more: 0, repos: [] });
  assert.equal(fs.existsSync(file), false);
});

test('after stop nothing more is polled', async () => {
  const h = harness();
  await h.tick();
  h.gh.stop();
  h.advance(10 * MIN);
  await h.tick();
  await h.gh.refresh();
  assert.equal(h.polls(), 1);
});

test('stop during a poll lets that poll finish but starts no other', async () => {
  const targets = [{ sessionId: 'A', common: checkout({ slug: 'o/a' }).common, branch: 'x', at: 2 }, { sessionId: 'B', common: checkout({ slug: 'o/b' }).common, branch: 'x', at: 1 }];
  const h = harness({ targets });
  const waiting = [];
  h.w.hook = (args) => (kindOf(args) === 'pr open' ? new Promise((resolve) => waiting.push(() => resolve(ok([])))) : null);
  const beat = h.tick();
  await new Promise((r) => setImmediate(r));
  h.gh.stop();
  waiting.forEach((go) => go());
  await beat;
  assert.deepEqual([...new Set(h.calls.map((c) => slugIn(c.args)))], ['o/a']);
});

test('a check whose link is not https keeps its failure but loses the link', () => {
  const r = rollup([
    { __typename: 'StatusContext', context: 'evil', state: 'FAILURE', targetUrl: 'javascript:alert(1)', startedAt: '2026-01-01T00:00:00Z' },
    { __typename: 'CheckRun', name: 'build', workflowName: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/n/actions/runs/1/job/2', completedAt: '2026-01-01T00:00:00Z' },
  ]);
  assert.equal(r.checks, 'failing');
  assert.equal(r.failing.find((f) => f.name === 'evil').url, null);
  assert.equal(r.failing.find((f) => f.name === 'build').url, 'https://github.com/o/n/actions/runs/1/job/2');
});
