// OpenCode sessions on the board, against a stand-in OpenCode service: start one, see it work, answer its permission
// request, see it finish, reply, end it, take it off. Then a Claude session stuck at its usage limit, carried on in
// OpenCode when asked. Run with `npm test`. Starts the server on a spare port under a throwaway home, with a stand-in
// `claude` whose roster the test controls and a stand-in OpenCode service whose state the test controls.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
// A port the system says is free: fixed ranges collided when test files ran side by side (EADDRINUSE).
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => r(port)); }); });

const SERVER = fileURLToPath(new URL('../server.mjs', import.meta.url));
const PORT = await freePort();
const BASE = `http://127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-oc-'));
const proj = path.join(home, 'proj');
fs.mkdirSync(proj);
fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# rules\n');
fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{}');

// A Claude session that stopped at its 5-hour limit: its prompt, a reply, and the limit line Claude Code writes.
const SID = '22222222-3333-4444-8555-666666666666';
const resetsAt = Math.floor(Date.now() / 1000) + 3600;
fs.writeFileSync(path.join(home, '.claude', 'projects', 'p', `${SID}.jsonl`), [
  { parentUuid: null, type: 'user', cwd: proj, timestamp: '2026-11-14T10:00:00.000Z', message: { role: 'user', content: 'Build the export button' } },
  { parentUuid: 'a', type: 'assistant', cwd: proj, timestamp: '2026-11-14T10:00:01.000Z', message: { role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Started on it.' }] } },
  { parentUuid: 'b', type: 'assistant', cwd: proj, timestamp: '2026-11-14T10:00:02.000Z', error: 'rate_limit', apiErrorStatus: 429, isApiErrorMessage: true,
    apiErrorParams: { rate_limit_info: { resetsAt, rateLimitType: 'five_hour' } },
    message: { role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 3pm" }] } },
].map((d) => JSON.stringify(d)).join('\n') + '\n');
const bin = path.join(home, 'bin');
fs.mkdirSync(bin);
const roster = path.join(home, 'roster.json');
fs.writeFileSync(roster, JSON.stringify([{ pid: null, id: 'ab12cd34', cwd: proj, kind: 'background', startedAt: 1, sessionId: SID, name: 'export', status: 'idle', state: 'done' }]));
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh
case "$1" in
  agents) cat "${roster}";;
  auth) echo "{}";;
  *) exit 1;;
esac
`, { mode: 0o755 });

// ---- the stand-in OpenCode service
const oc = { sessions: new Map(), messages: new Map(), active: new Set(), perms: [], creds: [], code: null, refuse: null, calls: [], streams: new Set(), n: 0 };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
const emit = (type, data) => { for (const r of oc.streams) r.write(`data: ${JSON.stringify({ id: 'evt_' + (++oc.n), created: Date.now(), type, data })}\n\n`); };
const svc = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const u = new URL(req.url, 'http://x'), p = u.pathname, body = raw ? JSON.parse(raw) : null;
    oc.calls.push({ method: req.method, path: p, body });
    let m;
    if (p === '/api/event') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ id: 'evt_0', type: 'server.connected', data: {} })}\n\n`);
      oc.streams.add(res);
      res.on('close', () => oc.streams.delete(res));
      return;
    }
    if (p === '/api/info') return json(res, 200, { version: '2.0.0', pid: 1, urls: [], paths: { tmp: '/tmp' } });
    if (p === '/api/model') return json(res, 200, { location: { directory: '/' }, data: [{ providerID: 'fake', id: 'm1', name: 'Fake One', type: 'chat', capabilities: { tools: true, input: [], output: [] } }] });
    if (p === '/api/model/default') return json(res, 200, { location: { directory: '/' }, data: { providerID: 'fake', id: 'm1' } });
    if (p === '/api/session/active') return json(res, 200, { data: Object.fromEntries([...oc.active].map((id) => [id, { type: 'running' }])) });
    if (p === '/api/permission/request') return json(res, 200, { location: { directory: '/' }, data: oc.perms });
    if (p === '/api/form') return json(res, 200, { location: { directory: '/' }, data: [] });
    if (p === '/api/session' && req.method === 'POST') {
      const id = `ses_test${oc.sessions.size + 1}`;
      oc.sessions.set(id, body);
      oc.messages.set(id, []);
      return json(res, 200, { data: { id, model: body.model ?? { providerID: 'fake', id: 'm1' } } });
    }
    if ((m = p.match(/^\/api\/session\/(ses_\w+)\/(prompt|synthetic)$/))) {
      oc.messages.get(m[1]).push({ id: 'msg_' + (++oc.n), type: m[2] === 'prompt' ? 'user' : 'synthetic', text: body.text, time: { created: Date.now() } });
      if (m[2] === 'prompt' && oc.refuse) {
        // The provider refuses the call: the turn ends at once, with no text, as OpenCode reports it.
        const error = { type: 'ProviderRequestError', message: oc.refuse, status: 402 }, sid = m[1];
        setTimeout(() => {
          oc.messages.get(sid).push({ id: 'msg_' + (++oc.n), type: 'assistant', time: { created: Date.now() }, content: [], finish: 'error', error },
                                    { id: 'msg_' + (++oc.n), type: 'idle', outcome: 'failed', error, time: { created: Date.now() + 1 } });
          emit('session.execution.failed', { sessionID: sid, error });
          emit('session.status', { sessionID: sid, status: { type: 'idle' } });
        }, 100);
      } else if (m[2] === 'prompt') oc.active.add(m[1]);
      return json(res, 200, { data: { id: 'msg_x', sessionID: m[1], type: 'user' } });
    }
    if ((m = p.match(/^\/api\/session\/(ses_\w+)\/message$/))) {
      // As OpenCode 2.3 does: a limit over 200, or an order but asc or desc, is refused; desc gives the newest first.
      const limit = u.searchParams.get('limit'), order = u.searchParams.get('order') ?? 'desc';
      if (limit != null && !(Number(limit) >= 1 && Number(limit) <= 200)) return json(res, 400, { _tag: 'InvalidRequestError', message: 'Expected a value less than or equal to 200\n  at ["limit"]', kind: 'Query' });
      if (!['asc', 'desc'].includes(order)) return json(res, 400, { _tag: 'InvalidRequestError', message: 'Expected "asc" | "desc"\n  at ["order"]', kind: 'Query' });
      const all = oc.messages.get(m[1]) ?? [], sorted = order === 'asc' ? all : [...all].reverse();
      return json(res, 200, { data: sorted.slice(0, Number(limit ?? 50)), cursor: {} });
    }
    if (p === '/api/integration') return json(res, 200, { location: { directory: '/' }, data: [
      { id: 'openai', name: 'OpenAI', methods: [{ type: 'key', label: 'API key' }, { type: 'oauth', id: 'chatgpt', label: 'ChatGPT' }] }] });
    if (p === '/api/credential') return json(res, 200, { data: oc.creds });
    if (p === '/api/integration/openai/connect/key') { oc.creds.push({ id: 'cred_k', integrationID: 'openai', label: 'key', active: true, value: { type: 'key', key: body.key } }); return json(res, 204); }
    if (p === '/api/integration/openai/connect/oauth') return json(res, 200, { location: { directory: '/' }, data: { attemptID: 'att_1', url: 'https://auth.example/start', instructions: 'Sign in, then paste the code.', mode: 'code', time: { created: 1, expires: 2 } } });
    if (p === '/api/integration/openai/connect/oauth/att_1/complete') { oc.creds.push({ id: 'cred_o', integrationID: 'openai', label: 'chatgpt', active: false, value: { type: 'oauth', access: 'A', refresh: 'R', methodID: 'chatgpt', expires: 1 } }); oc.code = body.code; return json(res, 204); }
    if ((m = p.match(/^\/api\/credential\/(cred_\w+)$/)) && req.method === 'DELETE') { oc.creds = oc.creds.filter((c) => c.id !== m[1]); return json(res, 204); }
    if ((m = p.match(/^\/api\/session\/(ses_\w+)\/generate$/))) {
      return json(res, 200, { data: { text: JSON.stringify({ reply: 'Two sessions: export is at its limit.', actions: [], look: [] }), tokens: {}, cost: 0 } });
    }
    if ((m = p.match(/^\/api\/session\/(ses_\w+)\/permission\/(per_\w+)\/reply$/))) {
      oc.perms = oc.perms.filter((x) => x.id !== m[2]);
      return json(res, 204);
    }
    if ((m = p.match(/^\/api\/session\/(ses_\w+)\/interrupt$/))) { oc.active.delete(m[1]); return json(res, 200, { interrupted: true }); }
    if ((m = p.match(/^\/api\/session\/(ses_\w+)(\/agent)?$/))) return json(res, 204);
    json(res, 404, { message: 'not here' });
  });
});
await new Promise((r) => svc.listen(0, '127.0.0.1', r));
const OC_URL = `http://127.0.0.1:${svc.address().port}`;

// ---- the server
const prefs = path.join(home, 'panel', 'prefs.json');
fs.mkdirSync(path.dirname(prefs));
fs.writeFileSync(prefs, JSON.stringify({ profile: 'default' }));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE')));
const server = spawn(process.execPath, [SERVER], { env: { ...env, HOME: home, PATH: `${bin}:${env.PATH}`, ACP_PORT: String(PORT), ACP_PREFS: prefs, ACP_GITHUB: 'off',
                                                          ACP_OPENCODE_URL: OC_URL }, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server did not start: ' + log)), 10_000);
  server.stdout.on('data', () => { if (log.includes(BASE)) { clearTimeout(t); resolve(); } });
  server.on('exit', () => reject(new Error('server exited: ' + log)));
});
const token = (await (await fetch(BASE + '/')).text()).match(/[0-9a-f]{48}/)[0];
const api = (p, body) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE, 'x-acp-token': token }, body: JSON.stringify(body) }).then((r) => r.json());
const snapshot = async () => {
  const c = new AbortController();
  const r = await fetch(`${BASE}/events?t=${token}`, { signal: c.signal });
  const reader = r.body.getReader();
  let buf = '';
  for (;;) { const { value } = await reader.read(); buf += Buffer.from(value).toString(); const m = buf.match(/^data: (.*)$/m); if (m) { c.abort(); return JSON.parse(m[1]); } }
};
/** The snapshot once `ok(snapshot)` holds, looked for a few seconds. */
async function until(ok, what) {
  let snap;
  for (let i = 0; i < 40; i++) { snap = await snapshot(); if (ok(snap)) return snap; await new Promise((r) => setTimeout(r, 250)); }
  assert.fail(`${what}: ${JSON.stringify(snap?.sessions?.map((s) => [s.sessionId, s.status, s.state]))} streams=${oc.streams.size} calls=${[...new Set(oc.calls.map((c) => c.path))].join(",")}\n${log}`);
}
after(async () => {
  for (const r of oc.streams) r.destroy();
  svc.close();
  if (server.exitCode === null && server.signalCode === null) await new Promise((r) => { server.once('exit', r); server.kill(); });
  fs.rmSync(home, { recursive: true, force: true });
});

test('OpenCode: Settings and the launcher see the service and its models', async () => {
  const r = await api('/api/opencode', {});
  assert.equal(r.ok, true);
  assert.equal(r.running, true);
  assert.equal(r.version, '2.0.0');
  assert.deepEqual(r.models.map((x) => x.ref), ['fake/m1']);
  assert.equal(r.defaultModel, 'fake/m1');
});

let OCID = null;
test('OpenCode: a session starts, asks, is answered, finishes, takes a reply, ends and goes', async () => {
  const r = await api('/api/launch', { prompt: 'Add a footer', cwd: proj, agentKind: 'opencode', model: 'fake/m1', mode: 'default', name: 'footer' });
  assert.equal(r.ok, true, JSON.stringify(r));
  OCID = r.sessionId;
  assert.match(OCID, /^ses_test/);
  const made = oc.sessions.get(OCID);
  assert.deepEqual(made.location, { directory: proj });
  assert.equal(made.agent, 'build');
  assert.deepEqual(made.model, { providerID: 'fake', id: 'm1' });
  assert.deepEqual(made.permissions.map((x) => x.action), ['edit', 'shell', 'webfetch']);
  assert.equal(oc.messages.get(OCID)[0].text, 'Add a footer');
  const kept = JSON.parse(fs.readFileSync(path.join(home, 'panel', 'opencode-sessions.json'), 'utf8')).sessions[OCID];
  assert.equal(kept.name, 'footer');

  let s = (await until((x) => x.sessions.some((y) => y.sessionId === OCID && y.status === 'busy'), 'it shows as working')).sessions.find((y) => y.sessionId === OCID);
  assert.equal(s.agent, 'opencode');
  assert.equal(s.kind, 'opencode');
  assert.equal(s.termable, false);

  // It asks to run a command.
  oc.perms.push({ id: 'per_1', sessionID: OCID, action: 'shell', resources: ['npm test'], save: ['npm *'] });
  emit('permission.asked', oc.perms[0]);
  const snap = await until((x) => x.pending.some((p) => p.sessionId === OCID), 'its request shows as a card');
  const card = snap.pending.find((p) => p.sessionId === OCID);
  assert.equal(card.id, `oc:${OCID}:per_1`);
  assert.equal(card.toolName, 'Shell');
  assert.equal(card.toolInput.command, 'npm test');
  assert.equal(snap.sessions.find((y) => y.sessionId === OCID).status, 'waiting');
  const refused = await api('/api/decide', { id: card.id, behavior: 'allow', updatedInput: { command: 'rm -rf /' } });
  assert.equal(refused.ok, false, 'an edited command is never sent');
  const ok = await api('/api/decide', { id: card.id, behavior: 'allow', always: true });
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.deepEqual(oc.calls.findLast((c) => c.path.endsWith('/reply')).body, { decision: 'always' });

  // While it works: the tool it runs shows by name (the event names none), and its Chat fills from its messages.
  oc.messages.get(OCID).push({ id: 'msg_work', type: 'assistant', time: { created: Date.now() }, model: { providerID: 'fake', id: 'm1' },
    content: [{ type: 'tool', id: 'call_0', name: 'shell', state: { status: 'running', input: { command: 'npm run build' }, metadata: {} }, time: { created: Date.now() } }] });
  emit('session.tool.called', { sessionID: OCID, assistantMessageID: 'msg_work', id: 'call_0', input: { command: 'npm run build' }, executed: false });
  s = (await until((x) => x.sessions.find((y) => y.sessionId === OCID)?.lastTool?.tool === 'shell', 'the tool it runs, by name')).sessions.find((y) => y.sessionId === OCID);
  assert.equal(s.lastTool.text, 'npm run build');
  const mid = await api('/api/history', { sessionId: OCID });
  assert.equal(mid.ok, true, JSON.stringify(mid));
  assert.ok(mid.items.some((m) => m.who === 'tool' && m.name === 'shell' && m.state === 'running'), 'its Chat shows the call in progress');
  const reads = oc.calls.filter((c) => c.path === `/api/session/${OCID}/message`);
  assert.ok(reads.length > 0);

  // It finishes its turn.
  oc.messages.get(OCID).push({ id: 'msg_done', type: 'assistant', time: { created: Date.now() }, model: { providerID: 'fake', id: 'm1' },
    content: [{ type: 'tool', id: 'call_1', name: 'bash', state: { status: 'completed', input: { command: 'npm test' }, content: [{ type: 'text', text: 'ok' }] }, time: { created: Date.now() } },
              { type: 'text', text: 'The footer is in.' }] });
  oc.active.delete(OCID);
  emit('session.status', { sessionID: OCID, status: { type: 'idle' } });
  s = (await until((x) => x.sessions.some((y) => y.sessionId === OCID && y.status === 'idle' && y.lastMessage), 'it shows as idle with what it said')).sessions.find((y) => y.sessionId === OCID);
  assert.equal(s.lastMessage, 'The footer is in.');
  assert.equal(s.model, 'fake/m1');

  const h = await api('/api/history', { sessionId: OCID });
  assert.equal(h.ok, true);
  assert.deepEqual(h.items.map((m) => m.who), ['you', 'tool', 'tool', 'result', 'claude']);

  const rep = await api('/api/reply', { sessionId: OCID, text: 'Now the header' });
  assert.equal(rep.ok, true, JSON.stringify(rep));
  assert.deepEqual(oc.calls.findLast((c) => c.path.endsWith('/prompt')).body, { text: 'Now the header', delivery: 'queue' });
  assert.equal((await api('/api/reply', { sessionId: OCID, text: '/compact' })).ok, false, 'no slash commands');

  const mode = await api('/api/mode', { sessionId: OCID, mode: 'auto' });
  assert.equal(mode.ok, true, JSON.stringify(mode));
  assert.deepEqual(oc.calls.findLast((c) => c.method === 'PATCH').body, { permissions: [] });

  assert.equal((await api('/api/end', { sessionId: OCID })).ok, true);
  assert.ok(oc.calls.some((c) => c.path.endsWith('/interrupt')), 'its turn is stopped');
  s = (await snapshot()).sessions.find((y) => y.sessionId === OCID);
  assert.equal(s.state, 'stopped');
  assert.equal((await api('/api/remove', { sessionId: OCID })).ok, true);
  assert.ok(!(await snapshot()).sessions.some((y) => y.sessionId === OCID));
  const left = JSON.parse(fs.readFileSync(path.join(home, 'panel', 'opencode-sessions.json'), 'utf8')).sessions;
  assert.ok(!left[OCID], 'it is forgotten');
});

test('a Claude session at its usage limit says so, and carries on in OpenCode when asked', async () => {
  const snap = await until((x) => x.sessions.some((y) => y.sessionId === SID && y.limit), 'the limit shows');
  const s = snap.sessions.find((y) => y.sessionId === SID);
  assert.equal(s.limit.type, 'five_hour');
  assert.equal(s.limit.resetsAt, resetsAt * 1000);
  assert.match(s.limit.text, /5-hour limit/);

  const r = await api('/api/opencode/continue', { sessionId: SID, model: 'fake/m1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const msgs = oc.messages.get(r.sessionId);
  assert.equal(msgs[0].type, 'synthetic');
  assert.match(msgs[0].text, /Build the export button/);
  assert.match(msgs[0].text, /Claude: Started on it\./);
  assert.match(msgs[0].text, /usage limit/);
  assert.match(msgs[0].text, /CLAUDE\.md/);
  assert.match(msgs[1].text, /^Continue the task/);
  assert.deepEqual(oc.sessions.get(r.sessionId).location, { directory: proj });

  const after = await until((x) => x.sessions.find((y) => y.sessionId === SID)?.continuedAs?.id === r.sessionId, 'the Claude record says where it went');
  const carried = after.sessions.find((y) => y.sessionId === r.sessionId);
  assert.equal(carried.continuedFrom, SID);
  assert.equal(carried.agent, 'opencode');
});

test('the overseer offers OpenCode\'s models and answers through OpenCode on one, kept off the board', async () => {
  const snap = await until((x) => x.overseer?.models?.includes('opencode:fake/m1'), 'the overseer lists OpenCode models');
  assert.ok(snap.overseer.models.includes('sonnet'));
  assert.equal((await api('/api/overseer/model', { model: 'opencode:fake/m1' })).ok, true);
  assert.equal((await api('/api/overseer/model', { model: 'opencode:bad' })).ok, false);
  const before = oc.sessions.size;
  assert.equal((await api('/api/overseer/say', { text: 'What is going on?' })).ok, true);
  let turns;
  for (let i = 0; i < 40; i++) { turns = (await api('/api/overseer/turns', {})).turns; if (turns?.at(-1)?.who === 'overseer') break; await new Promise((r) => setTimeout(r, 250)); }
  const last = turns.at(-1);
  assert.equal(last.text, 'Two sessions: export is at its limit.', JSON.stringify(last));
  assert.equal(last.model, 'opencode:fake/m1');
  const made = [...oc.sessions].slice(before).map(([, b]) => b);
  assert.equal(made.length, 1, 'one session of its own');
  assert.ok(made[0].permissions.every((r) => r.effect === 'deny'));
  assert.match(oc.calls.findLast((c) => c.path.endsWith('/generate')).body.prompt, /JSON Schema[\s\S]*<you>What is going on\?<\/you>/);
  const own = [...oc.sessions.keys()].at(-1);
  assert.ok(!(await snapshot()).sessions.some((s) => s.sessionId === own), 'its session is not on the board');
});

test('a turn the provider refuses (out of credit) shows its error as what it said, and needs you until you reply', async () => {
  const BROKE = 'Account.InsufficientFunds - Insufficient balance. Top up at https://opencode.ai/console/billing';
  oc.refuse = BROKE;
  const r = await api('/api/launch', { prompt: 'None of the shortcuts really seem to work?????', cwd: proj, agentKind: 'opencode', mode: 'default' });
  assert.equal(r.ok, true, JSON.stringify(r));
  const snap = await until((x) => x.sessions.some((s) => s.sessionId === r.sessionId && s.waitingFor === 'provider error'), 'it needs you, with the error');
  const s = snap.sessions.find((y) => y.sessionId === r.sessionId);
  assert.equal(s.status, 'waiting');
  assert.equal(s.ocError.message, BROKE);
  assert.equal(s.lastMessage, `OpenCode stopped with an error: ${BROKE}`);
  assert.ok(!snap.pending.some((p) => p.sessionId === r.sessionId), 'not a card: there is nothing to allow');
  // It stays that way through the poll that follows (the service says it is idle, its messages say how the turn ended).
  await new Promise((ok) => setTimeout(ok, 3500));
  assert.equal((await snapshot()).sessions.find((y) => y.sessionId === r.sessionId).waitingFor, 'provider error');
  const h = await api('/api/history', { sessionId: r.sessionId });
  assert.deepEqual(h.items.map((m) => m.who), ['you', 'note']);
  assert.equal(h.items[1].text, `It stopped: ${BROKE}`);
  // A reply starts a new turn: the error is behind it.
  oc.refuse = null;
  assert.equal((await api('/api/reply', { sessionId: r.sessionId, text: 'Try again on another model' })).ok, true);
  const after = (await snapshot()).sessions.find((y) => y.sessionId === r.sessionId);
  assert.equal(after.status, 'busy');
  assert.equal(after.ocError, null);
  await api('/api/end', { sessionId: r.sessionId });
  await api('/api/remove', { sessionId: r.sessionId });
});

test('providers connect from Glue: a key goes through, a browser sign-in finishes with its code, an account comes off', async () => {
  let r = await api('/api/opencode/providers', {});
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.providers.map((p) => [p.id, p.methods.map((m) => m.type), p.accounts.length]), [['openai', ['key', 'oauth'], 0]]);

  assert.equal((await api('/api/opencode/connect', { how: 'key', integrationID: 'openai', key: 'two words' })).ok, false, 'a key is one token');
  r = await api('/api/opencode/connect', { how: 'key', integrationID: 'openai', key: 'sk-test-123' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(oc.calls.findLast((c) => c.path.endsWith('/connect/key')).body, { key: 'sk-test-123' });

  r = await api('/api/opencode/connect', { how: 'oauth', integrationID: 'openai', methodID: 'chatgpt' });
  assert.deepEqual([r.ok, r.attemptID, r.url, r.code], [true, 'att_1', 'https://auth.example/start', true]);
  assert.equal((await api('/api/opencode/connect', { how: 'code', integrationID: 'openai', attemptID: 'att_1', code: 'abc-123' })).ok, true);
  assert.equal(oc.code, 'abc-123');

  r = await api('/api/opencode/providers', {});
  const accts = r.providers[0].accounts;
  assert.deepEqual(accts.map((a) => a.id), ['cred_k', 'cred_o']);
  assert.doesNotMatch(JSON.stringify(r), /sk-test-123/, 'a key never comes back');
  assert.equal((await api('/api/opencode/disconnect', { credentialID: 'cred_k' })).ok, true);
  assert.deepEqual((await api('/api/opencode/providers', {})).providers[0].accounts.map((a) => a.id), ['cred_o']);
  assert.equal((await api('/api/opencode/connect', { how: 'key', integrationID: '../x', key: 'k' })).ok, false);
});
