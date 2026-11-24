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

  /** Whether one click answers these requests: a single plain tool request from Claude Code, not one held open. */
  const plainAsk = (reqs) => Array.isArray(reqs) && reqs.length === 1 && !reqs[0].open && reqs[0].agent !== 'opencode'
    && (PLAIN.has(reqs[0].toolName) || String(reqs[0].toolName ?? '').startsWith('mcp__'));

  /** The follow-up rows "Send all" sends, and the ones it leaves out: those whose sending would close a terminal Claude. */
  function bulkReplies(rows, restarts) {
    const send = [], left = [];
    for (const r of rows) if (r.kind === 'follow') (restarts(r) ? left : send).push(r);
    return { send, left };
  }

  /** What a dismissal of a failed agent holds for: until it is in another state or says something new. */
  const dismissKey = (s) => `${s.sessionId}:${s.state}:${s.lastMessageAt ?? ''}`;

  globalThis.HomeBoard = { needsList, needKinds, homeCards, headCounts, plainAsk, bulkReplies, dismissKey, repoName };
})();
