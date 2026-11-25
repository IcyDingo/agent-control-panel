// Home's parts that decide: each issue as a goal (its branches, what is ahead, its one move), agents outside any goal,
// which goals are open, and the Issues panel's items; plus the small helpers the page shares (a request's one-line
// form, a working agent's line, dismissals, keeping rows in place). The page draws them; this file only decides, from
// what it is handed, so the tests can run it too. A plain script with no imports or exports: the page loads it with a
// <script> tag, and Node imports it; either way it sets globalThis.HomeBoard.
(() => {
  /** The tools whose whole request fits on one line, so one click on Allow answers it. */
  const PLAIN = new Set(['Bash', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);
  /** A repository's short name: its last folder. */
  const repoName = (repo) => String(repo).replace(/\/+$/, '').split('/').pop() || String(repo);

  /** What one click on Allow would allow, in full and never cut, for a plain tool: its command, file, pattern, address
   *  or query. Null when the request is not one line (an MCP tool's input, an edit): that row offers Answer instead. */
  function inlineAsk(p) {
    const i = p?.toolInput ?? {}, str = (v) => (typeof v === 'string' && v.trim() ? v : null);
    switch (p?.toolName) {
      case 'Bash': return str(i.command);
      case 'Read': return str(i.file_path);
      case 'Glob': case 'Grep': return str(i.pattern) && (str(i.path) ? `${i.pattern} in ${i.path}` : i.pattern);
      case 'WebFetch': return str(i.url);
      case 'WebSearch': return str(i.query);
      default: return null;
    }
  }

  /** Whether one click answers these requests: a single plain tool request from Claude Code, not one held open, whose
   *  whole input the row can show. */
  const plainAsk = (reqs) => Array.isArray(reqs) && reqs.length === 1 && !reqs[0].open && reqs[0].agent !== 'opencode'
    && PLAIN.has(reqs[0].toolName) && inlineAsk(reqs[0]) !== null;

  /** What a working agent runs, in a line ("Edit cart.tsx"), or its error; '' when the panel does not know. */
  const busyLine = (s) => (s?.ocError?.message ? `Error: ${s.ocError.message}` : s?.lastTool?.tool ? [s.lastTool.tool, s.lastTool.text].filter(Boolean).join(' ') : '');

  /** Put `want` under `parent` in order, never moving a node that stays where it already sits relative to the others:
   *  the ones that go are taken out first, so one row leaving never moves the rows under it (moving a node out and back
   *  blurs a box being typed in). */
  function syncChildren(parent, want) {
    const keep = new Set(want);
    for (const n of [...parent.children]) if (!keep.has(n)) parent.removeChild(n);
    want.forEach((n, i) => { if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] ?? null); });
  }

  /** What a dismissal of a failed agent holds for: until it is in another state or says something new. */
  const dismissKey = (s) => `${s.sessionId}:${s.state}:${s.lastMessageAt ?? ''}`;

  /** The dismissals to keep: one goes when its agent is on the board and has moved on (another key). One whose agent is
   *  not on the board stays, since the board is empty for a moment while the page starts; the newest 200 at most. */
  function pruneDismissed(keys, sessions) {
    const now = new Map(sessions.map((s) => [s.sessionId, dismissKey(s)]));
    const kept = keys.filter((k) => { const sid = k.slice(0, k.indexOf(':')); return !now.has(sid) || now.get(sid) === k; });
    return kept.slice(Math.max(0, kept.length - 200));
  }

  /**
   * What an issue's item shows: `{ mark, label, detail }`. `mark` is todo, working (its agent on the board, or starting),
   * finished (its agent finished or is gone, nothing merged) or done. `sessions` is a Map of session id to session.
   */
  function itemView(it, sessions, stateOf, labelOf) {
    if (it.state === 'done') return { mark: 'done', label: '', detail: Number.isInteger(it.pr) ? `merged #${it.pr}` : 'done' };
    if (it.state !== 'working') return { mark: 'todo', label: '', detail: '' };
    if (!it.sessionId) return { mark: 'working', label: '', detail: 'starting' };
    const s = sessions.get(it.sessionId);
    if (!s) return { mark: 'finished', label: '', detail: 'agent finished' };
    const st = stateOf(s);
    if (st === 'finished' || st === 'failed') return { mark: 'finished', label: labelOf(s), detail: 'agent finished' };
    return { mark: 'working', label: labelOf(s), detail: st === 'waiting' ? 'needs you' : st === 'busy' || st === 'stopping' ? 'working' : 'idle' };
  }

  /** Issues in their order, the ones whose every item is done last (an empty one is not done): each with `allDone`. */
  function issueOrder(list) {
    const tagged = list.map((x) => ({ ...x, allDone: x.items.length > 0 && x.items.every((it) => it.state === 'done') }));
    return [...tagged.filter((x) => !x.allDone), ...tagged.filter((x) => x.allDone)];
  }
  /** How many items are to do across these issues. */
  const todoCount = (list) => list.reduce((n, x) => n + x.items.filter((it) => it.state === 'todo').length, 0);

  // ---------------------------------------------------------------- Home's goals: each issue as a goal
  const MIN = 60_000, STALL_MS = 20 * MIN;
  /** A span in a few words: "1 min", "25 min", "3 h", "2 d". */
  const span = (ms) => { const m = Math.max(1, Math.floor(ms / MIN)); return m < 60 ? `${m} min` : m < 2880 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`; };
  /** "just now" or "<span> ago". */
  const agoWords = (ms) => (ms < MIN ? 'just now' : `${span(ms)} ago`);
  const short = (t, n = 80) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s; };
  const VERB = { Bash: 'run', Read: 'read', Glob: 'look for', Grep: 'search for', WebFetch: 'fetch', WebSearch: 'search the web for' };
  /** What a held or open request asks, after "asks: ". */
  function askWords(p) {
    if (p.toolName === 'AskUserQuestion') return p.toolInput?.questions?.[0]?.question ?? 'a question';
    if (p.toolName === 'ExitPlanMode') return 'plan ready for review';
    const one = inlineAsk(p);
    return one ? `${VERB[p.toolName] ?? p.toolName} ${one}` : p.toolInput?.file_path ? `${p.toolName} ${p.toolInput.file_path}` : p.toolName;
  }
  /** How pressing a branch is: 0 asks you, 1 broken, 2 ready to merge (or a main agent to wake), 3 stopped short or
   *  stalled, 4 working, 5 idle or gone. */
  const RANK = { asks: 0, follow: 0, failed: 1, fails: 1, merge: 2, wake: 2, short: 3, stalled: 3, busy: 4, starting: 4, idle: 5, gone: 5 };
  /** `need`: what this need is about (a request's id, a follow-up's time, a PR's commit), so a new one of the same
   *  kind reads as new. */
  const tip = (kind, tone, ring, words, acts, need = '') => ({ kind, tone, ring, words, acts, rank: RANK[kind], need: String(need) });
  const lastAct = (s) => Math.max(s.lastEventAt ?? 0, s.lastTool?.at ?? 0, s.lastMessageAt ?? 0);
  const firstSentence = (t) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); const m = s.match(/^.*?[.!?](?=\s|$)/); return short(m ? m[0] : s, 90); };
  const goneTip = (inGoal) => tip('gone', 'grey', false, 'agent finished', inGoal ? ['again'] : []);

  /**
   * Where a branch (an agent) stands, the first that applies: a request waits; a follow-up asks; it failed; its PR
   * fails; its PR can be merged; it stopped short; it works but nothing changed for 20 minutes; it works; idle; gone.
   * `s` null: an item whose agent has not shown up yet. `inGoal`: it is an item's agent (it can be picked up again).
   */
  function tipOf(s, { reqs = [], follow = null, failedShown = () => true, mergeable = () => false, stateOf, now = Date.now(), inGoal = true } = {}) {
    if (!s) return tip('starting', 'grey', true, 'starting', []);
    const st = stateOf(s), over = st === 'finished' || st === 'failed', pr = s.gh?.pr;
    if (reqs.length) {
      const plain = plainAsk(reqs); // what one click allows is shown whole, never cut
      return tip('asks', 'amber', false, `asks: ${plain ? askWords(reqs[0]) : short(askWords(reqs[0]))}${reqs.length > 1 ? ` (+${reqs.length - 1})` : ''}`, plain ? ['allow', 'deny'] : ['answer'], reqs[0].id);
    }
    if (st === 'waiting') return tip('asks', 'amber', false, 'waits in its terminal', ['open'], `term:${s.lastEventAt ?? ''}`);
    if (follow?.verdict === 'needs-answer') return tip('follow', 'amber', false, `asks: ${short(follow.ask)}`, ['send', 'answer'], follow.at ?? follow.ask);
    if (st === 'failed' && failedShown(s)) return tip('failed', 'red', false, `failed: ${firstSentence(s.lastMessage) || 'it stopped with an error'}`, inGoal ? ['again'] : ['open'], s.lastMessageAt ?? '');
    if (pr?.checks === 'failing') { const k = pr.failing?.length || 1; return tip('fails', 'red', false, `PR #${pr.number} fails ${k} check${k === 1 ? '' : 's'}`, ['fix'], pr.sha ?? pr.number); }
    if (mergeable(s)) return tip('merge', 'green', false, `PR #${pr?.number ?? ''} green`.trim(), ['merge'], pr?.sha ?? '');
    if (follow?.verdict === 'stopped-short') return tip('short', 'amber', true, `stopped: ${short(follow.ask)}`, ['keep']);
    if (over) return goneTip(inGoal);
    const quiet = now - lastAct(s);
    if (st === 'busy' || st === 'stopping') {
      if (quiet >= STALL_MS) return tip('stalled', 'amber', true, `no change for ${span(quiet)}`, ['nudge']);
      return tip('busy', 'green', true, `${busyLine(s) || 'working'} · ${span(quiet)}`, []);
    }
    return tip('idle', 'grey', true, `idle ${span(quiet)}`, []);
  }

  /**
   * An issue as a goal: `{ id, title, issue, total, shipped, lastShippedAt, branches: [{ item, s, tip }], ahead, move,
   * reached, empty, needSig }`. `move` is the goal's one move: its most pressing branch (rank ≤ 3), else "moving" while
   * something works, else "nobody on it" with the first part ahead, else reached, else nothing.
   */
  function goalOf(issue, { sessions, reqsOf, followOf, failedShown, mergeable, stateOf, now = Date.now() }) {
    const items = issue.items ?? [];
    const done = items.filter((x) => x.state === 'done'), ahead = items.filter((x) => x.state === 'todo');
    const branches = items.filter((x) => x.state === 'working').map((item) => {
      const s = item.sessionId ? sessions.get(item.sessionId) ?? null : null;
      const t = !item.sessionId ? tipOf(null) : !s ? goneTip(true)
        : tipOf(s, { reqs: reqsOf(s.sessionId) ?? [], follow: followOf(s.sessionId), failedShown, mergeable, stateOf, now, inGoal: true });
      return { item, s, tip: t };
    }).map((b, i) => [b, i]).sort((a, b) => a[0].tip.rank - b[0].tip.rank || a[1] - b[1]).map(([b]) => b);
    const lastShippedAt = done.reduce((m, x) => Math.max(m, x.doneAt ?? 0), 0);
    const reached = items.length > 0 && done.length === items.length, empty = items.length === 0;
    const top = branches.find((b) => b.tip.rank <= 3);
    let move;
    if (top) move = { rank: top.tip.rank, kind: top.tip.kind, words: top.tip.words, acts: top.tip.acts, item: top.item, s: top.s };
    else if (branches.some((b) => b.tip.rank === 4)) move = { rank: 4, kind: 'moving', words: lastShippedAt ? `moving · shipped ${agoWords(now - lastShippedAt)}` : 'moving', acts: [], item: null, s: null };
    else if (ahead.length) move = { rank: 5, kind: 'nobody', words: 'nobody on it', acts: ['pickup'], item: ahead[0], s: null };
    else if (reached) move = { rank: 6, kind: 'reached', words: 'all parts shipped', acts: [], item: null, s: null };
    else if (empty) move = { rank: 5, kind: 'empty', words: 'no parts yet', acts: ['add'], item: null, s: null };
    else move = { rank: 5, kind: 'quiet', words: 'nothing moving', acts: [], item: null, s: null };
    const needSig = JSON.stringify(branches.filter((b) => b.tip.rank <= 2).map((b) => [b.item.id, b.tip.kind, b.tip.need]));
    return { id: issue.id, title: issue.title, issue, total: items.length, shipped: done.length, lastShippedAt, branches, ahead, move, reached, empty, needSig };
  }

  /** Goals by their move, most pressing first; the Issues order within each. */
  const goalsOrder = (goals) => goals.map((g, i) => [g, i]).sort((a, b) => a[0].move.rank - b[0].move.rank || a[1] - b[1]).map(([g]) => g);

  /**
   * Agents on the board that no working item has: each that needs the owner (finished or not), and each that works or
   * idles and is not a main agent; and the main agents to wake (`held`: `{ space, name, down, waiting, s }`). Each
   * `{ s, tip, space? }`, most pressing first.
   */
  function outsideOf({ sessions, workingIds, isMain, reqsOf, followOf, failedShown, mergeable, stateOf, now = Date.now(), held = [] }) {
    const rows = [], heldIds = new Set(held.map((h) => h.s?.sessionId).filter(Boolean));
    for (const s of sessions) {
      if (workingIds.has(s.sessionId)) continue;
      const t = tipOf(s, { reqs: reqsOf(s.sessionId) ?? [], follow: followOf(s.sessionId), failedShown, mergeable, stateOf, now, inGoal: false });
      if (heldIds.has(s.sessionId) && t.rank > 1) continue; // its wake row stands for it
      const st = stateOf(s);
      if (t.rank <= 3 || (!isMain(s) && st !== 'finished' && st !== 'failed')) rows.push({ s, tip: t });
    }
    for (const h of held) {
      const n = h.waiting ?? 0, w = n === 1 ? 'update waits' : 'updates wait';
      rows.push({ s: h.s ?? null, space: h.space, down: Boolean(h.down), tip: tip('wake', 'amber', false, h.down ? `main agent of ${h.name}: stopped, ${n} ${w}` : `main agent of ${h.name}: updates held, ${n} ${w}`, ['wake'], `${h.down}:${n}`) });
    }
    return rows.map((r, i) => [r, i]).sort((a, b) => a[0].tip.rank - b[0].tip.rank || a[1] - b[1]).map(([r]) => r);
  }

  /** Whether a goal shows open: something needs the owner that they have not collapsed it on; or they opened it. */
  const isOpen = (goal, collapsed) => (goal.needSig !== '[]' ? collapsed.get(goal.id) !== goal.needSig : collapsed.get(goal.id) === 'open');

  /** The titles of reached goals whose last part shipped on `now`'s local day. */
  const reachedToday = (goals, now = Date.now()) => goals.filter((g) => g.reached && g.lastShippedAt && new Date(g.lastShippedAt).toDateString() === new Date(now).toDateString()).map((g) => g.title);

  globalThis.HomeBoard = { tipOf, goalOf, goalsOrder, outsideOf, isOpen, reachedToday, agoWords, span, itemView, issueOrder, todoCount, plainAsk, inlineAsk, busyLine, syncChildren, dismissKey, pruneDismissed, repoName };
})();
