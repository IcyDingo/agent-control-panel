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
  assert.equal(plainAsk([{ toolName: 'Bash' }]), true);
  assert.equal(plainAsk([{ toolName: 'mcp__github__list' }]), true);
  assert.equal(plainAsk([{ toolName: 'Edit' }]), false);
  assert.equal(plainAsk([{ toolName: 'Bash' }, { toolName: 'Read' }]), false);
  assert.equal(plainAsk([{ toolName: 'Bash', open: true }]), false);
  assert.equal(plainAsk([{ toolName: 'Bash', agent: 'opencode' }]), false);
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
