// Glue: a local browser view over every Claude Code session on this machine.
//
// Data in:   `claude agents --json --all` (the roster) + user-level `type: "http"` hooks (live events).
// Decisions: a PermissionRequest hook is held open here and answered from the browser. The terminal
//            dialog stays up in parallel, so whichever answers first wins and nothing ever waits on us;
//            a terminal answer leaves our request open, so PostToolUse and the roster retire the card.
// Control:   interrupt = a flag the agent's next PreToolUse hook answers with continue:false (+ deny);
//            end = `claude stop` (background) or SIGTERM to the roster's pid (terminal); remove = `claude rm`.
// Exposure:  127.0.0.1 only; Host is checked (DNS rebinding), browser calls need the per-start token
//            and a same-origin Origin (CSRF), and hook calls must carry no Origin (only Claude Code posts them).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { findRemoved } from './versions.mjs';
import { readChat, summaryOf } from './history.mjs';
import { createFollow } from './follow.mjs';
import { createThread } from './thread.mjs';
import { UNTRUSTED, trustKey, isTrusted, trustScript } from './trust.mjs';
import { prefsPath } from './cli.mjs';
import { createGithub } from './github.mjs';
import { createOverseer, migrateFrom } from './overseer.mjs';
import { createWatcher } from './watcher.mjs';
import { parseClaudeAuth, parseGhAuth, claudeLoginCommand, loginScript, LOGIN_ERROR } from './setup.mjs';
import { migrateFolders } from './migrate.mjs';
import { createStore } from './workspaces.mjs';

// `node server.mjs <command>` runs the CLI (cli.mjs) and never starts the server.
if (process.argv.length > 2) { const { main } = await import('./cli.mjs'); process.exit(await main(process.argv.slice(2))); }
// Agent Panel's folders under Glue's name, before anything reads its prefs. A server that ACP_PREFS points elsewhere is
// a second panel: the folders are not its to move.
if (!process.env.ACP_PREFS) for (const [a, b] of migrateFolders({ home: os.homedir() })) console.log(`moved ${a} to ${b}`);

const PORT = Number(process.env.ACP_PORT ?? 4747);
const DAEMON = process.env.ACP_DAEMON === '1';
const RETRY_MS = Number(process.env.ACP_RETRY_MS ?? 5000);
const ROSTER_MS = 3000;
// A background service must not cost battery while nobody looks: under ACP_DAEMON with no page connected, the roster
// is read once a minute and the version check waits. A page that connects brings both back at once.
const IDLE_ROSTER_MS = 60_000;
// Just under the hook's own timeout (hooks.example.json: 3600 s); past it Claude Code drops the request anyway.
const HOLD_MS = Number(process.env.ACP_HOLD_MS ?? 3590_000);
// A reload (yours, or the app's when a health check is slow) leaves the panel unwatched for a moment. Held requests
// wait this long for a page to come back: let go, a background session's plan can't be answered from here again.
const RECONNECT_MS = Number(process.env.ACP_RECONNECT_MS ?? 15_000);
const SUBAGENT_LINGER_MS = 600_000;
const STOP_TTL_MS = 15 * 60_000;
const STOP_REASON = 'Interrupted from Glue.';
const REFUSE_WINDOW_MS = 5000;
const MAX_BODY = 2_000_000;
// What the launcher may pass to `claude --bg`. bypassPermissions is deliberately not offered.
const MODELS = new Set(['', 'opus', 'opus[1m]', 'sonnet', 'haiku', 'fable']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']); // --effort's levels
const MODES = new Set(['', 'default', 'acceptEdits', 'plan', 'auto']);
// The modes an approved plan may switch to: the terminal's own plan-approval choices.
const PLAN_MODES = new Set(['default', 'acceptEdits', 'auto']);
// Dialogs that are a question or a plan rather than a call with arguments: one is open per agent at a time.
const DIALOGS = new Set(['AskUserQuestion', 'ExitPlanMode']);
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

const TOKEN = crypto.randomBytes(24).toString('hex');
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ORIGINS = new Set([...HOSTS].map((h) => `http://${h}`));
// Read per load, so a UI edit shows on refresh without a restart.
const page = () => fs.readFileSync(new URL('./public/index.html', import.meta.url), 'utf8');

/** sessionId → session record (roster fields + what the hooks told us). */
const sessions = new Map();
/** request id → a held PermissionRequest. */
const pending = new Map();
/** Interrupts waiting for the agent's next tool call: `${sessionId}:main` or `${sessionId}:${agentId}` → { at }. */
const stops = new Map();
/** Sessions removed or hidden from the panel. One comes back only if it runs again (a resumed terminal session). */
const dismissed = new Set();
/** Each open /events stream → the page's id (null for a stream that gave none). */
const clients = new Map();
/** Set while no page is connected but one may still come back (RECONNECT_MS). */
let releaseTimer = null;
const watched = () => clients.size > 0 || releaseTimer !== null;
let armed = true;

// A server started from inside a Claude Code session inherits its markers (CLAUDE_CODE_CHILD_SESSION and
// friends); passed on, they make a launched session skip its transcript and stay out of `claude agents`.
// CLAUDE_CONFIG_DIR is the profile's (below).
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CLAUDE')));

// ---------------------------------------------------------------- profiles
// A profile is a Claude Code config folder: ~/.claude for plain `claude`, ~/.claude-<name> for one run with
// CLAUDE_CONFIG_DIR=~/.claude-<name>. The panel shows one at a time; the choice is remembered across starts.
const HOME = os.homedir();
// ACP_PREFS gives a second panel (another ACP_PORT) a profile choice of its own.
const PREFS = prefsPath();
const HOOK_URL = `127.0.0.1:${PORT}/hook/`;
function listProfiles() {
  let names = [];
  try { names = fs.readdirSync(HOME).filter((n) => n === '.claude' || /^\.claude-[\w.-]{1,40}$/.test(n)).sort(); } catch {}
  const out = [];
  for (const n of names) {
    const dir = path.join(HOME, n);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    if (!['settings.json', '.claude.json', 'projects'].some((f) => fs.existsSync(path.join(dir, f)))) continue;
    const plain = n === '.claude'; // plain `claude` keeps its config file in the home folder
    out.push({ id: plain ? 'default' : n.slice('.claude-'.length), dir, plain, config: plain ? path.join(HOME, '.claude.json') : path.join(dir, '.claude.json') });
  }
  return out;
}
/** The command that runs Claude Code on a profile. */
const cliOf = (p) => (p.plain ? 'claude' : `CLAUDE_CONFIG_DIR=~/${path.basename(p.dir)} claude`);
/** What the picker shows: whose account it is, and whether its sessions report to this panel. */
function describeProfile(p) {
  let account = null;
  try { const a = JSON.parse(small(p.config, 8 << 20)).oauthAccount; if (a) account = { email: a.emailAddress ?? null, org: a.organizationName ?? null }; } catch {}
  let connected = false, effort = null;
  try {
    const text = small(path.join(p.dir, 'settings.json'), 4 << 20);
    connected = text.includes(HOOK_URL);
    effort = JSON.parse(text).effortLevel ?? null; // its default for new sessions, which /effort saves there
  } catch {}
  return { id: p.id, label: path.basename(p.dir).slice(1), dir: p.dir, where: p.dir.startsWith(HOME + path.sep) ? '~' + p.dir.slice(HOME.length) : p.dir, account, connected,
           effort: EFFORTS.has(effort) ? effort : null,
           command: cliOf(p) };
}
// ---------------------------------------------------------------- workspaces
// Every profile is a workspace, and every workspace is live at once: its roster is read, its hook events land, its held
// requests wait, and every process started for one of its sessions runs under its own CLAUDE_CONFIG_DIR. W holds one
// record per workspace whose profile folder exists; the store (workspaces.mjs) keeps names, colours and repositories,
// also for a profile that has gone and may come back.
/** The environment a profile's processes run under: plain `claude` has no CLAUDE_CONFIG_DIR. */
const envFor = (p) => (p.plain ? baseEnv : { ...baseEnv, CLAUDE_CONFIG_DIR: p.dir });
/** What stands in when there is no profile yet (a fresh machine): plain `claude`'s, so signing in works from here. */
const FALLBACK = { id: 'default', dir: path.join(HOME, '.claude'), plain: true, config: path.join(HOME, '.claude.json') };
const dataDir = path.dirname(PREFS);
try { fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 }); } catch {}
const store = createStore({ file: path.join(dataDir, 'workspaces.json'), profiles: listProfiles() });
/** wsId → { id, profile, env, info, rosterSeeded, rosterError, polls, setup } */
const W = new Map();
const makeWs = (p) => ({ id: p.id, profile: p, env: envFor(p), info: describeProfile(p), rosterSeeded: false, rosterError: null, polls: 0,
                         setup: { claude: { state: 'unknown' }, checkedAt: 0 } });
const wsById = (id) => W.get(id) ?? null;
/** The environment every process for this workspace runs under; null (and so refused by run) without one. */
const envOf = (ws) => ws?.env ?? null;
/** The workspace a session belongs to: set when the event or roster that introduced it arrived. */
const wsOfSession = (s) => (s ? wsById(s.ws) : null);
/** wsId → that workspace's overseer, made the first time it is asked for (overseerOf). */
const overseers = new Map();
// The workspace focused last, by any page: where an event that names no transcript goes, and the focus of a page that
// has not picked one. Each page's own focus is focusOf(client).
let shownId = null;
let serverUp = false;
/** Brings W in line with the profile folders: a new one becomes a workspace, one whose folder is gone leaves (with its
 *  sessions; its held requests go back to the terminal). A folder that is still there stays, so a moment when the home
 *  folder can't be read never empties the panel. */
function syncWorkspaces() {
  const list = listProfiles(), want = list.length ? list : [FALLBACK];
  store.sync(list); // the real profiles only: the stand-in is never kept as a workspace of its own
  let changed = false;
  for (const p of want) if (W.get(p.id)?.profile.dir !== p.dir) { W.set(p.id, makeWs(p)); changed = true; }
  for (const ws of [...W.values()]) {
    if (want.some((p) => p.id === ws.id) || fs.existsSync(ws.profile.dir)) continue;
    dropWorkspace(ws);
    changed = true;
  }
  if (!W.has(shownId)) shownId = W.keys().next().value ?? null;
  if (changed && serverUp) { broadcast(); checkSetup(true); }
}
function dropWorkspace(ws) {
  W.delete(ws.id);
  // Its overseer stops answering and its file is written now; a folder that comes back finds its conversation there.
  const o = overseers.get(ws.id);
  overseers.delete(ws.id);
  if (o) { try { o.stop(); o.flush(); } catch {} }
  for (const p of [...pending.values()]) if (p.ws === ws.id) settle(p.id, null, 'its profile is gone');
  for (const [id, s] of [...sessions]) {
    if (s.ws !== ws.id) continue;
    sessions.delete(id);
    inbox.delete(id);
    clearStops(id);
    termEnd(id);
  }
}
{
  syncWorkspaces();
  const all = [...W.values()].map((ws) => ws.profile);
  let saved = null;
  try { saved = JSON.parse(small(PREFS, 65536)).profile; } catch {}
  const env = process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR.replace(/^~(?=\/|$)/, HOME)) : null;
  // Picked before, else the one it was started under, else one that already reports here (an app opened from the Dock
  // has no CLAUDE_CONFIG_DIR), else plain `claude`'s.
  shownId = (all.find((p) => p.id === saved) ?? all.find((p) => p.dir === env) ?? all.find((p) => describeProfile(p).connected)
    ?? all.find((p) => p.plain) ?? all[0]).id;
  store.setFocus(shownId);
}
const shownWs = () => wsById(shownId);

// ---------------------------------------------------------------- the seal
// Each page (a client id: c= on its stream, x-acp-client on its calls) is shown one workspace. Its snapshot holds that
// workspace's sessions and requests only, plus { id, name, color, waiting } for each workspace; every action on a
// session or request outside it is refused.
const REFUSE = 'That belongs to another workspace. Switch to it to do this.';
/** clientId → the workspace that page shows. One that never picked shows the last focused (the store's). */
const clientFocus = new Map();
function focusOf(client) {
  const f = client ? clientFocus.get(client) : null;
  if (f && W.has(f)) return f;
  const last = store.focus();
  return W.has(last) ? last : W.has(shownId) ? shownId : W.keys().next().value;
}
/** The pages in `ids` that are shown workspace `wsId`. */
const sealedTo = (ids, wsId) => [...ids].filter((c) => focusOf(c) === wsId);
/** A session's transcript in workspace `ws`'s profile, or null. */
function findTranscript(ws, sessionId) {
  const root = path.join(ws.profile.dir, 'projects');
  try {
    for (const d of fs.readdirSync(root)) {
      const f = path.join(root, d, sessionId + '.jsonl');
      if (fs.existsSync(f)) return f;
    }
  } catch {}
  return null;
}
/** Whose a session is: its record's workspace, else the one whose profile holds its transcript; null when none knows it. */
function wsIdOfSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) return s.ws;
  if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return null;
  for (const ws of W.values()) if (findTranscript(ws, sessionId)) return ws.id;
  return null;
}
/** Whether an action from a page shown `wsId` may touch the session. One no workspace knows has nothing to give away. */
function ownedBy(wsId, sessionId) {
  const w = wsIdOfSession(sessionId);
  return w == null || w === wsId;
}
/** What a page calls a workspace: its name and colour from the store (the stand-in for no profile has none there). */
function wsView(id) {
  const w = store.get(id);
  return { id, name: w?.name ?? path.basename(W.get(id)?.profile.dir ?? id).replace(/^\./, ''), color: w?.color ?? 'violet' };
}
/** The live workspaces, in the store's order. */
const wsOrder = () => { const known = store.list().map((w) => w.id).filter((id) => W.has(id)); return [...known, ...[...W.keys()].filter((id) => !known.includes(id))]; };
/** What waits on you in a workspace: held requests, open questions and plans, and its overseer's cards waiting for a
 *  click. */
function waitingOf(wsId) {
  let n = openRequests(wsId).length;
  for (const p of pending.values()) if (p.ws === wsId) n++;
  n += overseerOf(wsId)?.status().proposed ?? 0;
  return n;
}
/** An event whose transcript lies in a profile's projects/ says whose its session is. */
const namesProfile = (e, ws) => typeof e?.transcript_path === 'string' && e.transcript_path.startsWith(path.join(ws.profile.dir, 'projects') + path.sep);
/** Moves a session (and what it holds open here) to workspace `id`. */
function setWs(s, id) {
  if (s.ws === id) return;
  s.ws = id;
  for (const p of pending.values()) if (p.sessionId === s.sessionId) p.ws = id;
}

/** The workspace a hook event's session runs under: its transcript lives in that profile's projects/. A profile seen
 *  for the first time is looked for at once, so its first event is not lost. An event that names no transcript is the
 *  shown workspace's, as it always was; one under no profile at all is nobody's (null). */
function wsOfEvent(e) {
  const tp = typeof e?.transcript_path === 'string' ? e.transcript_path : null;
  if (tp == null) return shownWs();
  const find = () => [...W.values()].find((ws) => tp.startsWith(path.join(ws.profile.dir, 'projects') + path.sep)) ?? null;
  const hit = find();
  if (hit) return hit;
  // Only a folder that could be a profile (~/.claude or ~/.claude-<name>) is worth looking at the home folder again for.
  const i = tp.indexOf(path.sep + 'projects' + path.sep), dir = i > 0 ? tp.slice(0, i) : '';
  if (path.dirname(dir) !== HOME || !/^\.claude(-[\w.-]{1,40})?$/.test(path.basename(dir))) return null;
  syncWorkspaces();
  return find();
}
// Every caller says which environment a process runs under: a session's or workspace's (envOf) or none of them
// (baseEnv). One that forgets is refused, never run with the panel's own.
const run = (cmd, args, opts = {}) => new Promise((resolve) => {
  if (!opts.env) { console.error(`run ${cmd}: no environment given, not run`); return resolve({ err: new Error('no environment given'), stdout: '', stderr: '' }); }
  execFile(cmd, args, { timeout: 15_000, maxBuffer: 8_000_000, ...opts },
    (err, stdout, stderr) => resolve({ err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
});
const firstLine = (r) => `${r.stderr}\n${r.stdout}`.split('\n').map((l) => l.trim()).find(Boolean)?.slice(0, 300) || String(r.err?.message ?? 'failed');

// The processes this server runs under. Ending the session it was started from would take the panel down with it.
const hostPids = new Set();
(async () => {
  for (let pid = process.ppid, i = 0; pid > 1 && i < 16; i++) {
    hostPids.add(pid);
    pid = Number((await run('ps', ['-o', 'ppid=', '-p', String(pid)], { env: baseEnv })).stdout.trim());
  }
})();

// ---------------------------------------------------------------- state

/** A session's record, made on first sight in workspace `ws` (an id): the one whose event or roster introduced it. */
function session(id, ws) {
  let s = sessions.get(id);
  if (!s) {
    s = { sessionId: id, ws, name: null, cwd: null, hereCwd: null, rosterCwd: null, kind: null, status: null, state: null, waitingFor: null,
          inRoster: false, lastTool: null, lastMessage: null, note: null, ended: false, subagents: new Map(),
          spawns: [], lastEventAt: Date.now() };
    sessions.set(id, s);
  }
  return s;
}

function summarize(tool, input = {}) {
  return { ...summaryOf(tool, input), at: Date.now() };
}

const stopKey = (sessionId, agentId) => `${sessionId}:${agentId ?? 'main'}`;
const isEnded = (s) => s.ended || s.state === 'done' || s.state === 'failed' || s.state === 'stopped';
function clearStops(sessionId) {
  for (const k of stops.keys()) if (k.startsWith(sessionId + ':')) stops.delete(k);
}

/** Record a hook event from a session of workspace `ws`. Returns the hook's reply: only an interrupted agent's
 *  PreToolUse gets one. */
function onHookEvent(e, ws) {
  if (!e?.session_id || isOverseerCall(e.cwd)) return null;
  if (dismissed.has(e.session_id)) {
    if (e.hook_event_name === 'SessionEnd' || e.hook_event_name === 'Stop') return null;
    dismissed.delete(e.session_id); // it is running again
  }
  const s = session(e.session_id, ws.id);
  // First seen through an event that named no transcript, it was put in the focused workspace: this one says whose it is.
  if (namesProfile(e, ws)) setWs(s, ws.id);
  s.lastEventAt = Date.now();
  if (e.cwd && !s.cwd) s.cwd = e.cwd;
  // Where it is now, for showing its branch only: a session can move (into a worktree, say) after it starts.
  if (!e.agent_id && typeof e.cwd === 'string' && path.isAbsolute(e.cwd) && e.cwd.length < 4096) s.hereCwd = e.cwd;
  if (!e.agent_id && typeof e.permission_mode === 'string') s.mode = e.permission_mode;
  const sub = e.agent_id ? s.subagents.get(e.agent_id) : null;
  let reply = null;

  switch (e.hook_event_name) {
    case 'SubagentStart': {
      // Title it with the task its parent gave it: the Agent call that just went out with the same type.
      const i = s.spawns.findIndex((c) => c.type === e.agent_type);
      const call = i >= 0 ? s.spawns.splice(i, 1)[0] : s.spawns.shift();
      s.subagents.set(e.agent_id, { agentId: e.agent_id, agentType: e.agent_type ?? 'subagent',
                                    title: call?.description ?? null, task: call?.prompt ?? null,
                                    startedAt: Date.now(), lastTool: null, stoppedAt: null });
      break;
    }
    case 'SubagentStop':
      if (sub) { sub.stoppedAt = Date.now(); sub.result = trim(e.last_assistant_message, 1500); }
      stops.delete(stopKey(e.session_id, e.agent_id));
      break;
    case 'PreToolUse': {
      // Interrupted: refuse the call and end the agent's turn. The flag stays until the turn is over, so the
      // other calls of a parallel batch are refused too (continue:false alone lets the call run). A call well
      // after the first refusal belongs to a new turn: a session with a background task never reads idle, so
      // the roster can't be what clears it.
      const key = stopKey(e.session_id, e.agent_id), flag = stops.get(key);
      if (flag?.refusedAt && Date.now() - flag.refusedAt > REFUSE_WINDOW_MS) stops.delete(key);
      else if (flag) {
        flag.refusedAt ??= Date.now();
        reply = { continue: false, stopReason: STOP_REASON,
                  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: STOP_REASON } };
        // A subagent stopped this way may never send SubagentStop: it is over now.
        if (sub && !sub.stoppedAt) { sub.stoppedAt = Date.now(); sub.result ??= 'Stopped from the panel.'; }
        break;
      }
      const t = summarize(e.tool_name, e.tool_input);
      if (e.agent_id) {
        if (!sub) s.subagents.set(e.agent_id, { agentId: e.agent_id, agentType: e.agent_type ?? 'subagent',
                                                startedAt: Date.now(), lastTool: t, stoppedAt: null });
        else {
          sub.lastTool = t;
          if (sub.stale) { sub.stale = false; sub.stoppedAt = null; } // read as gone from disk, but it is working
        }
      } else s.lastTool = t;
      if (!e.agent_id && SPAWN_TOOLS.has(e.tool_name)) {
        const now = Date.now();
        s.spawns = s.spawns.filter((c) => now - c.at < 120_000).slice(-20);
        s.spawns.push({ type: e.tool_input?.subagent_type ?? 'general-purpose', description: trim(e.tool_input?.description, 120),
                        prompt: trim(e.tool_input?.prompt, 400), at: now });
      }
      break;
    }
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied':
      // The tool ran or was refused without us: the terminal answered a request we still hold.
      // A question comes back with its answers added to the input, so dialogs match on the tool alone.
      for (const p of pending.values()) {
        if (p.sessionId === e.session_id && p.agentId === (e.agent_id ?? null) && p.toolName === e.tool_name
            && (DIALOGS.has(e.tool_name) || JSON.stringify(p.toolInput) === JSON.stringify(e.tool_input ?? {}))) settle(p.id, null, 'answered in the terminal');
      }
      break;
    case 'Notification':
      s.note = { type: e.notification_type ?? null, text: trim(e.message, 200), at: Date.now() };
      break;
    case 'Stop': {
      s.lastMessage = trimMid(e.last_assistant_message, 3000);
      s.lastMessageAt = Date.now();
      s.note = null;
      stops.delete(stopKey(e.session_id, null));
      setTimeout(() => pollRoster(wsOfSession(s)), 1500); // a message waiting for this turn to end can go now
      if (!e.agent_id) feed('finished', s, `${labelOf(s)} finished its turn${s.lastMessage ? `: ${String(s.lastMessage).replace(/\s+/g, ' ').slice(0, 140)}` : '.'}`);
      break;
    }
    case 'SessionEnd':
      s.ended = true;
      settleSubagents(s);
      clearStops(e.session_id);
      break;
  }
  // The session's Chat: a call starting makes its thread, so a page that opens the session mid-turn sees its state.
  try { (e.hook_event_name === 'PreToolUse' && !e.agent_id ? threadOf(e.session_id) : threads.get(e.session_id))?.hook(e); }
  catch (err) { console.error('thread:', err?.message ?? err); }
  broadcast();
  return reply;
}

const trim = (v, n) => (typeof v === 'string' ? (v.length > n ? v.slice(0, n) + '…' : v) : null);
// Keeps the end too: a long reply usually closes with the question or options it puts to you.
const trimMid = (v, n) => (typeof v === 'string' ? (v.length > n ? v.slice(0, n * 0.4) + '\n\n…\n\n' + v.slice(-n * 0.6) : v) : null);

/** A session that has ended has no running subagents, whether or not their SubagentStop ever arrived. */
function settleSubagents(s) {
  for (const a of s.subagents.values()) a.stoppedAt ??= Date.now();
}

/** A workspace's `claude agents --json --all`, or { error }. */
async function readRoster(ws) {
  const r = await run('claude', ['agents', '--json', '--all'], { timeout: 5000, env: envOf(ws) });
  if (r.err) return { error: String(r.err.message).slice(0, 200) };
  try { return { list: JSON.parse(r.stdout) }; } catch { return { error: 'claude agents --json returned non-JSON' }; }
}

/** Every workspace's roster, after looking for profile folders that came or went. */
function pollAll() {
  syncWorkspaces();
  return Promise.all([...W.values()].map((ws) => pollRoster(ws)));
}
// The first roster of a workspace (at start, or when its profile appears) is what was already there: no "started" lines.
async function pollRoster(ws) {
  if (!ws) return;
  const { list, error } = await readRoster(ws);
  if (W.get(ws.id) !== ws) return; // its profile went while it read
  if (++ws.polls % 20 === 0) ws.info = describeProfile(ws.profile); // its hooks or account may have changed outside the panel
  if (error) { ws.rosterError = error; broadcast(); return; }
  ws.rosterError = null;
  const seen = new Set();
  for (const r of list) {
    if (!r.sessionId || isOverseerCall(r.cwd)) continue;
    const over = r.state === 'done' || r.state === 'failed' || r.state === 'stopped';
    if (dismissed.has(r.sessionId)) { if (over) continue; dismissed.delete(r.sessionId); }
    seen.add(r.sessionId);
    const s = session(r.sessionId, ws.id), was = { inRoster: s.inRoster, state: s.state, status: s.status };
    setWs(s, ws.id); // its profile's own list says whose it is, over an event that named no transcript
    // The roster moving it (into its worktree, say) is newer than the folder its last hook event named.
    if (r.cwd && r.cwd !== s.rosterCwd) { s.rosterCwd = r.cwd; s.hereCwd = null; }
    Object.assign(s, { id: r.id ?? null, name: r.name ?? null, cwd: r.cwd ?? s.cwd, kind: r.kind ?? null,
                       status: r.status ?? null, state: r.state ?? null, waitingFor: r.waitingFor ?? null,
                       pid: r.pid ?? null, startedAt: r.startedAt ?? null, inRoster: true, leftRosterAt: null });
    if (!over) Object.assign(s, { ended: false, closedByPanel: false }); // running again, e.g. resumed with a reply
    if (ws.rosterSeeded) {
      if (!was.inRoster && !over) feed('started', s, `${labelOf(s)} started.`);
      else if (over && was.state !== r.state && was.inRoster) feed(r.state === 'done' ? 'done' : r.state, s, `${labelOf(s)} is ${r.state === 'done' ? 'done' : r.state}.`);
      if (r.status === 'waiting' && was.status !== 'waiting' && was.inRoster) feed('needs-you', s, `${labelOf(s)} waits for you${r.waitingFor ? ` (${r.waitingFor})` : ''}.`);
    }
    // What it last said comes from the Stop hook; a session that ended its turn before this server started
    // gets it from its transcript instead.
    if (!saidRead.has(s.sessionId)) {
      saidRead.add(s.sessionId);
      s.lastMessage ??= trimMid(lastSaid(s.sessionId), 3000);
      s.mode ??= lastTurn(s.sessionId).mode ?? null;
    }
    const on = ranOn(s.sessionId);
    // Where it works: the folder its transcript last names, which Claude Code writes itself (hook events and the roster
    // only stand in until there is one: the roster gives a stopped job its starting folder back).
    Object.assign(s, { model: on.model ?? null, effort: on.effort ?? null, editTops: on.edits ?? [], ranCwd: on.cwd ?? s.ranCwd ?? null });
    loadSubagents(s);
    if (over) { settleSubagents(s); clearStops(s.sessionId); }
    // An interrupted session that has gone idle is done stopping. (A continue:false ends the turn without a Stop event.)
    const st = stops.get(stopKey(s.sessionId, null));
    if (st && r.status === 'idle' && Date.now() - st.at > 2500) stops.delete(stopKey(s.sessionId, null));
  }
  // Claude Code reads a session as busy while a background task (a dev server, a watch) runs, even when its
  // turn is over and it waits at its prompt. The transcript tells the two apart.
  const mine = () => [...sessions.values()].filter((s) => s.ws === ws.id);
  for (const s of mine()) s.atPrompt = atPrompt(s);
  const tasks = mine().some((s) => s.atPrompt) ? await backgroundTasks() : new Map();
  for (const s of mine()) s.bgTasks = s.atPrompt ? tasks.get(s.pid) ?? 0 : 0;
  if (W.get(ws.id) !== ws) return; // its profile went while it looked at background tasks
  ws.rosterSeeded = true;
  if (inbox.size) deliverQueued();
  // Gone from the roster = closed or removed: drop its last status so it can't still read "needs you".
  for (const s of mine()) {
    if (seen.has(s.sessionId) || !s.inRoster) continue;
    Object.assign(s, { inRoster: false, leftRosterAt: Date.now(), ended: true, status: null, waitingFor: null });
    feed('closed', s, `${labelOf(s)} closed.`);
    settleSubagents(s);
    clearStops(s.sessionId);
  }
  // Claude Code keeps our request open after the terminal says yes, so a held main-agent request
  // whose session has stopped waiting for two polls running was answered there (the backstop for a
  // PostToolUse that doesn't match, e.g. a command amended in the terminal). Not for subagents: a
  // background subagent can wait on us while its parent session reads as idle.
  for (const p of [...pending.values()]) {
    const s = sessions.get(p.sessionId);
    if (p.agentId || !s?.inRoster || s.ws !== ws.id || Date.now() - p.createdAt < 4000) continue;
    p.notWaiting = s.status === 'waiting' ? 0 : (p.notWaiting ?? 0) + 1;
    if (p.notWaiting >= 2) settle(p.id, null, 'answered in the terminal');
  }
  broadcast();
}

function prune() {
  const now = Date.now();
  for (const [k, st] of stops) if (now - st.at > STOP_TTL_MS) stops.delete(k);
  while (dismissed.size > 500) dismissed.delete(dismissed.values().next().value);
  for (const [id, s] of sessions) {
    for (const [aid, sub] of s.subagents) if (sub.stoppedAt && now - sub.stoppedAt > SUBAGENT_LINGER_MS) s.subagents.delete(aid);
    // Closed sessions linger 10 minutes; hook-only ones (claude -p, SDK) never enter the roster and go an hour after they go quiet.
    const stale = s.leftRosterAt ? now - s.leftRosterAt > 600_000 : now - s.lastEventAt > 3600_000;
    if (!s.inRoster && stale && ![...pending.values()].some((p) => p.sessionId === id)) sessions.delete(id);
  }
  // A thread nobody follows keeps only its hook state (a session's calls would otherwise pile up as rows), and goes
  // with its session.
  for (const [id, t] of threads) if (!follows.has(id)) { if (sessions.has(id)) t.reset(); else threads.delete(id); }
}

// ---------------------------------------------------------------- held permission requests

// A request is held for the workspace its session runs under (`ws`, an id), whichever workspace is on screen: handing it
// back would leave a background session's prompt open with no screen to answer it on.
function holdPermission(e, ws, res) {
  const id = crypto.randomUUID();
  // An event that names no transcript was guessed into the focused workspace: a session already known says better.
  const s = e.session_id ? session(e.session_id, ws.id) : null;
  if (s && namesProfile(e, ws)) setWs(s, ws.id);
  const p = { id, sessionId: e.session_id, agentId: e.agent_id ?? null, agentType: e.agent_type ?? null,
              toolName: e.tool_name, toolInput: e.tool_input ?? {}, toolUseId: e.tool_use_id ?? null, suggestions: e.permission_suggestions ?? [],
              cwd: e.cwd ?? null, permissionMode: e.permission_mode ?? null, createdAt: Date.now(),
              deadline: Date.now() + HOLD_MS, ws: s?.ws ?? ws.id, res, timer: null };
  p.timer = setTimeout(() => settle(id, null, 'expired'), HOLD_MS);
  // The hook timed out or its session went away. (A terminal answer does NOT close it: see pollRoster.)
  res.on('close', () => { if (pending.has(id)) settle(id, null, 'closed by Claude Code'); });
  pending.set(id, p);
  if (s) {
    s.lastEventAt = Date.now();
    feed('needs-you', sessions.get(e.session_id), `${labelOf(sessions.get(e.session_id))} asks: ${askOf(p)}`);
    // A subagent's call is not in this thread.
    try { if (!e.agent_id) threadOf(e.session_id).request(e, { waiting: true }); }
    catch (err) { console.error('thread:', err?.message ?? err); }
  }
  broadcast({ type: 'new-request', id, ws: p.ws }); // only pages shown its workspace hear of it
}
/** The requests held for a session. */
const heldFor = (sessionId) => [...pending.values()].filter((p) => p.sessionId === sessionId);

/** Answer a held request. `decision` null = no answer, the terminal dialog decides. */
function settle(id, decision, why) {
  const p = pending.get(id);
  if (!p) return false;
  pending.delete(id);
  clearTimeout(p.timer);
  if (!p.res.writableEnded && !p.res.destroyed) {
    p.res.writeHead(200, { 'content-type': 'application/json' });
    p.res.end(decision ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }) : '');
  }
  // Also runs from timers (HOLD_MS, the last page closing), where a throw would stop the server.
  try { if (!p.agentId) threads.get(p.sessionId)?.request({ tool_use_id: p.toolUseId, tool_name: p.toolName, tool_input: p.toolInput }, { why }); }
  catch (err) { console.error('thread:', err?.message ?? err); }
  if (['allow', 'deny', 'answer', 'approve-plan'].includes(why) && sessions.has(p.sessionId)) feed('answered', sessions.get(p.sessionId), `${labelOf(sessions.get(p.sessionId))}: ${p.toolName} ${why === 'allow' ? 'allowed' : why === 'deny' ? 'denied' : why === 'answer' ? 'answered' : 'plan approved'} from the panel.`);
  broadcast({ type: 'settled', id, why, ws: p.ws });
  return true;
}

/** Answer a held request from a page shown workspace `wsId`: only that workspace's requests. */
function decide(body, wsId) {
  const p = pending.get(body?.id);
  if (!p) return { ok: false, error: 'That request is gone: answered in the terminal or expired.' };
  if (p.ws !== wsId || !ownedBy(wsId, p.sessionId)) return { ok: false, error: REFUSE };
  let decision;
  if (body.behavior === 'deny') {
    decision = { behavior: 'deny', message: String(body.message || 'Denied from Glue.') };
  } else if (body.behavior === 'answer') {
    // AskUserQuestion takes its answers as part of its input: { "<question text>": "<label or typed answer>" }.
    if (p.toolName !== 'AskUserQuestion') return { ok: false, error: 'Only a question takes answers.' };
    const asked = new Set((p.toolInput.questions ?? []).map((q) => q.question));
    const a = body.answers;
    if (!a || typeof a !== 'object' || Array.isArray(a)) return { ok: false, error: 'Answers must be an object.' };
    for (const [q, v] of Object.entries(a)) {
      if (!asked.has(q) || typeof v !== 'string' || !v.trim() || v.length > 5000) return { ok: false, error: 'Answer each question it asked, in words.' };
    }
    if (Object.keys(a).length !== asked.size) return { ok: false, error: 'Answer every question before sending.' };
    decision = { behavior: 'allow', updatedInput: { ...p.toolInput, answers: a } };
  } else if (body.behavior === 'approve-plan') {
    // A bare allow leaves the plan dialog open; it takes the plan back as input plus the mode to carry on in.
    if (p.toolName !== 'ExitPlanMode') return { ok: false, error: 'Only a plan can be approved.' };
    if (!PLAN_MODES.has(body.mode)) return { ok: false, error: 'Pick how it should carry on.' };
    decision = { behavior: 'allow', updatedInput: p.toolInput,
                 updatedPermissions: [{ type: 'setMode', mode: body.mode, destination: 'session' }] };
  } else if (body.behavior === 'allow') {
    decision = { behavior: 'allow' };
    if (body.updatedInput !== undefined) {
      if (typeof body.updatedInput !== 'object' || body.updatedInput === null || Array.isArray(body.updatedInput))
        return { ok: false, error: 'The edited input must be a JSON object.' };
      decision.updatedInput = body.updatedInput;
    }
    // "Always allow" adopts the request's own suggestions, never rules from the browser.
    if (body.always && p.suggestions.length) decision.updatedPermissions = p.suggestions;
    // Switch its mode as it carries on, the way an approved plan does. Main agent only: a subagent's request
    // would switch the whole session.
    if (body.mode) {
      if (p.agentId || !RESUME_MODES.has(body.mode)) return { ok: false, error: 'Its mode can only switch to ask, accept edits, plan or auto, on a main-agent request.' };
      decision.updatedPermissions = [...(decision.updatedPermissions ?? []), { type: 'setMode', mode: body.mode, destination: 'session' }];
    }
  } else return { ok: false, error: 'behavior must be allow, deny, answer or approve-plan' };
  settle(p.id, decision, body.behavior);
  return { ok: true };
}

// ---------------------------------------------------------------- launch + stop

/** Start a background session in workspace `ws` (the page's focus; the overseer's for its proposals): `claude --bg` with
 *  argv only (no shell), every value checked. */
function launch(body, ws = shownWs()) {
  return new Promise((resolve) => {
    const fail = (error) => resolve({ ok: false, error });
    const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
    if (!prompt || prompt.length > 20_000) return fail('Write a prompt for the agent (up to 20,000 characters).');
    let cwd = typeof body.cwd === 'string' ? body.cwd.trim() : '';
    if (cwd === '~' || cwd.startsWith('~/')) cwd = path.join(os.homedir(), cwd.slice(1));
    cwd = path.resolve(cwd || os.homedir());
    try { if (!fs.statSync(cwd).isDirectory()) throw new Error(); } catch { return fail(`There is no folder at ${cwd}.`); }
    const model = body.model ?? '', mode = body.mode ?? '', effort = body.effort ?? '';
    const name = String(body.name ?? '').trim(), agent = String(body.agent ?? '').trim();
    if (!MODELS.has(model)) return fail('Pick a model from the list.');
    if (effort && !EFFORTS.has(effort)) return fail('Pick an effort level from the list.');
    if (!MODES.has(mode)) return fail('Pick a permission mode from the list.');
    if (name && !/^[\w .-]{1,60}$/.test(name)) return fail('A name can use letters, digits, spaces, dots and dashes, 60 at most.');
    if (agent && !/^[\w:.-]{1,80}$/.test(agent)) return fail('An agent type is a name like code-reviewer or plugin:agent.');
    // Its own worktree: Claude Code makes .claude/worktrees/<name> on a new branch worktree-<name>, and names it when
    // you don't.
    const worktree = body.worktree === true, wtName = String(body.worktreeName ?? '').trim();
    if (worktree) {
      if (wtName && !WORKTREE_NAME.test(wtName)) return fail('A worktree name can use letters, digits, dots, dashes and underscores, 60 at most.');
      const place = gitPlace(cwd);
      if (!place) return fail(`${tilde(cwd)} is not in a git repository, so it can't have a worktree of its own.`);
      if (wtName && fs.existsSync(path.join(place.repo, '.claude', 'worktrees', wtName))) return fail(`There is already a worktree named ${wtName}. Pick another name, or leave it blank for a new one.`);
    }
    const args = ['--bg'];
    if (name) args.push('--name', name);
    if (model) args.push('--model', model);
    if (effort) args.push('--effort', effort);
    if (mode) args.push('--permission-mode', mode);
    if (agent) args.push('--agent', agent);
    if (worktree) args.push('--worktree', ...(wtName ? [wtName] : []));
    args.push('--', prompt);
    // Under its workspace's profile.
    if (!ws) return fail(NO_WS);
    run('claude', args, { cwd, timeout: 30_000, env: envOf(ws) }).then((r) => {
      const id = `${r.stdout}\n${r.stderr}`.match(/backgrounded · (\w+)/)?.[1];
      if (id) { setTimeout(() => pollRoster(ws), 400); return resolve({ ok: true, id, cwd }); }
      const why = firstLine(r);
      if (UNTRUSTED.test(why)) return resolve({ ok: false, untrusted: true,
        error: `The ${profileLabel(ws)} profile hasn't trusted ${tilde(trustKey(cwd, gitPlace(cwd)?.top))} yet. Claude Code asks once per folder.` });
      fail(why);
    });
  });
}

// ---------------------------------------------------------------- interrupt, end, remove

const BG_ID = /^[0-9a-f]{8}$/;
// A session whose profile folder has gone between its being picked and the action: nothing runs without its profile.
const NO_WS = 'Its profile is gone, so nothing can be run for it.';
const liveSession = (body) => {
  const s = sessions.get(String(body?.sessionId ?? ''));
  return s && !dismissed.has(s.sessionId) ? s : null;
};

/** Stop an agent at its next tool call, like Esc. The session (or, for a subagent, its parent) stays open. */
function interrupt(body) {
  const s = liveSession(body);
  if (!s || isEnded(s)) return { ok: false, error: 'That session is not running.' };
  const aid = body.agentId == null ? null : String(body.agentId);
  const now = Date.now();
  if (aid) {
    const a = s.subagents.get(aid);
    if (!a || a.stoppedAt) return { ok: false, error: 'That subagent has already finished.' };
    stops.set(stopKey(s.sessionId, aid), { at: now });
  } else {
    stops.set(stopKey(s.sessionId, null), { at: now });
    for (const a of s.subagents.values()) if (!a.stoppedAt) stops.set(stopKey(s.sessionId, a.agentId), { at: now });
  }
  // What it is asking here right now is refused at once rather than left for its next tool call.
  for (const p of [...pending.values()]) {
    if (p.sessionId !== s.sessionId || (aid && p.agentId !== aid)) continue;
    settle(p.id, { behavior: 'deny', message: STOP_REASON, ...(aid ? {} : { interrupt: true }) }, 'interrupted');
  }
  broadcast();
  return { ok: true };
}

/** End a session; its conversation is kept. Background: `claude stop`. Terminal: SIGTERM, as closing its window would. */
async function end(body) {
  const s = liveSession(body);
  if (!s || !s.inRoster || isEnded(s)) return { ok: false, error: 'That session is not running.' };
  return endSession(s);
}
async function endSession(s) {
  const ws = wsOfSession(s);
  if (!ws) return { ok: false, error: NO_WS };
  if (s.kind === 'background') {
    if (!BG_ID.test(s.id ?? '')) return { ok: false, error: 'It has no background id to stop.' };
    const r = await run('claude', ['stop', s.id], { env: envOf(ws) });
    setTimeout(() => pollRoster(ws), 400);
    return r.err ? { ok: false, error: firstLine(r) } : { ok: true };
  }
  if (s.kind !== 'interactive') return { ok: false, error: 'Only background and terminal sessions can be ended from here.' };
  // The pid comes from a fresh roster read, never from the browser, and must still be a claude process.
  const { list } = await readRoster(ws);
  const pid = list?.find((r) => r.sessionId === s.sessionId && r.kind === 'interactive')?.pid;
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: 'Could not find its process. It may have closed already.' };
  if (hostPids.has(pid)) return { ok: false, error: 'The panel server runs inside this session. Ending it would stop the panel too.' };
  const cmd = (await run('ps', ['-o', 'command=', '-p', String(pid)], { env: baseEnv })).stdout.trim();
  if (!/(^|\/)claude(\s|$)/.test(cmd)) return { ok: false, error: 'Its process is no longer Claude Code, so it was left alone.' };
  try { process.kill(pid, 'SIGTERM'); } catch (e) { return { ok: false, error: `Could not signal its process (${e.code}).` }; }
  s.closedByPanel = true;
  setTimeout(() => pollRoster(ws), 600);
  return { ok: true };
}

/** Take a finished session off the list. Background: `claude rm`, which keeps the transcript and refuses
 *  (we never pass --discard-unpushed or --force-remove-worktree) when its worktree has unsaved work.
 *  Anything else has already left `claude agents`, so the panel just stops showing it. */
async function remove(body) {
  const s = liveSession(body);
  if (!s) return { ok: true };
  if (!isEnded(s)) return { ok: false, error: 'It is still running. End it first.' };
  const rm = s.kind === 'background' && s.inRoster;
  if (rm) {
    if (!BG_ID.test(s.id ?? '')) return { ok: false, error: 'It has no background id to remove.' };
    const ws = wsOfSession(s);
    if (!ws) return { ok: false, error: NO_WS };
    const r = await run('claude', ['rm', s.id], { env: envOf(ws) });
    if (r.err) return { ok: false, error: firstLine(r) };
  }
  dismissed.add(s.sessionId);
  sessions.delete(s.sessionId);
  clearStops(s.sessionId);
  broadcast();
  return { ok: true, removed: rm };
}

// ---------------------------------------------------------------- reply

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RESUME_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto']);

/** The model, effort and permission mode of a session's last turn, read from the tail of its transcript. */
const files = new Map(); // sessionId → its transcript
/** A session's transcript, in its own workspace's profile. One the panel has no record of yet (just launched, say) is
 *  looked for in workspace `where` (the asking page's focus), else in the one focused last. */
function transcriptFile(sessionId, where = null) {
  if (!UUID.test(sessionId)) return null;
  const s = sessions.get(sessionId), ws = s ? wsOfSession(s) : where ?? shownWs();
  if (!ws) return null;
  const root = path.join(ws.profile.dir, 'projects');
  const hit = files.get(sessionId);
  if (hit && hit.startsWith(root + path.sep) && fs.existsSync(hit)) return hit;
  const f = findTranscript(ws, sessionId);
  if (f) files.set(sessionId, f);
  return f;
}
function tailOf(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, len = Math.min(size, bytes), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').split('\n').reverse();
  } finally { fs.closeSync(fd); }
}

// Hooks only tell this server about subagents that start while it runs. Claude Code keeps each one on disk
// (<session>/subagents/agent-<id>.jsonl, and a .meta.json with its type, description and `finished`), so the first
// time a session shows up its subagents come from there: after a restart they are all still listed.
const STALE_SUB_MS = 15 * 60_000; // unfinished but untouched this long: it went with an interrupted turn
function headLine(file, bytes = 65536) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(bytes), n = fs.readSync(fd, buf, 0, bytes, 0); return buf.toString('utf8', 0, n).split('\n')[0]; }
  finally { fs.closeSync(fd); }
}
const msgText = (m) => (typeof m?.content === 'string' ? m.content
  : Array.isArray(m?.content) ? m.content.filter((c) => c?.type === 'text').map((c) => c.text).join('\n') : '');
function loadSubagents(s) {
  if (s.subsLoaded) return;
  const file = transcriptFile(s.sessionId);
  if (!file) return; // nothing saved yet: the next poll tries again
  s.subsLoaded = true;
  const dir = path.join(file.slice(0, -'.jsonl'.length), 'subagents');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^agent-[\w-]{1,80}\.meta\.json$/.test(n)); } catch { return; }
  const found = [];
  for (const n of names) {
    try {
      const id = n.slice('agent-'.length, -'.meta.json'.length), log = path.join(dir, `agent-${id}.jsonl`);
      const meta = JSON.parse(small(path.join(dir, n), 65536)), first = JSON.parse(headLine(log));
      const tail = tailOf(log, 65536).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const touched = fs.statSync(log).mtimeMs, lastAt = Date.parse(tail.find((d) => d.timestamp)?.timestamp) || touched;
      const said = tail.find((d) => d.type === 'assistant' && msgText(d.message).trim());
      const use = tail.find((d) => d.type === 'assistant' && Array.isArray(d.message?.content) && d.message.content.some((c) => c?.type === 'tool_use'))
        ?.message.content.filter((c) => c?.type === 'tool_use').at(-1);
      const stale = meta.finished !== true && Date.now() - touched > STALE_SUB_MS;
      const over = meta.finished === true || stale;
      // Its report is its last words, or what it handed back with SubagentHandback.
      const report = use?.name === 'SubagentHandback' && typeof use.input?.message === 'string' ? use.input.message : msgText(said?.message);
      found.push({ agentId: id, agentType: typeof meta.agentType === 'string' ? meta.agentType : 'subagent', title: trim(meta.description, 120),
                   task: trim(msgText(first.message), 400), startedAt: Date.parse(first.timestamp) || lastAt,
                   lastTool: use ? { ...summarize(use.name, use.input ?? {}), at: lastAt } : null,
                   stoppedAt: over ? lastAt : null, result: meta.finished === true ? trim(report, 1500) : null, stale });
    } catch {}
  }
  for (const a of found.sort((x, y) => x.startedAt - y.startedAt).slice(-40)) {
    const have = s.subagents.get(a.agentId);
    if (have) { have.title ??= a.title; have.task ??= a.task; have.startedAt = Math.min(have.startedAt, a.startedAt); }
    else s.subagents.set(a.agentId, a);
  }
  s.subagents = new Map([...s.subagents].sort((x, y) => x[1].startedAt - y[1].startedAt));
}

const turns = new Map(); // sessionId → { size, mtimeMs, over }: the last read of its transcript
function turnIsOver(sessionId) {
  const file = transcriptFile(sessionId);
  let st;
  try { st = file && fs.statSync(file); } catch {}
  if (!st) return false;
  const c = turns.get(sessionId);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.over;
  let over = false;
  for (const line of tailOf(file, 256_000)) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain) break;
    if (d.type === 'system' && (d.subtype === 'turn_duration' || d.subtype === 'stop_hook_summary')) { over = true; break; }
    if (d.type === 'assistant') { over = d.message?.stop_reason === 'end_turn'; break; }
    if (d.type === 'user') {
      const c0 = d.message?.content, text = typeof c0 === 'string' ? c0 : Array.isArray(c0) && c0[0]?.type === 'text' ? c0[0].text : '';
      over = /^\[Request interrupted by user/.test(text ?? '');
      break;
    }
    if (d.type === 'api-request' || d.type === 'api-request-blob') break; // a model call in flight
  }
  turns.set(sessionId, { size: st.size, mtimeMs: st.mtimeMs, over });
  return over;
}
const saidRead = new Set();
function lastSaid(sessionId) {
  const file = transcriptFile(sessionId);
  if (!file) return null;
  for (const line of tailOf(file, 512_000)) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    // A local /command leaves a made-up reply ("No response requested.") that Claude never wrote.
    if (d.isSidechain || d.type !== 'assistant' || !Array.isArray(d.message?.content) || d.message.model === '<synthetic>') continue;
    const text = d.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    if (text) return text;
  }
  return null;
}
/** A session's conversation for the panel's chat, newest last; asking for more reads further back. */
async function history(body, ctx) {
  const file = transcriptFile(body?.sessionId, ctx?.ws);
  if (!file) return { ok: false, error: 'Its transcript is not in this profile.' };
  const limit = Number.isInteger(body?.limit) ? Math.min(2000, Math.max(20, body.limit)) : 60;
  const before = Number.isInteger(body?.before) ? body.before : Infinity; // a byte offset: only what starts before it
  return { ok: true, ...(await readChat(file, { limit, before })) };
}
const atPrompt = (s) => Boolean(s.inRoster && s.status === 'busy' && !isEnded(s)
  && !hasRunningSub(s) && turnIsOver(s.sessionId));

// Shells Claude Code's Bash tool started that outlive the turn: its background tasks. They end with the session.
async function backgroundTasks() {
  const r = await run('ps', ['-A', '-o', 'pid=,ppid=,command='], { env: baseEnv });
  const n = new Map();
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\s*\d+\s+(\d+)\s+(.*)$/);
    if (m && m[2].includes('/shell-snapshots/')) n.set(+m[1], (n.get(+m[1]) ?? 0) + 1);
  }
  return n;
}

function lastTurn(sessionId) {
  const out = {};
  const file = transcriptFile(sessionId);
  if (!file) return out;
  out.file = file;
  for (const line of tailOf(file, 512_000)) {
    if (out.model && out.mode) break;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'user' || d.type === 'assistant') out.talked = true;
    if (!out.model && d.type === 'assistant' && !d.isSidechain && modelOf(d)) Object.assign(out, { model: modelOf(d), effort: effortOf(d) });
    if (!out.mode && typeof d.permissionMode === 'string') Object.assign(out, { mode: d.permissionMode, modeAt: Date.parse(d.timestamp) || 0 });
  }
  return out;
}
// A reply's model as it was asked for: requestedModel keeps a [1m] that the reply's own model name drops.
const modelOf = (d) => [d.requestedModel, d.message?.model].find((m) => typeof m === 'string' && /^[\w.\-[\]]{1,80}$/.test(m)) ?? null;
const effortOf = (d) => (EFFORTS.has(d.effort) ? d.effort : null);
/** The model and effort its replies run on now, for the panel to show: from its newest reply, read again only when the
 *  transcript has grown. Neither changes without a restart, so a tail with no reply in it keeps the last read. Also the
 *  folder of its newest step, which follows it into a worktree it entered mid-session (the roster keeps the folder it
 *  started in), and the checkouts it last edited files in, newest first. */
const EDITS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const ran = new Map(); // sessionId → { size, mtimeMs, model, effort, cwd, edits }
function ranOn(sessionId) {
  const file = transcriptFile(sessionId);
  let st;
  try { st = file && fs.statSync(file); } catch {}
  const c = ran.get(sessionId);
  if (!st) return c ?? {};
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c;
  const out = { size: st.size, mtimeMs: st.mtimeMs, model: c?.model ?? null, effort: c?.effort ?? null, cwd: c?.cwd ?? null };
  let model = false, cwd = false;
  const edits = [];
  for (const line of tailOf(file, c ? 128_000 : 512_000)) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain) continue;
    if (!cwd && typeof d.cwd === 'string' && path.isAbsolute(d.cwd)) { out.cwd = d.cwd; cwd = true; }
    if (d.type !== 'assistant') continue;
    if (!model && modelOf(d)) { Object.assign(out, { model: modelOf(d), effort: effortOf(d) }); model = true; }
    for (const b of Array.isArray(d.message?.content) ? d.message.content : []) {
      const f = b?.type === 'tool_use' && EDITS.has(b.name) ? b.input?.file_path ?? b.input?.notebook_path : null;
      if (typeof f === 'string' && path.isAbsolute(f)) edits.push(f);
    }
  }
  const tops = edits.map((f) => gitPlace(path.dirname(f))?.top).filter(Boolean);
  out.edits = [...new Set([...tops, ...(c?.edits ?? [])])].slice(0, 4);
  ran.set(sessionId, out);
  return out;
}
/** `opus` or `opus[1m]` names the model it runs on now (claude-opus-5-5[1m]). */
const sameModel = (alias, full) => typeof full === 'string' && full.includes(`-${alias.replace('[1m]', '')}-`) && alias.endsWith('[1m]') === full.endsWith('[1m]');

async function rosterSettles(ws, sessionId, done, ms = 12_000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 700))) {
    const { list } = await readRoster(ws);
    if (list && done(list.find((r) => r.sessionId === sessionId))) return true;
  }
  return false;
}

/** Answer a session that has stopped to ask you something in words. Claude Code has no way to type into a running
 *  terminal session from outside, so it is restarted: stopped (a terminal session closes in its window), then resumed
 *  in the background under the same id with the reply as its next prompt, keeping its name, model, effort and
 *  permission mode unless you picked others. A background job wakes as itself (see below). */
// Sending to a background session: `claude --resume <id> -- <text>` without --bg hands the text to the running job
// as your next message (queued if it is working, as if typed in agent view's peek panel), then attaches. It needs a
// terminal, so it runs under script(1), and the client is closed once the message is in the transcript.
const SEND_MS = 25_000;
const sendingTo = new Set();
async function sendToBackground(s, text) {
  if (sendingTo.has(s.sessionId)) return { ok: false, error: 'Your last message or mode switch is still on its way.' };
  if (/^[/!]/.test(text)) return { ok: false, error: 'A message that starts with / or ! is not sent this way. Start it with a word.' };
  const file = transcriptFile(s.sessionId), ws = wsOfSession(s);
  if (!file) return { ok: false, error: 'It has no saved conversation yet.' };
  if (!ws) return { ok: false, error: NO_WS };
  sendingTo.add(s.sessionId);
  const p = spawn('script', ['-q', '/dev/null', 'claude', '--resume', s.sessionId, '--', text],
    { cwd: s.cwd, env: { ...envOf(ws), TERM: 'xterm-256color' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '';
  p.stdout.on('data', (d) => { out = (out + d).slice(-4000); });
  p.stderr.on('data', (d) => { out = (out + d).slice(-4000); });
  let exited = false;
  p.on('exit', () => { exited = true; });
  p.on('error', () => { exited = true; });
  const has = (d) => (d.type === 'queue-operation' && d.content === text) || (d.type === 'user' && d.message?.content === text)
    || (d.type === 'attachment' && d.attachment?.type === 'queued_command' && d.attachment.prompt === text);
  let seen = false;
  for (const end = Date.now() + SEND_MS; !seen && Date.now() < end; await new Promise((r) => setTimeout(r, 400))) {
    for (const line of tailOf(file, 256_000)) { try { if (has(JSON.parse(line))) { seen = true; break; } } catch {} }
    if (exited && !seen) break;
  }
  await new Promise((r) => setTimeout(r, seen ? 800 : 0));
  try { process.kill(-p.pid, 'SIGTERM'); } catch {}
  sendingTo.delete(s.sessionId);
  if (!seen) return { ok: false, error: 'It did not take your message. ' + (out.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '').replace(/\s+/g, ' ').trim().slice(-160) || 'Try claude attach.') };
  logSent(s, text, 'now');
  setTimeout(() => pollRoster(ws), 600);
  return { ok: true, sent: true };
}

// A /command. A running background job takes none from outside (claude --resume refuses one), so slash-command.py types
// it at its prompt the way you would in claude attach, only while it is idle there with nothing open. Anything else runs
// it as the prompt it restarts with. Refused here: commands that only open a view or a menu on its screen, which nobody
// would see, and /model and /effort, which also make it your default for new sessions (the menus by the chat box don't).
const SCREEN_ONLY = new Set(['status', 'permissions', 'theme', 'help', 'resume', 'rewind', 'usage', 'cost', 'stats']);
const BARE_SCREEN_ONLY = new Set(['config', 'settings', 'advisor']); // these open one only without arguments
function commandOf(text) {
  const m = /^\/([\w:.-]{1,80})(?: ([^\n\r]{0,400}))?$/.exec(text);
  if (!m) return { error: 'A command is one line: /name, then its arguments (400 characters at most).' };
  const [, name, args = ''] = m;
  if (name === 'model' || name === 'effort') return { error: `Pick its ${name} in the menu by the chat box: /${name} would also make it your default for new sessions.` };
  if (SCREEN_ONLY.has(name) || (BARE_SCREEN_ONLY.has(name) && !args.trim())) return { error: `/${name} opens a view on its screen, which nobody sees in the background. Run it in claude attach.` };
  return { name };
}
const SLASH = fileURLToPath(new URL('./slash-command.py', import.meta.url));
async function runCommand(s, text) {
  if (s.status === 'waiting' || [...pending.values()].some((p) => p.sessionId === s.sessionId)) return { ok: false, error: 'Answer what it is asking first.' };
  if (sendingTo.has(s.sessionId)) return { ok: false, error: 'Your last message or mode switch is still on its way.' };
  const file = transcriptFile(s.sessionId), ws = wsOfSession(s);
  if (!file) return { ok: false, error: 'It has no saved conversation yet.' };
  if (!ws) return { ok: false, error: NO_WS };
  sendingTo.add(s.sessionId);
  const r = await run('python3', [SLASH, s.id, text, file], { cwd: os.homedir(), timeout: 60_000, env: envOf(ws) });
  sendingTo.delete(s.sessionId);
  let out;
  try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { out = { ok: false, error: firstLine(r) || 'The command did not report back.' }; }
  if (!out.ok) return { ok: false, error: out.error };
  logSent(s, text, 'command', Date.now(), { ran: out.ran ?? null, output: trimMid(out.output || null, 3000), status: out.status ?? null });
  setTimeout(() => pollRoster(ws), 600);
  broadcast();
  return { ok: true, command: true, ran: out.ran ?? null, status: out.status ?? null };
}

// A terminal session has no way in from outside. One that is working keeps your message here, and once it is free
// (its turn over, no subagent running, nothing waiting on you) the panel replies as it would to an idle one:
// Claude closes in its terminal and carries on in the background with it.
const inbox = new Map(); // sessionId → [{ id, text, at }]
const delivering = new Set();
const hasRunningSub = (s) => [...s.subagents.values()].some((a) => !a.stoppedAt);
const isWorking = (s) => !isEnded(s) && (s.inRoster || !s.kind) && !atPrompt(s)
  && ([...pending.values()].some((p) => p.sessionId === s.sessionId) || hasRunningSub(s)
      || (s.inRoster ? Boolean(s.status) && s.status !== 'idle' : Date.now() - (s.lastTool?.at ?? 0) < 60_000));
async function deliverQueued() {
  for (const [id, q] of inbox) {
    const s = sessions.get(id);
    if (!s || delivering.has(id) || isWorking(s)) continue;
    delivering.add(id);
    // A /command goes in on its own; the messages before it go in together.
    const cut = q.findIndex((m) => m.text.startsWith('/'));
    const batch = q.slice(0, cut === 0 ? 1 : cut < 0 ? q.length : cut);
    const pick = (k) => batch.findLast((m) => m[k])?.[k];
    const mode = pick('mode'), model = pick('model'), effort = pick('effort');
    const r = await reply({ sessionId: id, text: batch.map((m) => m.text).join('\n\n'), fromQueue: true,
                            ...(mode ? { mode } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
    delivering.delete(id);
    if (r.ok) {
      q.splice(0, q.length, ...q.filter((m) => !batch.includes(m)));
      if (!q.length) inbox.delete(id);
      if (!r.command) for (const m of batch) logSent(s, m.text, 'once it was done', m.at);
      s.queueError = null;
    } else s.queueError = r.error;
    broadcast();
  }
}
/** What you sent it from here, newest last: the panel's half of the chat. */
function logSent(s, text, how, at = Date.now(), extra = {}) {
  (s.sent ??= []).push({ text: trim(text, 3000), at, how, ...extra });
  if (s.sent.length > 5) s.sent.shift();
}
function unqueue(body) {
  const q = inbox.get(body?.sessionId);
  const i = q ? q.findIndex((m) => m.id === body?.id) : -1;
  if (i < 0) return { ok: false, error: 'It already has that message.' };
  q.splice(i, 1);
  if (!q.length) inbox.delete(body.sessionId);
  broadcast();
  return { ok: true };
}

/** The worktree a session works in, if any: its roster folder or the folder of its newest step, else the worktree its
 *  transcript last says it entered (and didn't leave). */
function worktreeOf(s) {
  const inTree = [s.ranCwd, s.hereCwd, s.cwd].find((c) => /\/\.claude\/worktrees\/[^/]+/.test(c ?? ''));
  if (inTree) return inTree;
  const file = transcriptFile(s.sessionId);
  if (!file) return null;
  for (const line of tailOf(file, 2_000_000)) {
    if (!line.includes('"worktree-state"')) continue;
    try { const p = JSON.parse(line).worktreeSession?.worktreePath; return typeof p === 'string' && fs.existsSync(p) ? p : null; } catch {}
  }
  return null;
}

async function reply(body) {
  const s = liveSession(body);
  const fail = (error) => ({ ok: false, error });
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!s) return fail('That session is gone.');
  const ws = wsOfSession(s); // everything below runs under its own profile
  if (!ws) return fail(NO_WS);
  if (!text || text.length > 20_000) return fail('Write a reply (up to 20,000 characters).');
  if (text.startsWith('!')) return fail('A message that starts with ! (a shell command) is not sent from here.');
  const command = text.startsWith('/') ? commandOf(text) : null;
  if (command?.error) return fail(command.error);
  const running = s.inRoster && !isEnded(s);
  if (s.kind !== 'background' && s.kind !== 'interactive') return fail('Only background and terminal sessions take a reply here.');
  if (!UUID.test(s.sessionId)) return fail('It has no session id to resume.');
  if (s.pid != null && hostPids.has(s.pid)) return fail('The panel server runs inside this session, so reply to it in its terminal.');
  // A model or effort you picked, when it differs from what it runs on now. Either takes a restart: a running session
  // changes them only at its own prompt (/model, /effort), and both of those also make it your default for new sessions.
  if (body?.model && !MODELS.has(body.model)) return fail('Pick a model from the list.');
  if (body?.effort && !EFFORTS.has(body.effort)) return fail('Pick an effort level from the list.');
  const now = ranOn(s.sessionId);
  const want = { model: body?.model && !sameModel(body.model, now.model) ? body.model : null,
                 effort: body?.effort && body.effort !== now.effort ? body.effort : null };
  const change = Boolean(want.model || want.effort);
  // A background job still running takes it as your next message, working or not, unless it is to restart. (One that
  // finished and was stopped stays on the list as done, with no process.)
  const bgUp = s.kind === 'background' && s.inRoster && BG_ID.test(s.id ?? '') && !['stopped', 'failed'].includes(s.state) && s.pid != null;
  if (bgUp && !change && !command) return sendToBackground(s, text);
  // A background job Claude Code still lists keeps the options it started with (its name, model, effort, mode and
  // worktree): resumed with none, it wakes as itself under the same id. Passing any starts a copy instead: the same
  // conversation under a new id, in the folder it is started from. So a model, effort or mode you pick needs its
  // record removed first (claude rm) for it to wake as itself, and that would take a worktree the job made along with
  // it. One that works in its own worktree carries on as a copy started from inside that worktree instead; its record
  // stays, ended, and keeps the worktree (Claude Code refuses to remove it while the copy works there).
  const modePick = RESUME_MODES.has(body?.mode) ? body.mode : null;
  const keeps = s.kind === 'background' && s.inRoster && BG_ID.test(s.id ?? '');
  const repick = Boolean(change || modePick);
  const tree = keeps && repick ? worktreeOf(s) : null;
  // One that is working keeps your message until it is done: a terminal session always, a background job that is to
  // restart or run a /command.
  if ((s.kind === 'interactive' || bgUp) && isWorking(s) && !body?.fromQueue) {
    if (stops.has(stopKey(s.sessionId, null))) return fail('It is stopping. Send your message once it is idle.');
    const q = inbox.get(s.sessionId) ?? [];
    if (q.length >= 10) return fail('Ten messages are already waiting for it.');
    q.push({ id: crypto.randomUUID(), text, at: Date.now(), mode: RESUME_MODES.has(body?.mode) ? body.mode : null, ...want });
    inbox.set(s.sessionId, q);
    broadcast();
    return { ok: true, queued: true };
  }
  if (isWorking(s)) return fail('It is still working. Wait for it to finish, or interrupt it first.');
  if (bgUp && !change) return runCommand(s, text);
  const cwd = tree ?? s.cwd; // a copy starts from inside its worktree (the roster gives a stopped job its starting folder back)
  if (!cwd || !fs.existsSync(cwd)) return fail(`Its folder is gone (${cwd}), so it can't be resumed.`);
  // Checked before anything is ended: a session that never saved a conversation has nothing to resume.
  const turn = lastTurn(s.sessionId);
  if (!turn.file || !turn.talked) return fail(s.kind === 'interactive' ? 'It has no saved conversation yet, so it would not come back. Reply in its terminal.' : 'It has no saved conversation yet, so it would not come back.');

  // A job that is done with its task is still up, waiting at its prompt: it is stopped too, before its record goes.
  if (bgUp || (running && s.pid != null)) {
    const r = await endSession(s);
    if (!r.ok) return r;
    const gone = await rosterSettles(ws, s.sessionId, (r) => !r || ['stopped', 'failed'].includes(r.state) || (bgUp ? r.pid == null : r.state === 'done'));
    if (!gone) return fail('It did not stop in time, so your reply was not sent. Try again.');
  }
  const args = ['--bg', '--resume', s.sessionId];
  if (!keeps || repick) {
    if (keeps && !tree) {
      const r = await run('claude', ['rm', s.id], { env: envOf(ws) });
      if (r.err && !/No job matching/i.test(firstLine(r))) return fail(`It can't be restarted with your reply: ${firstLine(r)}`);
    }
    if (s.name && !s.name.startsWith('-')) args.push('--name', s.name.slice(0, 120));
    const model = want.model ?? turn.model, effort = want.effort ?? turn.effort;
    if (model && /^[\w.\-[\]]{1,80}$/.test(model)) args.push('--model', model);
    if (EFFORTS.has(effort)) args.push('--effort', effort);
    // The mode you picked, else one the panel switched it to since, else the one its transcript last shows (a switch is
    // written there only with its next message). Never the hook-reported one: hooks carry no token, so a forged event
    // must not be able to pick the mode a session restarts in.
    const switched = bgUp && s.switchedTo?.at > (turn.modeAt ?? 0) ? s.switchedTo.mode : null;
    const mode = [modePick, switched, turn.mode].find((m) => RESUME_MODES.has(m));
    if (mode) args.push('--permission-mode', mode);
  }
  args.push('--', text);
  const r = await run('claude', args, { cwd, timeout: 30_000, env: envOf(ws) });
  const id = `${r.stdout}\n${r.stderr}`.match(/backgrounded · (\w+)/)?.[1];
  if (!id) return fail(firstLine(r));
  const copy = Boolean(tree);
  if (copy) s.continuedAs = { id, at: Date.now() }; // the record stays on the board, ended, and says where it went
  else { dismissed.delete(s.sessionId); Object.assign(s, { ended: false, closedByPanel: false, note: null }); }
  setTimeout(() => pollRoster(ws), 400);
  broadcast();
  if (!body?.fromQueue) logSent(s, text, 'restarted');
  return { ok: true, id, same: s.sessionId.startsWith(id), ...(copy ? { copy } : {}), ...(change ? { restartedOn: want } : {}) };
}

// ---------------------------------------------------------------- mode

// A running session's mode only changes from its own screen (Shift+Tab) or with a permission answer. For a background
// job the panel does the former: mode-switch.py attaches in a pseudo-terminal and presses Shift+Tab until the footer
// shows the mode. Terminal sessions are on someone's screen, so they switch there.
const MODE_SWITCH = fileURLToPath(new URL('./mode-switch.py', import.meta.url));
async function switchMode(body) {
  const s = liveSession(body);
  const mode = body?.mode;
  if (!s) return { ok: false, error: 'That session is gone.' };
  if (!RESUME_MODES.has(mode)) return { ok: false, error: 'Pick ask, accept edits, plan or auto.' };
  // A job that is done with its task is still there to attach to; a stopped or failed one would be started again.
  if (s.kind !== 'background' || !s.inRoster || !BG_ID.test(s.id ?? '') || s.ended || s.state === 'stopped' || s.state === 'failed' || s.pid == null)
    return { ok: false, error: s.kind === 'interactive' ? 'A terminal session switches with Shift+Tab in its terminal. Here, a message or a permission answer can switch it.' : 'Only a running background session switches here.' };
  // Shift+Tab in an open dialog would answer it, so not while it waits on you.
  if (s.status === 'waiting' || [...pending.values()].some((p) => p.sessionId === s.sessionId))
    return { ok: false, error: 'Answer what it is asking first. Allowing it can switch the mode too.' };
  if (sendingTo.has(s.sessionId)) return { ok: false, error: 'Your last message or mode switch is still on its way.' };
  const ws = wsOfSession(s);
  if (!ws) return { ok: false, error: NO_WS };
  sendingTo.add(s.sessionId);
  const r = await run('python3', [MODE_SWITCH, s.id, mode], { cwd: os.homedir(), timeout: 40_000, env: envOf(ws) });
  sendingTo.delete(s.sessionId);
  let out;
  try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { out = { ok: false, error: firstLine(r) || 'The switch did not report back.' }; }
  if (!out.ok) {
    if (RESUME_MODES.has(out.to)) { s.mode = out.to; s.switchedTo = { mode: out.to, at: Date.now() }; broadcast(); } // where it really is now
    return { ok: false, error: out.error };
  }
  s.mode = mode;
  s.switchedTo = { mode, at: Date.now() };
  broadcast();
  return { ok: true, from: out.from };
}

// ---------------------------------------------------------------- a question or plan nobody holds any more

// A background session's question (AskUserQuestion) or plan (ExitPlanMode) that no hook request holds any more (the
// hold ran out, or the panel restarted) is still open on its own screen, and a background session has no terminal to
// answer it in. The panel reads it from the transcript and answers it there: answer-question.py / answer-plan.py attach
// in a pseudo-terminal and press the keys you would. A plan's choices are the ones its held card offers anyway. A
// permission prompt is never answered by keys from here: that would go around Claude Code's permission system.
const ANSWER_QUESTION = fileURLToPath(new URL('./answer-question.py', import.meta.url));
const ANSWER_PLAN = fileURLToPath(new URL('./answer-plan.py', import.meta.url));
// What a plan's own screen approves into: auto mode, or asking before edits.
const OPEN_PLAN_MODES = new Set(['auto', 'default']);
const asks = new Map(); // sessionId → { size, mtimeMs, ask }: the last read of its transcript
/** The tool call a waiting background session's dialog is for, from its transcript, when the panel isn't holding it. */
function openAsk(s) {
  if (s.kind !== 'background' || !s.inRoster || s.status !== 'waiting' || isEnded(s) || !BG_ID.test(s.id ?? '')) return null;
  if ([...pending.values()].some((p) => p.sessionId === s.sessionId && !p.agentId)) return null;
  const file = transcriptFile(s.sessionId);
  let st;
  try { st = file && fs.statSync(file); } catch {}
  if (!st) return null;
  const c = asks.get(s.sessionId);
  if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.ask;
  let ask = null, n = 0;
  const answered = new Set();
  for (const line of tailOf(file, 512_000)) {
    if (++n > 800) break;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain) continue;
    const content = d.message?.content;
    if (d.type === 'user' && !Array.isArray(content)) break; // a prompt you typed: nothing before it is still open
    if (!Array.isArray(content)) continue;
    if (d.type === 'user') for (const b of content) if (b.type === 'tool_result') answered.add(b.tool_use_id);
    const t = d.type === 'assistant' && content.findLast((b) => b.type === 'tool_use' && !answered.has(b.id));
    if (t) { ask = { toolUseId: t.id, toolName: t.name, toolInput: t.input ?? {}, at: Date.parse(d.timestamp) || null }; break; }
  }
  asks.set(s.sessionId, { size: st.size, mtimeMs: st.mtimeMs, ask });
  return ask;
}
/** Workspace `wsId`'s open dialogs, shaped like held requests so the page shows them the same way. */
const openRequests = (wsId) => [...sessions.values()].flatMap((s) => {
  const a = s.ws === wsId ? openAsk(s) : null;
  return a ? [{ id: `open:${s.sessionId}:${a.toolUseId}`, open: true, sessionId: s.sessionId, agentId: null, toolName: a.toolName,
                toolInput: a.toolInput, toolUseId: a.toolUseId, permissionMode: s.mode ?? null, createdAt: a.at ?? Date.now() }] : [];
});
/** What its conversation got back for a tool call, once it has. */
function resultOf(s, toolUseId) {
  const file = transcriptFile(s.sessionId);
  if (!file) return null;
  for (const line of tailOf(file, 512_000)) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const r = d.type === 'user' && Array.isArray(d.message?.content) && d.message.content.find((b) => b.type === 'tool_result' && b.tool_use_id === toolUseId);
    if (r) return typeof r.content === 'string' ? r.content : (r.content ?? []).map((b) => b.text ?? '').join('\n');
  }
  return null;
}
async function answerOpen(body) {
  const s = liveSession(body);
  if (!s) return { ok: false, error: 'That session is gone.' };
  const ask = openAsk(s);
  if (!ask || ask.toolUseId !== body?.toolUseId) return { ok: false, error: 'It is not asking that any more.' };
  if (ask.toolName === 'ExitPlanMode') return answerOpenPlan(s, ask, body);
  if (ask.toolName !== 'AskUserQuestion')
    return { ok: false, error: `The panel only answers questions and plans this way. Open it with claude attach ${s.id} to answer its permission prompt.` };
  const qs = Array.isArray(ask.toolInput.questions) ? ask.toolInput.questions : [];
  if (!qs.length) return { ok: false, error: 'Its question has nothing in it to answer.' };
  if (qs.some((q) => q.multiSelect)) return { ok: false, error: `It asks for several picks at once, which the panel can't press for it. Open it with claude attach ${s.id}.` };
  const answers = body?.answers && typeof body.answers === 'object' ? body.answers : {};
  const picks = [];
  for (const q of qs) {
    const a = String(answers[q.question] ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
    if (!a || a.length > 2000) return { ok: false, error: 'Answer every question (up to 2,000 characters each).' };
    const opts = Array.isArray(q.options) ? q.options : [];
    const j = opts.findIndex((o) => o.label === a);
    picks.push(j >= 0 ? { option: j + 1 } : { other: opts.length + 1, text: a });
  }
  if (sendingTo.has(s.sessionId)) return { ok: false, error: 'Your last message or mode switch is still on its way.' };
  const ws = wsOfSession(s);
  if (!ws) return { ok: false, error: NO_WS };
  sendingTo.add(s.sessionId);
  const r = await run('python3', [ANSWER_QUESTION, s.id, JSON.stringify({ questions: qs.map((q) => q.question), picks,
    toolUseId: ask.toolUseId, transcript: transcriptFile(s.sessionId) })],
    { cwd: os.homedir(), timeout: 60_000, env: envOf(ws) });
  let out;
  try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { out = { ok: false, error: firstLine(r) || 'It did not report back.' }; }
  // Its conversation shows the answers once Claude Code takes them: check they are the ones picked.
  let got = null;
  for (const end = Date.now() + 15_000; out.ok && got == null && Date.now() < end; await new Promise((r) => setTimeout(r, 500))) got = resultOf(s, ask.toolUseId);
  sendingTo.delete(s.sessionId);
  asks.delete(s.sessionId);
  setTimeout(() => pollRoster(ws), 500);
  broadcast();
  if (!out.ok) return { ok: false, error: out.error };
  if (got == null) return { ok: false, error: 'Its screen took the answers, but its conversation does not show them yet. Look again in a moment.' };
  const wrong = qs.filter((q) => !got.replace(/\s+/g, ' ').includes(String(answers[q.question]).replace(/\s+/g, ' ').trim()));
  if (wrong.length) return { ok: false, error: `It took different answers than you picked: ${trim(got, 300)}` };
  logSent(s, qs.map((q) => `${q.header || q.question}: ${String(answers[q.question]).trim()}`).join('\n'), 'as its answers');
  return { ok: true };
}
/** Approve an open plan into a mode, or send it back with what to change, on its own screen. */
async function answerOpenPlan(s, ask, body) {
  let spec;
  if (body?.behavior === 'approve-plan') {
    if (!OPEN_PLAN_MODES.has(body.mode)) return { ok: false, error: 'Its screen approves into auto mode or asking before edits.' };
    spec = { choice: body.mode };
  } else if (body?.behavior === 'deny') {
    const text = String(body.message ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim();
    if (!text || text.length > 5000) return { ok: false, error: 'Say what to change (up to 5,000 characters).' };
    spec = { choice: 'feedback', text };
  } else return { ok: false, error: 'Approve the plan or send it back.' };
  if (sendingTo.has(s.sessionId)) return { ok: false, error: 'Your last message or mode switch is still on its way.' };
  const ws = wsOfSession(s);
  if (!ws) return { ok: false, error: NO_WS };
  sendingTo.add(s.sessionId);
  const r = await run('python3', [ANSWER_PLAN, s.id, JSON.stringify({ ...spec, toolUseId: ask.toolUseId, transcript: transcriptFile(s.sessionId) })],
    { cwd: os.homedir(), timeout: 60_000, env: envOf(ws) });
  let out;
  try { out = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { out = { ok: false, error: firstLine(r) || 'It did not report back.' }; }
  // Its conversation shows the answer once Claude Code takes it: check it is the one picked.
  let got = null;
  for (const end = Date.now() + 15_000; out.ok && got == null && Date.now() < end; await new Promise((r) => setTimeout(r, 500))) got = resultOf(s, ask.toolUseId);
  sendingTo.delete(s.sessionId);
  asks.delete(s.sessionId);
  setTimeout(() => pollRoster(ws), 500);
  broadcast();
  if (!out.ok) return { ok: false, error: out.error };
  if (got == null) return { ok: false, error: 'Its screen took it, but its conversation does not show it yet. Look again in a moment.' };
  const approved = got.startsWith('User has approved your plan');
  if (spec.choice === 'feedback' ? approved || !got.replace(/\s+/g, ' ').includes(spec.text) : !approved)
    return { ok: false, error: `It took a different answer than you picked: ${trim(got, 300)}` };
  logSent(s, spec.text ?? `Approved its plan, ${spec.choice === 'auto' ? 'in auto mode' : 'asking before edits'}`,
    spec.text ? 'as what to change in its plan' : 'on its screen');
  return { ok: true };
}

// ---------------------------------------------------------------- folders for a new agent

const expand = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);
const tilde = (p) => (p === os.homedir() ? '~' : p.startsWith(os.homedir() + '/') ? '~' + p.slice(os.homedir().length) : p);
/** Folders under the one being typed, for the launcher's suggestions. */
// ---------------------------------------------------------------- git: the branch and worktree a folder is on

// Read from the files under .git, never by running git: a repo's own config can make git run commands, and a hook
// event can name any folder.
const WORKTREE_NAME = /^(?!.*\.\.)(?!.*\.lock$)[A-Za-z0-9][\w.-]{0,59}$/;
const places = new Map(); // folder → { at, place }
/** The start of a regular file, read without blocking: a FIFO, a device or a directory is refused, never waited on. */
function small(f, max = 4096) {
  const fd = fs.openSync(f, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error(`${f} is not a file`);
    const buf = Buffer.alloc(max);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, max, 0)).trim();
  } finally { fs.closeSync(fd); }
}
function gitPlace(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
  const hit = places.get(dir);
  if (hit && Date.now() - hit.at < 4000) return hit.place;
  let place = null;
  try { place = readPlace(dir); } catch {}
  places.set(dir, { at: Date.now(), place });
  if (places.size > 500) places.delete(places.keys().next().value);
  return place;
}
function readPlace(dir) {
  for (let top = dir, i = 0; i < 64; i++) {
    const dot = path.join(top, '.git');
    let st = null;
    try { st = fs.statSync(dot); } catch {}
    if (st && !st.isFile() && !st.isDirectory()) return null;
    if (st) {
      let gitDir = dot, common = dot;
      if (st.isFile()) { // a linked worktree (or a submodule): .git names its git dir
        const m = small(dot).match(/^gitdir:\s*(.+)$/m);
        if (!m) return null;
        gitDir = common = path.resolve(top, m[1].trim());
        try { common = path.resolve(gitDir, small(path.join(gitDir, 'commondir'))); } catch {} // a submodule has none
      }
      const head = small(path.join(gitDir, 'HEAD'));
      const branch = head.match(/^ref:\s*refs\/heads\/(.+)$/)?.[1] ?? null;
      const linked = common !== gitDir;
      return { branch, commit: !branch && /^[0-9a-f]{40,64}$/.test(head) ? head.slice(0, 10) : null, worktree: linked ? path.basename(top) : null,
               top, repo: linked && path.basename(common) === '.git' ? path.dirname(common) : top, common };
    }
    const up = path.dirname(top);
    if (up === top) return null;
    top = up;
  }
  return null;
}
const placeOut = (p) => p && { branch: p.branch, commit: p.commit, worktree: p.worktree, top: p.top, repo: p.repo };
/** A `worktree` setting as Claude Code would see it from here, under workspace `ws`'s profile: local, then project, then
 *  user settings. */
const worktreeSetting = (place, key, ws) => [path.join(place.top, '.claude', 'settings.local.json'), path.join(place.top, '.claude', 'settings.json'), path.join(ws.profile.dir, 'settings.json')]
  .map((f) => { try { return JSON.parse(small(f, 512 * 1024))?.worktree?.[key]; } catch { return undefined; } })
  .find((v) => typeof v === 'string');
/** What a worktree Claude Code makes from here starts at: the remote's default branch, unless settings say HEAD. */
function worktreeBase(place, ws) {
  if (worktreeSetting(place, 'baseRef', ws) !== 'head') {
    try { const ref = small(path.join(place.common, 'refs', 'remotes', 'origin', 'HEAD')).match(/^ref:\s*refs\/remotes\/(.+)$/)?.[1]; if (ref) return ref; } catch {}
  }
  return place.branch ?? 'its current commit';
}
/** The launcher's look at a folder: is it there, and is it in a git repository. */
function folderInfo(body, ctx) {
  const dir = path.resolve(expand(String(body?.path ?? '').trim()) || os.homedir());
  try { if (!fs.statSync(dir).isDirectory()) return { ok: true, folder: false }; } catch { return { ok: true, folder: false }; }
  const p = gitPlace(dir), home = dir === os.homedir(), ws = ctx?.ws ?? shownWs(); // the workspace the launcher starts agents in: the page's
  // A background session moves itself into a worktree before it edits, unless the repo turned that off.
  return { ok: true, folder: true, git: p && { branch: p.branch, worktree: p.worktree, repo: tilde(p.repo), base: worktreeBase(p, ws),
                                               isolates: worktreeSetting(p, 'bgIsolation', ws) !== 'none' },
           // Whether this profile has trusted it; a background session starts only where it has (never the home folder).
           trusted: home ? null : isTrusted(ws.profile.config, trustKey(dir, p?.top)), home, profile: profileLabel(ws) };
}

const profileLabel = (ws) => path.basename(ws.profile.dir).slice(1);
/** Claude Code's own path, as the panel's commands find it (every workspace has the same PATH). */
const claudePath = () => String(baseEnv.PATH ?? '').split(':').filter(Boolean).map((d) => path.join(d, 'claude'))
  .find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } });
/** Terminal in the folder, on this profile, running Claude Code: its trust prompt waits there for you to accept. The
 *  window opens from a .command file, so the panel needs no permission to control Terminal. */
async function openTrustTerminal(body, ctx) {
  if (process.platform !== 'darwin') return { ok: false, error: 'Opening Terminal is macOS only. Run claude in the folder once and accept its prompt.' };
  const dir = path.resolve(expand(String(body?.path ?? '').trim()) || os.homedir());
  try { if (!fs.statSync(dir).isDirectory()) throw new Error(); } catch { return { ok: false, error: `There is no folder at ${tilde(dir)}.` }; }
  if (dir === os.homedir()) return { ok: false, error: 'Claude Code never keeps trust for your home folder. Pick a project folder.' };
  const claude = claudePath();
  if (!claude) return { ok: false, error: "Claude Code wasn't found on the panel's PATH." };
  const where = path.join(path.dirname(PREFS), 'trust');
  fs.mkdirSync(where, { recursive: true, mode: 0o700 });
  for (const n of fs.readdirSync(where)) try { const f = path.join(where, n); if (Date.now() - fs.statSync(f).mtimeMs > 3_600_000) fs.unlinkSync(f); } catch {}
  const file = path.join(where, `trust-${crypto.randomBytes(4).toString('hex')}.command`);
  const ws = ctx?.ws ?? shownWs(); // trust is for the launcher, which starts agents in the page's workspace
  fs.writeFileSync(file, trustScript({ dir, configDir: ws.profile.plain ? null : ws.profile.dir, claude, label: profileLabel(ws) }), { mode: 0o700 });
  const r = await run('open', ['-a', 'Terminal', file], { timeout: 10_000, env: baseEnv });
  return r.err ? { ok: false, error: firstLine(r) } : { ok: true };
}

function listFolders(body) {
  const typed = expand(String(body?.path ?? '').trim());
  if (!typed.startsWith('/')) return { ok: true, folders: [] };
  const parent = typed.endsWith('/') ? typed : path.dirname(typed), stem = typed.endsWith('/') ? '' : path.basename(typed).toLowerCase();
  let names = [];
  try {
    names = fs.readdirSync(parent, { withFileTypes: true })
      .filter((d) => (stem.startsWith('.') || !d.name.startsWith('.')) && d.name.toLowerCase().startsWith(stem)
        && (d.isDirectory() || (d.isSymbolicLink() && (() => { try { return fs.statSync(path.join(parent, d.name)).isDirectory(); } catch { return false; } })())))
      .map((d) => d.name).sort((a, b) => a.localeCompare(b)).slice(0, 60);
  } catch {}
  return { ok: true, folders: names.map((n) => tilde(path.join(parent, n))) };
}
// ---------------------------------------------------------------- switching profile

/** Who a profile is signed in as, and on which plan, from Claude Code itself: its files can lag a fresh sign-in, and
 *  two profiles on one email differ only by plan. Undefined when it can't tell. */
async function signedIn(p) {
  const r = await run('claude', ['auth', 'status', '--json'], { env: envFor(p), timeout: 5000 });
  try {
    const a = JSON.parse(r.stdout);
    return a.loggedIn ? { email: a.email ?? null, org: a.orgName ?? null, plan: a.subscriptionType ?? null } : null;
  } catch { return undefined; }
}
const profiles = async (body, ctx) => ({ ok: true, active: ctx?.focus ?? shownId, profiles: await Promise.all(listProfiles().map(async (p) => {
  const d = describeProfile(p), a = await signedIn(p);
  return a === undefined ? d : { ...d, account: a };
})) });
/** A page that went away and didn't come back in time forgets its focus. */
function forgetFocusLater(client) {
  setTimeout(() => { if (!clientRes.has(client)) clientFocus.delete(client); }, RECONNECT_MS);
}
/** `{ ws, force }`: the asking page is shown workspace `ws`. Nothing is cleared or stopped: every workspace stays live,
 *  its sessions, held requests and waiting messages with it. Only what the page itself had open from the workspace it
 *  leaves (a session's chat, its terminal) stops reaching it. It is also the focus a new page starts on. */
function focusWorkspace(body, ctx = {}) {
  const id = typeof body?.ws === 'string' ? body.ws : '';
  if (id && !W.has(id)) syncWorkspaces(); // a profile folder made since the last roster read
  const ws = id ? wsById(id) : null;
  if (!ws) return { ok: false, error: 'There is no such workspace.' };
  const client = ctx.client ?? null, was = focusOf(client);
  if (ws.id !== was) {
    // Messages still waiting to go out to the sessions on screen: ask first, as switching always has.
    const queued = [...inbox].filter(([sid]) => sessions.get(sid)?.ws === was).reduce((n, [, q]) => n + q.length, 0);
    if (queued && body.force !== true) return { ok: false, confirm: true, queued };
  }
  if (client) {
    clientFocus.set(client, ws.id);
    if (!clientRes.has(client)) forgetFocusLater(client);
    const open = clientOpen.get(client);
    if (open && !ownedBy(ws.id, open)) { leave(client, open); clientOpen.delete(client); }
    for (const [sid, t] of terms) if (t.clients.has(client) && !ownedBy(ws.id, sid)) termLeave(client, sid);
  }
  store.setFocus(ws.id);
  if (ws.id !== shownId) {
    shownId = ws.id;
    savePrefs({ profile: ws.id });
    checkSetup(true);
  }
  broadcast();
  return { ok: true };
}
/**
 * Points a profile's hooks at this panel: adds the entries of hooks.example.json that its settings.json lacks, after
 * copying the file aside. Nothing else in it changes. Its sessions pick the hooks up as Claude Code reloads settings.
 */
function connectProfile(body) {
  const p = listProfiles().find((x) => x.id === body?.id);
  if (!p) return { ok: false, error: 'There is no such profile.' };
  const file = path.join(p.dir, 'settings.json');
  let settings = {};
  if (fs.existsSync(file)) {
    try { settings = JSON.parse(small(file, 4 << 20)); } catch { return { ok: false, error: `${tilde(file)} isn't valid JSON, so it was left as it is.` }; }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return { ok: false, error: `${tilde(file)} isn't a settings object, so it was left as it is.` };
  }
  if (settings.hooks != null && (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) return { ok: false, error: `Its "hooks" setting isn't an object, so it was left as it is.` };
  const want = JSON.parse(fs.readFileSync(new URL('./hooks.example.json', import.meta.url), 'utf8').replaceAll('127.0.0.1:4747/', HOOK_URL.replace(/hook\/$/, ''))).hooks;
  settings.hooks ??= {};
  let added = 0;
  for (const [event, entries] of Object.entries(want)) {
    const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : (settings.hooks[event] = []);
    if (list.some((m) => (m?.hooks ?? []).some((h) => typeof h?.url === 'string' && h.url.includes(HOOK_URL)))) continue;
    list.push(...entries);
    added++;
  }
  const fresh = () => { const ws = wsById(p.id); if (ws) ws.info = describeProfile(ws.profile); };
  if (!added) { fresh(); broadcast(); return { ok: true, added: 0 }; }
  let backup = null;
  if (fs.existsSync(file)) {
    backup = `${file}.before-glue-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(file, backup);
  }
  const tmp = `${file}.glue-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, file);
  fresh();
  broadcast();
  return { ok: true, added, backup: backup && tilde(backup) };
}

// ---------------------------------------------------------------- first-run setup

/** The prefs file holds more than one choice: a write keeps the others. */
function readPrefs() { try { const v = JSON.parse(small(PREFS, 65536)); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } }
function savePrefs(change) {
  try { fs.mkdirSync(path.dirname(PREFS), { recursive: true }); fs.writeFileSync(PREFS, JSON.stringify({ ...readPrefs(), ...change }) + '\n'); } catch {}
}
// Whether each workspace's profile is signed in to Claude Code (its `setup.claude`), and gh to GitHub: the checklist, the
// sign-in banner and the profile tab show it. Read when the panel starts, when a workspace appears or is shown, every few
// minutes while a page is open, when a page asks (while the checklist waits on a sign-in, and when you come back to its
// window), and when Claude Code fails with what reads as a login error. Never on the 1 s tick: each read starts a
// process. gh and the checklist being done are one for all workspaces: one GitHub login, one checklist.
const setup = { github: { state: process.env.ACP_GITHUB === 'off' ? 'off' : 'unknown' }, done: readPrefs().setupDone === true, checkedAt: 0 };
let setupCheck = null;
function checkSetup(force) {
  if (setupCheck) return setupCheck;
  if (!force && Date.now() - setup.checkedAt < 3000) return Promise.resolve();
  const list = [...W.values()], gh = ghPath();
  setupCheck = Promise.all([
    Promise.all(list.map((ws) => run('claude', ['auth', 'status', '--json'], { env: envOf(ws), timeout: 8000 }).then((r) => parseClaudeAuth(r.stdout)))),
    setup.github.state === 'off' ? setup.github
      : gh ? run(gh, ['auth', 'status', '--hostname', 'github.com'], { env: baseEnv, cwd: path.dirname(PREFS), timeout: 8000 }).then(parseGhAuth) : { state: 'missing' },
  ]).then(([claudes, gh]) => {
    const seen = () => JSON.stringify([list.map((ws) => ws.setup.claude), setup.github]), was = seen();
    list.forEach((ws, i) => {
      // A read that timed out says nothing new: a sign-in already seen stays.
      if (claudes[i].state !== 'unknown' || ws.setup.claude.state === 'unknown') ws.setup.claude = claudes[i];
      ws.setup.checkedAt = Date.now();
    });
    setup.github = gh;
    setup.checkedAt = Date.now();
    // Signed in to gh again: the GitHub poller waits five minutes after a signed-out answer, so it looks now instead.
    if (gh.state === 'ok' && github.state().gh === 'signed-out') github.refresh();
    if (seen() !== was) broadcast();
  }).finally(() => { setupCheck = null; });
  return setupCheck;
}
/** A failure from Claude Code that reads as a login problem: look again, so the banner says so. */
function loginFailed(text) { if (LOGIN_ERROR.test(String(text ?? ''))) checkSetup(true); }
const setupOut = (ws) => ({ claude: ws.setup.claude, github: setup.github, done: setup.done, loginCommand: claudeLoginCommand(ws.profile) });
async function setupCheckNow(body, ctx) { await checkSetup(false); return { ok: true, setup: setupOut(ctx?.ws ?? shownWs()) }; }
function setupDone(body) {
  setup.done = body?.done !== false;
  savePrefs({ setupDone: setup.done });
  broadcast();
  return { ok: true };
}
/** Terminal, running Claude Code's own sign-in on this profile, or gh's: the panel never sees a password or token. */
async function openLoginTerminal(body, ctx) {
  if (process.platform !== 'darwin') return { ok: false, error: 'Opening Terminal is macOS only. Run the command shown in a terminal.' };
  const what = body?.what === 'gh' ? 'gh' : 'claude';
  const bin = what === 'gh' ? ghPath() : claudePath();
  if (!bin) return { ok: false, error: what === 'gh' ? "The GitHub CLI (gh) isn't installed. Run brew install gh, then try again." : "Claude Code wasn't found on the panel's PATH." };
  const where = path.join(path.dirname(PREFS), 'trust');
  fs.mkdirSync(where, { recursive: true, mode: 0o700 });
  for (const n of fs.readdirSync(where)) try { const f = path.join(where, n); if (Date.now() - fs.statSync(f).mtimeMs > 3_600_000) fs.unlinkSync(f); } catch {}
  const file = path.join(where, `login-${what}-${crypto.randomBytes(4).toString('hex')}.command`);
  const ws = ctx?.ws ?? shownWs(); // the sign-in banner and checklist on this page are its workspace's
  fs.writeFileSync(file, loginScript({ what, bin, configDir: ws.profile.plain ? null : ws.profile.dir, label: profileLabel(ws) }), { mode: 0o700 });
  const r = await run('open', ['-a', 'Terminal', file], { timeout: 10_000, env: baseEnv });
  return r.err ? { ok: false, error: firstLine(r) } : { ok: true };
}

/** The Mac's own folder dialog, opened where the field points. */
let picking = false;
async function pickFolder(body) {
  if (process.platform !== 'darwin') return { ok: false, error: 'The folder dialog is macOS only. Type the path.' };
  if (picking) return { ok: false, error: 'The folder dialog is already open. It may be behind this window.' };
  let start = expand(String(body?.path ?? '').trim()) || os.homedir();
  try { if (!fs.statSync(start).isDirectory()) start = os.homedir(); } catch { start = os.homedir(); }
  picking = true;
  const r = await run('osascript', ['-e', 'on run argv', '-e', 'tell me to activate',
    '-e', 'return POSIX path of (choose folder with prompt "Folder for the new agent" default location (POSIX file (item 1 of argv)))',
    '-e', 'end run', start], { timeout: 600_000, env: baseEnv });
  picking = false;
  if (r.err) return /-128|cancel/i.test(r.stderr) ? { ok: false, cancelled: true } : { ok: false, error: firstLine(r) };
  return { ok: true, path: tilde(r.stdout.trim().replace(/(.)\/$/, '$1')) };
}

// ---------------------------------------------------------------- deleted versions

// Every workspace's running sessions, checked each minute for a Claude Code version deleted under them (versions.mjs):
// macOS can then refuse them ~/Documents at any moment. Each is marked on its tile; all of them, other workspaces' too,
// are listed in a banner, since the one that loses access is often not the one on screen.
const VERSIONS_MS = 60_000;
let oldVersions = [], checkingVersions = false;
// ps and lsof read processes, not any profile's files.
const runPlain = (cmd, args, opts = {}) => run(cmd, args, { env: baseEnv, ...opts });
async function checkVersions() {
  if (checkingVersions) return;
  checkingVersions = true;
  try {
    const rows = [...sessions.values()].filter((s) => s.inRoster && !isEnded(s) && Number.isInteger(s.pid) && W.has(s.ws)).map((s) => ({ s, p: W.get(s.ws).profile }));
    const found = await findRemoved(rows.map(({ s }) => s.pid), { run: runPlain });
    const next = rows.filter(({ s }) => found.has(s.pid)).map(({ s, p }) => ({
      sessionId: s.sessionId, id: s.id ?? null, name: s.name ?? null, kind: s.kind ?? null, ws: s.ws,
      profile: { id: p.id, label: path.basename(p.dir).slice(1), command: cliOf(p) },
      version: found.get(s.pid).version, self: found.get(s.pid).self }));
    for (const s of sessions.values()) {
      const o = next.find((x) => x.sessionId === s.sessionId);
      s.oldVersion = o ? { version: o.version, self: o.self } : null;
    }
    const changed = JSON.stringify(next) !== JSON.stringify(oldVersions);
    oldVersions = next;
    if (changed) broadcast();
  } catch (err) { console.error('version check failed:', err?.message ?? err); }
  finally { checkingVersions = false; }
}

// ---------------------------------------------------------------- live thread
// The open session's Chat is live. Its transcript is followed from the end (follow.mjs), what the hooks say is merged
// into it (thread.mjs), and every change goes to each page that has the session open, as an `event: thread` message on
// that page's /events stream. A page names itself with `c=` and says which session it has open with /api/follow (one
// at a time); however many pages open a session, its transcript has one follow, which stops RECONNECT_MS after the last
// of them has left. A session with no transcript yet (one just launched) is looked for every second until it has one.

const FOLLOW_RETRY_MS = 1000;
const CLIENT = /^[\w-]{1,64}$/;
/** sessionId → its thread. Made by the session's first PreToolUse or follow. */
const threads = new Map();
/** sessionId → { follow, clients: Set<clientId>, hush: clients whose /api/follow reply is still coming, ... } */
const follows = new Map();
/** clientId → the session that page has open. */
const clientOpen = new Map();
/** clientId → that page's /events response. */
const clientRes = new Map();

/** What a page gets of a row or an update: all but the call's input, which only the thread keys by. A copy: the
 *  thread's own objects are never changed. */
function bare(x) {
  if (x.who === 'update') { const { input, ...patch } = x.patch; return { ...x, patch }; }
  const { input, ...rest } = x;
  return rest;
}
function sendTo(ids, name, data) {
  const msg = `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of ids) { const res = clientRes.get(c); if (res && !res.writableEnded && !res.destroyed) res.write(msg); }
}

function threadOf(sessionId) {
  let t = threads.get(sessionId);
  if (!t) {
    // Changes go to the pages that follow it, except one still waiting for its /api/follow reply: that carries them.
    // Only pages shown the session's workspace.
    t = createThread({ emit: (events) => {
      const f = follows.get(sessionId);
      const to = f ? sealedTo([...f.clients].filter((c) => !f.hush.has(c)), followWs(f)) : [];
      if (to.length) sendTo(to, 'thread', { sessionId, events: events.map(bare) });
    } });
    threads.set(sessionId, t);
  }
  return t;
}

/** The workspace a followed session is in: its record's, else the one it was first followed from. */
const followWs = (f) => sessions.get(f.sessionId)?.ws ?? f.ws;
/** Start following a session's transcript, if it has one now. The follow opens first, at the file's end, and what lies
 *  before that offset is read back into the thread, so no line lands in neither and none in both; lines the follow
 *  reads meanwhile go in after it. Resolves whether it is live, and never rejects: an open that fails is logged and
 *  forgotten, so the next /api/follow or retry tries again. */
function openFollow(f) {
  if (f.ready) return f.ready;
  const file = transcriptFile(f.sessionId, wsById(f.ws));
  if (!file) return Promise.resolve(false);
  const id = f.sessionId, t = threadOf(id);
  let follow = null;
  const ready = (async () => {
    let early = [];
    follow = createFollow(file, {
      onItems: (items) => { try { if (early) early.push(...items); else t.addItems(items); } catch (err) { console.error('follow:', err?.message ?? err); } },
      // Shrunk or replaced: what the pages have is gone, and they ask again.
      onReset: () => { try { if (early) early = []; t.reset(); sendTo(sealedTo(f.clients, followWs(f)), 'thread-reset', { sessionId: id }); } catch (err) { console.error('follow:', err?.message ?? err); } },
    });
    await follow.start(); // rejects if it is gone again since it was found
    if (f.stopped) { follow.stop(); return false; }
    f.follow = follow;
    try {
      const { items, more } = await readChat(file, { limit: f.limit, before: follow.offset() });
      if (f.stopped) return false;
      f.more = more;
      t.addItems(items);
    } catch (err) { console.error('follow: reading back', err?.message ?? err); }
    const late = early;
    early = null;
    try { if (late.length) t.addItems(late); } catch (err) { console.error('follow:', err?.message ?? err); }
    return true;
  })().catch((err) => { // runs after `f.ready = ready` below, even for a throw before the first await
    console.error('follow:', err?.message ?? err);
    follow?.stop();
    if (f.follow === follow) f.follow = null;
    if (f.ready === ready) f.ready = null;
    return false;
  });
  return (f.ready = ready);
}
/** Look for a pending follow's transcript again in a second, until it is found or nobody follows it. */
function retryFollow(f) {
  if (f.retry || f.stopped) return;
  f.retry = setTimeout(async () => {
    f.retry = null;
    if (f.stopped) return;
    try { if (!(await openFollow(f))) retryFollow(f); } catch (err) { console.error('follow:', err?.message ?? err); }
  }, FOLLOW_RETRY_MS);
}
function stopFollow(f) {
  f.stopped = true;
  f.follow?.stop();
  clearTimeout(f.retry);
  clearTimeout(f.release);
  if (follows.get(f.sessionId) === f) follows.delete(f.sessionId);
  threads.get(f.sessionId)?.reset(); // its rows are read back when it is opened again; its hook state stays
}
/** A page no longer has session `id` open. Its follow stops RECONNECT_MS after it has nobody left. */
function leave(client, id) {
  const f = follows.get(id);
  if (!f) return;
  f.clients.delete(client);
  f.hush.delete(client);
  if (f.clients.size || f.release) return;
  f.release = setTimeout(() => { f.release = null; if (!f.clients.size) stopFollow(f); }, RECONNECT_MS);
}
/** A page that went away: its stream closed, or it never opened one. */
function dropClient(client) {
  clientOpen.delete(client);
  for (const id of [...terms.keys()]) termLeave(client, id);
  for (const [id, f] of follows) if (f.clients.has(client)) leave(client, id);
}

/** `{ client, sessionId | null, limit }`: page `client` has that session open (null: none). Its thread so far, and
 *  whether there is more before it; `pending` while the session has no transcript, whose rows then come as events. */
async function followSession(body) {
  const client = body?.client, id = body?.sessionId ?? null;
  if (typeof client !== 'string' || !CLIENT.test(client)) return { ok: false, error: 'Which page is this?' };
  if (id !== null && (typeof id !== 'string' || !UUID.test(id))) return { ok: false, error: 'There is no such session.' };
  const limit = Number.isInteger(body.limit) ? Math.min(2000, Math.max(1, body.limit)) : 60;
  // Already followed from another workspace's page (a session no workspace knows yet): not this page's to join.
  if (id !== null && follows.has(id) && followWs(follows.get(id)) !== focusOf(client)) return { ok: false, error: REFUSE };
  const was = clientOpen.get(client);
  if (was && was !== id) leave(client, was);
  if (id === null) { clientOpen.delete(client); return { ok: true, items: [], more: false }; }
  clientOpen.set(client, id);
  // A page that asks before its stream is up gets the grace a reload does; one that never opens a stream is let go.
  if (!clientRes.has(client)) setTimeout(() => { if (!clientRes.has(client)) dropClient(client); }, RECONNECT_MS);
  let f = follows.get(id);
  if (!f) follows.set(id, f = { sessionId: id, ws: wsIdOfSession(id) ?? focusOf(client), clients: new Set(), hush: new Set(), follow: null,
                                ready: null, more: false, limit, retry: null, release: null, stopped: false });
  clearTimeout(f.release);
  f.release = null;
  f.clients.add(client);
  f.hush.add(client);
  const live = await openFollow(f);
  f.hush.delete(client);
  if (!live) { retryFollow(f); return { ok: true, items: [], more: false, pending: true }; }
  return { ok: true, items: threadOf(id).items().map(bare), more: f.more };
}

// ---------------------------------------------------------------- GitHub: pull requests and checks for the branches agents are on

/** A macOS notification, which shows with no page open. Title and text go in as arguments, never as script. */
function notify(title, text) {
  if (process.platform !== 'darwin') return;
  run('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run',
    String(title).slice(0, 120), String(text).slice(0, 400)], { timeout: 10_000, env: baseEnv }).then((r) => { if (r.err) console.error('notify:', firstLine(r)); });
}
/** The gh CLI, as the panel's PATH finds it, else where Homebrew puts it: the app and the daemon bake a PATH that can lack it. */
const ghPath = () => [...String(baseEnv.PATH ?? '').split(':').filter(Boolean).map((d) => path.join(d, 'gh')), '/opt/homebrew/bin/gh', '/usr/local/bin/gh']
  .find((f) => { try { fs.accessSync(f, fs.constants.X_OK); return fs.statSync(f).isFile(); } catch { return false; } }) ?? null;
/** Where a session works, as git sees it: the checkout its tools ran in, else the one it started in. */
const placeOf = (s) => gitPlace(s.ranCwd ?? s.hereCwd ?? s.cwd);
const github = createGithub({
  file: path.join(dataDir, 'github.json'), run, read: small, ghPath, cwd: dataDir, env: baseEnv,
  off: process.env.ACP_GITHUB === 'off', mine: true, // your own open pull requests too, in any repository
  // Every session on the board, a finished background job waiting on its checks included.
  targets: () => [...sessions.values()].filter((s) => s.inRoster || !isEnded(s)).map((s) => {
    const p = placeOf(s);
    return p?.common ? { sessionId: s.sessionId, common: p.common, branch: p.branch, at: s.lastEventAt ?? s.startedAt ?? 0 } : null;
  }).filter(Boolean),
  notify,
  onEvent: (ev) => onGithubEvent(ev),
  onChange: () => { broadcast(); watcherCheck(); },
});
let onGithubEvent = () => {}, watcherCheck = () => {};
/** The failing log of a run or check the panel shows, trimmed, with the message that would hand it to an agent. */
async function githubLog(body) {
  const slug = String(body?.slug ?? ''), runId = String(body?.runId ?? '');
  if (!/^\d+$/.test(runId) || !github.knows(slug, runId)) return { ok: false, error: 'That run is not one the panel shows any more. Refresh and try again.' };
  return github.failedLog({ slug, runId, jobId: /^\d+$/.test(String(body?.jobId ?? '')) ? String(body.jobId) : undefined });
}
/** Sends a failing log to the agent on that branch, through the same path as a reply typed in the panel. */
async function githubHand(body) {
  const s = sessions.get(body?.sessionId);
  if (!s) return { ok: false, error: 'That session is gone.' };
  const p = placeOf(s), gh = p && github.forSession(p.common, p.branch);
  if (!gh || gh.slug !== body?.slug) return { ok: false, error: 'That run is from another repository than this session works in.' };
  let text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) {
    const log = await githubLog(body);
    if (!log.ok) return log;
    text = log.message;
  } else if (!github.knows(String(body.slug), String(body.runId ?? ''))) return { ok: false, error: 'That run is not one the panel shows any more. Refresh and try again.' };
  if (text.length > 40_000) return { ok: false, error: 'That message is too long to send. Shorten the log first.' };
  if (/^[/!]/.test(text)) return { ok: false, error: 'A message that starts with / or ! would run as a command. Start it with words.' };
  const r = await reply({ sessionId: s.sessionId, text });
  return { ...r, chars: text.length };
}

// ---------------------------------------------------------------- the overseers: one chat per workspace, about its sessions

const labelOf = (s) => s.name || path.basename(s.cwd ?? '') || s.sessionId.slice(0, 8);
/** Its state in the page's words: waiting, busy, idle, finished or failed. */
function boardState(s) {
  if (isEnded(s)) return s.state === 'failed' ? 'failed' : 'finished';
  if (heldFor(s.sessionId).length || s.status === 'waiting') return 'waiting';
  return isWorking(s) ? 'busy' : 'idle';
}
/** What a held request asks, in a line. */
function askOf(p) {
  const i = p.toolInput ?? {};
  if (p.toolName === 'ExitPlanMode') return 'A plan, ready for review';
  if (p.toolName === 'AskUserQuestion') return `A question: ${String(i.questions?.[0]?.question ?? '').slice(0, 200)}`;
  return `${p.agentId ? 'Its subagent: ' : ''}${p.toolName}: ${String(i.command ?? i.file_path ?? i.url ?? i.pattern ?? i.description ?? '').replace(/\s+/g, ' ').slice(0, 200)}`;
}
/** The sessions workspace `wsId`'s board shows, as the page picks them: what its overseer reads. */
const onBoard = (wsId) => { const now = Date.now(); return [...sessions.values()].filter((s) => s.ws === wsId && (s.inRoster || heldFor(s.sessionId).length
  || (s.leftRosterAt ? now - s.leftRosterAt < 600_000 : now - s.lastEventAt < 3_600_000))); };
/** The folders a proposed launch in workspace `wsId` may use: where its board's sessions work, and their repositories. */
function overseerFolders(wsId) {
  const out = new Set();
  for (const s of onBoard(wsId)) {
    const p = placeOf(s), here = s.ranCwd ?? s.hereCwd ?? s.cwd;
    for (const d of [p?.repo, p?.top, here]) if (d && path.isAbsolute(d) && d !== os.homedir()) out.add(d);
    if (out.size >= 12) break;
  }
  return [...out].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } }).slice(0, 12);
}
function overseerBoard(wsId) {
  return { folders: overseerFolders(wsId), sessions: onBoard(wsId).map((s) => {
    const p = placeOf(s), held = heldFor(s.sessionId);
    return { sessionId: s.sessionId, name: labelOf(s), kind: s.kind, state: boardState(s), since: s.startedAt ?? s.lastEventAt,
      repo: p ? path.basename(p.repo) : null, worktree: p?.worktree ?? null, branch: p?.branch ?? null, folder: s.ranCwd ?? s.hereCwd ?? s.cwd ?? null,
      mode: s.mode ?? null, tool: isWorking(s) && s.lastTool ? `${s.lastTool.tool}: ${s.lastTool.text}` : null, asks: held.map(askOf),
      subagents: [...s.subagents.values()].map((a) => ({ type: a.agentType ?? null, title: a.title ?? null, running: !a.stoppedAt })),
      said: s.lastMessage ?? null, gh: p ? github.forSession(p.common, p.branch) : null };
  }) };
}
/** What a message to it does now: goes in at once, waits until it is done, or restarts it in the background (which,
 *  for a terminal session, closes Claude in its terminal). The same split as reply(). */
function tellEffect(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return 'restart';
  const bgUp = s.kind === 'background' && s.inRoster && BG_ID.test(s.id ?? '') && !['stopped', 'failed'].includes(s.state) && s.pid != null;
  if (bgUp && !isWorking(s)) return 'send';
  if ((s.kind === 'interactive' || bgUp) && isWorking(s)) return bgUp ? 'send' : 'queue';
  return 'restart';
}
/** One headless, tool-less Claude Code call on the profile's own login, from an empty folder of its own. Hooks are off
 *  in its arguments, so it never shows on the board. Never rejects. */
const overseerCwd = path.join(dataDir, 'overseer', 'cwd');
/** The overseer's own calls run in its empty folder: Claude Code lists them, but they are not the user's sessions. */
const isOverseerCall = (cwd) => typeof cwd === 'string' && (cwd === overseerCwd || cwd.startsWith(overseerCwd + path.sep)
  || (overseerReal != null && (cwd === overseerReal || cwd.startsWith(overseerReal + path.sep))));
let overseerReal = null;
try { fs.mkdirSync(overseerCwd, { recursive: true, mode: 0o700 }); overseerReal = fs.realpathSync(overseerCwd); } catch {}
/** `env` is the workspace's whose overseer asks (envOf): its own login. Without one it is not run. */
function askModel(args, { timeout = 90_000, signal, env } = {}) {
  if (!env) { console.error('overseer: no environment given, not run'); return Promise.resolve({ err: new Error('no environment given'), stdout: '', stderr: '' }); }
  try { fs.mkdirSync(overseerCwd, { recursive: true, mode: 0o700 }); } catch {}
  return new Promise((resolve) => {
    try {
      const child = execFile('claude', args, { cwd: overseerCwd, env, timeout, signal, maxBuffer: 8_000_000 },
        (err, stdout, stderr) => {
          const out = { err, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') };
          if (err || /"is_error":\s*true/.test(out.stdout)) loginFailed(`${out.stderr}\n${out.stdout.slice(0, 4000)}`);
          resolve(out);
        });
      child.stdin?.end();
    } catch (err) { resolve({ err, stdout: '', stderr: '' }); }
  });
}
/** The shared file every profile's overseer was kept in before each workspace had its own. Read once per workspace, to
 *  seed its own file when that is missing; never written or removed. */
const OLD_OVERSEER = path.join(dataDir, 'overseer.json');
/** Workspace `id`'s overseer: on its own login, reading its own board, acting on its own sessions only, kept in its
 *  own file. Made on first use; null for a workspace that isn't live. Everything it reaches goes through `id`, looked
 *  up when used, so it never follows a page's focus. */
function overseerOf(id) {
  if (!W.has(id)) return null;
  let o = overseers.get(id);
  if (o) return o;
  const ws = () => wsById(id), key = overseerId(ws().profile), file = path.join(dataDir, `overseer-${id}.json`);
  let seed = null;
  try { if (!fs.existsSync(file)) seed = migrateFrom(OLD_OVERSEER, key); } catch {}
  o = createOverseer({
    file, profile: key, seed,
    ask: (args, opts) => askModel(args, { ...opts, env: envOf(ws()) }), board: () => overseerBoard(id), github: () => github.state(),
    history: (sessionId, limit) => (ownedBy(id, sessionId) ? history({ sessionId, limit }, { ws: ws() }) : { ok: false, error: REFUSE }),
    actions: {
      reply: (body) => (ownedBy(id, body?.sessionId) ? reply(body) : { ok: false, error: REFUSE }),
      launch: (body) => (ws() ? launch(body, ws()) : { ok: false, error: 'That workspace is gone.' }),
      interrupt: (body) => (ownedBy(id, body?.sessionId) ? interrupt(body) : { ok: false, error: REFUSE }),
      live: (sid) => { const s = sessions.get(sid); return s && s.ws === id && s.inRoster && !isEnded(s) ? s : null; },
      tellEffect, folders: () => overseerFolders(id),
      trusted: (cwd) => ws() != null && isTrusted(ws().profile.config, trustKey(cwd, gitPlace(cwd)?.top)) === true,
    },
    onChange: () => broadcast(),
  });
  overseers.set(id, o);
  return o;
}
/** The overseer whose feed a line about session `sessionId` goes in: its workspace's. None when no workspace knows it. */
const overseerOfSession = (sessionId) => { const w = typeof sessionId === 'string' ? wsIdOfSession(sessionId) : null; return w ? overseerOf(w) : null; };
// A GitHub event goes in the feed of each workspace whose sessions it is about. One about no session belongs to no
// workspace's feed yet, so it is dropped (sealing GitHub to workspaces comes with its own task).
onGithubEvent = (ev) => {
  const ids = new Set((Array.isArray(ev?.sessions) ? ev.sessions : []).map((sid) => (typeof sid === 'string' ? wsIdOfSession(sid) : null)).filter(Boolean));
  for (const id of ids) overseerOf(id)?.note(ev.type, { slug: ev.slug, text: ev.text });
};
// The PR watcher: tells the agent on a pull request's branch to fix it when it fails, conflicts, gets changes requested or
// sticks, until it goes in (watcher.mjs). A background session is told at once, through the same reply() as the page.
const watcher = createWatcher({
  file: path.join(dataDir, 'watcher.json'), github: () => github.state(),
  session: (id) => {
    const s = sessions.get(id);
    if (!s) return null;
    const kind = s.kind === 'background' && BG_ID.test(s.id ?? '') && s.inRoster ? 'background'
      : s.kind === 'interactive' && s.inRoster && !isEnded(s) ? 'interactive' : null;
    return { kind, name: labelOf(s) };
  },
  send: (sessionId, text) => reply({ sessionId, text }),
  // Its cards and lines go to the overseer of the session's own workspace (none, and dropped, when no workspace knows it).
  suggest: (sessionId, text, why, say) => overseerOfSession(sessionId)?.suggest({ sessionId, text, why, say }) ?? null,
  failedLog: (q) => github.failedLog(q), notify, note: (type, f) => overseerOfSession(f?.sessionId)?.note(type, f), onChange: () => broadcast(),
});
watcherCheck = () => { watcher.check().catch((e) => console.error('watcher:', e?.message ?? e)); };
/** The overseer keeps one conversation per profile, by an id it accepts: the profile's own when it is plain, else one
 *  made from its folder, so two accounts never share a conversation. */
const overseerId = (p) => (/^(?!\.{1,2}$)[\w.-]{1,40}$/.test(p.id) ? p.id : 'p-' + crypto.createHash('sha256').update(p.dir).digest('hex').slice(0, 16));
/** A line about session `s` in its own workspace's overseer's feed. A line about no session (a launch) names the
 *  workspace it happened in. */
const feed = (type, s, text, wsId = s?.ws) => { try { overseerOf(wsId)?.note(type, { sessionId: s?.sessionId, name: s ? labelOf(s) : undefined, text }); } catch {} };
for (const sig of ['SIGTERM', 'SIGINT']) process.once(sig, () => { for (const o of overseers.values()) { try { o.flush(); } catch {} } process.exit(0); });
/** The overseer routes: each page talks to its own workspace's overseer (ctx.focus), never another's. */
const withOverseer = (fn) => (b, ctx) => { const o = overseerOf(ctx?.focus); return o ? fn(o, b) : { ok: false, error: 'There is no such workspace.' }; };
const OVERSEER = {
  '/api/overseer/say': withOverseer((o, b) => o.say({ text: b?.text })),
  '/api/overseer/turns': withOverseer((o, b) => o.turns({ limit: Number(b?.limit) || 50 })),
  '/api/overseer/feed': withOverseer((o, b) => o.feed({ after: Number(b?.after) || 0 })),
  '/api/overseer/act': withOverseer((o, b) => o.act({ turnId: b?.turnId, actionId: b?.actionId, decision: b?.decision, edit: b?.edit })),
  '/api/overseer/stop': withOverseer((o) => o.stop()),
  '/api/overseer/model': withOverseer((o, b) => o.setModel(b?.model)),
  '/api/overseer/clear': withOverseer((o) => o.clear()),
};

// ---------------------------------------------------------------- the embedded terminal: a background session's own screen

// `claude attach <id>` in a pseudo-terminal (pty-bridge.py), shown in the page with xterm.js. One per session, shared by
// the pages that have it open; it lets go a little after the last one leaves, and the session keeps running.
const BRIDGE = fileURLToPath(new URL('./pty-bridge.py', import.meta.url));
const TERM_KEEP = 256 * 1024;                                   // the newest output, replayed to a page that opens it
const TERM_GRACE_MS = Number(process.env.ACP_TERM_GRACE_MS ?? 15_000);
const terms = new Map(); // sessionId → { proc, clients: Set<clientId>, buf: Buffer[], size, out: Buffer[], flush, release }
const frame = (kind, body) => { const b = Buffer.from(body); const h = Buffer.alloc(5); h.write(kind, 0, 'ascii'); h.writeUInt32BE(b.length, 1); return Buffer.concat([h, b]); };
const termSize = (v, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.max(10, Math.min(n, 500)) : d; };
/** Whether a session opens in the terminal: a background job Claude Code still lists, not stopped, not the panel's own. */
function termable(s) {
  if (!s || s.kind !== 'background' || !BG_ID.test(s.id ?? '') || !s.inRoster) return 'Only a background session that Claude Code still lists opens here. A terminal session lives in its own terminal window.';
  if (['stopped', 'failed'].includes(s.state)) return 'It has stopped. Send it a message to start it again, then open its terminal.';
  if (s.pid != null && hostPids.has(s.pid)) return 'The panel server runs inside this session, so it does not open here.';
  return null;
}
function termOpen(body) {
  const client = CLIENT.test(String(body?.client ?? '')) ? body.client : null;
  if (!client || !clientRes.has(client)) return { ok: false, error: 'The page is not connected. Reload it and try again.' };
  const s = sessions.get(body?.sessionId), why = termable(s);
  if (why) return { ok: false, error: why };
  let t = terms.get(s.sessionId);
  const cols = termSize(body.cols, 100), rows = termSize(body.rows, 30);
  if (!t) {
    const cwd = s.cwd && fs.existsSync(s.cwd) ? s.cwd : os.homedir();
    const ws = wsOfSession(s);
    if (!ws) return { ok: false, error: NO_WS };
    const proc = spawn('python3', [BRIDGE, String(cols), String(rows), '--', claudePath() ?? 'claude', 'attach', s.id],
      { cwd, env: { ...envOf(ws), TERM: 'xterm-256color', COLORTERM: 'truecolor' }, stdio: ['pipe', 'pipe', 'pipe'] });
    t = { proc, clients: new Set(), buf: [], size: 0, out: [], flush: null, release: null };
    terms.set(s.sessionId, t);
    const take = (d) => {
      t.buf.push(d); t.size += d.length;
      while (t.size > TERM_KEEP && t.buf.length > 1) t.size -= t.buf.shift().length;
      // Output comes in many small writes: a page gets it in one message every 16 ms.
      t.out.push(d);
      t.flush ??= setTimeout(() => { t.flush = null; const data = Buffer.concat(t.out).toString('base64'); t.out = []; sendTo(sealedTo(t.clients, s.ws), 'term', { sessionId: s.sessionId, data }); }, 16);
    };
    proc.stdout.on('data', take);
    proc.stderr.on('data', take);
    proc.stdin.on('error', () => {}); // it may be gone before a last keystroke lands
    const gone = () => {
      if (terms.get(s.sessionId) !== t) return;
      terms.delete(s.sessionId);
      clearTimeout(t.flush); clearTimeout(t.release);
      sendTo(sealedTo(t.clients, s.ws), 'term-exit', { sessionId: s.sessionId });
    };
    proc.on('exit', gone);
    proc.on('error', (e) => { console.error('terminal:', e?.message ?? e); gone(); });
  } else if (!t.proc.stdin.destroyed) t.proc.stdin.write(frame('r', `${cols} ${rows}`)); // a page joining redraws it at its size
  clearTimeout(t.release); t.release = null;
  t.clients.add(client);
  return { ok: true, scrollback: Buffer.concat(t.buf).toString('base64') };
}
/** The terminal a page has open, or null. */
function termOf(body) {
  const t = terms.get(body?.sessionId);
  return t && t.clients.has(body?.client) && !t.proc.stdin.destroyed ? t : null;
}
function termInput(body) {
  const t = termOf(body), data = typeof body?.data === 'string' ? body.data : '';
  if (!t) return { ok: false, error: 'That terminal is closed. Open it again.' };
  if (!data || data.length > 65_536) return { ok: true };
  t.proc.stdin.write(frame('d', data));
  return { ok: true };
}
function termResize(body) {
  const t = termOf(body);
  if (t) t.proc.stdin.write(frame('r', `${termSize(body.cols, 100)} ${termSize(body.rows, 30)}`));
  return { ok: true };
}
/** A page let go of a terminal; the last one leaving closes it after a grace, which hangs up `claude attach`. */
function termLeave(client, sessionId) {
  const t = terms.get(sessionId);
  if (!t || !t.clients.delete(client) || t.clients.size) return;
  clearTimeout(t.release);
  t.release = setTimeout(() => { if (!t.clients.size) termEnd(sessionId); }, TERM_GRACE_MS);
}
function termEnd(sessionId) {
  const t = terms.get(sessionId);
  if (t) try { t.proc.stdin.end(); } catch {}
}
const termClose = (body) => { termLeave(body?.client, body?.sessionId); return { ok: true }; };

// ---------------------------------------------------------------- snapshot + SSE
// ---------------------------------------------------------------- snapshot + SSE

// What a page shown workspace `wsId` gets: that workspace's sessions, requests, profile, roster error, setup and old
// versions, and of every workspace only { id, name, color, waiting }. Nothing else of another workspace leaves here.
function snapshot(wsId) {
  const now = Date.now(), ws = wsById(wsId);
  return {
    now, armed, rosterError: ws.rosterError, port: PORT, profile: ws.info, setup: setupOut(ws),
    workspace: wsView(wsId), workspaces: wsOrder().map((id) => ({ ...wsView(id), waiting: waitingOf(id) })),
    oldVersions: oldVersions.filter((o) => o.ws === wsId).map(({ ws: _, ...o }) => ({ ...o, shown: true })),
    sessions: [...sessions.values()].filter((s) => s.ws === wsId).map(({ spawns, hereCwd, rosterCwd, ranCwd, editTops, ...s }) => {
      const here = ranCwd ?? hereCwd ?? s.cwd, place = gitPlace(here), git = placeOut(place);
      return {
      ...s, git, workCwd: here, gh: place ? github.forSession(place.common, place.branch) : null, elsewhere: (editTops ?? []).filter((t) => t !== git?.top).slice(0, 3).map((t) => placeOut(gitPlace(t))).filter(Boolean),
      stopping: stops.has(stopKey(s.sessionId, null)), hostsPanel: hostPids.has(s.pid), termable: !termable(s),
      queued: inbox.get(s.sessionId) ?? [], working: isWorking(s),
      subagents: [...s.subagents.values()].map((a) => ({ ...a, stopping: !a.stoppedAt && stops.has(stopKey(s.sessionId, a.agentId)) })),
    }; }),
    pending: [...[...pending.values()].filter((p) => p.ws === wsId).map(({ res, timer, ...p }) => p), ...openRequests(wsId)],
    github: github.state(), overseer: overseerOf(wsId)?.status() ?? null, watcher: watcher.status(),
    _ts: now,
  };
}

// Changes close together go out as one snapshot, which carries every event since the last one (two requests held in
// the same moment are two `new-request`s, not the second alone). One snapshot per workspace a page is shown; an event
// about a request goes only with its own workspace's.
let queued = false;
let events = [];
function broadcast(event) {
  if (event) events.push(event);
  if (queued) return;
  queued = true;
  setTimeout(() => {
    queued = false;
    const evs = events, frames = new Map();
    events = [];
    for (const [res, client] of clients) {
      const wsId = focusOf(client);
      if (!frames.has(wsId)) frames.set(wsId, `data: ${JSON.stringify({ ...snapshot(wsId), events: evs.filter((e) => e.ws == null || e.ws === wsId).map(({ ws, ...e }) => e) })}\n\n`);
      res.write(frames.get(wsId));
    }
  }, 30);
}

// ---------------------------------------------------------------- http

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
};

// Nothing a request carries may throw out of the handler: an unhandled rejection would stop the server.
const server = http.createServer((req, res) => handle(req, res).catch((err) => {
  console.error('request failed:', err?.message ?? err);
  if (!res.headersSent) send(res, 500, { error: 'server error' }); else res.destroy();
}));
async function handle(req, res) {
  if (!HOSTS.has(req.headers.host)) return send(res, 421, { error: 'wrong host' });
  let url;
  try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return send(res, 400, { error: 'bad url' }); }

  // Hook endpoints: Claude Code posts these. A browser always sends Origin on a cross-site POST, so refuse it.
  if (url.pathname.startsWith('/hook/')) {
    if (req.method !== 'POST' || req.headers.origin) return send(res, 403, { error: 'hooks only' });
    let e;
    try { e = await readBody(req); } catch { return send(res, 400, ''); }
    // Each event goes to the workspace its session runs under, found from its transcript. One from under no profile at
    // all is nobody's: nothing is recorded, and a request is left to the terminal.
    if (url.pathname === '/hook/event') { const ws = wsOfEvent(e), reply = ws ? onHookEvent(e, ws) : null; return send(res, 200, reply ?? ''); }
    if (url.pathname === '/hook/permission') {
      // Nobody watching, or paused: answer nothing, the terminal decides.
      if (!armed || !watched()) return send(res, 200, '');
      const ws = wsOfEvent(e);
      return ws ? holdPermission(e, ws, res) : send(res, 200, '');
    }
    return send(res, 404, '');
  }

  // The embedded terminal's library, vendored: these three files and nothing else under it.
  const VENDOR = { '/vendor/xterm/xterm.js': 'text/javascript', '/vendor/xterm/addon-fit.js': 'text/javascript', '/vendor/xterm/xterm.css': 'text/css' };
  if (req.method === 'GET' && Object.hasOwn(VENDOR, url.pathname)) {
    let body;
    try { body = fs.readFileSync(new URL('./public' + url.pathname, import.meta.url)); } catch { return send(res, 404, { error: 'not found' }); }
    res.writeHead(200, { 'content-type': `${VENDOR[url.pathname]}; charset=utf-8`, 'cache-control': 'max-age=86400' });
    return res.end(body);
  }
  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, page().replace('__ACP_TOKEN__', TOKEN), 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && url.pathname === '/events') {
    if (url.searchParams.get('t') !== TOKEN) return send(res, 403, { error: 'token' });
    // The page's own id, for its focus and the thread of the session it has open (a reconnect brings the same one back).
    const client = CLIENT.test(url.searchParams.get('c') ?? '') ? url.searchParams.get('c') : null;
    // A new page starts on the workspace focused last and keeps it, whatever another page picks after.
    if (client && !clientFocus.has(client)) clientFocus.set(client, focusOf(client));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write(`retry: 2000\ndata: ${JSON.stringify(snapshot(focusOf(client)))}\n\n`);
    clients.set(res, client);
    if (client) clientRes.set(client, res);
    if (DAEMON && setRosterPace(true)) pollAll().then(checkVersions); // back from idle: catch up at once
    github.tick({ watched: true }); // a page that opens sees checks as fresh as the next poll
    clearTimeout(releaseTimer);
    releaseTimer = null;
    const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
      if (client && clientRes.get(client) === res) { clientRes.delete(client); dropClient(client); forgetFocusLater(client); }
      // Last tab gone and not back in time: hand every held request back to the terminal, and (under the daemon) slow
      // the roster down. Not before: until then a held request still needs the fast polls to see a terminal answer.
      if (clients.size === 0 && releaseTimer === null) releaseTimer = setTimeout(() => {
        releaseTimer = null;
        if (clients.size > 0) return;
        for (const id of [...pending.keys()]) settle(id, null, 'panel closed');
        if (DAEMON) setRosterPace(false);
      }, RECONNECT_MS);
    });
    return;
  }

  // The page's id, which says which workspace it is shown (null: the one focused last).
  const hdr = req.headers['x-acp-client'], hdrClient = typeof hdr === 'string' && CLIENT.test(hdr) ? hdr : null;

  // Workspace names and colours, which any page may see, and the repositories sorted into the asking page's workspace.
  if (req.method === 'GET' && url.pathname === '/api/workspaces') {
    if (req.headers['x-acp-token'] !== TOKEN) return send(res, 403, { error: 'forbidden' });
    const focus = focusOf(hdrClient);
    return send(res, 200, { ok: true, workspaces: store.list(), assigned: store.assigned().filter((a) => a.ws.includes(focus)) });
  }

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    if (!ORIGINS.has(req.headers.origin) || req.headers['x-acp-token'] !== TOKEN) return send(res, 403, { error: 'forbidden' });
    let body;
    try { body = await readBody(req); } catch { return send(res, 400, { error: 'bad body' }); }
    // The seal: every action runs as the asking page, on its workspace. A session from another workspace is refused here,
    // before any handler sees it (whatever the route: a sessionId always names the target).
    const bodyClient = typeof body?.client === 'string' && CLIENT.test(body.client) ? body.client : null;
    if (hdrClient && bodyClient && hdrClient !== bodyClient) return send(res, 400, { ok: false, error: 'Which page is this?' });
    const client = hdrClient ?? bodyClient, focus = focusOf(client), ctx = { client, focus, ws: wsById(focus) };
    const refused = () => send(res, 409, { ok: false, error: REFUSE });
    if (body?.sessionId != null && !ownedBy(focus, String(body.sessionId))) return refused();
    if (url.pathname === '/api/decide') {
      const r = decide(body, focus);
      return send(res, r.ok ? 200 : 409, r);
    }
    if (url.pathname === '/api/launch') {
      const r = await launch(body, ctx.ws);
      if (!r.ok) loginFailed(r.error);
      if (r.ok) feed('launched', null, `You started a session in ${tilde(r.cwd ?? '')}.`, focus);
      return send(res, r.ok ? 200 : 422, r);
    }
    if (url.pathname === '/api/interrupt') {
      const r = interrupt(body);
      if (r.ok && sessions.has(body?.sessionId)) feed('interrupted', sessions.get(body.sessionId), `You interrupted ${labelOf(sessions.get(body.sessionId))}.`);
      return send(res, r.ok ? 200 : 422, r);
    }
    const ACTIONS = { '/api/end': end, '/api/remove': remove, '/api/reply': reply, '/api/unqueue': unqueue, '/api/mode': switchMode,
                      '/api/folders': listFolders, '/api/folder': folderInfo, '/api/pick-folder': pickFolder,
                      '/api/workspace/focus': focusWorkspace,
                      // The profile tabs' old name for it, until the switch replaces them.
                      '/api/profile': (b, c) => focusWorkspace({ ws: b?.id, force: b?.force }, c),
                      '/api/profiles': profiles, '/api/profile/connect': connectProfile,
                      '/api/answer-open': answerOpen, '/api/history': history, '/api/follow': followSession,
                      '/api/trust-terminal': openTrustTerminal,
                      '/api/setup/check': setupCheckNow, '/api/setup/done': setupDone, '/api/setup/login': openLoginTerminal,
                      '/api/github/refresh': () => { github.refresh(); return { ok: true, github: github.state() }; },
                      '/api/github/log': githubLog, '/api/github/hand': githubHand, ...OVERSEER,
                      '/api/watcher/enabled': (b) => watcher.setEnabled(b?.on),
                      '/api/term/open': termOpen, '/api/term/input': termInput, '/api/term/resize': termResize, '/api/term/close': termClose };
    if (Object.hasOwn(ACTIONS, url.pathname)) {
      let r;
      try { r = await ACTIONS[url.pathname](body, ctx); } catch (err) { r = { ok: false, error: String(err?.message ?? err).slice(0, 300) }; }
      if (!r.ok) loginFailed(r.error); // a reply or restart that failed for want of a login
      return send(res, r.ok ? 200 : 422, r);
    }
    if (url.pathname === '/api/arm') {
      armed = Boolean(body.armed);
      if (!armed) for (const id of [...pending.keys()]) settle(id, null, 'paused');
      broadcast();
      return send(res, 200, { ok: true, armed });
    }
  }
  send(res, 404, { error: 'not found' });
}

// Under launchd a server that quit on a taken port would be relaunched every 10 s forever. Wait instead: an app-started
// server from before the service was installed quits when the app does, and this one takes the port then.
// It says so on the first try and then every 60th, so a long wait adds a line every 5 minutes, not every 5 s.
let portTries = 0;
server.on('error', (err) => {
  if (!(DAEMON && err.code === 'EADDRINUSE')) throw err;
  if (++portTries === 1 || portTries % 60 === 0) console.log(`port ${PORT} is taken; trying again every ${RETRY_MS / 1000} s`);
  setTimeout(() => server.listen(PORT, '127.0.0.1'), RETRY_MS);
});

let rosterTimer = null, rosterFast = null;
/** Reads the roster every ROSTER_MS when `fast`, every IDLE_ROSTER_MS when not. Returns whether the pace changed. */
function setRosterPace(fast) {
  if (fast === rosterFast) return false;
  clearInterval(rosterTimer);
  rosterFast = fast;
  rosterTimer = setInterval(pollAll, fast ? ROSTER_MS : IDLE_ROSTER_MS);
  return true;
}
/** Whether someone may be looking: always outside the daemon, and under it while a page is connected. */
const looking = () => !DAEMON || clients.size > 0;

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Glue → http://127.0.0.1:${PORT}`);
  // Each workspace's overseer, here and not at load (its state is declared further down): a missing file is seeded now.
  for (const id of W.keys()) overseerOf(id);
  serverUp = true;
  checkSetup(true); // the checklist, and later the sign-in banner, say what it finds
  pollAll().then(() => { if (looking()) checkVersions(); });
  setRosterPace(looking());
  setInterval(() => { if (looking()) checkVersions(); }, VERSIONS_MS);
  setInterval(() => { prune(); broadcast(); }, 10_000);
  // GitHub: one beat every 15 s, each repository on its own pace; the first a little after start, once the roster is in.
  setTimeout(() => { github.tick({ watched: clients.size > 0 }); setInterval(() => github.tick({ watched: clients.size > 0 }), 15_000); }, 20_000);
  setInterval(() => watcherCheck(), 60_000); // checks that stick become a problem with time, with nothing new from GitHub
  setInterval(() => { if (clients.size > 0) checkSetup(false); }, 3 * 60_000); // a login that lapses later shows as the banner
});
