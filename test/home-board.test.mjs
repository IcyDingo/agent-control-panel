// Home's board: who needs the owner and why, which card an agent is on, the counts, and which drafted replies "Send
// all" may send. public/home-board.js is a plain script the page loads; here it is imported and read from globalThis.
// Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../public/home-board.js');
const { needsList, needKinds, homeCards, headCounts, plainAsk, bulkReplies, dismissKey } = globalThis.HomeBoard;

const COL = { waiting: 'waiting', busy: 'busy', idle: 'idle', finished: 'finished', failed: 'finished' };
const stateOf = (s) => s.state, colOf = (st) => COL[st] ?? 'idle';
const ag = (id, over = {}) => ({ sessionId: `${id}-0000-4000-8000-000000000000`, state: 'idle', startedAt: 0, space: null, repo: null, gh: null, ...over });
const green = { number: 7, checks: 'passing', mergeState: 'CLEAN' };
const mergeable = (s) => s.gh?.pr === green;
const base = (sessions, over = {}) => ({ sessions, stateOf, reqsOf: () => [], asking: [], follow: [], mergeable, dismissed: () => false, ...over });
const ids = (list) => list.map((r) => [r.s.sessionId.slice(0, 2), r.kind]);

test('needsList orders waiting (asking first), then follow-ups, failed, ready PRs; each agent once at its top kind', () => {
  const w1 = ag('w1', { state: 'waiting', startedAt: 5 }), w2 = ag('w2', { state: 'waiting', startedAt: 9 }), w3 = ag('w3', { state: 'waiting', startedAt: 1 });
  const both = ag('wf', { state: 'waiting' }), fu = ag('fu'), fx = ag('fx', { state: 'failed' }), ff = ag('ff', { state: 'failed' });
  const pr = ag('pr', { state: 'busy', gh: { pr: green } }), gone = ag('gx', { state: 'failed' }), calm = ag('ok', { state: 'busy' });
  const list = needsList(base([pr, calm, gone, ff, fu, fx, both, w3, w2, w1], {
    reqsOf: (id) => (id === w1.sessionId || id === w3.sessionId ? [{ id: 'r' }] : []),
    asking: [w3.sessionId, w1.sessionId],
    follow: [{ sessionId: fx.sessionId.slice(0, 8) }, { sessionId: fu.sessionId.slice(0, 8) }, { sessionId: both.sessionId.slice(0, 8) }],
    dismissed: (s) => s === gone,
  }));
  assert.deepEqual(ids(list), [['w3', 'waiting'], ['w1', 'waiting'], ['w2', 'waiting'], ['wf', 'waiting'], ['fx', 'follow'], ['fu', 'follow'], ['ff', 'failed'], ['pr', 'merge']]);
  assert.equal(list.find((r) => r.kind === 'follow').follow.sessionId, fx.sessionId.slice(0, 8), 'a follow-up row carries its follow-up');
  assert.deepEqual(list[0].reqs, [{ id: 'r' }], 'a waiting row carries its requests');
  assert.equal(needKinds(list).get(pr.sessionId), 'merge');
  assert.equal(needKinds(list).has(calm.sessionId), false);
});

test('homeCards keeps spaces in their order, empty ones too, then repositories by name, then Other folders', () => {
  const spaces = [{ id: 'b', name: 'Billing' }, { id: 'a', name: 'Alpha' }];
  const sessions = [ag('z1', { repo: '/r/zeta' }), ag('a1', { repo: '/r/alpha' }), ag('l1'), ag('s1', { space: 'a' })];
  const cards = homeCards({ spaces, sessions, spaceIn: (s) => s.space, repoOf: (s) => s.repo, mainOf: () => null, colOf, stateOf, kinds: new Map() });
  assert.deepEqual(cards.map((c) => c.key), ['space:b', 'space:a', 'repo:/r/alpha', 'repo:/r/zeta', 'loose']);
  assert.deepEqual(cards.map((c) => c.kind), ['space', 'space', 'repo', 'repo', 'loose']);
  assert.equal(cards[0].title, 'Billing');
  assert.equal(cards[0].live.length, 0, 'an empty space is still a card');
  assert.equal(cards[2].title, 'alpha', 'a repository card is named by its folder');
});

test('an agent whose space is gone is on its repository\'s card', () => {
  const s = ag('x1', { space: 'deleted', repo: '/r/alpha' });
  const cards = homeCards({ spaces: [], sessions: [s], spaceIn: () => null, repoOf: (x) => x.repo, mainOf: () => null, colOf, stateOf, kinds: new Map() });
  assert.deepEqual(cards.map((c) => c.key), ['repo:/r/alpha']);
  assert.equal(cards[0].live[0], s);
});

test('a card lists needs-you first, then working, then idle; finished are a count; the main agent is not a row', () => {
  const main = ag('mm', { space: 'a', state: 'idle' }), idle = ag('i1', { space: 'a', startedAt: 3 }), busy = ag('b1', { space: 'a', state: 'busy' });
  const asks = ag('q1', { space: 'a', state: 'idle' }), done = ag('d1', { space: 'a', state: 'finished' }), failed = ag('f1', { space: 'a', state: 'failed' });
  const prs = { space: 'a', state: 'finished', gh: { pr: { number: 3, checks: 'failing' } } };
  const odd = ag('p1', prs);
  const kinds = new Map([[asks.sessionId, 'follow'], [failed.sessionId, 'failed']]);
  const [card] = homeCards({ spaces: [{ id: 'a', name: 'A' }], sessions: [idle, main, done, busy, asks, failed, odd], spaceIn: (s) => s.space, repoOf: () => null,
    mainOf: () => main, colOf, stateOf, kinds });
  assert.equal(card.main, main);
  assert.deepEqual(card.live.map((s) => s.sessionId.slice(0, 2)), ['q1', 'f1', 'b1', 'i1'], 'what they need, in priority order (a follow-up before failed), then busy, then idle');
  assert.equal(card.finished, 2, 'the finished ones that need nothing are a count');
  assert.deepEqual(card.all.map((s) => s.sessionId.slice(0, 2)).sort(), ['b1', 'd1', 'f1', 'i1', 'p1', 'q1'], 'all its agents but the main one, for its actions');
  assert.deepEqual(card.prs, { failing: 1, running: 0, ready: 0 });
});

test('a repository card stays while it has only finished agents, and goes when it has none', () => {
  const args = (sessions) => ({ spaces: [], sessions, spaceIn: () => null, repoOf: (s) => s.repo, mainOf: () => null, colOf, stateOf, kinds: new Map() });
  const [card] = homeCards(args([ag('d1', { repo: '/r/a', state: 'finished' })]));
  assert.equal(card.key, 'repo:/r/a');
  assert.deepEqual([card.live.length, card.finished], [0, 1]);
  assert.deepEqual(homeCards(args([])), []);
});

test('headCounts do not overlap', () => {
  const w = ag('w1', { state: 'waiting' }), b = ag('b1', { state: 'busy' }), p = ag('p1', { state: 'busy', gh: { pr: green } }), i = ag('i1'), d = ag('d1', { state: 'finished' });
  const kinds = new Map([[w.sessionId, 'waiting'], [p.sessionId, 'merge']]);
  assert.deepEqual(headCounts({ sessions: [w, b, p, i, d], kinds, colOf, stateOf, mergeable }), { need: 2, working: 1, idle: 1, ready: 1 });
});

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

test('bulkReplies leaves out replies that would close a terminal Claude', () => {
  const rows = [{ kind: 'follow', id: 1 }, { kind: 'waiting', id: 2 }, { kind: 'follow', id: 3, restart: true }, { kind: 'follow', id: 4 }];
  const r = bulkReplies(rows, (x) => x.restart === true);
  assert.deepEqual(r.send.map((x) => x.id), [1, 4]);
  assert.deepEqual(r.left.map((x) => x.id), [3]);
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

test('closesTerminal: a reply whose send would close a terminal Claude, also one the server just held for that', () => {
  const { closesTerminal } = globalThis.HomeBoard;
  const term = { kind: 'interactive', inRoster: true }, bg = { kind: 'background', inRoster: true };
  assert.equal(closesTerminal({ s: term, follow: { sessionId: 'a', how: 'restart' } }, new Set()), true);
  assert.equal(closesTerminal({ s: term, follow: { sessionId: 'a', how: 'send' } }, new Set(['a'])), true, 'held for a restart a moment ago');
  assert.equal(closesTerminal({ s: term, follow: { sessionId: 'a', how: 'send' } }, new Set()), false);
  assert.equal(closesTerminal({ s: bg, follow: { sessionId: 'a', how: 'restart' } }, new Set(['a'])), false, 'a background job just carries on');
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
