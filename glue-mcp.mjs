// The tools a space's main agent has for its workers: an MCP server on stdio that Claude Code starts for that one
// session (`--mcp-config`), passing each call on to Glue's own server on this computer. It holds one key, which is its
// space's: Glue decides from the key which space a call is about, so nothing a call says can reach another space,
// another workspace, or Glue's settings. It never ends a session, answers a permission or picks a permission mode.
//
// Newline-delimited JSON-RPC 2.0, Node standard library only. GLUE_PORT and GLUE_AGENT_KEY come from the config file
// Glue wrote for this main agent.

import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
/** What the main agent can do, as MCP tools. The verb is the route Glue serves it on. */
export const TOOLS = [
  { name: 'start_worker', verb: 'start',
    description: 'Start a worker: a separate Claude Code session that Glue runs in the background, in its own git worktree of this repository, listed under you in the owner\'s side panel. It knows nothing of your conversation, so the task must stand on its own. Glue decides its folder, branch and permissions. Returns its id and branch.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['name', 'task', 'model'], properties: {
      name: str('A short name for it, also its worktree and branch (worktree-<name>): letters, digits, dots, dashes and underscores, 40 at most. For example cart-api.', { maxLength: 40 }),
      task: str('The whole task, written to stand on its own: what to change, where, how to check it, and what to report back.', { maxLength: 20000 }),
      model: str('The model it runs on: the cheapest of the ones you are allowed that can do the task.') } } },
  { name: 'list_workers', verb: 'list', readOnly: true,
    description: 'List your workers: each with its id, name, model, state (working, idle, needs the owner, finished, failed), branch, pull request and the end of what it said last; and how many more you may start.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} } },
  { name: 'read_worker', verb: 'read', readOnly: true,
    description: 'Read the end of one worker\'s conversation: what it was told and said, each command it ran or file it touched in a line, and what failed.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['worker'], properties: {
      worker: str('Its id, as list_workers gives it.'), turns: { type: 'integer', minimum: 1, maximum: 20, description: 'How many of its last messages to read (8 when not given).' } } } },
  { name: 'tell_worker', verb: 'tell',
    description: 'Send one of your workers a message: an answer to its question, a correction, or what to do next. It reads it as its next instruction (after its current turn, when it is working).',
    inputSchema: { type: 'object', additionalProperties: false, required: ['worker', 'text'], properties: {
      worker: str('Its id, as list_workers gives it.'), text: str('The message, complete on its own. It must not start with / or !.', { maxLength: 4000 }) } } },
  { name: 'interrupt_worker', verb: 'interrupt',
    description: 'Stop one of your workers at its next tool call, as Esc would: for one that is on the wrong track. It stays open, and you can tell it what to do instead with tell_worker.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['worker'], properties: { worker: str('Its id, as list_workers gives it.') } } },
];

const NO_GLUE = 'Glue did not answer, so nothing was done. It may be restarting: try again in a moment, and if it stays this way, tell the owner.';

/**
 * The server, over any pair of line streams.
 * @param {object} deps
 * @param {Function} deps.call async (verb, args) => what Glue answered ({ ok, text?, error?, instructions? }), or null
 *   when it could not be reached
 * @param {Function} deps.write (line) => void: one JSON-RPC message out
 * @returns {{ handle: (line: string) => Promise<void> }}
 */
export function createServer({ call, write }) {
  const send = (o) => write(JSON.stringify({ jsonrpc: '2.0', ...o }));
  const text = (t, isError = false) => ({ content: [{ type: 'text', text: String(t) }], ...(isError ? { isError: true } : {}) });
  async function handle(line) {
    let m;
    try { m = JSON.parse(line); } catch { return; }
    if (!m || typeof m !== 'object' || typeof m.method !== 'string') return;
    const reply = (result) => { if (m.id != null) send({ id: m.id, result }); };
    if (m.method === 'initialize') {
      // Its standing brief comes from Glue, which knows the space, the models and the limits.
      const hello = await call('hello', {}).catch(() => null);
      return reply({ protocolVersion: typeof m.params?.protocolVersion === 'string' ? m.params.protocolVersion : '2025-06-18', capabilities: { tools: {} },
        serverInfo: { name: 'glue', version: '1' },
        instructions: hello?.ok && typeof hello.instructions === 'string' ? hello.instructions
          : 'These tools let a space\'s main agent start and follow workers in Glue. Glue did not answer just now, so they may fail until it does.' });
    }
    if (m.method === 'ping') return reply({});
    if (m.method === 'tools/list') return reply({ tools: TOOLS.map(({ name, description, inputSchema, readOnly }) => ({ name, description, inputSchema, ...(readOnly ? { annotations: { readOnlyHint: true } } : {}) })) });
    if (m.method === 'tools/call') {
      const tool = TOOLS.find((t) => t.name === m.params?.name);
      if (!tool) return reply(text(`There is no tool named ${String(m.params?.name ?? '').slice(0, 60)}.`, true));
      const args = m.params?.arguments && typeof m.params.arguments === 'object' ? m.params.arguments : {};
      const r = await call(tool.verb, args).catch(() => null);
      if (!r) return reply(text(NO_GLUE, true));
      return reply(text(r.ok ? r.text ?? 'Done.' : r.error ?? 'Glue refused that, and gave no reason.', !r.ok));
    }
    // Anything else that wants an answer (server/discover, resources/list…) is not one of ours.
    if (m.id != null) send({ id: m.id, error: { code: -32601, message: 'Method not found' } });
  }
  return { handle };
}

/** A call to Glue's own server on this computer, with this main agent's key. Null when it can't be reached. */
export function glueCall({ port, key, fetch: f = fetch, timeout = 60_000 }) {
  return async (verb, args) => {
    try {
      const res = await f(`http://127.0.0.1:${port}/agent/${verb}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-glue-agent': key },
        body: JSON.stringify(args ?? {}), signal: AbortSignal.timeout(timeout) });
      const body = await res.json().catch(() => null);
      return body && typeof body === 'object' ? body : { ok: false, error: `Glue answered ${res.status}.` };
    } catch { return null; }
  };
}

// Run as the server when started as a program (not when a test imports it).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.GLUE_PORT), key = process.env.GLUE_AGENT_KEY ?? '';
  const server = createServer({ call: glueCall({ port, key }), write: (line) => process.stdout.write(line + '\n') });
  // One line at a time, in order: an answer never overtakes the one before it.
  let last = Promise.resolve();
  readline.createInterface({ input: process.stdin }).on('line', (line) => { last = last.then(() => server.handle(line)).catch(() => {}); })
    .on('close', () => { last.finally(() => process.exit(0)); });
}
