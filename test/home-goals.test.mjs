// Home's goals: what each issue shows as a goal (its branches, what is ahead, its one move), the order, which goals
// are open, agents outside any goal, and the reached line. public/home-board.js decides; run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
await import('../public/home-board.js');
const { tipOf, goalOf, goalsOrder, outsideOf, isOpen, reachedToday } = globalThis.HomeBoard;

const NOW = Date.UTC(2026, 10, 26, 12, 0, 0), MIN = 60_000;
const ag = (id, over = {}) => ({ sessionId: `${id}-0000-4000-8000-000000000000`, state: 'idle', lastEventAt: NOW - MIN, gh: null, ...over });
const stateOf = (s) => s.state;
const green = { number: 7, checks: 'passing', mergeState: 'CLEAN', sha: 'abc' };
const base = (over = {}) => ({ reqs: [], follow: null, failedShown: () => true, mergeable: (s) => s.gh?.pr === green, stateOf, now: NOW, inGoal: true, ...over });
const bash = { id: 'r1', toolName: 'Bash', toolInput: { command: 'npm run migrate' }, createdAt: 1 };

test('tipOf: what a branch says, first match wins', () => {
  const asks = tipOf(ag('a1', { state: 'waiting' }), base({ reqs: [bash] }));
  assert.deepEqual([asks.kind, asks.tone, asks.acts], ['asks', 'amber', ['allow', 'deny']]);
  assert.match(asks.words, /^asks: /);
  assert.match(asks.words, /npm run migrate/);
  const q = tipOf(ag('a2', { state: 'waiting' }), base({ reqs: [{ id: 'r2', toolName: 'AskUserQuestion', toolInput: { questions: [{ question: 'Chat or upload?' }] } }] }));
  assert.deepEqual([q.kind, q.acts, q.words], ['asks', ['answer'], 'asks: Chat or upload?']);
  const waits = tipOf(ag('a2', { state: 'waiting' }), base());
  assert.deepEqual([waits.kind, waits.acts], ['asks', ['open']], 'waiting on something the panel cannot read');
  const f = tipOf(ag('a3'), base({ follow: { verdict: 'needs-answer', ask: 'Which login?', reply: 'The work one.' } }));
  assert.deepEqual([f.kind, f.acts, f.words], ['follow', ['send', 'answer'], 'asks: Which login?']);
  const failed = tipOf(ag('a4', { state: 'failed', lastMessage: 'Tests broke. More text.' }), base());
  assert.deepEqual([failed.kind, failed.tone, failed.acts, failed.words], ['failed', 'red', ['again'], 'failed: Tests broke.']);
  assert.equal(tipOf(ag('a4', { state: 'failed' }), base({ failedShown: () => false })).kind, 'gone', 'a dismissed failure');
  const fails = tipOf(ag('a5', { state: 'busy', gh: { pr: { number: 9, checks: 'failing', failing: ['test', 'lint'] } } }), base());
  assert.deepEqual([fails.kind, fails.tone, fails.acts, fails.words], ['fails', 'red', ['fix'], 'PR #9 fails 2 checks']);
  const merge = tipOf(ag('a6', { gh: { pr: green } }), base());
  assert.deepEqual([merge.kind, merge.tone, merge.ring, merge.acts, merge.words], ['merge', 'green', false, ['merge'], 'PR #7 green']);
  const short = tipOf(ag('a7'), base({ follow: { verdict: 'stopped-short', ask: 'Write the tests', reply: 'Go on.' } }));
  assert.deepEqual([short.kind, short.acts], ['short', ['keep']]);
  const stalled = tipOf(ag('a8', { state: 'busy', lastEventAt: NOW - 21 * MIN }), base());
  assert.deepEqual([stalled.kind, stalled.tone, stalled.ring, stalled.acts, stalled.words], ['stalled', 'amber', true, ['nudge'], 'no change for 21 min']);
  const busy = tipOf(ag('a9', { state: 'busy', lastTool: { tool: 'Edit', text: 'cart.tsx', at: NOW - MIN } }), base());
  assert.deepEqual([busy.kind, busy.tone, busy.ring, busy.acts, busy.words], ['busy', 'green', true, [], 'Edit cart.tsx · 1 min']);
  assert.equal(tipOf(ag('b1', { state: 'finished' }), base()).kind, 'gone');
  assert.deepEqual(tipOf(ag('b1', { state: 'finished' }), base({ inGoal: false })).acts, [], 'nothing to pick up again outside a goal');
  assert.equal(tipOf(null, base()).kind, 'starting');
});

const it = (id, state, over = {}) => ({ id, text: `Part ${id}`, state, sessionId: null, doneAt: 0, pr: null, ...over });
const ctxOf = (sessions, over = {}) => ({ sessions: new Map(sessions.map((s) => [s.sessionId, s])), reqsOf: () => [], followOf: () => null,
  failedShown: () => true, mergeable: (s) => s.gh?.pr === green, stateOf, now: NOW, ...over });

test('goalOf: shipped, branches, ahead, and the goal\'s one move', () => {
  const asking = ag('c1', { state: 'waiting' }), busy = ag('c2', { state: 'busy', lastTool: { tool: 'Bash', text: 'npm test', at: NOW } });
  const issue = { id: 'i1', title: 'Pages load fast', items: [it('a', 'done', { doneAt: 10, pr: 3 }), it('b', 'done', { doneAt: 20 }),
    it('c', 'working', { sessionId: busy.sessionId }), it('d', 'working', { sessionId: asking.sessionId }), it('e', 'todo')] };
  const g = goalOf(issue, ctxOf([asking, busy], { reqsOf: (id) => (id === asking.sessionId ? [bash] : []) }));
  assert.deepEqual([g.shipped, g.total, g.lastShippedAt, g.branches.length, g.ahead.length, g.reached, g.empty], [2, 5, 20, 2, 1, false, false]);
  assert.deepEqual(g.branches.map((b) => b.item.id), ['d', 'c'], 'the branch that needs you first');
  assert.deepEqual([g.move.rank, g.move.kind, g.move.item.id], [0, 'asks', 'd']);
  assert.equal(g.needSig, JSON.stringify([['d', 'asks']]));
  assert.equal(goalOf({ id: 'i2', title: 'Empty', items: [] }, ctxOf([])).empty, true);
  const reached = goalOf({ id: 'i3', title: 'Done', items: [it('a', 'done', { doneAt: 5 })] }, ctxOf([]));
  assert.deepEqual([reached.reached, reached.move.rank], [true, 6]);
  const idle = goalOf({ id: 'i4', title: 'Waiting', items: [it('a', 'done'), it('b', 'todo')] }, ctxOf([]));
  assert.deepEqual([idle.move.rank, idle.move.acts, idle.move.item.id], [5, ['pickup'], 'b']);
  const start = goalOf({ id: 'i5', title: 'Starting', items: [it('a', 'working')] }, ctxOf([]));
  assert.deepEqual([start.branches[0].tip.kind, start.move.rank], ['starting', 4]);
  const gone = goalOf({ id: 'i6', title: 'Gone', items: [it('a', 'working', { sessionId: 'x-gone' })] }, ctxOf([]));
  assert.equal(gone.branches[0].tip.kind, 'gone', 'its agent is no longer on the board');
});

test('goalsOrder: needs you, broken, ready, stalled, moving, nobody on it; stable within each', () => {
  const g = (id, rank) => ({ id, move: { rank } });
  assert.deepEqual(goalsOrder([g('a', 5), g('b', 0), g('c', 2), g('d', 0), g('e', 4)]).map((x) => x.id), ['b', 'd', 'c', 'e', 'a']);
});

test('outsideOf: agents in no working item that need you (finished or not), or work; not a busy main agent', () => {
  const onDone = ag('d1', { state: 'waiting' }), merged = ag('d2', { state: 'finished', gh: { pr: green } }), quiet = ag('d3', { state: 'finished' });
  const mainBusy = ag('d4', { state: 'busy', lastTool: { tool: 'Read', text: 'x', at: NOW } }), mainAsks = ag('d5', { state: 'waiting' });
  const inItem = ag('d6', { state: 'busy' }), loose = ag('d7', { state: 'busy', lastTool: { tool: 'Edit', text: 'y', at: NOW } });
  const mains = new Set([mainBusy.sessionId, mainAsks.sessionId]);
  const rows = outsideOf({ sessions: [onDone, merged, quiet, mainBusy, mainAsks, inItem, loose], workingIds: new Set([inItem.sessionId]),
    isMain: (s) => mains.has(s.sessionId), reqsOf: (id) => (id === onDone.sessionId || id === mainAsks.sessionId ? [bash] : []), followOf: () => null,
    failedShown: () => true, mergeable: (s) => s.gh?.pr === green, stateOf, now: NOW, held: [] });
  assert.deepEqual(rows.map((r) => r.s.sessionId.slice(0, 2)), ['d1', 'd5', 'd2', 'd7']);
  const held = outsideOf({ sessions: [], workingIds: new Set(), isMain: () => true, reqsOf: () => [], followOf: () => null, failedShown: () => true,
    mergeable: () => false, stateOf, now: NOW, held: [{ space: 's1', name: 'Billing', down: true, waiting: 3, s: null }] });
  assert.deepEqual([held[0].tip.kind, held[0].tip.acts, held[0].space], ['wake', ['wake'], 's1']);
});

test('isOpen: open while something new needs you; a goal you collapsed stays shut until that changes', () => {
  const g = { id: 'i1', needSig: '[["d","asks"]]' };
  assert.equal(isOpen(g, new Map()), true);
  assert.equal(isOpen(g, new Map([['i1', '[["d","asks"]]']])), false);
  assert.equal(isOpen(g, new Map([['i1', '[["c","merge"]]']])), true);
  const calm = { id: 'i2', needSig: '[]' };
  assert.equal(isOpen(calm, new Map()), false);
  assert.equal(isOpen(calm, new Map([['i2', 'open']])), true);
});

test('reachedToday: reached goals whose last part shipped today, local time', () => {
  const day = new Date(NOW); day.setHours(0, 0, 0, 0);
  const goals = [{ title: 'A', reached: true, lastShippedAt: day.getTime() + 1000 }, { title: 'B', reached: true, lastShippedAt: day.getTime() - 1000 },
    { title: 'C', reached: false, lastShippedAt: NOW }];
  assert.deepEqual(reachedToday(goals, NOW), ['A']);
});
