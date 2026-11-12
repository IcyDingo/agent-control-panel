// The PR watcher: sees each pull request on an agent's branch through to merging. When one fails its checks, conflicts
// with its base, gets changes requested or has checks stuck running, it tells the agent on that branch to fix it and push
// again. A background session is told at once; a terminal session listed by Claude Code gets a card in the overseer to
// confirm (a message closes Claude in its terminal); one the panel only knows from its hooks can't be messaged, so you
// are alerted to tell it yourself. At most three fixes are asked per pull request, each problem once per commit.
//
// A rule, not a model: it reads the GitHub state the panel already polls. Its memory (what it asked, how often) is kept in
// a 0600 file so a restart never asks twice. Node standard library only.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_FIXES = 3;
export const STUCK_MS = 30 * 60_000;
const KEEP = 500;
const RETRY_MS = 5 * 60_000;

/** What is wrong with a pull request now, worst first: each `{ kind, key }`, the key saying when it counts as new. */
export function problemsOf(pr, slug, now) {
  const at = `${slug}#${pr.number}`, out = [];
  if (pr.checks === 'failing') out.push({ kind: 'failing', key: `${at}@${pr.sha}:failing` });
  if (pr.mergeState === 'DIRTY') out.push({ kind: 'conflict', key: `${at}@${pr.sha}:conflict` });
  // A review stands across commits until the reviewer looks again: it is asked about once, until it changes.
  if (pr.review === 'CHANGES_REQUESTED') out.push({ kind: 'changes', key: `${at}:changes` });
  if (pr.checks === 'running' && pr.runningSince && now - pr.runningSince > STUCK_MS) out.push({ kind: 'stuck', key: `${at}@${pr.sha}:stuck` });
  return out;
}

const WHAT = { failing: 'its checks fail', conflict: 'it conflicts with its base branch', changes: 'a reviewer requested changes', stuck: 'its checks have run for over 30 minutes' };

/** The message for one problem. `log` is the failing log's own message, when it could be fetched. */
export function messageOf(kind, pr, slug, { log, attempt } = {}) {
  const ref = `pull request #${pr.number} (${pr.branch}) in ${slug}`, end = ` Commit and push to ${pr.branch} so it can go in. (From the panel's PR watcher: fix ${attempt} of ${MAX_FIXES}.)`;
  if (kind === 'failing') {
    if (log) return `${log}\n\nThis is ${ref}.${end}`;
    const names = (pr.failing ?? []).map((f) => f.name).filter(Boolean).join(', ');
    return `The checks on ${ref} fail${names ? `: ${names}` : ''}. Look at them with \`gh pr checks ${pr.number}\` and \`gh run view\`, find the cause and fix it.${end}`;
  }
  if (kind === 'conflict') return `${ref[0].toUpperCase()}${ref.slice(1)} has merge conflicts with its base branch. Bring the base branch in (rebase or merge), resolve the conflicts, and run the tests.${end}`;
  if (kind === 'changes') return `A reviewer requested changes on ${ref}. Read the review and its comments with \`gh pr view ${pr.number} --comments\` and \`gh api repos/${slug}/pulls/${pr.number}/comments\`, and address each one.${end}`;
  return `The checks on ${ref} have run for over 30 minutes. Look at them with \`gh pr checks ${pr.number}\` and \`gh run view\`, and fix or re-run what is stuck.${end}`;
}

/**
 * @param {object} deps
 * @param {string} deps.file         where its memory is kept (0600)
 * @param {Function} deps.github     () => snap.github, the state github.mjs keeps
 * @param {Function} deps.session    (sessionId) => { kind: 'background'|'interactive'|null, name, live } | null
 * @param {Function} deps.send       async (sessionId, text) => reply()'s result
 * @param {Function} deps.suggest    (sessionId, text, why, say) => the overseer's card
 * @param {Function} deps.failedLog  async ({ slug, runId, jobId }) => github.failedLog()'s result
 * @param {Function} deps.notify     (title, text) => void
 * @param {Function} deps.note       (type, fields) => void, the overseer's feed
 */
export function createWatcher({ file, github, session, send, suggest, failedLog, notify = () => {}, note = () => {}, onChange = () => {},
  now = Date.now, log = (m) => console.error(m) } = {}) {
  let mem = { v: 1, enabled: true, done: {}, fixes: {}, capped: {}, last: {}, retry: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved?.v === 1) mem = { ...mem, ...saved, done: saved.done ?? {}, fixes: saved.fixes ?? {}, capped: saved.capped ?? {}, last: saved.last ?? {}, retry: saved.retry ?? {} };
  } catch { /* no file yet: start with nothing asked */ }
  let checking = false, again = false, cached = null;
  const busy = new Set();

  function save() {
    cached = null;
    const done = Object.entries(mem.done).sort((a, b) => b[1] - a[1]).slice(0, KEEP);
    mem.done = Object.fromEntries(done);
    const t = now();
    for (const [k, until] of Object.entries(mem.retry)) if (mem.done[k] || until < t - 24 * 3_600_000) delete mem.retry[k];
    if (!file) return;
    const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(mem), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing more to do */ }
      log(`watcher: could not write ${file} (${e?.code ?? 'error'}).`);
    }
  }
  const tell = (fn, ...a) => { try { return fn(...a); } catch (e) { log(`watcher: ${e?.message ?? e}`); return null; } };

  /** One problem of one pull request: ask the agent, or alert you, and remember it. */
  async function handle(repo, pr, p, sid) {
    const at = `${repo.slug}#${pr.number}`, s = tell(session, sid);
    mem.done[p.key] = now();
    if (!s) { save(); return; }
    const n = (mem.fixes[at] ?? 0) + 1;
    if (n > MAX_FIXES) {
      if (!mem.capped[at]) {
        mem.capped[at] = now();
        tell(notify, 'Agent Panel · PR still not going in', `#${pr.number} in ${repo.slug}: ${WHAT[p.kind]}, after ${MAX_FIXES} fixes asked of ${s.name}. Over to you.`);
        tell(note, 'fix-capped', { sessionId: sid, name: s.name, slug: repo.slug, text: `#${pr.number} in ${repo.slug}: ${WHAT[p.kind]} after ${MAX_FIXES} fixes asked of ${s.name}. Over to you.` });
      }
      save(); return;
    }
    let logMsg = null;
    if (p.kind === 'failing') {
      const f = (pr.failing ?? []).find((x) => x.runId);
      if (f) { const r = await failedLog({ slug: repo.slug, runId: f.runId, jobId: f.jobId }).catch(() => null); if (r?.ok) logMsg = r.message; }
    }
    const text = messageOf(p.kind, pr, repo.slug, { log: logMsg, attempt: n });
    const why = `#${pr.number}: ${WHAT[p.kind]}`;
    let result;
    if (s.kind === 'background') {
      const r = await Promise.resolve(send(sid, text)).catch((e) => ({ ok: false, error: String(e?.message ?? e) }));
      if (r?.ok) {
        mem.fixes[at] = n;
        result = r.queued ? 'asked; it reads it once it is done' : 'asked';
        tell(notify, 'Agent Panel · fix asked', `Asked ${s.name} to fix #${pr.number} in ${repo.slug}: ${WHAT[p.kind]} (${n} of ${MAX_FIXES}).`);
        tell(note, 'fix-sent', { sessionId: sid, name: s.name, slug: repo.slug, text: `Asked ${s.name} to fix #${pr.number} in ${repo.slug}: ${WHAT[p.kind]} (${n} of ${MAX_FIXES}).` });
      } else {
        // Not taken (busy, or a message still on its way): asked again in five minutes, and you hear of it once.
        result = `not sent: ${r?.error ?? 'no answer'}`;
        delete mem.done[p.key];
        const first = !mem.retry[p.key];
        mem.retry[p.key] = now() + RETRY_MS;
        mem.last[at] = { kind: p.kind, at: now(), result, fixes: mem.fixes[at] ?? 0 };
        save();
        if (!first) return;
        tell(notify, 'Agent Panel · fix not sent', `#${pr.number} in ${repo.slug}: ${WHAT[p.kind]}, and ${s.name} could not be told (${r?.error ?? 'no answer'}).`);
        tell(note, 'fix-failed', { sessionId: sid, name: s.name, slug: repo.slug, text: `#${pr.number} in ${repo.slug}: ${WHAT[p.kind]}; ${s.name} could not be told: ${r?.error ?? 'no answer'}` });
      }
    } else if (s.kind === 'interactive') {
      mem.fixes[at] = n;
      result = 'proposed, waiting for your click';
      tell(suggest, sid, text, why, `#${pr.number} in ${repo.slug}: ${WHAT[p.kind]}. ${s.name} runs in a terminal window, so sending this closes Claude there and carries it on in the background. Send it, change it, or decline.`);
      tell(notify, 'Agent Panel · fix to confirm', `#${pr.number} in ${repo.slug}: ${WHAT[p.kind]}. A fix request for ${s.name} waits for your click in the overseer.`);
    } else {
      result = 'tell it yourself';
      tell(notify, 'Agent Panel · PR needs a fix', `#${pr.number} in ${repo.slug}: ${WHAT[p.kind]}. ${s.name} runs where the panel can't message it: tell it in its terminal.`);
      tell(note, 'fix-alert', { sessionId: sid, name: s.name, slug: repo.slug, text: `#${pr.number} in ${repo.slug}: ${WHAT[p.kind]}. Tell ${s.name} in its terminal; the panel can't message it.` });
    }
    mem.last[at] = { kind: p.kind, at: now(), result, fixes: mem.fixes[at] ?? 0 };
    save();
  }

  /** Look at every pull request on an agent's branch once. Called after each GitHub poll; overlapping calls fold into one. */
  async function check() {
    if (checking) { again = true; return; }
    checking = true;
    try {
      do {
        again = false;
        const gh = tell(github);
        if (!mem.enabled || !gh?.repos) break;
        for (const repo of gh.repos) {
          for (const pr of repo.prs ?? []) {
            const at = `${repo.slug}#${pr.number}`;
            // A changes-requested review that was looked at again counts afresh if it comes back.
            if (pr.review !== 'CHANGES_REQUESTED' && mem.done[`${at}:changes`]) delete mem.done[`${at}:changes`];
            const sid = (pr.sessions ?? [])[0];
            if (!sid || busy.has(at)) continue;
            const t = now(), p = problemsOf(pr, repo.slug, t).find((x) => !mem.done[x.key] && !((mem.retry[x.key] ?? 0) > t));
            if (!p) continue;
            busy.add(at);
            try { await handle(repo, pr, p, sid); } catch (e) { log(`watcher: ${e?.message ?? e}`); } finally { busy.delete(at); }
            tell(onChange);
          }
        }
      } while (again);
    } finally { checking = false; }
  }

  return {
    check,
    setEnabled(on) {
      mem.enabled = Boolean(on);
      save();
      tell(onChange);
      if (mem.enabled) check().catch((e) => log(`watcher: ${e?.message ?? e}`)); // turned on: look now, not at the next poll
      return { ok: true, enabled: mem.enabled };
    },
    /** What the page shows: on or off, and per pull request how many fixes were asked and the last thing done. */
    status() { return cached ??= { enabled: mem.enabled, max: MAX_FIXES, prs: { ...mem.last } }; },
  };
}
