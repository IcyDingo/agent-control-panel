// A session's conversation from its transcript: what you said, and what Claude said back. Run with `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chatOf, readChat } from '../history.mjs';

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

test('a turn: what you asked, and the last thing Claude said in it', () => {
  const items = chatOf([you('list the files', 1), said('Checking.', 2), tool(3), result(4), said('There is one: file.txt.', 5)]);
  assert.deepEqual(items, [{ who: 'you', text: 'list the files', at: at(1) }, { who: 'claude', text: 'There is one: file.txt.', at: at(5) }]);
});

test('a message sent while it worked splits the turn: each part keeps its own last reply', () => {
  const items = chatOf([you('build it', 1), said('Starting.', 2), queued('also add tests', 3), said('Noted, after the build.', 4), tool(5), said('Built, with tests.', 6)]);
  assert.deepEqual(items.map((m) => [m.who, m.text]), [['you', 'build it'], ['claude', 'Starting.'], ['you', 'also add tests'], ['claude', 'Built, with tests.']]);
});

test('one reply written in several blocks reads as one', () => {
  const items = chatOf([you('hi', 1), said('Hello.', 2, 'msg_same'), said('How can I help?', 3, 'msg_same')]);
  assert.equal(items.at(-1).text, 'Hello.\n\nHow can I help?');
});

test('what you did not type stays out: tool results, skills, reminders, notifications, interrupts', () => {
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
  assert.deepEqual(items.map((m) => m.text), ['real question', 'An answer.']);
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

test('reading from the end: the newest messages, and whether there are more', async () => {
  const file = transcript(50);
  const r = await readChat(file, { limit: 10, chunk: 4096 });
  assert.equal(r.items.length, 10);
  assert.deepEqual(r.items.slice(-2).map((m) => m.text), ['question 49 ✓ ünïcödé', 'answer 49']);
  assert.equal(r.items[0].text, 'question 45 ✓ ünïcödé', 'whole turns, oldest first');
  assert.equal(r.more, true);
  const all = await readChat(file, { limit: 500, chunk: 4096 });
  assert.equal(all.items.length, 100);
  assert.equal(all.more, false);
  assert.ok(all.items.every((m) => !m.text.includes('�')), 'a character split across chunks is read whole');
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
