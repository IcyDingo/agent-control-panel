# Home as goals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Home shows each issue as a goal with a sideways tree of its parallel branches, collapsible to one line, with the one click that keeps it moving; agents outside any goal that need the owner still show.

**Architecture:** Deciding logic in `public/home-board.js` (pure functions, unit-tested); drawing in `public/index.html`'s Home section with `el()`, `patch()`-style signatures and `HB.syncChildren`. `issues.mjs` gains `doneAt`. No new server routes: actions use `/api/decide`, `/api/answer-open`, `/api/overseer/follow` (via `fuAct`), `/api/reply`, `/api/interrupt`, `/api/main/wake`, the Issues panel's `pickUp` and `mergeSession`.

**Tech Stack:** Node ≥20 standard library, plain browser JS, `node --test`.

**Spec:** `docs/superpowers/specs/2026-11-26-home-goals-tree-design.md`

## Global Constraints
- Flat dots, page colour tokens in light and dark, tints not outlines; no counts line, no agent lists, no transcripts.
- Stall: 20 minutes with no event from a working session. Reached: shown "Reached today" for the local calendar day of the last `doneAt`.
- "Ask to fix" text: `The checks on PR #<n> fail (<names>). Fix them and push.` "Nudge" text: `You have shown no progress for <N> minutes. Say where you are, and carry on.`
- Below 720 px the sideways tree stacks into rows joined by `├`/`╰`.

## Review Focus
- An agent on a done item that later asks permission: must show under Outside any goal (it is not a working item's agent). Test in Task 2.
- A finished agent with a mergeable PR or open follow-up and no working item: shows under Outside any goal. Test in Task 2.
- A collapsed goal whose need changes (a new ask) opens again; the same need does not. Test in Task 2.
- An issue with no items, and an item `working` with no `sessionId` yet ("starting"). Test in Task 2.
- Typing in an opened stop survives a snapshot: the goal's node is rebuilt only when its signature changes. Checked by hand in Task 4.

---

### Task 1: `doneAt` on items

**Files:** Modify `issues.mjs` (`itemIn`, `tick`, `done`, `back`); Test `test/issues.test.mjs`.

**Interfaces — Produces:** each item has `doneAt: number` (0 when unknown or not done).

- [ ] **Step 1: Failing test** `test('an item records when it was done; undone clears it')`: with `now` stubbed to 1000, `tick(ws,i,it,true)` → item `doneAt === 1000`; at 2000 `done(ws,i,it2,5)` → `doneAt === 2000`; `tick(ws,i,it,false)` → `doneAt === 0`; a new store on the same file keeps `doneAt === 2000`.
- [ ] **Step 2:** `npm test -- test/issues.test.mjs` → FAIL.
- [ ] **Step 3:** Set `doneAt: now()` in `tick(on)` and `done`, `0` on untick and `back`; `itemIn` keeps a finite `doneAt` only for done items.
- [ ] **Step 4:** Test passes. **Step 5:** Commit `feat(issues): an item records when it was done`.

### Task 2: Goals in `home-board.js`

**Files:** Modify `public/home-board.js`; Test `test/home-board.test.mjs`.

**Interfaces — Produces** (on `globalThis.HomeBoard`):
- `tipOf(s, { reqs, follow, failedShown, mergeable, stateOf, now })` → `{ tone: 'amber'|'red'|'green'|'grey', ring: boolean, kind, words, acts: string[] }`, `kind` one of `asks`, `follow`, `failed`, `fails`, `merge`, `short`, `stalled`, `busy`, `idle`, `gone`, `starting`; `acts` from `allow`, `deny`, `answer`, `send`, `fix`, `merge`, `keep`, `nudge`, `again`, `wake`. First match wins, in the spec's table order. `s` null → `starting`. `failedShown(s)` false (dismissed) → `gone`.
- `goalOf(issue, ctx)` with `ctx = { sessions: Map<id,s>, reqsOf(id), followOf(id), failedShown, mergeable, stateOf, now }` → `{ id, title, total, shipped, lastShippedAt, branches: [{ item, s, tip }], ahead: [item], move: { rank, kind, words, acts, item }, reached, empty, needSig }`. `rank`: 0 asks/follow, 1 failed/fails, 2 merge, 3 short/stalled, 4 moving, 5 nobody on it, 6 reached. `needSig`: JSON of the branches' `[item.id, kind]` with rank ≤ 2.
- `goalsOrder(goals)` → by `move.rank`, stable.
- `outsideOf({ sessions, workingIds: Set, isMain(s), reqsOf, followOf, failedShown, mergeable, stateOf, now })` → `[{ s, tip }]`: agents not in `workingIds`, that need the owner (tip rank ≤ 3) whatever their state, or work/idle and are not finished and not a main agent.
- `isOpen(goal, collapsed: Map<id, sig>)` → `goal.needSig !== '[]' && collapsed.get(goal.id) !== goal.needSig`; with nothing needing the owner, open only when `collapsed.get(id) === 'open'`.
- `reachedToday(goals, now)` → titles of goals with `reached` whose `lastShippedAt` is on `now`'s local day.

- [ ] **Step 1: Failing tests** (fixtures as the file's `ag()`):
  - `tipOf`: a held plain Bash request → `{ kind:'asks', tone:'amber', acts:['allow','deny'] }`, words start `asks:`; a needs-answer follow → `kind:'follow', acts:['send','answer']`; failed shown → `failed`/red/`['again']`; failed dismissed → `gone`; PR `checks:'failing', failing:['test','lint']` → `fails`, words `PR #7 fails 2 checks`, `['fix']`; mergeable → `merge`/green/`['merge']`; busy with `lastEventAt` 21 min before `now` → `stalled`, `['nudge']`; busy 1 min → `busy`, no acts; `null` → `starting`.
  - `goalOf`: 2 done (doneAt 10, 20), 2 working (one asking, one busy), 1 todo → `shipped 2, total 5, lastShippedAt 20, branches.length 2, ahead.length 1, move.rank 0`; no items → `empty: true`; all done → `reached: true, move.rank 6`; only todo → `move.rank 5`, `move.acts ['pickup']`.
  - `goalsOrder` puts rank 0 before 2 before 5, stable within a rank.
  - `outsideOf`: an asking agent whose item is done (not in `workingIds`) is listed; a finished agent with a mergeable PR is listed; a finished agent with nothing is not; a busy main agent is not; an asking main agent is.
  - `isOpen`: needs → open; collapsed with same sig → closed; new sig → open; nothing needed → closed unless `'open'`.
  - `reachedToday`: same local day listed, the day before not.
- [ ] **Step 2:** `npm test -- test/home-board.test.mjs` → FAIL.
- [ ] **Step 3:** Implement. Reuse `plainAsk`, `inlineAsk`, `busyLine`. Words: asks → `asks: ` + (`inlineAsk` or question text), short to 80 chars.
- [ ] **Step 4:** Pass. **Step 5:** Commit `feat(home): what a goal shows, decided in home-board.js`.

### Task 3: Home draws the goals

**Files:** Modify `public/index.html` (Home markup at `#home`, CSS, `renderHome`, the old `renderCounts`/`renderNeeds`/`renderCards`/`homeCard` and their state go; Settings and toast text "reports on Home" → "reports in its conversation").

**Interfaces — Consumes:** Task 2's functions; `fuAct(f, decision, btn, text)`, `mergeSession(sessionId, pr)`, `pickUp(issue, item, {form})`, `buildCard(p)`, `api(route, body)`, `confirmOr(key, fn)`, `dismissedNeeds`, `mainOfSpace`, `snap.mains`.

- [ ] **Step 1:** Markup: replace `#h-counts`, `#h-board`, `#h-spaces` with `<section id="h-goals">` (head: "Goals", Expand all/Collapse all, + New goal) — the dock stays.
- [ ] **Step 2:** Render: per goal a node keyed `goal:<id>` with a signature of its view, open state, open stop and busy/armed keys; collapsed line (chevron, title, branch dots, move words, button(s), bar `shipped/total`); open: left column + sideways tree (CSS grid; stems via borders), ahead end; stacked rows under 720 px (media query). "Outside any goal" last; "Reached today" line; "+ New goal" types a title in place (`/api/issue/create`).
- [ ] **Step 3:** Actions: allow/deny (`/api/decide` or `/api/answer-open` as today's `waitingRow`), answer (opens the stop with `buildCard`/the follow reply box), send (`fuAct(f,'send',btn,f.reply)`), fix/nudge (`/api/reply` with the constraint texts), merge (`confirmOr('merge:'+sid, () => mergeSession(sid, pr))`), keep (`fuAct` send), again (`pickUp`), pickup (`pickUp` first todo), wake (`/api/main/wake`). Stop panel: Tell it… (`/api/reply`), Interrupt, Open agent, Dismiss for failed.
- [ ] **Step 4:** Collapse prefs in `pref('acp.goalsCollapsed')` (JSON of id → sig/'open'); j/k move focus among `#h-goals button.act`, Enter clicks (not in inputs).
- [ ] **Step 5:** `npm test` passes (no page tests; the old Home tests in `home-board.test.mjs` for removed functions stay as long as the functions stay; remove `homeCards`/`headCounts` and their tests if nothing calls them).
- [ ] **Step 6:** Commit `feat(home): goals as sideways trees, collapsible, with the move that keeps each going`.

### Task 4: Try it for real
- [ ] Second Glue on a spare port with a copied, silenced data folder (watcher off, alerts off, follow-ups off, main agents stripped); screenshot Home wide and narrow, light and dark, with a goal open and a stop open; type in a stop across a snapshot.
- [ ] Fix what shows; commit; push; PR; merge when green.
