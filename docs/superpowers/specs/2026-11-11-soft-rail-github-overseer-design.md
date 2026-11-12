# Agent panel: softer look, repo-first rail, GitHub status, and an overseer

## Context

The panel today groups sessions only by state, shows just the branch on each tile (folder and repo hide in
tooltips), draws everything with hairline outlines at tight spacing, knows nothing about GitHub, and has no place to
ask "what is everything doing?". Running several agents across several repos is therefore harder than it should be,
and a failed check or a broken main is only noticed by going to GitHub.

What you decided:

- **Rail:** profiles stay at the top but as a tab bar; Needs you first; agents keep their names but are grouped by
  repo and worktree.
- **Look:** soft and spacious, with background colours behind things instead of outlines.
- **GitHub:** watch the branches agents are on plus the default branch after merges; alert on failure.
- **Overseer:** a coordinator you chat with. It knows every session and proposes actions; you confirm each with a click.

Constraints kept from the repo's specs: Node standard library only, no build step, one HTML file, 127.0.0.1 only,
every new `/api` route is POST behind the per-start token, child processes by argv, git read-only, slow work off the
request path, nothing new in the hub projection.

## Amended 2026-11-12: built on the slim rail

This design was written against `901d710`. Before it was built, the local main gained the slim-rail, live-session-view
and clean-pass work and lost World, Hub and Space, and the owner chose to build on that. What changes:

- **Rail.** The one-line session rows, subagent trees, keys and find stay. The state queues (Working, Idle) give way to
  repository sections: Needs you, then one section per repository, then Other folders, then Finished. Repository
  sections are ordered by name, not recent activity, so they hold still while agents work (the slim rail's anti-goal
  about rows moving under the pointer). A row under Needs you names its repository, since it sits away from that
  section. A repository header shows the folder it sits in and, with one checkout in use, that checkout and branch;
  with two or more, a quiet label heads each checkout's rows. Interrupt all and End idle are per section.
- **Look.** Applied to the clean-pass chrome: rows stay one line (30 px, up from 26 px) rather than becoming cards.
  Section headers are sentence case. The rail is 300 px by default. A single profile hides the tab bar.
- **World and Space.** Gone from main, so their checks are dropped.
- **Server.** `askClaude`, `notifyOrder` and `world.mjs` no longer exist: the overseer gets its own headless
  `claude -p` helper, and GitHub alerts their own `notify()`. Line numbers in the phases below refer to the old tree.

## Shape of the result

```
┌ Agent panel  [default][work][client]  ● live  2 need you · 3 working      ⏸ theme  Space  World  [New agent] ┐
├───────────────────────────┬──────────────────────────────────────────────────────────────────────────────────┤
│ ◆ Overseer                │  (no session open → the Overseer is the home view)                                │
│                           │   chat thread, proposed-action cards,            │ Across everything              │
│ NEEDS YOU              2  │   feed lines ("fix-login finished",              │  agent-control-panel  ✓ main   │
│  ● fix-login              │   "CI failed on #31")                            │   #31 feat/soft  ✗ build       │
│    chai-expense · fix/login│                                                 │  chai-expense-tracker ● running│
│                           │   [ Ask about your agents…            Send ]     │  Recently merged …             │
│ agent-control-panel ✓ main│                                                                                   │
│  ~/…/agent-control-panel  │  (a session open → today's session panel, plus a place bar                        │
│  ◐ soft-redesign          │   repo / worktree / branch / PR #31 ✗ and a Pull request block in Details)        │
│    wt dynamic… · feat/soft│                                                                                   │
│ chai-expense-tracker ✗ CI │                                                                                   │
│ Other folders             │                                                                                   │
│ Finished               4 ▸│                                                                                   │
└───────────────────────────┴──────────────────────────────────────────────────────────────────────────────────┘
```

## Phase 1 — Rail: profile tabs, Needs you, repo and worktree groups

All in `public/index.html`; no server change.

- **Profile tabs.** Replace `#prof-btn`/`#prof-menu` (HTML 816-819, JS 2799-2853) with a `role="tablist"` in the top
  bar. Tabs come from the existing `/api/profiles`, fetched on connect, after a switch and on window focus. Each tab
  shows the label and a "not connected" dot; account, plan and command move to its tooltip. `chooseProfile()` stays,
  including the two-click "Switch anyway: N unsent messages are dropped".
- **Sections.** Keep `groups()` (1312) for the top-bar counts and Space view. Add `sections(vis)` for the rail:
  1. **Needs you**: pinned, never folds, same order as today (`asking()`).
  2. **One section per repo**, keyed by `s.git.repo`, ordered by most recent activity. Header: repo name, its folder
     as a dim `~`-shortened path, live counts, and (Phase 3) the CI pill. Tiles sort by checkout (main first, then
     worktrees), then working before idle. When a repo has two or more checkouts in use, a quiet sub-label names each.
  3. **Other folders**: sessions outside any repo, labelled by folder name.
  4. **Finished**: one folded section at the bottom with today's Clear button.
  - A waiting session appears only in Needs you (tiles are single persistent nodes in the `tiles` Map, 1433); its
    repo header says "1 needs you".
  - Replace the static `colEls` (1398-1411) with a keyed section cache built the same way; keep the
    "move only what is out of place" reorder (1511-1513). Fold state stays in `acp.folded` with `repo:<path>` keys.
  - Bulk buttons keep their two-click behaviour, scoped to the section: Interrupt all and End idle per repo.
- **Tile.** Row 3 (`.twhere`, 1440/1453) becomes `repo · worktree-or-"main checkout" · branch`; inside its own repo
  section the repo part is dropped. Non-git sessions show the folder name with the folder icon.
- **Session header.** Turn the inline facts (`.d-facts`, 1597-1602) into a place bar: repo / worktree / branch
  chips built from `whereOf()` and `repoOf()` (1420-1426), with the full path beneath and click-to-copy via the
  existing clipboard pattern in `copyBtn` (1524).

## Phase 2 — Soft, spacious surfaces

CSS in `public/index.html` (13-811). Use the `frontend-design` skill for the visual pass.

- **Principle:** tone separates, lines don't. Four layers, each a step lighter (dark) or whiter (light):
  canvas `--bg` → islands `--panel` (rail, session panel, as rounded blocks with a gap around them) →
  cards `--raise` (tiles, request cards, composer, repo sections) → controls `--fill`.
- **New tokens** in the main `:root` and both light blocks (17-46), and the forced-dark `.space` block (609-616):
  - radii `--r-1: 8px; --r-2: 12px; --r-3: 16px; --r-pill: 999px`
  - spacing `--s-1…--s-6: 4, 8, 12, 16, 24, 32px`
  - fills `--fill`, `--fill-strong`, and state tints `--amber-fill`, `--run-fill`, `--ok-fill`, `--stop-fill`
    (the existing `-dim` values, raised slightly)
- **Apply:**
  - Tiles, chips, buttons, the composer, request cards and notes lose their 1px borders and get a fill.
  - A waiting tile is amber-tinted; the open tile is `--fill-strong`; state tags become tinted pills; the state
    light becomes a round 8px dot.
  - Hairlines remain only between same-tone regions and as focus rings.
  - Roomier: body 14px, top bar 56px, tile padding 14×16, 10px between tiles, 20px between sections, rail default
    340px, buttons 32px tall.
- **Cleanup while there:** drop the unused `--top`, merge the duplicate `.linkish` (139 and 421).
- **World and Space view:** layout untouched; they inherit the new control styles, so check both. `public/world.js`
  and the shared `w-*` ids are not touched. `hub/public/hub.css` is left alone (my call: the hub page's controls
  drift slightly from the app until someone wants them matched).

## Phase 3 — GitHub

New `github.mjs` (factory, injected deps, like `createWorld` at `world.mjs:652`), wired in `server.mjs`.

- **Sign-in:** your `gh` CLI. The panel stores no token. Missing or signed-out `gh` shows one quiet hint line.
- **Which repo:** read `[remote "origin"] url` from `<common>/config` (a file read beside `readPlace`,
  `server.mjs:1200-1225`; no git spawn). `parseRemote()` accepts github.com HTTPS/SSH forms and never keeps the raw
  URL, which can embed a token. Other hosts are simply not tracked.
- **Calls,** through the existing `run` (`server.mjs:158`), always `-R github.com/<slug>` from the panel's data
  folder so `gh` never runs git inside a repo:
  - `gh pr list --state open --json number,title,url,isDraft,headRefName,headRefOid,isCrossRepository,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,updatedAt`
  - `gh run list --branch <default> --json databaseId,workflowName,displayTitle,status,conclusion,headSha,event,url,createdAt,updatedAt,attempt`
  - `gh pr list --state merged --limit 15 …` (first poll, every fifth, and when a tracked PR disappears)
  - `gh run view <id> --log-failed` on demand
- **Polling:** one 15 s ticker with a per-repo `nextAt` and an overlap guard (pattern: `worldScanning`,
  `server.mjs:1377-1385`).
  | Situation | Interval |
  |---|---|
  | Page open, CI idle | 60 s |
  | Page open, something running | 20 s |
  | No page open | 5 min (60 s while something runs) |
  | Error | 60 s doubling to 15 min |
  - At most six repos, most recently active first.
  - `ACP_GITHUB=off` disables it; set that in `test/daemon-server.test.mjs`, which runs with the real HOME and PATH.
- **Failure alerts:** keyed by `slug#pr<number>@<head sha>` and `slug#run<id>.<attempt>`, remembered in a 0600
  `github.json` so a restart never repeats one. On first sight after a start, only failures from the last 15 minutes
  notify. Delivery is a macOS notification through `notify()`, extracted from `notifyOrder`
  (`server.mjs:1498-1504`), so it works with no page open.
- **Data to the page:** `snap.github = { gh, hint, repos: [{ slug, url, defaultBranch, prs, runs, merged, error }] }`
  and a small `gh` summary on each session (PR number, check state, main state, the failed run to hand over). Added
  in `snapshot()` (`server.mjs:1617-1634`).
- **Routes** (in the `ACTIONS` table, `server.mjs:1750`): `/api/github/refresh`, `/api/github/log`,
  `/api/github/hand`.
- **UI:**
  - CI pill on each repo section header; a check dot on the tile's place row.
  - PR chip in the session's place bar, linking to GitHub.
  - A **Pull request** block in Details: checks, mergeability, review state.
  - **Send the failing log to this agent**: shows the trimmed log and the exact message first, then sends through
    the existing `reply()`. The button says when sending will restart a terminal session in the background, which
    `reply()` does for an idle terminal session (`server.mjs:969-999`).

## Phase 4 — Overseer

New `overseer.mjs`, wired in `server.mjs`; UI in `public/index.html`.

- **What it is:** one headless, tool-less `claude -p` call per message, the pattern already used by `askClaude`
  (`server.mjs:1445-1457`, args at `world.mjs:464-466`). Extract `askModel(args, opts)` from `askClaude` and reuse
  it, including `quietIds` so these calls never appear on the board. It runs on the active profile's Claude Code
  login; no API key. Default model sonnet, changeable in its composer.
- **What it sees each turn:** a compact digest built by a pure `digest()`:
  - up to 24 sessions: name, kind, state and age, repo, worktree, branch, PR and check state, current tool, what it
    asks you, subagents, last message
  - the folders it may launch in
  - GitHub status, the last 30 feed events, the last 12 turns
  - It can ask for more of one session's transcript (`look`, answered from `history.mjs`), at most two extra rounds.
- **What it returns** (via `--json-schema`): `{ reply, actions[≤4], look[≤2] }`, with actions `tell`, `launch` and
  `interrupt`.
- **Asks first:** actions are stored as proposals and rendered as cards showing the target and the exact text, which
  you can edit. Nothing runs without a click, and there is no "run all". On confirm the server calls the same
  `reply` / `launch` / `interrupt` functions the buttons use (`server.mjs:914`, `463`, `516`). Server-side checks:
  - the session must exist and be live
  - `tell` text must not start with `/` or `!` (`reply` would run a leading `/` as a slash command)
  - `launch` only in a folder the panel already knows and Claude Code already trusts; it cannot pick model or
    permission mode
  - proposals expire after an hour
  - it cannot answer permission requests or approve plans
- **Feed:** the server notes started, finished, needs you, answered, failed, closed, told, launched, interrupted and
  the GitHub events into a 200-item ring. Feed lines show in the overseer thread and feed its digest. Emit points
  are the existing roster, hook and settle sites (`server.mjs:273-279`, `320-356`, `386-414`).
- **Storage:** `overseer.json` (0600) beside `prefs.json`, one conversation and feed **per profile**, since each
  profile can be a different Claude account. A profile switch swaps conversations and drops any in-flight answer.
- **Data to the page:** `snap.overseer = { busy, rev, feedSeq, proposed, model }` only; turns and feed are fetched
  when `rev` changes, because the snapshot is re-sent whole on every broadcast.
- **Routes:** `/api/overseer/say`, `turns`, `feed`, `act`, `stop`, `model`, `clear`.
- **UI:**
  - The Overseer replaces the "Nothing open" placeholder (`#empty`, HTML 845) as the home view, with a pinned tile
    at the top of the rail that returns to it (`open = null`).
  - Reuse the `.thread` / `.msg` / `.composer` styles and `md()` (2344-2381), but with its own render functions and
    ids, since `renderThread` and `renderCompose` are tied to the open session.
  - Overseer text renders as plain markdown, never HTML.
  - Starter chips when empty: "What needs me?", "What is everyone doing?", "Anything failing on GitHub?".
  - A side column, **Across everything**, shows each repo's PRs, default-branch runs and recent merges.
  - Auto-open of the longest-waiting session at start is unchanged.

## Order of work, tests, and delivery

1. Save this design as `docs/superpowers/specs/2026-11-11-soft-rail-github-overseer-design.md` (repo convention).
2. Phase 1, then Phase 2: page only; verified in the running panel.
3. Phase 3, tests first:
   - `test/github.test.mjs`: remote parsing table, check rollup, `gh` error classes, only agent branches kept, alert
     dedupe and the 15-minute window, persistence across restarts, cadence and backoff, log trimming.
   - Then the wiring and UI.
4. Phase 4, tests first:
   - `test/overseer.test.mjs`: digest caps and tag stripping, args carry the tool denials, look loop bounded, busy
     refusal, every validation rule, the `act` state machine for each `reply` result, per-profile isolation, 0600
     file.
   - `test/overseer-server.test.mjs`: the stub-`claude` harness from `test/restart.test.mjs:27-48` plus a stub `gh`.
5. README: sections for GitHub and the Overseer, and what leaves the Mac (session digests go to your own Claude
   account; nothing new goes to the hub).

One branch (`worktree-dynamic-churning-curry`), one commit per phase in the repo's `feat(panel): …` style, pushed as
a **draft PR** (main is PR-only).

## Verification

- `npm test` passes, including the three new files and the existing suite with `ACP_GITHUB=off` where needed.
- Run a second panel on a spare port (`ACP_PORT=4760 ACP_PREFS=<temp>/prefs.json node server.mjs`) so the panel you
  are using is untouched. With the Playwright browser, screenshot the rail, a session, and the Overseer in dark and
  light at 1440px and 800px wide, then World and Space view to confirm nothing shifted.
- GitHub, live: a real poll against `IcyDingo/agent-control-panel` shows this branch's PR. Failure, running, alert
  and hand-the-log paths are checked with the stub `gh`, since this repo has no CI workflows.
- Overseer, live: one real turn ("What is everyone doing?"), then one proposed `tell` confirmed against a throwaway
  background session, checking the message arrives and the card records the result.
- Smoke-test the planner's assumptions before relying on them: the inner shape of `statusCheckRollup`, the
  tab-separated `--log-failed` format, `--system-prompt` together with `--json-schema`, and whether
  `~/.claude/CLAUDE.md` loads into the overseer call.

## Not included

- Needs-you counts on inactive profile tabs (the server tracks one profile at a time).
- Pull requests from forks, GitHub Enterprise hosts, GitLab.
- The overseer acting without a click, or doing code work itself.
- Streaming the overseer's answer as it is written (it arrives whole; the view shows "thinking").
- Restyling the hub website.
