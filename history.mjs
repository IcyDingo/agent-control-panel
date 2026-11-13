// A session's conversation, read from its transcript: what you said, and everything Claude said and did back.
//
// One transcript line yields at most one thread item: your message, one text block of Claude's, one tool call, one
// tool result, or a note where the conversation was compacted. Each item carries `pos`, the byte offset of its line,
// so a thread read back from the file and one followed as it grows can be stitched without showing an item twice.
// Transcripts grow to hundreds of megabytes (API requests, tool output), so the conversation is read from the end in
// chunks, and only lines that can be talk are parsed.

import fs from 'node:fs';

/** Whether a transcript line can be part of the conversation; the rest is never parsed. */
function talk(line) {
  if (line.startsWith('{"type":')) return false; // API requests, titles, modes: never talk
  const head = line.slice(0, 400);
  if (head.includes('"type":"user"')) return true;
  if (head.includes('"role":"assistant"')) return line.includes('"type":"text"') || line.includes('"type":"tool_use"'); // not thinking
  return line.includes('"type":"queued_command"');
}
const META = ['isMeta', 'isSidechain', 'isVisibleInTranscriptOnly'];
const SUMMARY = 'Earlier conversation was summarized here to save room.';

/** What you typed, as you typed it, or null for what Claude Code sent in your name. */
function yourText(text) {
  const t = text.trim();
  const cmd = t.match(/<command-name>\s*(\S+?)\s*<\/command-name>/);
  if (cmd) return [cmd[1], t.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1].trim()].filter(Boolean).join(' ');
  const bash = t.match(/^<bash-input>([\s\S]*?)<\/bash-input>$/);
  if (bash) return `! ${bash[1].trim()}`;
  if (!t || t.startsWith('<') || t.startsWith('[Request interrupted')) return null;
  return t;
}

/** How a tool call reads in one line: what it ran, read or looked for. The tile and permission cards use it too. */
export function summaryOf(tool, input = {}) {
  const pick = input.command ?? input.file_path ?? input.notebook_path ?? input.pattern ?? input.url
    ?? input.description ?? input.query ?? input.prompt
    ?? Object.values(input).find((v) => typeof v === 'string') ?? '';
  return { tool, text: String(pick).replace(/\s+/g, ' ').slice(0, 240) };
}

/** The start of a tool's output: its first six lines or 600 characters, whichever is shorter, and how much is left. */
export function previewOf(content) {
  const text = typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
  const lines = text.trimEnd().split('\n');
  let head = lines.slice(0, 6).join('\n');
  const wide = head.length > 600;
  if (wide) head = head.slice(0, 600) + '…';
  const rest = lines.length - head.split('\n').length;
  return rest > 0 ? `${head}\n… (${rest} more lines)` : head;
}

/** One transcript line, starting at byte `pos` of its file → its thread item, or null for a line that is not talk. */
export function itemOf(line, pos) {
  if (!line || !talk(line)) return null;
  let d;
  try { d = JSON.parse(line); } catch { return null; }
  const at = Date.parse(d.timestamp) || 0, c = d.message?.content;
  if (d.type === 'user' && d.isCompactSummary) return { who: 'note', key: `note:${pos}`, text: SUMMARY, at, pos };
  if (d.type === 'user' && !META.some((k) => d[k])) {
    const res = Array.isArray(c) && c.find((b) => b?.type === 'tool_result');
    if (res) return { who: 'result', key: `result:${pos}`, toolUseId: res.tool_use_id, ok: !res.is_error, preview: previewOf(res.content), at, pos };
    const text = yourText(typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
    return text ? { who: 'you', key: `you:${pos}`, text, at, pos } : null;
  }
  if (d.type === 'attachment' && d.attachment?.type === 'queued_command' && !d.isSidechain) {
    const a = d.attachment, text = typeof a.prompt === 'string' && (a.commandMode ?? 'prompt') === 'prompt' ? yourText(a.prompt) : null;
    return text ? { who: 'you', key: `you:${pos}`, text, at, pos } : null;
  }
  if (d.type !== 'assistant' || d.isSidechain || d.message?.model === '<synthetic>' || !Array.isArray(c)) return null;
  // Claude Code writes each block of a reply on a line of its own; the first block that shows is the line's item.
  const b = c.find((b) => (b?.type === 'text' && b.text?.trim()) || b?.type === 'tool_use');
  if (b?.type === 'text') return { who: 'claude', key: `claude:${pos}`, text: b.text.trim(), messageId: d.message.id, at, pos };
  if (b?.type === 'tool_use') {
    const input = b.input ?? {};
    return { who: 'tool', key: `tool:${b.id}`, toolUseId: b.id, name: b.name, summary: summaryOf(b.name, input), input, state: 'running', at, pos };
  }
  return null;
}

/** Thread items, oldest first, with the doubles left out: your message recorded twice, a compaction note twice. */
function tidy(items) {
  const out = [];
  let you = null; // your last message so far
  for (const m of items) {
    if (m.who === 'you' && you?.text === m.text && Math.abs(m.at - you.at) < 2000) continue; // recorded twice
    if (m.who === 'note' && out.at(-1)?.who === 'note') continue;
    if (m.who === 'you') you = m;
    out.push(m);
  }
  return out;
}

/** Transcript lines, oldest first, the first starting at byte `pos0` of its file → thread items, oldest first. */
export function chatOf(lines, pos0 = 0) {
  const items = [];
  let pos = pos0;
  for (const line of lines) {
    const item = itemOf(line, pos);
    if (item) items.push(item);
    pos += Buffer.byteLength(line, 'utf8') + 1; // and its newline
  }
  return tidy(items);
}

/** The newest `limit` turns of a transcript (a turn starts at a message of yours) whose items start before byte
 *  `before`, oldest first, and whether there is more before them. Reads back from the end `chunk` bytes at a time, and
 *  decodes only whole lines, so a character split between chunks is read whole. */
export async function readChat(file, { limit = 60, before = Infinity, chunk = 4 << 20 } = {}) {
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch { return { items: [], more: false }; }
  try {
    const size = (await fh.stat()).size;
    let pos = size;
    if (before < size) { // start at `before` when a line starts there; inside a line, read from the end and filter
      const b = Buffer.alloc(1);
      if (before <= 0) pos = 0;
      else if ((await fh.read(b, 0, 1, before - 1)).bytesRead && b[0] === 10) pos = before;
    }
    let carry = Buffer.alloc(0), items = [], turns = 0;
    while (pos > 0 && turns < limit) {
      const len = Math.min(chunk, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos);
      const data = carry.length ? Buffer.concat([buf, carry]) : buf;
      const nl = pos > 0 ? data.indexOf(10) : -1; // a newline byte is never inside a character
      if (pos > 0 && nl < 0) { carry = data; continue; } // one line longer than a chunk: keep reading back
      carry = pos > 0 ? data.subarray(0, nl) : Buffer.alloc(0);
      const start = pos > 0 ? nl + 1 : 0;
      const fresh = chatOf(data.subarray(start).toString('utf8').split('\n'), pos + start).filter((m) => m.pos < before);
      if (!fresh.length) continue;
      items = tidy(fresh.concat(items));
      turns = items.reduce((n, m) => n + (m.who === 'you'), 0);
    }
    // Reading stopped partway: the oldest turn may have lost its start, so only whole turns are kept.
    const yours = items.reduce((at, m, i) => (m.who === 'you' ? at.concat(i) : at), []);
    const cut = yours.length > limit || (pos > 0 && yours.length >= limit) ? yours.at(-limit) : 0;
    return { items: items.slice(cut), more: pos > 0 || cut > 0 };
  } finally { await fh.close(); }
}
