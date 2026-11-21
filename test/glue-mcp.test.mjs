// glue-mcp: the tools a space's main agent has for its workers, as an MCP server on stdio. A fake `call` stands in for
// Glue's own server, and one test runs the real program against a stub HTTP server. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOLS, createServer, glueCall } from '../glue-mcp.mjs';

function mk(answers = {}) {
  const out = [], calls = [];
  const s = createServer({ write: (line) => out.push(JSON.parse(line)), call: async (verb, args) => { calls.push({ verb, args }); const a = answers[verb]; return typeof a === 'function' ? a(args) : a ?? null; } });
  const ask = async (m) => { await s.handle(JSON.stringify({ jsonrpc: '2.0', ...m })); return out.at(-1); };
  return { ask, out, calls };
}

test('it says hello with the brief Glue gives it, and lists five tools: none that ends, answers or configures anything', async () => {
  const k = mk({ hello: { ok: true, instructions: 'You are the main agent of the space "Checkout".' } });
  const init = await k.ask({ id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  assert.equal(init.id, 1);
  assert.equal(init.result.protocolVersion, '2025-11-25', 'it speaks the version it was asked in');
  assert.deepEqual(init.result.capabilities, { tools: {} });
  assert.equal(init.result.instructions, 'You are the main agent of the space "Checkout".');
  const list = await k.ask({ id: 2, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((t) => t.name), ['start_worker', 'list_workers', 'read_worker', 'tell_worker', 'interrupt_worker']);
  assert.deepEqual(list.result.tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name), ['list_workers', 'read_worker']);
  for (const t of list.result.tools) assert.equal(t.inputSchema.type, 'object', t.name);
  // What starting a worker takes: never a folder, a permission mode or a login.
  assert.deepEqual(Object.keys(TOOLS[0].inputSchema.properties), ['name', 'task', 'model']);
  for (const t of TOOLS) for (const k of Object.keys(t.inputSchema.properties)) assert.ok(['name', 'task', 'model', 'worker', 'turns', 'text'].includes(k), `${t.name} takes ${k}`);
  // With Glue not answering it still starts, and says so.
  const down = await mk().ask({ id: 1, method: 'initialize', params: {} });
  assert.match(down.result.instructions, /Glue did not answer just now/);
  assert.equal(down.result.protocolVersion, '2025-06-18');
});

test('a tool call goes to Glue by its verb, and what Glue says comes back as the tool\'s text', async () => {
  const k = mk({ start: (a) => ({ ok: true, text: `Started ${a.name} on ${a.model}.` }), tell: { ok: false, error: 'No such worker.' }, list: { ok: true } });
  const r = await k.ask({ id: 5, method: 'tools/call', params: { name: 'start_worker', arguments: { name: 'cart-api', task: 'Do it', model: 'sonnet' } } });
  assert.deepEqual(r, { jsonrpc: '2.0', id: 5, result: { content: [{ type: 'text', text: 'Started cart-api on sonnet.' }] } });
  assert.deepEqual(k.calls.at(-1), { verb: 'start', args: { name: 'cart-api', task: 'Do it', model: 'sonnet' } });
  const bad = await k.ask({ id: 6, method: 'tools/call', params: { name: 'tell_worker', arguments: { worker: 'zz', text: 'hi' } } });
  assert.deepEqual(bad.result, { content: [{ type: 'text', text: 'No such worker.' }], isError: true });
  assert.equal((await k.ask({ id: 7, method: 'tools/call', params: { name: 'list_workers' } })).result.content[0].text, 'Done.');
  // Glue not reachable: said as an error, nothing thrown.
  const down = await k.ask({ id: 8, method: 'tools/call', params: { name: 'read_worker', arguments: { worker: 'a' } } });
  assert.equal(down.result.isError, true);
  assert.match(down.result.content[0].text, /Glue did not answer, so nothing was done/);
  // A tool that is not one of ours never reaches Glue.
  const n = k.calls.length;
  const none = await k.ask({ id: 9, method: 'tools/call', params: { name: 'end_session', arguments: {} } });
  assert.equal(none.result.isError, true);
  assert.equal(k.calls.length, n);
});

test('what it does not know is refused in words, and a notification gets no answer', async () => {
  const k = mk();
  assert.deepEqual(await k.ask({ id: 1, method: 'server/discover' }), { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'Method not found' } });
  assert.deepEqual((await k.ask({ id: 2, method: 'ping' })).result, {});
  const n = k.out.length;
  await k.ask({ method: 'notifications/initialized' });
  await k.ask({ method: 'notifications/cancelled', params: {} });
  assert.equal(k.out.length, n, 'no id, no answer');
  // A line that is not JSON, or not a request, is passed over.
  const s = createServer({ write: () => assert.fail('nothing to say'), call: async () => null });
  await s.handle('not json');
  await s.handle('[]');
  await s.handle('{"jsonrpc":"2.0"}');
});

test('the real program: it sends each call to Glue on this computer with its own key', async () => {
  const seen = [];
  const glue = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; }).on('end', () => {
      seen.push({ url: req.url, key: req.headers['x-glue-agent'], origin: req.headers.origin ?? null, body: JSON.parse(raw || '{}') });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url === '/agent/hello' ? { ok: true, instructions: 'BRIEF' } : { ok: true, text: 'Two workers.' }));
    });
  });
  await new Promise((r) => glue.listen(0, '127.0.0.1', r));
  const port = glue.address().port;
  const p = spawn(process.execPath, [fileURLToPath(new URL('../glue-mcp.mjs', import.meta.url))], { env: { ...process.env, GLUE_PORT: String(port), GLUE_AGENT_KEY: 'k'.repeat(64) }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  let buf = '';
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const until = async (fn) => { for (let i = 0; i < 100; i++) { if (fn()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } }) + '\n');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'list_workers', arguments: {} } }) + '\n');
  assert.ok(await until(() => lines.length === 2), JSON.stringify(lines));
  assert.equal(lines[0].result.instructions, 'BRIEF');
  assert.equal(lines[1].result.content[0].text, 'Two workers.');
  assert.deepEqual(seen.map((s) => [s.url, s.key, s.origin]), [['/agent/hello', 'k'.repeat(64), null], ['/agent/list', 'k'.repeat(64), null]], 'its key on every call, and no Origin');
  p.stdin.end();
  assert.ok(await new Promise((r) => { p.on('exit', (code) => r(code === 0)); }), 'it ends when its input does');
  await new Promise((r) => glue.close(r));
  // A port nothing listens on: the call comes back null, not thrown.
  assert.equal(await glueCall({ port: 1, key: 'x', timeout: 2000 })('list', {}), null);
});
