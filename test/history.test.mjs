// A session's conversation from its transcript: what you said, and what Claude said back. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatOf, itemOf, readChat } from '../history.mjs';

// Lines in the shape and key order Claude Code writes them.
let n = 0;
const ts = (s) => new Date(Date.UTC(2026, 9, 21, 9, 0, s)).toISOString();
const you = (content, s, extra = {}) => JSON.stringify({ parentUuid: null, isSidechain: false, promptId: 'p', type: 'user', ...extra,
  message: { role: 'user', content }, uuid: `u${n++}`, timestamp: ts(s) });
const said = (text, s, id = `msg_${n++}`, extra = {}) => JSON.stringify({ parentUuid: 'x', isSidechain: false, ...extra,
  message: { model: 'claude-opus-5-5', id, type: 'message', role: 'assistant', content: [{ type: 'text', text }] }, type: 'assistant', uuid: `a${n++}`, timestamp: ts(s) });
const tool = (s) => JSON.stringify({ parentUuid: 'x', isSidechain: false,
  message: { model: 'claude-opus-5-5', id: `msg_${n++}`, type: 'message', role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }] }, type: 'assistant', timestamp: ts(s) });
const result = (s) => you([{ tool_use_id: 't', type: 'tool_result', content: 'file.txt' }], s);
const queued = (prompt, s) => JSON.stringify({ parentUuid: 'x', isSidechain: false, attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' } },
  type: 'attachment', uuid: `q${n++}`, timestamp: ts(s) });
const at = (s) => Date.parse(ts(s));
const said2 = (blocks, s, extra = {}) => JSON.stringify({ parentUuid: 'x', isSidechain: false, ...extra,
  message: { model: 'claude-opus-5-5', id: `msg_${n++}`, type: 'message', role: 'assistant', content: blocks }, type: 'assistant', uuid: `a${n++}`, timestamp: ts(s) });
const shape = (items) => items.map((m) => [m.who, m.text ?? m.name ?? m.preview]);

test('a turn: what you asked, everything Claude said and did in it, in order', () => {
  const lines = [you('list the files', 1), said('Checking.', 2, 'msg_a'), tool(3), result(4), said('There is one: file.txt.', 5, 'msg_b')];
  const items = chatOf(lines), pos = (i) => lines.slice(0, i).reduce((p, l) => p + Buffer.byteLength(l) + 1, 0);
  assert.deepEqual(items, [
    { who: 'you', key: `you:${pos(0)}`, text: 'list the files', at: at(1), pos: pos(0) },
    { who: 'claude', key: `claude:${pos(1)}`, text: 'Checking.', messageId: 'msg_a', at: at(2), pos: pos(1) },
    { who: 'tool', key: 'tool:t', toolUseId: 't', name: 'Bash', summary: { tool: 'Bash', text: 'ls' }, input: { command: 'ls' }, state: 'running', at: at(3), pos: pos(2) },
    { who: 'result', key: `result:${pos(3)}`, toolUseId: 't', ok: true, preview: 'file.txt', at: at(4), pos: pos(3) },
    { who: 'claude', key: `claude:${pos(4)}`, text: 'There is one: file.txt.', messageId: 'msg_b', at: at(5), pos: pos(4) },
  ]);
});

test('a message sent while it worked is a you item where it landed', () => {
  const items = chatOf([you('build it', 1), said('Starting.', 2), queued('also add tests', 3), said('Noted, after the build.', 4), tool(5), said('Built, with tests.', 6)]);
  assert.deepEqual(shape(items), [['you', 'build it'], ['claude', 'Starting.'], ['you', 'also add tests'], ['claude', 'Noted, after the build.'],
    ['tool', 'Bash'], ['claude', 'Built, with tests.']]);
});

test('the same message recorded twice within two seconds is one item', () => {
  const items = chatOf([queued('also add tests', 1), you('also add tests', 2), you('also add tests', 9)]);
  assert.deepEqual(items.map((m) => m.at), [at(1), at(9)]);
});

test('one reply written in several blocks is one item per block, sharing messageId', () => {
  const items = chatOf([you('hi', 1), said('Hello.', 2, 'msg_same'), said('How can I help?', 3, 'msg_same')]);
  const claude = items.filter((m) => m.who === 'claude');
  assert.deepEqual(claude.map((m) => m.text), ['Hello.', 'How can I help?']);
  assert.equal(claude[0].messageId, 'msg_same');
  assert.equal(claude[1].messageId, 'msg_same');
  assert.ok(claude[0].pos < claude[1].pos);
});

test('a tool call and its result are separate items linked by toolUseId', () => {
  const call = said2([{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a/b.txt', limit: 5 } }], 1);
  const back = you([{ tool_use_id: 'toolu_1', type: 'tool_result', content: [{ type: 'text', text: 'one' }, { type: 'image' }, { type: 'text', text: 'two' }] }], 2);
  const [t, r] = chatOf([call, back]);
  assert.deepEqual([t.who, t.key, t.toolUseId, t.name, t.state, t.summary, t.input], ['tool', 'tool:toolu_1', 'toolu_1', 'Read', 'running',
    { tool: 'Read', text: '/a/b.txt' }, { file_path: '/a/b.txt', limit: 5 }]);
  assert.deepEqual([r.who, r.toolUseId, r.ok, r.preview], ['result', 'toolu_1', true, 'one\ntwo']);
  const failed = itemOf(you([{ type: 'tool_result', content: 'no such file', is_error: true, tool_use_id: 'toolu_2' }], 3), 0);
  assert.deepEqual([failed.ok, failed.preview], [false, 'no such file']);
});

test('a result whose call is not in the lines is still an item', () => {
  const items = chatOf([result(4)]);
  assert.deepEqual(items.map((m) => [m.who, m.toolUseId, m.preview]), [['result', 't', 'file.txt']]);
});

test('thinking, api-request and sidechain lines yield nothing', () => {
  const lines = [
    said2([{ type: 'thinking', thinking: 'hmm "type":"text"', signature: 's' }], 1),
    JSON.stringify({ type: 'api-request', body: { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'not this' }] }] } }),
    JSON.stringify({ type: 'api-request-blob', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } }),
    said('A subagent talking', 2, undefined, { isSidechain: true }),
    said2([{ type: 'tool_use', id: 'ts', name: 'Bash', input: { command: 'ls' } }], 3, { isSidechain: true }),
    you([{ tool_use_id: 'ts', type: 'tool_result', content: 'x' }], 4, { isSidechain: true }),
    JSON.stringify({ type: 'mode', mode: 'plan' }),
    '',
    '{"parentUuid":"x","type":"user","message":',
  ];
  for (const line of lines) assert.equal(itemOf(line, 0), null, line);
});

test('a long result is cut to six lines with a count', () => {
  const stdout = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n';
  const r = itemOf(you([{ tool_use_id: 't', type: 'tool_result', content: stdout }], 1), 0);
  assert.equal(r.preview, 'line 0\nline 1\nline 2\nline 3\nline 4\nline 5\n… (34 more lines)');
  const wide = itemOf(you([{ tool_use_id: 't', type: 'tool_result', content: 'y'.repeat(2000) + '\nnext' }], 1), 0);
  assert.equal(wide.preview, 'y'.repeat(600) + '…\n… (1 more lines)', 'cut at 600 characters when that is shorter');
  const short = itemOf(you([{ tool_use_id: 't', type: 'tool_result', content: 'a\nb\nc\nd\ne\nf' }], 1), 0);
  assert.equal(short.preview, 'a\nb\nc\nd\ne\nf', 'six lines are not cut');
});

test('pos is the byte offset of the line, not its index', () => {
  const lines = [you('héllo ✓ ünïcödé', 1), said('hi', 2)];
  const items = chatOf(lines, 1000);
  assert.equal(items[0].pos, 1000);
  assert.equal(items[1].pos, 1000 + Buffer.byteLength(lines[0]) + 1);
  assert.equal(items[1].key, `claude:${items[1].pos}`);
});

test('what you did not type stays out: skills, reminders, notifications, interrupts', () => {
  const items = chatOf([
    you('real question', 1),
    result(2),
    you([{ type: 'text', text: 'Base directory for this skill: /x' }], 3, { isMeta: true }),
    you('<task-notification>agent done</task-notification>', 4),
    you('<system-reminder>be nice</system-reminder>', 5),
    you([{ type: 'text', text: '[Request interrupted by user]' }], 6),
    you('<local-command-stdout>Set model</local-command-stdout>', 7),
    said('An answer.', 8),
    said('A subagent talking', 9, undefined, { isSidechain: true }),
    JSON.stringify({ type: 'api-request', body: { messages: [{ role: 'user', content: 'not this' }] } }),
  ]);
  assert.deepEqual(shape(items), [['you', 'real question'], ['result', 'file.txt'], ['claude', 'An answer.']]);
});

test('slash commands and shell commands read as you typed them', () => {
  const items = chatOf([you('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>haiku</command-args>', 1),
    you('<bash-input>git status</bash-input>', 2)]);
  assert.deepEqual(items.map((m) => m.text), ['/model haiku', '! git status']);
});

test('a summary where the conversation was compacted shows as a note, once', () => {
  const sum = (s) => you('This session is being continued from a previous conversation…', s, { isCompactSummary: true, isVisibleInTranscriptOnly: true });
  const items = chatOf([you('a', 1), said('b', 2), sum(3), sum(4), you('c', 5)]);
  assert.deepEqual(items.map((m) => m.who), ['you', 'claude', 'note', 'you']);
  assert.equal(items[2].text, 'Earlier conversation was summarized here to save room.');
});

test('a made-up reply from a local command is not Claude talking', () => {
  const items = chatOf([you('/clear', 1), JSON.stringify({ parentUuid: 'x', isSidechain: false, message: { model: '<synthetic>', id: 'm', type: 'message', role: 'assistant',
    content: [{ type: 'text', text: 'No response requested.' }] }, type: 'assistant', timestamp: ts(2) })]);
  assert.deepEqual(items.map((m) => m.who), ['you']);
});

/** A transcript file with `turns` turns, each with a big tool result between question and answer. */
function transcript(turns, pad = 3000) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-')), 's.jsonl'), lines = [];
  for (let i = 0; i < turns; i++) lines.push(you(`question ${i} ✓ ünïcödé`, i * 3), tool(i * 3), you([{ tool_use_id: 't', type: 'tool_result', content: 'x'.repeat(pad) }], i * 3 + 1), said(`answer ${i}`, i * 3 + 2));
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('reading from the end: the newest turns, and whether there are more', async () => {
  const file = transcript(50);
  const r = await readChat(file, { limit: 10, chunk: 4096 });
  assert.equal(r.items.length, 40, 'ten turns of four items');
  assert.deepEqual(shape(r.items.slice(-4)), [['you', 'question 49 ✓ ünïcödé'], ['tool', 'Bash'], ['result', 'x'.repeat(600) + '…'], ['claude', 'answer 49']]);
  assert.equal(r.items[0].text, 'question 40 ✓ ünïcödé', 'whole turns, oldest first');
  assert.equal(r.more, true);
  const all = await readChat(file, { limit: 500, chunk: 4096 });
  assert.equal(all.items.length, 200);
  assert.equal(all.more, false);
  assert.ok(all.items.every((m) => !(m.text ?? m.preview ?? '').includes('�')), 'a character split across chunks is read whole');
  const whole = fs.readFileSync(file);
  assert.ok(all.items.every((m) => whole.subarray(m.pos).toString('utf8', 0, 40).startsWith('{"parentUuid"')), 'pos is where its line starts');
  assert.deepEqual(all.items, chatOf(whole.toString('utf8').split('\n')), 'read back in chunks reads the same as all at once');
});

test('readChat limits by turns and honours before', async () => {
  const file = transcript(3, 100);
  const all = await readChat(file, { chunk: 512 });
  assert.deepEqual([all.items.length, all.more], [12, false], 'fewer turns than the limit: everything');
  const two = await readChat(file, { limit: 2, chunk: 512 });
  assert.deepEqual(two.items, all.items.slice(4));
  assert.equal(two.more, true);
  const lastYou = all.items.findLast((m) => m.who === 'you').pos;
  const earlier = await readChat(file, { limit: 2, before: lastYou, chunk: 512 });
  assert.deepEqual(earlier.items, all.items.slice(0, 8), 'nothing from the last turn');
  assert.equal(earlier.more, false);
  const one = await readChat(file, { limit: 1, before: lastYou, chunk: 512 });
  assert.deepEqual([one.items, one.more], [all.items.slice(4, 8), true]);
  const mid = await readChat(file, { before: lastYou + 3, chunk: 512 });
  assert.deepEqual(mid.items, all.items.slice(0, 9), 'a before inside a line keeps the item that line starts');
});

test('a line longer than a chunk is still read', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-')), 's.jsonl');
  fs.writeFileSync(file, [you('short', 1), said('y'.repeat(50_000), 2)].join('\n') + '\n');
  const r = await readChat(file, { limit: 10, chunk: 1024 });
  assert.deepEqual(r.items.map((m) => m.text.length), [5, 50_000]);
});

test('a missing or empty transcript is no conversation', async () => {
  assert.deepEqual(await readChat('/nowhere/at/all.jsonl'), { items: [], more: false });
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chat-')), 's.jsonl');
  fs.writeFileSync(file, '');
  assert.deepEqual(await readChat(file), { items: [], more: false });
});
