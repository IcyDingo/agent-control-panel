// The OpenCode module's pure parts: finding the service, the rules for each mode, messages as thread items, events as
// status, permissions and forms as cards, and the brief a handover starts from. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseService, findService, serviceFile, permissionRules, agentFor, modelRef, refText, pickable, itemsOf, lastSaidOf,
         modelOfMessages, requestOf, questionOf, formAnswer, statusOf, isLimit, briefOf, sseParser, createClient, OC_ID } from '../opencode.mjs';

test('the service file: a url or a host and port, a password, local addresses only', () => {
  assert.deepEqual(parseService('{"url":"http://127.0.0.1:4096","password":"pw"}'), { url: 'http://127.0.0.1:4096', password: 'pw', username: 'opencode' });
  assert.deepEqual(parseService('{"hostname":"localhost","port":5000,"token":"t"}'), { url: 'http://localhost:5000', password: 't', username: 'opencode' });
  assert.equal(parseService('{"url":"http://example.com:4096"}'), null);
  assert.equal(parseService('{"url":"https://127.0.0.1:4096"}'), null);
  assert.equal(parseService('{"port":"nope"}'), null);
  assert.equal(parseService('not json'), null);
});

test('findService reads the override, else OpenCode\'s own file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-home-'));
  assert.equal(findService({ home, env: {} }), null);
  const f = serviceFile({ home, env: {} });
  assert.equal(f, path.join(home, '.local', 'state', 'opencode', 'service.json'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ url: 'http://127.0.0.1:4100', password: 'x' }));
  assert.equal(findService({ home, env: {} }).url, 'http://127.0.0.1:4100');
  assert.equal(findService({ home, env: { ACP_OPENCODE_URL: 'http://127.0.0.1:9' } }).url, 'http://127.0.0.1:9');
});

test('modes: ask asks before edits, shell and the web; accept edits before shell; auto never; plan uses the plan agent', () => {
  const actions = (m) => permissionRules(m).map((r) => `${r.action}:${r.effect}`);
  assert.deepEqual(actions('default'), ['edit:ask', 'shell:ask', 'webfetch:ask']);
  assert.deepEqual(actions(''), ['edit:ask', 'shell:ask', 'webfetch:ask']);
  assert.deepEqual(actions('plan'), ['edit:ask', 'shell:ask', 'webfetch:ask']);
  assert.deepEqual(actions('acceptEdits'), ['shell:ask']);
  assert.deepEqual(actions('auto'), []);
  assert.equal(agentFor('plan'), 'plan');
  assert.equal(agentFor('default'), 'build');
});

test('model names go both ways', () => {
  assert.deepEqual(modelRef('anthropic/claude-sonnet-5-5'), { providerID: 'anthropic', id: 'claude-sonnet-5-5' });
  assert.deepEqual(modelRef('openai/gpt-6#high'), { providerID: 'openai', id: 'gpt-6', variant: 'high' });
  assert.equal(modelRef('no-slash'), null);
  assert.equal(modelRef('a/b; rm -rf'), null);
  assert.equal(refText({ providerID: 'openai', id: 'gpt-6', variant: 'high' }), 'openai/gpt-6#high');
  const list = pickable([
    { providerID: 'z', id: 'm1', name: 'Zed', type: 'chat', capabilities: { tools: true } },
    { providerID: 'a', id: 'img', type: 'image', capabilities: { tools: false } },
    { providerID: 'a', id: 'm2', name: 'Alpha', capabilities: { tools: true } },
  ]);
  assert.deepEqual(list.map((m) => m.ref), ['a/m2', 'z/m1']);
});

const MESSAGES = [
  { id: 'msg_1', type: 'user', text: 'Fix the bug', time: { created: 1000 } },
  { id: 'msg_2', type: 'assistant', time: { created: 2000 }, model: { providerID: 'openai', id: 'gpt-6' }, content: [
    { type: 'reasoning', text: 'hmm' },
    { type: 'text', text: 'Looking.' },
    { type: 'tool', id: 'call_1', name: 'bash', state: { status: 'completed', input: { command: 'ls' }, content: [{ type: 'text', text: 'a\nb' }] }, time: { created: 2100, completed: 2200 } },
    { type: 'tool', id: 'call_2', name: 'edit', state: { status: 'error', input: { filePath: '/x' }, error: { type: 'x', message: 'denied' } }, time: { created: 2300 } },
    { type: 'tool', id: 'call_3', name: 'read', state: { status: 'running', input: { filePath: '/y' }, metadata: {} }, time: { created: 2400 } },
  ] },
  { id: 'msg_3', type: 'synthetic', text: 'brief', time: { created: 500 } },
  { id: 'msg_4', type: 'idle', outcome: 'failed', error: { type: 'ProviderRequestError', message: 'Rate limited' }, time: { created: 3000 } },
  { id: 'msg_5', type: 'assistant', time: { created: 4000 }, content: [{ type: 'text', text: 'Done now.' }] },
];

test('messages become the thread items a transcript would', () => {
  const items = itemsOf(MESSAGES);
  assert.deepEqual(items.map((m) => m.who), ['note', 'you', 'claude', 'tool', 'result', 'tool', 'result', 'tool', 'note', 'claude']);
  const [note, you, said, bash, out, edit, fail, read] = items;
  assert.equal(note.text, 'Glue handed it what came before.');
  assert.equal(you.text, 'Fix the bug');
  assert.equal(said.text, 'Looking.');
  assert.deepEqual([bash.key, bash.name, bash.summary.text], ['tool:call_1', 'bash', 'ls']);
  assert.deepEqual([out.toolUseId, out.ok, out.preview], ['call_1', true, 'a\nb']);
  assert.equal(edit.summary.text, '/x');
  assert.deepEqual([fail.ok, fail.preview], [false, 'denied']);
  assert.equal(read.state, 'running');
  assert.match(items[8].text, /Rate limited/);
  // Ordered by position, which follows the messages' time.
  for (let i = 1; i < items.length; i++) assert.ok(items[i].pos > items[i - 1].pos);
  assert.equal(lastSaidOf(MESSAGES), 'Done now.');
  assert.equal(modelOfMessages(MESSAGES), 'openai/gpt-6');
});

test('a permission request reads as a card', () => {
  const r = requestOf({ id: 'per_1', sessionID: 'ses_abc123', action: 'shell', resources: ['npm test'], save: ['npm *'], message: 'Run the tests' });
  assert.equal(r.id, 'oc:ses_abc123:per_1');
  assert.equal(r.toolName, 'Shell');
  assert.deepEqual(r.toolInput, { command: 'npm test', description: 'Run the tests' });
  assert.equal(r.suggestions.length, 1);
  const e = requestOf({ id: 'per_2', sessionID: 'ses_abc123', action: 'edit', resources: ['/a.js'] });
  assert.deepEqual([e.toolName, e.toolInput.file_path, e.suggestions.length], ['Edit', '/a.js', 0]);
  assert.deepEqual(requestOf({ id: 'p', sessionID: 'ses_abc123', action: 'external_directory', resources: ['/etc'] }).toolInput, { resources: ['/etc'] });
});

test('a form reads as a question card, and its answers go back by key', () => {
  const form = { id: 'frm_1', sessionID: 'ses_abc123', title: 'Setup', fields: [
    { key: 'db', type: 'string', title: 'Which database?', options: [{ value: 'pg', label: 'Postgres' }, { value: 'my', label: 'MySQL' }], required: true },
    { key: 'ok', type: 'boolean', title: 'Seed it?' },
    { key: 'n', type: 'integer', title: 'How many?' },
    { key: 'tags', type: 'multiselect', title: 'Tags', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { key: 'secret', type: 'string', hidden: true },
  ] };
  const q = questionOf(form);
  assert.equal(q.toolName, 'AskUserQuestion');
  assert.equal(q.answerable, true);
  assert.deepEqual(q.toolInput.questions.map((x) => x.question), ['Which database?', 'Seed it?', 'How many?', 'Tags']);
  assert.deepEqual(q.toolInput.questions[0].options.map((o) => o.label), ['Postgres', 'MySQL']);
  assert.equal(q.toolInput.questions[3].multiSelect, true);
  assert.deepEqual(formAnswer(form, { 'Which database?': 'Postgres', 'Seed it?': 'Yes', 'How many?': '3', Tags: 'A, B' }).answer,
    { db: 'pg', ok: true, n: 3, tags: ['a', 'b'] });
  assert.deepEqual(formAnswer(form, { 'Which database?': 'SQLite' }).answer, { db: 'SQLite' });
  assert.match(formAnswer(form, {}).error, /every question/);
  assert.match(formAnswer(form, { 'Which database?': 'pg', 'How many?': '2.5' }).error, /number/);
  assert.equal(questionOf({ id: 'f', sessionID: 'ses_abc123', fields: [{ key: 'x', type: 'external' }] }).answerable, false);
});

test('events say how a session is doing', () => {
  assert.deepEqual(statusOf({ type: 'session.status', data: { sessionID: 'ses_a1b2c3', status: { type: 'busy' } } }), { sessionID: 'ses_a1b2c3', status: 'busy', note: null });
  assert.equal(statusOf({ type: 'session.status', data: { sessionID: 'ses_a1b2c3', status: { type: 'idle' } } }).refresh, true);
  assert.match(statusOf({ type: 'session.status', data: { sessionID: 'ses_a1b2c3', status: { type: 'retry', attempt: 2, message: 'overloaded', next: 1 } } }).note, /Trying again \(2\): overloaded/);
  const f = statusOf({ type: 'session.execution.failed', data: { sessionID: 'ses_a1b2c3', error: { type: 'x', message: 'boom', status: 429 } } });
  assert.equal(f.status, 'idle');
  assert.match(f.note, /boom/);
  assert.equal(isLimit(f.error), true);
  assert.equal(isLimit({ message: 'bad request', status: 400 }), false);
  assert.equal(statusOf({ type: 'permission.asked', data: { id: 'per_1', sessionID: 'ses_a1b2c3', action: 'edit', resources: [] } }).asks, true);
  assert.equal(statusOf({ type: 'form.created', data: { form: { id: 'frm_1', sessionID: 'ses_a1b2c3' } } }).sessionID, 'ses_a1b2c3');
  assert.equal(statusOf({ type: 'session.text.delta', data: {} }), null);
  assert.ok(OC_ID.test('ses_01JABCDEF'));
  assert.ok(!OC_ID.test('11111111-2222-4333-8444-555555555555'));
});

test('the brief: the task, the talk (newest kept), the files, and CLAUDE.md when there is no AGENTS.md', () => {
  const items = [{ who: 'you', text: 'Add login' }, { who: 'claude', text: 'On it.' }, { who: 'tool', name: 'Edit', summary: { tool: 'Edit', text: '/app.js' } }];
  const b = briefOf({ prompt: 'Add login', items, status: ' M app.js', diffStat: ' app.js | 4 ++--', claudeMd: true, agentsMd: false, limit: { resetsAt: Date.UTC(2026, 10, 14, 15) } });
  assert.match(b, /## The task it was given\nAdd login/);
  assert.match(b, /User: Add login\nClaude: On it\.\n {2}\(tool\) Edit: \/app\.js/);
  assert.match(b, /git status --short:\n M app\.js/);
  assert.match(b, /CLAUDE\.md/);
  assert.match(b, /usage limit \(it resets 2026-11-14T15:00:00\.000Z\)/);
  assert.doesNotMatch(briefOf({ items, claudeMd: true, agentsMd: true }), /CLAUDE\.md/);
  const long = briefOf({ items: Array.from({ length: 500 }, (_, i) => ({ who: 'you', text: `message ${i} ${'x'.repeat(100)}` })), max: 2000 });
  assert.match(long, /earlier conversation left out/);
  assert.match(long, /message 499/);
  assert.doesNotMatch(long, /message 0 /);
});

test('the event stream parser joins data lines and splits events', () => {
  const got = [];
  const p = sseParser((d) => got.push(d));
  p('data: {"a":1}\n\nda');
  p('ta: {"b":\ndata: 2}\n\n: ping\n\n');
  assert.deepEqual(got, ['{"a":1}', '{"b":\n2}']);
});

test('the client sends its password, unwraps data, and says what went wrong', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
      if (req.url.startsWith('/api/session/ses_bad1')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"message":"no such session"}'); }
      if (req.url === '/api/session') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"data":{"id":"ses_new123"}}'); }
      res.writeHead(204); res.end();
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const c = createClient({ service: () => ({ url, password: 'pw', username: 'opencode' }) });
    const s = await c.createSession({ directory: '/repo', agent: 'build', permissions: permissionRules('default') });
    assert.equal(s.id, 'ses_new123');
    assert.equal(seen[0].auth, 'Basic ' + Buffer.from('opencode:pw').toString('base64'));
    assert.deepEqual(JSON.parse(seen[0].body).location, { directory: '/repo' });
    await c.replyPermission('ses_abc123', 'per_1', 'once');
    assert.equal(seen[1].url, '/api/session/ses_abc123/permission/per_1/reply');
    await assert.rejects(c.messages('ses_bad1'), /no such session/);
    await assert.rejects(c.prompt('../etc', 'x'), /not an OpenCode session/);
    await assert.rejects(createClient({ service: () => null }).info(), /not running/);
  } finally { srv.close(); }
});
