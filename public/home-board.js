// Home's board, the parts that decide: who needs the owner and why, which card each agent is on, the counts on Home's
// head line, and which drafted replies "Send all" may send. The page draws them; this file only decides, from what it is
// handed, so the tests can run it too. A plain script with no imports or exports: the page loads it with a <script>
// tag, and Node imports it; either way it sets globalThis.HomeBoard.
(() => {
  /** What an agent needs, most pressing first. An agent is listed once, under the first that applies. */
  const KINDS = ['waiting', 'follow', 'failed', 'merge'];
  const rank = (k) => { const i = KINDS.indexOf(k); return i < 0 ? KINDS.length : i; };
  const PLAIN = new Set(['Bash', 'Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch']);

  /**
   * Everything that needs the owner, a row per agent: `{ s, kind, follow, reqs }`. Waiting ones first (those with
   * requests in the side panel's order, then the others, newest first), then Ask Glue's follow-ups in its order, then
   * failed ones not dismissed, then agents whose pull request is green.
   */
  function needsList({ sessions, stateOf, reqsOf, asking = [], follow = [], mergeable, dismissed }) {
    const rows = [], seen = new Set();
    const add = (s, kind, extra = {}) => { if (!s || seen.has(s.sessionId)) return; seen.add(s.sessionId); rows.push({ s, kind, follow: null, reqs: [], ...extra }); };
    const waiting = sessions.filter((s) => stateOf(s) === 'waiting');
    const at = (s) => { const i = asking.indexOf(s.sessionId); return i < 0 ? Infinity : i; };
    waiting.sort((a, b) => at(a) - at(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
    for (const s of waiting) add(s, 'waiting', { reqs: reqsOf(s.sessionId) ?? [] });
    for (const f of follow) add(sessions.find((s) => s.sessionId.startsWith(f.sessionId)), 'follow', { follow: f });
    for (const s of sessions) if (stateOf(s) === 'failed' && !dismissed(s)) add(s, 'failed');
    for (const s of sessions) if (mergeable(s)) add(s, 'merge');
    return rows;
  }

  /** The rows as a lookup: session id → what it needs. */
  const needKinds = (list) => new Map(list.map((r) => [r.s.sessionId, r.kind]));

  /** A repository's short name: its last folder. */
  const repoName = (repo) => String(repo).replace(/\/+$/, '').split('/').pop() || String(repo);

  /**
   * The cards, in a fixed order: every space as it was made (empty ones too), then a card per repository by name for
   * agents in no space, then "Other folders" for the rest. A repository's card is there while any of its agents is.
   * Each: `{ key, kind, id, title, main, live, finished, prs, all }` (`all`: its agents but the main one). `live` are the agents to list (not the main agent):
   * what needs the owner first, in priority order, then working, then idle. `finished` counts the rest.
   */
  function homeCards({ spaces, sessions, spaceIn, repoOf, mainOf, colOf, stateOf, kinds }) {
    const bySpace = new Map(spaces.map((x) => [x.id, []])), byRepo = new Map(), loose = [];
    for (const s of sessions) {
      const sp = spaceIn(s);
      if (sp && bySpace.has(sp)) { bySpace.get(sp).push(s); continue; }
      const r = repoOf(s);
      if (r) { if (!byRepo.has(r)) byRepo.set(r, []); byRepo.get(r).push(s); } else loose.push(s);
    }
    const col = (s) => colOf(stateOf(s));
    const order = (s) => (kinds.has(s.sessionId) ? rank(kinds.get(s.sessionId)) : col(s) === 'busy' ? 10 : 11);
    const card = (key, kind, id, title, list, main) => {
      const others = list.filter((s) => s !== main);
      const live = others.filter((s) => kinds.has(s.sessionId) || col(s) !== 'finished').sort((a, b) => order(a) - order(b) || (b.startedAt ?? 0) - (a.startedAt ?? 0));
      const prs = { failing: 0, running: 0, ready: 0 };
      for (const s of others) {
        const pr = s.gh?.pr;
        if (!pr) continue;
        if (pr.checks === 'failing') prs.failing++;
        else if (pr.checks === 'running') prs.running++;
        else if (kinds.get(s.sessionId) === 'merge' || kinds.get(s.sessionId) === 'follow' && pr.checks === 'passing') prs.ready++;
      }
      return { key, kind, id, title, main: main ?? null, live, finished: others.length - live.length, prs, all: others };
    };
    const out = spaces.map((x) => card(`space:${x.id}`, 'space', x.id, x.name, bySpace.get(x.id), mainOf(x.id)));
    for (const r of [...byRepo.keys()].sort((a, b) => repoName(a).localeCompare(repoName(b)) || a.localeCompare(b))) out.push(card(`repo:${r}`, 'repo', r, repoName(r), byRepo.get(r), null));
    if (loose.length) out.push(card('loose', 'loose', null, 'Other folders', loose, null));
    return out;
  }

  /** Home's head line: how many need the owner, work, idle (none counted twice), and how many pull requests are ready. */
  function headCounts({ sessions, kinds, colOf, stateOf, mergeable }) {
    const n = { need: 0, working: 0, idle: 0, ready: 0 };
    for (const s of sessions) {
      if (mergeable(s)) n.ready++;
      if (kinds.has(s.sessionId)) { n.need++; continue; }
      const c = colOf(stateOf(s));
      if (c === 'busy') n.working++; else if (c === 'idle') n.idle++;
    }
    return n;
  }

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

  /** Whether sending a follow-up's reply would close Claude in its terminal: its follow-up says restart, or the server
   *  just held a send for that (`held`: the session ids whose last send was held), on a terminal session. */
  const closesTerminal = (r, held) => r.s?.kind === 'interactive' && Boolean(r.s.inRoster) && (r.follow?.how === 'restart' || held.has(r.follow?.sessionId));

  /** Put `want` under `parent` in order, never moving a node that stays where it already sits relative to the others:
   *  the ones that go are taken out first, so one row leaving never moves the rows under it (moving a node out and back
   *  blurs a box being typed in). */
  function syncChildren(parent, want) {
    const keep = new Set(want);
    for (const n of [...parent.children]) if (!keep.has(n)) parent.removeChild(n);
    want.forEach((n, i) => { if (parent.children[i] !== n) parent.insertBefore(n, parent.children[i] ?? null); });
  }

  /** The follow-up rows "Send all" sends, and the ones it leaves out: those whose sending would close a terminal Claude. */
  function bulkReplies(rows, restarts) {
    const send = [], left = [];
    for (const r of rows) if (r.kind === 'follow') (restarts(r) ? left : send).push(r);
    return { send, left };
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
  const tip = (kind, tone, ring, words, acts) => ({ kind, tone, ring, words, acts, rank: RANK[kind] });
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
    if (reqs.length) return tip('asks', 'amber', false, `asks: ${short(askWords(reqs[0]))}${reqs.length > 1 ? ` (+${reqs.length - 1})` : ''}`, plainAsk(reqs) ? ['allow', 'deny'] : ['answer']);
    if (st === 'waiting') return tip('asks', 'amber', false, 'waits in its terminal', ['open']);
    if (follow?.verdict === 'needs-answer') return tip('follow', 'amber', false, `asks: ${short(follow.ask)}`, ['send', 'answer']);
    if (st === 'failed' && failedShown(s)) return tip('failed', 'red', false, `failed: ${firstSentence(s.lastMessage) || 'it stopped with an error'}`, inGoal ? ['again'] : ['open']);
    if (pr?.checks === 'failing') { const k = pr.failing?.length || 1; return tip('fails', 'red', false, `PR #${pr.number} fails ${k} check${k === 1 ? '' : 's'}`, ['fix']); }
    if (mergeable(s)) return tip('merge', 'green', false, `PR #${pr?.number ?? ''} green`.trim(), ['merge']);
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
    const needSig = JSON.stringify(branches.filter((b) => b.tip.rank <= 2).map((b) => [b.item.id, b.tip.kind]));
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
    const rows = [];
    for (const s of sessions) {
      if (workingIds.has(s.sessionId)) continue;
      const t = tipOf(s, { reqs: reqsOf(s.sessionId) ?? [], follow: followOf(s.sessionId), failedShown, mergeable, stateOf, now, inGoal: false });
      const st = stateOf(s);
      if (t.rank <= 3 || (!isMain(s) && st !== 'finished' && st !== 'failed')) rows.push({ s, tip: t });
    }
    for (const h of held) {
      const n = h.waiting ?? 0, w = n === 1 ? 'update waits' : 'updates wait';
      rows.push({ s: h.s ?? null, space: h.space, tip: tip('wake', 'amber', false, h.down ? `main agent of ${h.name}: stopped, ${n} ${w}` : `main agent of ${h.name}: updates held, ${n} ${w}`, ['wake']) });
    }
    return rows.map((r, i) => [r, i]).sort((a, b) => a[0].tip.rank - b[0].tip.rank || a[1] - b[1]).map(([r]) => r);
  }

  /** Whether a goal shows open: something needs the owner that they have not collapsed it on; or they opened it. */
  const isOpen = (goal, collapsed) => (goal.needSig !== '[]' ? collapsed.get(goal.id) !== goal.needSig : collapsed.get(goal.id) === 'open');

  /** The titles of reached goals whose last part shipped on `now`'s local day. */
  const reachedToday = (goals, now = Date.now()) => goals.filter((g) => g.reached && g.lastShippedAt && new Date(g.lastShippedAt).toDateString() === new Date(now).toDateString()).map((g) => g.title);

  globalThis.HomeBoard = { tipOf, goalOf, goalsOrder, outsideOf, isOpen, reachedToday, agoWords, span, itemView, issueOrder, todoCount, needsList, needKinds, homeCards, headCounts, plainAsk, inlineAsk, busyLine, closesTerminal, syncChildren, bulkReplies, dismissKey, pruneDismissed, repoName };
})();
