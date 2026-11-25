# Migration numbers: Glue closes the local gap

## Intent
The owner runs many agents in parallel on `chai-expense-tracker` (Supabase, 1,939 migrations named
`<version>_<number>_<name>.sql`, e.g. `20370301004328_3078_ap_invoice_levies.sql`). Two agents working at once take the
same number. The owner asked how a deploying agent could "auto discover other PR from current PC … to be able to
frontrun migrations issues and numbers", wanted clashes to "auto fix", and found instructions in `CLAUDE.md` an
inefficient way to make agents behave.

The repository already handles most of it itself, and Glue must not change that:
- `npm run new:migration` (`scripts/next-migration.sh`): next file, highest version + 1 and highest number + 1, from the
  agent's own folder. Its own comment: it "cannot stop two parallel branches from grabbing the same one".
- `npm run stamp:check` (`scripts/stamp-check.sh`): a branch's new migrations against `origin/staging`, `origin/main`
  and every other open PR into staging (COLLIDES / BELOW).
- `scripts/check-migrations.sh`: allows the numbers used twice on purpose (541, 809–813, `GRANDFATHERED_SEQ`).
- `.github/workflows/gate.yml`: a clashing PR is renumbered automatically when it lands (`land-restamp.sh`, on unless
  `LAND_AUTO_RESTAMP` is `off`).

What the repository cannot do: see work on this computer that is not pushed yet (that is where two parallel agents take
the same number), and make agents run its scripts. **The owner decided (2026-11-24):** "Fill only the local gap. Have
Glue check new migration numbers against local worktrees and handed-out numbers, plus what stamp:check already sees, and
auto-renumber only clashes between local agents. Leave PR clashes to the CI renumbering at merge. Skip the deliberately
duplicated numbers (541, 809–813), count CI-renamed migrations as landed, and ignore stale branches with no agent,
worktree or open PR. Don't change the existing repository tooling."

## Goals
- The moment an agent on this computer creates a migration (by `npm run new:migration`, by writing the file, or any
  other way), Glue checks its number and version against every other local agent's work, the numbers Glue handed out,
  and what `stamp:check` sees. If it clashes or sorts below, the agent is told at once, in the same turn, with a free
  number booked for it.
- A clash between two local agents that still exists (the agent was not told at creation, or did not rename) is fixed by
  Glue telling the agent that should renumber to do so, with a booked number.
- No `CLAUDE.md` lines, no command for agents to learn.

## Non-goals
- No change to the repository's scripts, workflows or `CLAUDE.md`. Glue writes nothing into the repository: no edits,
  commits or pushes. The agent renames its own file.
- PR-against-PR clashes, and a PR that clashes with `staging` or `main`, are left to the CI renumbering at merge: Glue
  sends no message and shows no Home row for them. (They are still named to an agent at the moment it creates a clashing
  migration, since that is the cheapest moment to avoid one.)
- No other migration tools in this round: a repository is covered when it has `supabase/migrations` with numbered files
  (`^\d{14}_\d+_[\w.-]+\.sql$`). Other repositories are untouched.

## Anti-goals
- No noise: the duplicates on purpose, migrations CI renamed when they landed, and stale branches never produce a
  message, a card or a Home row.
- Never two agents handed the same number by Glue.
- Never a message that restarts or closes an agent against Auto-fix's rules, and never the same clash raised twice.
- Nothing about one workspace's repositories reaches another workspace's page.

## Approaches
- **A. Glue hands out numbers and checks, with a command and `CLAUDE.md` lines (first pick, then changed).** The owner
  found the `CLAUDE.md` route inefficient and wanted auto-fix, and the repository turned out to have its own allocator,
  check and CI renumbering.
- **A, as decided: Glue fills only the local gap (picked).** Glue checks at creation through its hooks, auto-fixes only
  local-vs-local clashes, and leaves the rest to the repository's tooling and CI.
- **B. Glue only watches** and flags clashes. Catches them late; someone still renumbers.
- **C. Only the repository's tooling.** Exists already; blind to unpushed work on this computer.

## Design

### What counts (the index)
For each covered repository with an agent on the board, Glue keeps an index of migrations, each with where it was seen:
1. **Landed:** `origin/staging` and `origin/main` (the branches `stamp:check` reads), as this computer last fetched
   them. Glue runs `git fetch -q origin staging main` at most once per 2 minutes per repository, and carries on with what
   it has if that fails. (Generalised: the remote's default branch, plus `main` when it exists and differs.)
2. **Open PRs into the default branch:** every open PR in the list Glue's GitHub poller already fetches (not only the
   ones with an agent on the board): the migrations it adds, read with `gh api repos/<slug>/pulls/<n>/files` (paged),
   cached by the PR's head commit. A PR whose files cannot be read is skipped and logged.
3. **Local work:** every worktree of the repository on disk (`git worktree list`), uncommitted and untracked files
   included; and every local branch that has an agent on the board or an open PR, from its latest commit. A local branch
   with no agent, no worktree and no open PR is not read.
4. **Handed out (bookings):** numbers and versions Glue gave an agent to rename to, with the agent, for 3 days or until a
   file with that number or version appears in the index.

A migration's identity is its file name. Rules that keep the noise out:
- **Landed by name:** a migration whose name part (after the number) is on `staging` or `main` under another number
  counts as landed (CI renamed it when it landed, or it was squash-merged): it is no one's clash.
- **Duplicates on purpose:** two migrations that are both on `staging` or `main` never clash with each other (this covers
  541 and 809–813 without a list). A clash needs at least one side that is not landed.

### What a clash is
For an unlanded local migration `m` (in a worktree or a counted local branch):
- **Clash:** another migration in the index with a different file name and the same number, or the same version.
- **Below:** `m`'s version sorts at or before the highest version on `staging` or `main` (as `stamp:check`'s BELOW).
The free number and version to rename to follow the repository's own rule (`next-migration.sh`): the highest number in
the index (bookings included) + 1, and the highest version in the index + 1. Glue books them for that agent.
Requests for a free number are handled one at a time per repository, so two agents are never handed the same one.

### At creation (through Glue's hooks)
- On each `PostToolUse` of a Claude Code agent whose login has live updates on, Glue looks at that agent's own
  migrations folder (the worktree it runs in) for files it has not seen there before. Reading the folder is cheap; the
  rest of the index comes from what Glue already holds, so the answer is within the hook's 2 seconds.
- A new file that clashes or is below gets an answer to that hook telling the agent, in the same turn: which number or
  version clashes and with what (another agent's worktree, a booked number, a PR, `staging`/`main`), and the file name to
  rename it to, already booked. Words for the agent, e.g.: "Glue: migration 3079 is also taken by worktree-cart-api
  (agent cart-api). Rename supabase/migrations/20370301004329_3079_levies.sql to 20370301004330_3080_levies.sql (booked
  for you), and change any reference to the old name."
- A new file that is free is simply added to the index (it now claims its number for the others).
- *To verify with the real CLI before building on it, as was done for the main agents:* that Claude Code passes a
  `PostToolUse` hook's answer (`hookSpecificOutput.additionalContext`, or `decision: "block"` with a reason) from an
  `http` hook to the agent. If it does not, the creation check falls back to the auto-fix below, at most a minute later.

### Auto-fix (local agents only)
- Once a minute, for each covered repository, Glue rebuilds the index and looks for clashes and belows between two local
  unlanded migrations (two worktrees, a worktree and a counted branch, or a local migration and a booking) that are
  still there.
- **Who renumbers:** of two clashing local migrations, the one Glue saw appear later; if it saw neither appear (both
  there before Glue looked), the one on the branch whose last commit is newer. A below is renumbered by its own agent.
- **How they are told:** the agent working in that worktree or on that branch gets the same words as at creation, under
  Auto-fix's rules (`watcher.mjs`), and only while the workspace's Auto-fix is on: a background agent is told at once (it
  reads it after its current turn when busy); a terminal Claude gets a card in Needs you for the owner to confirm, since a
  message closes it there; an agent the panel can only see through its hooks cannot be messaged, so its clash is a row in
  Needs you. Each clash is raised once (by the two file names and the number), never again while it stands, and kept in
  Glue's data folder so a restart does not raise it again.
- A clash whose renumbering agent is not on the board (a worktree with no agent) is a row in Needs you, naming both
  sides and the number to rename to.

### Home
- Needs you gets one new kind, `migration`, only for what auto-fix cannot do itself (above). The row names the two
  migrations and where they are, the number to rename to, and opens the agent when there is one. PR clashes never show.
- The page gets, per repository of its workspace only, those rows' data and nothing more.

## Constraints
- Node standard library, and the `git` and `gh` already used. The deciding part (patterns, landed-by-name, clashes,
  below, who renumbers, the next free number) in a module of its own (`migrations.mjs`) with unit tests on plain data,
  including the repository's real shapes (the duplicates on purpose, a CI-renamed migration, a stale branch). The git
  and gh reading and the hook in the server, tested end to end with a throwaway repository, worktrees, a stand-in `gh`
  and hook events, as the existing server tests do.
- No change to the hooks Glue installs: `PostToolUse` already goes to `/hook/event`.

## Left to the builder
- The exact words, within what each must say.
- How the Home row looks, within the Needs-you rows' look.
- Paging and caching of PR file lists, within "cached by head commit".
