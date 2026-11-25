// Home's board: who needs the owner and why, which card an agent is on, the counts, and which drafted replies "Send
// all" may send. public/home-board.js is a plain script the page loads; here it is imported and read from globalThis.
// Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../public/home-board.js');
const { plainAsk, dismissKey } = globalThis.HomeBoard;

const COL = { waiting: 'waiting', busy: 'busy', idle: 'idle', finished: 'finished', failed: 'finished' };
const stateOf = (s) => s.state, colOf = (st) => COL[st] ?? 'idle';
const ag = (id, over = {}) => ({ sessionId: `${id}-0000-4000-8000-000000000000`, state: 'idle', startedAt: 0, space: null, repo: null, gh: null, ...over });
const green = { number: 7, checks: 'passing', mergeState: 'CLEAN' };
const mergeable = (s) => s.gh?.pr === green;
const base = (sessions, over = {}) => ({ sessions, stateOf, reqsOf: () => [], asking: [], follow: [], mergeable, dismissed: () => false, ...over });
const ids = (list) => list.map((r) => [r.s.sessionId.slice(0, 2), r.kind]);

test('plainAsk: one plain tool request, from Claude Code, not an open one', () => {
  assert.equal(plainAsk([{ toolName: 'Bash', toolInput: { command: 'ls' } }]), true);
  assert.equal(plainAsk([{ toolName: 'mcp__github__list', toolInput: {} }]), false, 'an MCP tool gets Answer: its input is not one line');
  assert.equal(plainAsk([{ toolName: 'Edit' }]), false);
  const ls = { toolName: 'Bash', toolInput: { command: 'ls' } };
  assert.equal(plainAsk([ls, { toolName: 'Read', toolInput: { file_path: '/a' } }]), false);
  assert.equal(plainAsk([{ ...ls, open: true }]), false);
  assert.equal(plainAsk([{ ...ls, agent: 'opencode' }]), false);
  assert.equal(plainAsk([]), false);
});

test('dismissKey changes when the agent says something new', () => {
  const s = ag('f1', { state: 'failed', lastMessageAt: 10 });
  assert.equal(dismissKey(s), dismissKey({ ...s }));
  assert.notEqual(dismissKey(s), dismissKey({ ...s, lastMessageAt: 11 }));
  assert.notEqual(dismissKey(s), dismissKey({ ...s, state: 'idle' }));
});

test('inlineAsk shows in full what one click would allow, or nothing (then the row offers Answer)', () => {
  const { inlineAsk } = globalThis.HomeBoard;
  const long = `npm run build && ${'x'.repeat(200)} && rm -rf dist`;
  assert.equal(inlineAsk({ toolName: 'Bash', toolInput: { command: long } }), long, 'the whole command, never cut');
  assert.equal(inlineAsk({ toolName: 'WebFetch', toolInput: { url: 'https://a.b/c' } }), 'https://a.b/c');
  assert.equal(inlineAsk({ toolName: 'Grep', toolInput: { pattern: 'TODO', path: 'src' } }), 'TODO in src');
  assert.equal(inlineAsk({ toolName: 'Read', toolInput: { file_path: '/x/a.js' } }), '/x/a.js');
  assert.equal(inlineAsk({ toolName: 'mcp__mail__send', toolInput: { to: 'a@b.c', body: 'hi' } }), null, 'an MCP tool\'s input is not one line: Answer');
  assert.equal(inlineAsk({ toolName: 'Bash', toolInput: {} }), null);
  assert.equal(globalThis.HomeBoard.plainAsk([{ toolName: 'mcp__mail__send', toolInput: { to: 'a' } }]), false, 'so it gets no inline Allow');
});

test('busyLine says what a working agent runs', () => {
  const { busyLine } = globalThis.HomeBoard;
  assert.equal(busyLine({ lastTool: { tool: 'Edit', text: 'cart.tsx' } }), 'Edit cart.tsx');
  assert.equal(busyLine({ lastTool: { tool: 'Bash', text: '' } }), 'Bash');
  assert.equal(busyLine({ ocError: { message: 'Rate limited' } }), 'Error: Rate limited');
  assert.equal(busyLine({}), '');
});

test('syncChildren never moves a row that stays, so a box being typed in keeps its focus', () => {
  const { syncChildren } = globalThis.HomeBoard;
  // A tiny stand-in for a DOM parent that counts how often each node is taken out and put back.
  const mkParent = (kids) => { const p = { children: [...kids], moved: new Map(),
    insertBefore(n, ref) { const i = p.children.indexOf(n); if (i >= 0) { p.children.splice(i, 1); p.moved.set(n, (p.moved.get(n) ?? 0) + 1); } const j = ref ? p.children.indexOf(ref) : -1; p.children.splice(j < 0 ? p.children.length : j, 0, n); },
    removeChild(n) { p.children.splice(p.children.indexOf(n), 1); } }; return p; };
  const A = { id: 'A' }, B = { id: 'B' }, C = { id: 'C' }, D = { id: 'D' };
  const p = mkParent([A, B, C]);
  syncChildren(p, [B, C]); // A was answered
  assert.deepEqual(p.children, [B, C]);
  assert.equal(p.moved.get(B), undefined, 'B, being typed in, was not moved');
  syncChildren(p, [D, B, C]); // a new row comes in on top
  assert.deepEqual(p.children, [D, B, C]);
  assert.equal(p.moved.get(B), undefined);
  syncChildren(p, [C, B]); // a real change of order moves what it must
  assert.deepEqual(p.children, [C, B]);
});

test('pruneDismissed drops a dismissal only when its agent is on the board and has moved on; keeps the newest 200', () => {
  const { pruneDismissed } = globalThis.HomeBoard;
  const a = ag('a1', { state: 'failed', lastMessageAt: 1 }), b = ag('b1', { state: 'failed', lastMessageAt: 2 });
  const kept = [dismissKey(a), dismissKey(b), `${ag('gone').sessionId}:failed:9`];
  assert.deepEqual(pruneDismissed(kept, []), kept, 'an empty board (the page starting) drops nothing');
  assert.deepEqual(pruneDismissed(kept, [a, { ...b, lastMessageAt: 3 }]), [dismissKey(a), kept[2]], 'b said something new: its dismissal goes');
  const many = Array.from({ length: 205 }, (_, i) => `${i}-x:failed:1`);
  assert.deepEqual(pruneDismissed(many, []), many.slice(5));
});

test('itemView: what an issue\'s item shows, from its state and its agent', () => {
  const { itemView } = globalThis.HomeBoard;
  const sessions = new Map([['s1', { sessionId: 's1', name: 'cart-ui', state: 'busy' }], ['s2', { sessionId: 's2', name: 'api', state: 'waiting' }],
    ['s3', { sessionId: 's3', name: 'old', state: 'finished' }], ['s4', { sessionId: 's4', name: 'calm', state: 'idle' }]]);
  const v = (it) => itemView(it, sessions, (s) => s.state, (s) => s.name);
  assert.deepEqual(v({ state: 'todo' }), { mark: 'todo', label: '', detail: '' });
  assert.deepEqual(v({ state: 'working', sessionId: 's1' }), { mark: 'working', label: 'cart-ui', detail: 'working' });
  assert.deepEqual(v({ state: 'working', sessionId: 's2' }), { mark: 'working', label: 'api', detail: 'needs you' });
  assert.deepEqual(v({ state: 'working', sessionId: 's4' }), { mark: 'working', label: 'calm', detail: 'idle' });
  assert.deepEqual(v({ state: 'working', sessionId: 's3' }), { mark: 'finished', label: 'old', detail: 'agent finished' });
  assert.deepEqual(v({ state: 'working', sessionId: 'gone' }), { mark: 'finished', label: '', detail: 'agent finished' });
  assert.deepEqual(v({ state: 'working', sessionId: null, launchId: 'c1' }), { mark: 'working', label: '', detail: 'starting' });
  assert.deepEqual(v({ state: 'done', pr: 91 }), { mark: 'done', label: '', detail: 'merged #91' });
  assert.deepEqual(v({ state: 'done', pr: null }), { mark: 'done', label: '', detail: 'done' });
});

test('issueOrder puts fully done issues last, keeping the order; todoCount counts items to do', () => {
  const { issueOrder, todoCount } = globalThis.HomeBoard;
  const mkI = (id, states) => ({ id, items: states.map((state, i) => ({ id: `${id}${i}`, state })) });
  const list = [mkI('a', ['done', 'done']), mkI('b', ['todo']), mkI('c', []), mkI('d', ['done']), mkI('e', ['working', 'done'])];
  assert.deepEqual(issueOrder(list).map((x) => [x.id, x.allDone]), [['b', false], ['c', false], ['e', false], ['a', true], ['d', true]], 'an empty issue is not done');
  assert.equal(todoCount(list), 1);
  assert.equal(todoCount([]), 0);
});
