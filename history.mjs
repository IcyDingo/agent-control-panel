// A session's conversation, read from its transcript: what you said, and what Claude said back.
//
// Each stretch between two of your messages keeps the last thing Claude wrote in it: its answer, not the running
// commentary between tool calls. Transcripts grow to hundreds of megabytes (API requests, tool output), so the
// conversation is read from the end in chunks, and only lines that can be talk are parsed.

import fs from 'node:fs';

/** Whether a transcript line can be part of the conversation; the rest is never parsed. */
function talk(line) {
  if (line.startsWith('{"type":')) return false; // API requests, titles, modes: never talk
  const head = line.slice(0, 400);
  if (head.includes('"type":"user"')) return !line.includes('"tool_use_id"');
  if (head.includes('"role":"assistant"')) return line.includes('"type":"text"');
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

/** Transcript lines, oldest first → [{ who: 'you' | 'claude' | 'note', text, at }]. */
export function chatOf(lines) {
  const out = [];
  let reply = null; // the last thing Claude wrote since your last message: { id, parts, at }
  const flush = () => { if (reply) out.push({ who: 'claude', text: reply.parts.join('\n\n'), at: reply.at }); reply = null; };
  const yours = (text, at) => {
    flush();
    const last = out.at(-1);
    if (last?.who === 'you' && last.text === text && Math.abs(at - last.at) < 2000) return; // recorded twice
    out.push({ who: 'you', text, at });
  };
  for (const line of lines) {
    if (!line || !talk(line)) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const at = Date.parse(d.timestamp) || 0;
    if (d.type === 'user' && d.isCompactSummary) {
      flush();
      if (out.at(-1)?.text !== SUMMARY) out.push({ who: 'note', text: SUMMARY, at });
    } else if (d.type === 'user' && !META.some((k) => d[k])) {
      const c = d.message?.content;
      const raw = typeof c === 'string' ? c : Array.isArray(c) && !c.some((b) => b?.type === 'tool_result')
        ? c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '';
      const text = yourText(raw);
      if (text) yours(text, at);
    } else if (d.type === 'attachment' && d.attachment?.type === 'queued_command' && !d.isSidechain) {
      const a = d.attachment, text = typeof a.prompt === 'string' && (a.commandMode ?? 'prompt') === 'prompt' ? yourText(a.prompt) : null;
      if (text) yours(text, at);
    } else if (d.type === 'assistant' && !d.isSidechain && d.message?.model !== '<synthetic>' && Array.isArray(d.message?.content)) {
      const text = d.message.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
      if (!text) continue;
      if (reply && reply.id === d.message.id) { reply.parts.push(text); reply.at = at; }
      else reply = { id: d.message.id, parts: [text], at };
    }
  }
  flush();
  return out;
}

/** The newest `limit` messages of a transcript, oldest first, and whether there are older ones. Reads back from the end
 *  `chunk` bytes at a time, and decodes only whole lines, so a character split between chunks is read whole. */
export async function readChat(file, { limit = 60, chunk = 4 << 20 } = {}) {
  let fh;
  try { fh = await fs.promises.open(file, 'r'); } catch { return { items: [], more: false }; }
  try {
    let pos = (await fh.stat()).size, carry = Buffer.alloc(0), lines = [], items = [];
    while (pos > 0 && items.length <= limit) {
      const len = Math.min(chunk, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, pos);
      const data = carry.length ? Buffer.concat([buf, carry]) : buf;
      const nl = pos > 0 ? data.indexOf(10) : -1; // a newline byte is never inside a character
      if (pos > 0 && nl < 0) { carry = data; continue; } // one line longer than a chunk: keep reading back
      carry = pos > 0 ? data.subarray(0, nl) : Buffer.alloc(0);
      const fresh = data.subarray(pos > 0 ? nl + 1 : 0).toString('utf8').split('\n').filter(talk);
      if (!fresh.length) continue;
      lines = fresh.concat(lines);
      items = chatOf(lines);
    }
    // Reading stopped partway: the oldest stretch may have lost its first message, so it is left out.
    return { items: items.slice(-limit), more: pos > 0 || items.length > limit };
  } finally { await fh.close(); }
}
