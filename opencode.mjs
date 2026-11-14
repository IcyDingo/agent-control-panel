// OpenCode (opencode.ai): the second kind of agent Glue runs, next to Claude Code.
//
// OpenCode 2 keeps one background service per user, shared by its terminal app, its desktop app and anything else that
// talks to it. That service owns every session, in any folder: Glue creates sessions there, sends them prompts, reads
// their messages and answers their permission requests over its HTTP API (/api), and follows its event stream
// (/api/event) for live status. The `opencode` command is used only to set up: find the binary, start the service,
// sign in to a provider.
//
// The API calls itself experimental, so every call it makes is in this file, and everything that turns what it says
// into what the board shows is a pure function below, tested without a service. Node standard library only.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { summaryOf, previewOf } from './history.mjs';

/** An OpenCode session id. */
export const OC_ID = /^ses[\w-]{4,100}$/;
/** A model as OpenCode names it: provider/model, with an optional #variant. */
export const MODEL_REF = /^[\w.@-]{1,60}\/[\w.@:/[\]-]{1,120}(#[\w.-]{1,40})?$/;
/** How Glue's permission modes read for OpenCode, which has no modes of its own: rules, and the plan agent. */
export const OC_MODES = new Set(['', 'default', 'acceptEdits', 'plan', 'auto']);

// ---------------------------------------------------------------- finding the service

/** Where OpenCode writes the address and password of its running service. */
export function serviceFile({ home = os.homedir(), env = process.env } = {}) {
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local', 'state');
  return path.join(state, 'opencode', 'service.json');
}

/** The service's `{ url, password }` from its file's text, or null. The file's fields are not documented, so the usual
 *  names for each are accepted: a url (or a host and a port), and a password (or a token). Only a local address is. */
export function parseService(text) {
  let d;
  try { d = JSON.parse(text); } catch { return null; }
  if (!d || typeof d !== 'object') return null;
  const s = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  let url = s(d.url) ?? s(d.baseUrl) ?? s(d.baseURL) ?? s(d.endpoint) ?? s(d.origin) ?? s(d.address);
  if (!url) {
    const port = Number(d.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    url = `http://${s(d.hostname) ?? s(d.host) ?? '127.0.0.1'}:${port}`;
  }
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return null;
  const password = s(d.password) ?? s(d.token) ?? s(d.secret) ?? null;
  return { url: `${u.protocol}//${u.host}`, password, username: s(d.username) ?? 'opencode' };
}

/** The service to talk to: ACP_OPENCODE_URL (and ACP_OPENCODE_PASSWORD) when set, else OpenCode's own file. */
export function findService({ home = os.homedir(), env = process.env } = {}) {
  if (env.ACP_OPENCODE_URL) return parseService(JSON.stringify({ url: env.ACP_OPENCODE_URL, password: env.ACP_OPENCODE_PASSWORD ?? null }));
  try {
    const f = serviceFile({ home, env });
    const fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      if (!fs.fstatSync(fd).isFile()) return null;
      const buf = Buffer.alloc(65536);
      return parseService(buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0)));
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/** The `opencode` binary on PATH, or in the places its installers put it, or null. */
export function findBinary({ home = os.homedir(), env = process.env } = {}) {
  const dirs = [...String(env.PATH ?? '').split(':').filter(Boolean), path.join(home, '.opencode', 'bin'), path.join(home, '.local', 'bin'),
                '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs) {
    const f = path.join(d, 'opencode');
    try { fs.accessSync(f, fs.constants.X_OK); if (fs.statSync(f).isFile()) return f; } catch {}
  }
  return null;
}

// ---------------------------------------------------------------- the client

export class OcError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

/** A client for the service `service()` names (looked up at each call, so a service that starts later is found). */
export function createClient({ service, fetch: doFetch = globalThis.fetch, timeout = 10_000 }) {
  const headers = (svc, json) => ({
    ...(json ? { 'content-type': 'application/json' } : {}),
    accept: 'application/json',
    ...(svc.password ? { authorization: 'Basic ' + Buffer.from(`${svc.username ?? 'opencode'}:${svc.password}`).toString('base64') } : {}),
  });

  async function req(method, p, { body, query, ms = timeout } = {}) {
    const svc = service();
    if (!svc) throw new OcError('OpenCode is not running.', 0);
    const u = new URL('/api' + p, svc.url);
    for (const [k, v] of Object.entries(query ?? {})) if (v != null) u.searchParams.set(k, String(v));
    const c = new AbortController(), t = setTimeout(() => c.abort(), ms);
    let r;
    try {
      r = await doFetch(u, { method, headers: headers(svc, body !== undefined), body: body === undefined ? undefined : JSON.stringify(body), signal: c.signal });
    } catch (e) {
      throw new OcError(e?.name === 'AbortError' ? 'OpenCode did not answer in time.' : 'OpenCode is not running.', 0);
    } finally { clearTimeout(t); }
    const text = await r.text().catch(() => '');
    let d = null;
    try { d = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) {
      const why = d?.message ?? d?.error?.message ?? d?.data?.message ?? (typeof d?.error === 'string' ? d.error : null);
      throw new OcError(r.status === 401 ? 'OpenCode refused Glue: its password did not match.' : `OpenCode: ${why ?? `HTTP ${r.status}`}`, r.status);
    }
    return d && typeof d === 'object' && 'data' in d ? d.data : d;
  }
  const at = (dir) => (dir ? { 'location[directory]': dir } : {});
  const sid = (id) => { if (!OC_ID.test(String(id))) throw new OcError('That is not an OpenCode session.'); return encodeURIComponent(id); };

  return {
    info: async () => req('GET', '/info', { ms: 3000 }),
    createSession: async ({ directory, agent, model, permissions, title }) => req('POST', '/session', { body: {
      location: { directory }, ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(permissions ? { permissions } : {}), ...(title ? { metadata: { title } } : {}) } }),
    session: async (id) => req('GET', `/session/${sid(id)}`),
    prompt: async (id, text, { delivery = 'queue' } = {}) => req('POST', `/session/${sid(id)}/prompt`, { body: { text, delivery } }),
    /** One answer from the session's model to `prompt`, outside its conversation: `{ text, tokens, cost }`. */
    generate: async (id, prompt, { ms = 90_000 } = {}) => req('POST', `/session/${sid(id)}/generate`, { body: { prompt }, ms }),
    synthetic: async (id, text) => req('POST', `/session/${sid(id)}/synthetic`, { body: { text, resume: false } }),
    messages: async (id, { limit = 400 } = {}) => req('GET', `/session/${sid(id)}/message`, { query: { limit, order: 'asc' } }),
    interrupt: async (id) => req('POST', `/session/${sid(id)}/interrupt`),
    setAgent: async (id, agent) => req('POST', `/session/${sid(id)}/agent`, { body: { agent } }),
    setPermissions: async (id, permissions) => req('PATCH', `/session/${sid(id)}`, { body: { permissions } }),
    active: async () => req('GET', '/session/active', { ms: 4000 }),
    permissions: async (dir) => req('GET', '/permission/request', { query: at(dir), ms: 4000 }),
    replyPermission: async (id, requestID, decision, message) => req('POST', `/session/${sid(id)}/permission/${encodeURIComponent(requestID)}/reply`,
      { body: { decision, ...(message ? { message } : {}) } }),
    forms: async (dir) => req('GET', '/form', { query: at(dir), ms: 4000 }),
    replyForm: async (id, formID, answer) => req('POST', `/session/${sid(id)}/form/${encodeURIComponent(formID)}/reply`, { body: { answer } }),
    cancelForm: async (id, formID, message) => req('DELETE', `/session/${sid(id)}/form/${encodeURIComponent(formID)}`, { query: { message } }),
    models: async (dir) => req('GET', '/model', { query: at(dir) }),
    defaultModel: async (dir) => req('GET', '/model/default', { query: at(dir) }),
    providers: async (dir) => req('GET', '/provider', { query: at(dir) }),
    // Connecting providers ("integrations"): with a key, or by signing in in a browser. Their credentials stay in
    // OpenCode; Glue passes a key through and keeps nothing.
    integrations: async () => req('GET', '/integration'),
    credentials: async () => req('GET', '/credential'),
    connectKey: async (integrationID, key, answer) => req('POST', `/integration/${encodeURIComponent(integrationID)}/connect/key`,
      { body: { key, ...(answer && Object.keys(answer).length ? { answer } : {}) } }),
    connectOAuth: async (integrationID, methodID, answer) => req('POST', `/integration/${encodeURIComponent(integrationID)}/connect/oauth`,
      { body: { methodID, ...(answer && Object.keys(answer).length ? { answer } : {}) } }),
    oauthStatus: async (integrationID, attemptID) => req('GET', `/integration/${encodeURIComponent(integrationID)}/connect/oauth/${encodeURIComponent(attemptID)}`),
    oauthComplete: async (integrationID, attemptID, code) => req('POST', `/integration/${encodeURIComponent(integrationID)}/connect/oauth/${encodeURIComponent(attemptID)}/complete`,
      { body: code ? { code } : {} }),
    removeCredential: async (credentialID) => req('DELETE', `/credential/${encodeURIComponent(credentialID)}`),

    /** Follow the service's events: `onEvent(event)` for each, `onState(up)` when the stream opens or drops. It comes
     *  back by itself, waiting longer each time it can't (1 s up to 30 s). The stream replays nothing, so a reconnect is
     *  where the caller reads the state again. */
    subscribe(onEvent, onState = () => {}) {
      let stopped = false, c = null, wait = 1000, timer = null;
      const loop = async () => {
        if (stopped) return;
        const svc = service();
        if (svc) {
          c = new AbortController();
          try {
            const r = await doFetch(new URL('/api/event', svc.url), { headers: { ...headers(svc, false), accept: 'text/event-stream' }, signal: c.signal });
            if (!r.ok || !r.body) throw new Error(`HTTP ${r.status}`);
            onState(true);
            wait = 1000;
            const parse = sseParser((data) => { try { onEvent(JSON.parse(data)); } catch {} });
            const dec = new TextDecoder();
            for await (const chunk of r.body) { if (stopped) break; parse(dec.decode(chunk, { stream: true })); }
          } catch {}
          if (!stopped) onState(false);
        }
        if (stopped) return;
        timer = setTimeout(loop, wait);
        wait = Math.min(wait * 2, 30_000);
      };
      loop();
      return { stop() { stopped = true; clearTimeout(timer); try { c?.abort(); } catch {} } };
    },
  };
}

/** Text from an event stream → `onData(data)` once per event, with its data lines joined. */
export function sseParser(onData) {
  let buf = '', data = [];
  return (text) => {
    buf += text;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      if (line === '') { if (data.length) onData(data.join('\n')); data = []; }
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
  };
}

// ---------------------------------------------------------------- what Glue asks for, in OpenCode's terms

/** The permission rules for one of Glue's modes. OpenCode allows everything unless told otherwise, and the last rule
 *  that matches wins. Ask (the default) asks before edits, shell commands and fetching the web; accept edits asks
 *  before shell commands only; auto asks for nothing. Plan runs on OpenCode's plan agent, which can't edit. */
export function permissionRules(mode) {
  const ask = (action) => ({ action, resource: '*', effect: 'ask' });
  if (mode === 'auto') return [];
  if (mode === 'acceptEdits') return [ask('shell')];
  return [ask('edit'), ask('shell'), ask('webfetch')];
}
/** OpenCode's agent for one of Glue's modes. */
export const agentFor = (mode) => (mode === 'plan' ? 'plan' : 'build');

/** 'provider/model#variant' → OpenCode's model reference, or null. */
export function modelRef(s) {
  if (typeof s !== 'string' || !MODEL_REF.test(s)) return null;
  const [main, variant] = s.split('#'), i = main.indexOf('/');
  return { providerID: main.slice(0, i), id: main.slice(i + 1), ...(variant ? { variant } : {}) };
}
/** OpenCode's model reference → 'provider/model#variant'. */
export const refText = (m) => (m && m.providerID && m.id ? `${m.providerID}/${m.id}${m.variant ? '#' + m.variant : ''}` : null);

/** The models a picker offers: chat models that can call tools (an agent is nothing without them), by provider. */
export function pickable(models) {
  return (Array.isArray(models) ? models : []).filter((m) => m && m.providerID && (m.id || m.modelID)
      && (m.type == null || m.type === 'chat') && m.capabilities?.tools !== false)
    .map((m) => ({ ref: `${m.providerID}/${m.id ?? m.modelID}`, name: m.name || m.id || m.modelID, provider: m.providerID }))
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name));
}

/** OpenCode's providers and the credentials it holds → what the Connect dialog shows: each provider's name, how it can
 *  connect (a key, a browser sign-in, or a command only its terminal can run), the extra fields each way asks for, and
 *  which accounts it already has. A credential's secret never leaves here. */
export function providersOf(integrations, credentials) {
  const creds = Array.isArray(credentials) ? credentials : [];
  const field = (f) => (f && typeof f.key === 'string' && !f.hidden && (f.type === 'string' || f.type == null)
    ? { key: f.key, title: String(f.title || f.description || f.key).slice(0, 120), required: f.required === true, placeholder: f.placeholder ? String(f.placeholder).slice(0, 120) : '',
        options: Array.isArray(f.options) ? f.options.slice(0, 50).map((o) => ({ value: String(o.value), label: String(o.label ?? o.value) })) : null } : null);
  const fieldsOf = (m) => (Array.isArray(m?.form) ? m.form.map(field).filter(Boolean) : []);
  return (Array.isArray(integrations) ? integrations : []).filter((i) => i && typeof i.id === 'string').map((i) => ({
    id: i.id, name: String(i.name || i.id).slice(0, 80),
    methods: (Array.isArray(i.methods) ? i.methods : []).map((m) => (
      m?.type === 'key' ? { type: 'key', id: null, label: String(m.label || 'API key'), fields: fieldsOf(m) }
      : m?.type === 'oauth' ? { type: 'oauth', id: String(m.id), label: String(m.label || 'Sign in'), fields: fieldsOf(m) }
      : m?.type === 'command' ? { type: 'command', id: String(m.id), label: String(m.label || 'Sign in in a terminal') }
      : null)).filter(Boolean),
    accounts: creds.filter((c) => c?.integrationID === i.id).map((c) => ({ id: String(c.id), label: String(c.label || 'Account'), active: c.active === true, kind: c.value?.type ?? null })),
  })).sort((a, b) => (b.accounts.length > 0) - (a.accounts.length > 0) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------- what OpenCode says, in Glue's terms

const SUMMARY = 'Earlier conversation was summarized here to save room.';
const toolText = (content) => (Array.isArray(content) ? content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n') : '');
const timeOf = (m) => Number(m?.time?.created) || 0;

/** A session's messages → the thread items history.mjs makes from a transcript (you, claude, tool, result, note), so
 *  the Chat shows both kinds the same way. `pos` keeps them in message order. */
export function itemsOf(messages) {
  const out = [];
  const list = (Array.isArray(messages) ? messages : []).slice().sort((a, b) => timeOf(a) - timeOf(b));
  list.forEach((m, mi) => {
    const at = timeOf(m), base = (mi + 1) * 1000, id = String(m?.id ?? mi);
    if (m?.type === 'user') {
      const text = String(m.text ?? '').trim();
      if (text) out.push({ who: 'you', key: `you:${id}`, text, at, pos: base });
    } else if (m?.type === 'synthetic') {
      out.push({ who: 'note', key: `note:${id}`, text: 'Glue handed it what came before.', at, pos: base });
    } else if (m?.type === 'compaction') {
      out.push({ who: 'note', key: `note:${id}`, text: SUMMARY, at, pos: base });
    } else if (m?.type === 'shell' && typeof m.command === 'string') {
      out.push({ who: 'you', key: `you:${id}`, text: `! ${m.command}`, at, pos: base });
    } else if (m?.type === 'idle' && m.outcome === 'failed' && m.error?.message) {
      const text = `It stopped: ${errorText(m.error)}`;
      if (out.at(-1)?.text !== text) out.push({ who: 'note', key: `note:${id}`, text, error: true, at, pos: base });
    } else if (m?.type === 'assistant' && Array.isArray(m.content)) {
      m.content.forEach((b, bi) => {
        const pos = base + bi + 1;
        if (b?.type === 'text' && b.text?.trim()) out.push({ who: 'claude', key: `claude:${id}:${bi}`, text: b.text.trim(), messageId: id, at, pos });
        else if (b?.type === 'tool' && b.id) {
          const st = b.state ?? {}, input = st.input && typeof st.input === 'object' ? st.input : {};
          out.push({ who: 'tool', key: `tool:${b.id}`, toolUseId: b.id, name: b.name ?? 'tool', summary: summaryOf(b.name ?? 'tool', input), input,
                     state: 'running', at: Number(b.time?.created) || at, pos });
          if (st.status === 'completed' || st.status === 'error') {
            const text = st.status === 'error' ? st.error?.message ?? toolText(st.content) : toolText(st.content);
            out.push({ who: 'result', key: `result:${b.id}`, toolUseId: b.id, ok: st.status === 'completed', preview: previewOf(text),
                       at: Number(b.time?.completed) || at, pos: pos + 0.5 });
          }
        }
      });
      // A reply that ended in an error (a provider refusing the call, say) carries it on the message itself.
      if (m.error?.message) out.push({ who: 'note', key: `note:${id}:error`, text: `It stopped: ${errorText(m.error)}`, error: true, at, pos: base + 999 });
    }
  });
  return out;
}

/** A turn's error in one line: OpenCode's message, with the provider's own error name when it gives one. */
export const errorText = (err) => String(err?.message ?? 'an error').replace(/\s+/g, ' ').trim().slice(0, 500);

/** The error its latest turn ended with, or null: on the reply that failed (`error`, finish "error"), or on the turn's
 *  closing idle (outcome "failed"). A turn is everything after your latest message; a later reply or a turn that went
 *  on to succeed clears it. */
export function turnErrorOf(messages) {
  const list = (Array.isArray(messages) ? messages : []).slice().sort((a, b) => timeOf(a) - timeOf(b));
  let err = null;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m?.type === 'user' || m?.type === 'synthetic') break;
    if (m?.type === 'idle') { if (m.outcome === 'failed' && m.error) err ??= m.error; else if (!err) return null; }
    if (m?.type === 'assistant' && m.error) err ??= m.error;
  }
  return err ? { message: errorText(err), type: typeof err.type === 'string' ? err.type.slice(0, 80) : null, status: Number.isInteger(err.status) ? err.status : null } : null;
}

/** What it said last, for the board's tile. */
export function lastSaidOf(messages) {
  const list = (Array.isArray(messages) ? messages : []).slice().sort((a, b) => timeOf(a) - timeOf(b));
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m?.type !== 'assistant' || !Array.isArray(m.content)) continue;
    const text = m.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n').trim();
    if (text) return text;
  }
  return null;
}
/** The model of its newest reply, as 'provider/model'. */
export function modelOfMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) if (list[i]?.type === 'assistant' && refText(list[i].model)) return refText(list[i].model);
  return null;
}

/** A permission OpenCode asks for → a card in the shape of a held request. A shell command reads as Claude's Bash,
 *  an edit as an edit to its file, anything else as its action and what it is on. */
export function requestOf(p) {
  const res = Array.isArray(p?.resources) ? p.resources.map(String) : [];
  const action = String(p?.action ?? 'permission');
  const toolName = action === 'shell' || action === 'bash' ? 'Shell' : action === 'edit' ? 'Edit' : action === 'webfetch' ? 'WebFetch' : action;
  const toolInput = action === 'shell' || action === 'bash' ? { command: res.join('\n') }
    : action === 'edit' ? { file_path: res.join(', ') }
    : action === 'webfetch' ? { url: res.join(' ') }
    : { resources: res };
  if (p?.message) toolInput.description = String(p.message).slice(0, 500);
  return { id: `oc:${p.sessionID}:${p.id}`, oc: 'permission', ocId: p.id, sessionId: p.sessionID, agentId: null, toolName, toolInput,
           toolUseId: p.source?.id ?? null, suggestions: Array.isArray(p.save) && p.save.length ? [{ oc: 'always', save: p.save.slice(0, 10) }] : [],
           permissionMode: null };
}

const fieldsOf = (form) => (Array.isArray(form?.fields) ? form.fields : []).filter((f) => f && typeof f.key === 'string' && !f.hidden);
/** A form OpenCode puts to you → a question card, each field a question. Only fields a question card can answer
 *  (text, a pick from options, several picks, yes or no) are asked; a form with any other kind is answered in OpenCode. */
export function questionOf(form) {
  const fields = fieldsOf(form);
  const asks = fields.map((f) => ({
    question: String(f.title || f.description || f.key).slice(0, 300), header: form.title ? String(form.title).slice(0, 40) : undefined,
    options: f.type === 'boolean' ? [{ label: 'Yes' }, { label: 'No' }]
      : Array.isArray(f.options) ? f.options.slice(0, 20).map((o) => ({ label: String(o.label ?? o.value) })) : [],
    multiSelect: f.type === 'multiselect',
  }));
  const answerable = fields.length > 0 && fields.every((f) => ['string', 'multiselect', 'boolean', 'number', 'integer'].includes(f.type));
  return { id: `oc:${form.sessionID}:${form.id}`, oc: 'form', ocId: form.id, sessionId: form.sessionID, agentId: null, toolName: 'AskUserQuestion',
           toolInput: { questions: asks }, answerable, permissionMode: null };
}
/** A question card's answers ({ question text: answer }) → the form's answer ({ key: value }), or { error }. */
export function formAnswer(form, answers) {
  const out = {};
  for (const f of fieldsOf(form)) {
    const q = String(f.title || f.description || f.key).slice(0, 300), a = answers?.[q];
    if (typeof a !== 'string' || !a.trim()) { if (f.required) return { error: 'Answer every question before sending.' }; continue; }
    const pick = (label) => f.options?.find((o) => String(o.label ?? o.value) === label)?.value ?? label;
    if (f.type === 'boolean') out[f.key] = /^(yes|true)$/i.test(a.trim());
    else if (f.type === 'number' || f.type === 'integer') {
      const n = Number(a);
      if (!Number.isFinite(n) || (f.type === 'integer' && !Number.isInteger(n))) return { error: `${q} takes a number.` };
      out[f.key] = n;
    } else if (f.type === 'multiselect') out[f.key] = a.split(',').map((x) => x.trim()).filter(Boolean).map(pick);
    else out[f.key] = pick(a.trim());
  }
  return { answer: out };
}

/** What an event changes about a session's status, or null when it changes nothing. `status` is idle, busy or
 *  retrying; `note` is a passing word on it (a retry), cleared when the status moves on; `error` is what a failed turn
 *  ended with, which stays until a new turn starts (`clearError`), so the idle that follows a failure can't wipe it;
 *  `refresh` asks the caller to read its messages again (the chat, what it said last). */
export function statusOf(e) {
  const d = e?.data ?? {};
  const failed = () => ({ sessionID: d.sessionID, status: 'idle', note: null, error: { message: errorText(d.error), type: typeof d.error?.type === 'string' ? d.error.type.slice(0, 80) : null,
                                                                                     status: Number.isInteger(d.error?.status) ? d.error.status : null }, refresh: true });
  switch (e?.type) {
    case 'session.status': {
      const t = d.status?.type;
      if (t === 'idle') return { sessionID: d.sessionID, status: 'idle', note: null, refresh: true };
      if (t === 'busy') return { sessionID: d.sessionID, status: 'busy', note: null };
      if (t === 'retry') return { sessionID: d.sessionID, status: 'busy', note: `Trying again (${d.status.attempt ?? 1}): ${String(d.status.message ?? '').slice(0, 200)}` };
      return null;
    }
    case 'session.idle': return { sessionID: d.sessionID, status: 'idle', refresh: true };
    case 'session.execution.started': return { sessionID: d.sessionID, status: 'busy', note: null, clearError: true };
    case 'session.execution.failed': return failed();
    case 'session.step.failed': return d.error ? { ...failed(), status: undefined } : null; // the turn may still go on (a retry); its end says
    case 'session.execution.succeeded':
    case 'session.execution.interrupted': return { sessionID: d.sessionID, status: 'idle', clearError: true, refresh: true };
    case 'session.tool.called': return { sessionID: d.sessionID, tool: { input: d.input ?? {} }, refresh: true };
    case 'session.tool.success':
    case 'session.tool.failed':
    case 'session.text.ended': return { sessionID: d.sessionID, refresh: true };
    case 'session.deleted': return { sessionID: d.sessionID ?? d.id, deleted: true };
    case 'permission.asked': return { sessionID: d.sessionID, asks: true };
    case 'permission.replied': return { sessionID: d.sessionID, asks: true };
    case 'form.created': return { sessionID: d.form?.sessionID, asks: true };
    case 'form.replied':
    case 'form.cancelled': return { sessionID: d.sessionID ?? d.form?.sessionID, asks: true };
    default: return null;
  }
}

/** Whether an OpenCode error is a provider's limit: what makes the next handover worth asking about. */
export const isLimit = (err) => Boolean(err) && (err.reason === 'rate_limit' || err.status === 429 || /rate.?limit|quota|usage limit/i.test(String(err.message ?? '')));

// ---------------------------------------------------------------- handing a Claude session over

const BRIEF_MAX = 30_000;
/** The brief an OpenCode session starts from when it carries on a Claude session's work: the task, the conversation so
 *  far (newest kept when it is long), the state of the files, and where the project's rules are. */
export function briefOf({ prompt, items = [], status = '', diffStat = '', claudeMd = false, agentsMd = false, limit = null, max = BRIEF_MAX }) {
  const lines = [];
  for (const m of items) {
    if (m.who === 'you') lines.push(`User: ${m.text}`);
    else if (m.who === 'claude') lines.push(`Claude: ${m.text}`);
    else if (m.who === 'tool') lines.push(`  (tool) ${m.summary?.tool ?? m.name}: ${m.summary?.text ?? ''}`.trimEnd());
    else if (m.who === 'note') lines.push(`(${m.text})`);
  }
  let talk = lines.join('\n');
  if (talk.length > max) talk = '[…earlier conversation left out…]\n' + talk.slice(-max);
  return [
    'You are taking over a task that another coding agent (Claude Code) was working on in this folder.',
    limit ? `It stopped because it reached its usage limit${limit.resetsAt ? ` (it resets ${new Date(limit.resetsAt).toISOString()})` : ''}.` : null,
    prompt ? `\n## The task it was given\n${prompt}` : null,
    `\n## The conversation so far\n${talk || '(nothing saved)'}`,
    status || diffStat ? `\n## The files now\n${[status && `git status --short:\n${status}`, diffStat && `git diff --stat:\n${diffStat}`].filter(Boolean).join('\n\n')}` : null,
    claudeMd && !agentsMd ? '\nThis project keeps its rules for agents in CLAUDE.md. Read it before you change anything.' : null,
    '\nCarry on from where it stopped. Check the current state of the files before you change them.',
  ].filter((x) => x != null).join('\n');
}
