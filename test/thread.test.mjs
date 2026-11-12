// A followed session's thread: transcript items merged with hook state, whichever arrives first. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summaryOf } from '../history.mjs';
import { createThread, toolKey } from '../thread.mjs';

// Items in the shapes history.mjs gives them, and hook events in the shape Claude Code sends them.
const AT = Date.UTC(2026, 10, 4, 9, 0, 0);
const tool = (id, name, input, pos) => ({ who: 'tool', key: `tool:${id}`, toolUseId: id, name, summary: summaryOf(name, input), input, state: 'running', at: AT + pos, pos });
const result = (id, ok, preview, pos) => ({ who: 'result', key: `result:${pos}`, toolUseId: id, ok, preview, at: AT + pos, pos });
const said = (text, pos) => ({ who: 'claude', key: `claude:${pos}`, text, messageId: `msg_${pos}`, at: AT + pos, pos });
const hook = (name, tool_name, tool_input, tool_use_id, extra = {}) =>
  ({ hook_event_name: name, session_id: 's', tool_name, tool_input, ...(tool_use_id ? { tool_use_id } : {}), ...extra });
const LS = { command: 'ls' }, READ = { file_path: '/x' };

/** A thread recording every emit call. */
function thread() {
  const calls = [];
  return { t: createThread({ emit: (events) => calls.push(events) }), calls };
}

test('line then hook: the tool row is created by the line and set done by PostToolUse', () => {
  const { t, calls } = thread();
  t.addItems([tool('a', 'Bash', LS, 100)]);
  assert.deepEqual(calls, [[tool('a', 'Bash', LS, 100)]]);
  t.hook(hook('PostToolUse', 'Bash', LS, 'a', { agent_id: 'sub' })); // a subagent's: not this thread's
  assert.equal(calls.length, 1);
  t.hook(hook('PostToolUse', 'Bash', LS, 'a'));
  assert.equal(calls.length, 2);
  const [[u]] = calls.slice(1);
  assert.equal(u.who, 'update');
  assert.equal(u.key, 'tool:a');
  assert.equal(u.patch.state, 'done');
  assert.equal(typeof u.patch.endedAt, 'number');
  assert.equal(t.items()[0].state, 'done');
  t.hook(hook('PreToolUse', 'Bash', LS, 'a')); // late: a finished call never runs again
  assert.equal(calls.length, 2);
});

test('hook then line: PreToolUse makes a provisional row; the tool_use line adopts it under the real key', () => {
  const { t, calls } = thread();
  const fk = 'tool~Bash:{"command":"ls"}';
  t.hook(hook('PreToolUse', 'Bash', LS)); // no tool_use_id
  assert.equal(calls.length, 1);
  const [[p]] = calls;
  assert.equal(p.who, 'tool');
  assert.equal(p.key, fk);
  assert.equal(p.pos, null);
  assert.equal(p.state, 'running');
  assert.deepEqual(p.summary, summaryOf('Bash', LS));
  t.addItems([tool('a', 'Bash', LS, 100)]);
  assert.deepEqual(calls[1], [{ who: 'update', key: fk, patch: { removed: true } }, { ...tool('a', 'Bash', LS, 100), state: 'running' }]);
  assert.deepEqual(t.items(), [tool('a', 'Bash', LS, 100)]);
  t.hook(hook('PostToolUse', 'Bash', LS)); // still no id: it finds the adopted row
  assert.equal(calls[2][0].key, 'tool:a');
  assert.equal(calls[2][0].patch.state, 'done');
});

test('a result before its call becomes a result row; a result after its call is an update', () => {
  const { t, calls } = thread();
  t.addItems([result('a', true, 'file.txt', 200)]);
  assert.deepEqual(calls, [[result('a', true, 'file.txt', 200)]]);
  t.addItems([tool('b', 'Bash', LS, 300)]);
  t.addItems([result('b', false, 'no such file', 400)]);
  assert.deepEqual(calls[2], [{ who: 'update', key: 'tool:b', patch: { state: 'failed', preview: 'no such file', endedAt: AT + 400 } }]);
  assert.deepEqual(t.items().map((m) => m.key), ['result:200', 'tool:b']);
  // The call the orphan belongs to turns up after all (an older page): the result folds into it.
  t.addItems([tool('a', 'Bash', LS, 100)]);
  assert.deepEqual(calls[3], [{ who: 'update', key: 'result:200', patch: { removed: true } },
                              { ...tool('a', 'Bash', LS, 100), state: 'done', preview: 'file.txt', endedAt: AT + 200 }]);
  assert.deepEqual(t.items().map((m) => [m.key, m.state]), [['tool:a', 'done'], ['tool:b', 'failed']]);
});

test('a refused call stays refused when its tool_result arrives', () => {
  const { t, calls } = thread();
  t.addItems([tool('a', 'Bash', LS, 100)]);
  t.hook(hook('PermissionDenied', 'Bash', LS, 'a'));
  assert.deepEqual(calls[1], [{ who: 'update', key: 'tool:a', patch: { state: 'refused' } }]);
  t.addItems([result('a', false, 'Permission denied', 200)]);
  assert.deepEqual(calls[2], [{ who: 'update', key: 'tool:a', patch: { preview: 'Permission denied', endedAt: AT + 200 } }]);
  assert.equal(t.items()[0].state, 'refused');
});

test('a held request marks waiting, and settling records why', () => {
  const { t, calls } = thread();
  t.addItems([tool('a', 'Bash', LS, 100)]);
  const ref = { tool_name: 'Bash', tool_input: LS }; // a held request carries no tool_use_id
  t.request(ref, { waiting: true });
  assert.deepEqual(calls[1], [{ who: 'update', key: 'tool:a', patch: { waiting: true } }]);
  t.request(ref, { why: 'Allowed from the panel' });
  assert.deepEqual(calls[2], [{ who: 'update', key: 'tool:a', patch: { waiting: false, settledWhy: 'Allowed from the panel' } }]);
  t.request(ref, { waiting: true }); // late news of the hold: settled stays settled
  assert.equal(calls.length, 3);
  assert.deepEqual(t.items()[0], { ...tool('a', 'Bash', LS, 100), waiting: false, settledWhy: 'Allowed from the panel' });
});

test('Stop appends a turn divider', () => {
  const { t, calls } = thread();
  const before = Date.now();
  t.addItems([said('done', before - AT - 1000)]);
  t.hook({ hook_event_name: 'Stop', session_id: 's', agent_id: 'sub' }); // a subagent's Stop is not this turn's end
  assert.equal(calls.length, 1);
  t.hook({ hook_event_name: 'Stop', session_id: 's' });
  assert.equal(calls.length, 2);
  const [[turn]] = calls.slice(1);
  assert.equal(turn.who, 'turn');
  assert.match(turn.key, /^turn:\d+$/);
  assert.ok(turn.at >= before && turn.at <= Date.now());
  t.addItems([said('next', turn.at - AT + 1000)]); // the next turn's line, written after the Stop
  assert.deepEqual(t.items().map((m) => m.who), ['claude', 'turn', 'claude']);
});

test('hook state remembered before the backfill annotates the backfill', () => {
  const { t, calls } = thread();
  t.hook(hook('PreToolUse', 'Bash', LS, 'x'));
  t.hook(hook('PostToolUse', 'Bash', LS, 'x'));
  t.request({ tool_name: 'Read', tool_input: READ }, { why: 'Allowed by a rule' }); // no id, and no row yet
  t.reset();
  assert.deepEqual(t.items(), []);
  calls.length = 0;
  t.addItems([tool('x', 'Bash', LS, 100), tool('y', 'Read', READ, 200)]);
  assert.equal(calls.length, 1);
  const [x, y] = calls[0];
  assert.equal(x.state, 'done');
  assert.equal(typeof x.endedAt, 'number');
  assert.equal(y.settledWhy, 'Allowed by a rule');
  assert.equal(y.waiting, false);
  // Only the last 300 keys are remembered.
  t.hook(hook('PostToolUse', 'Bash', LS, 'old'));
  for (let i = 0; i < 300; i++) t.hook(hook('PostToolUse', 'Bash', { command: `echo ${i}` }, `n${i}`));
  t.reset();
  t.addItems([tool('old', 'Bash', LS, 300), tool('n299', 'Bash', { command: 'echo 299' }, 400)]);
  assert.deepEqual(t.items().map((m) => m.state), ['running', 'done']);
});

test('the same inputs in either order give the same rows', () => {
  const script = [
    (t) => t.addItems([said('Looking.', 50)]),
    (t) => t.addItems([tool('a', 'Bash', LS, 100)]),
    (t) => t.addItems([result('a', true, 'file.txt', 200)]),
    (t) => t.hook(hook('PreToolUse', 'Bash', LS, 'a')),
    (t) => t.hook(hook('PostToolUse', 'Bash', LS, 'a')),
    (t) => t.request({ tool_name: 'Bash', tool_input: LS }, { waiting: true }),
    (t) => t.request({ tool_name: 'Bash', tool_input: LS }, { why: 'Allowed from the panel' }),
    (t) => t.hook(hook('PreToolUse', 'Read', READ)),
    (t) => t.addItems([tool('b', 'Read', READ, 300)]),
    (t) => t.hook(hook('PermissionDenied', 'Read', READ)),
    (t) => t.addItems([result('b', false, 'denied', 400)]),
    (t) => t.addItems([said('Could not read it.', 500)]),
  ];
  const run = (order) => { const { t } = thread(); for (const i of order) script[i](t); return t.items(); };
  const forwards = run(script.map((_, i) => i));
  assert.deepEqual(forwards.map((m) => [m.key, m.state]),
    [['claude:50', undefined], ['tool:a', 'done'], ['tool:b', 'refused'], ['claude:500', undefined]]);
  assert.deepEqual(forwards[1], { ...tool('a', 'Bash', LS, 100), state: 'done', preview: 'file.txt', endedAt: AT + 200,
                                  waiting: false, settledWhy: 'Allowed from the panel' });
  assert.deepEqual(run(script.map((_, i) => script.length - 1 - i)), forwards, 'backwards');
  let seed = 7; // a fixed set of shuffles, the same every run
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let k = 0; k < 500; k++) {
    const order = script.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    assert.deepEqual(run(order), forwards, `order ${order}`);
  }
});

test('events of one call are emitted once, together', () => {
  const { t, calls } = thread();
  t.addItems([tool('a', 'Bash', LS, 100), result('a', true, 'file.txt', 200), said('Done.', 300)]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [{ ...tool('a', 'Bash', LS, 100), state: 'done', preview: 'file.txt', endedAt: AT + 200 }, said('Done.', 300)]);
  t.addItems([tool('a', 'Bash', LS, 100), said('Done.', 300)]); // a line read twice (backfill and follow overlap): no news
  t.hook(hook('Notification', 'Bash', LS, 'a'));
  t.addItems([]);
  assert.equal(calls.length, 1);
});

test('toolKey uses the tool_use_id when there is one, else the tool and its input', () => {
  assert.equal(toolKey({ tool_use_id: 'toolu_1', tool_name: 'Bash', tool_input: LS }), 'tool:toolu_1');
  assert.equal(toolKey({ tool_name: 'Bash', tool_input: LS }), 'tool~Bash:{"command":"ls"}');
  assert.equal(toolKey({ tool_name: 'Bash' }), 'tool~Bash:{}');
});
