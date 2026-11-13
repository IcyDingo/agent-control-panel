# Workspaces: Work and Private, sealed from each other

Date: 2026-11-13. Status: design, for review. This is the first of four projects that turn Glue into an orchestrator
across coding agents. The other three are outlined at the end, so this one leaves room for them; they get designs of
their own.

## Why

Glue is becoming the place you run your development work from, whatever agent does it: Claude Code today, then Codex,
then any model through OpenRouter. The goal is a faster path from idea to merged change, with less juggling of tools,
terminals and logins.

The user works across two identities on one Mac:

- **Private:** their own Claude Code login (`~/.claude`, personal Max plan).
- **Work:** their client's login (`~/.claude-contract`, the Clinton Health Access Initiative Enterprise plan).

These have different owners and different data policies. **What happens in Private must never reach Work, and the
reverse.** Today Glue shows one Claude profile at a time, but the seal is incomplete: switching is clunky, the GitHub
panel's "your open pull requests anywhere" list mixes both, and nothing stops a work repository from being launched
under the private login.

A **workspace** is the unit that carries an identity and keeps it sealed. Every later provider (Codex, OpenRouter, a
second GitHub account) slots into a workspace rather than floating free.

## Goals

1. Two (or more) workspaces, each with its own logins, agents, overseer, PR watcher, history and folders.
2. Moving between them is fluent: one key, and you always know which one you're in.
3. Nothing waits unseen: the other workspace tells you **how many** things need you, never what they are.
4. Every repository belongs to one workspace, decided by the user the first time an agent works in it.

## Non-goals

- Configuring Codex, OpenRouter or roles. Those are projects 2–4; this design only leaves the slots.
- Several GitHub accounts. The user has one (`IcyDingo`), shared by both workspaces for now.
- Moving a running session between workspaces.

## Anti-goals (this fails even if it works)

- Any name, prompt, transcript excerpt, repository name, branch or PR title from one workspace appearing on screen, in
  a notification, in the overseer's digest, or in a model call while the other workspace is active.
- An agent started, messaged or handed a fix in one workspace using the other's login, key or folder.
- A busier screen. With one workspace configured, Glue looks exactly as it does today.

## What the user decided

- Glue becomes the orchestrator between Claude Code, Codex and OpenRouter models, optimised for the development
  workflow.
- Private and Work are strictly sealed.
- **Moving between them:** option "C with B's styling" from the mockups. One workspace is in focus. The other shows
  only a count of what needs you. The look is B's clean switch with a window-wide accent colour, not a separate strip.
- **Folders:** Glue asks which workspace a repository belongs to the first time an agent works in it, and remembers.
- **First run for this user:** Private = the `claude` profile, Work = the `claude-contract` profile, and both use
  the one GitHub account.
- **Order of the four projects:** Workspaces, Codex, OpenRouter, Roles.

## How it behaves

### What a workspace is

A workspace has a **name**, a **colour**, and exactly **one Claude Code profile**. Workspaces and Claude profiles are
one-to-one, so every profile Glue finds today becomes a workspace. Later projects add, per workspace, a Codex home
folder, an OpenRouter key (in the macOS Keychain) and optionally a GitHub config folder. Leave room in the stored
shape, but build none of them now.

A workspace also owns a list of **repositories**:
- **A GitHub repository** is identified by its GitHub `owner/name`, from `origin`, the same key the GitHub poller and
  the PR watcher already use. Every clone and worktree of it follows. A repository known only from the "mine" search,
  with no local checkout, can be sorted too. *(My call.)*
- **A repository can be in more than one workspace when the user allows it** (the user's decision). By default the
  question offers one workspace. "Both" (or several) is an explicit choice, and the assignment list shows it. A shared
  repository's own data (name, pull requests, checks, merges) shows in every workspace it's in. That is the user's
  choice, not a leak. Sessions stay sealed regardless: a session belongs to its login's workspace only.
  - **The PR watcher on a shared repository:** a pull request is handled by the workspace whose session is on its
    branch, through that session's login. Its memory stays keyed by repository and PR, so a pull request is never
    asked about twice, whichever workspace sees it.
- **Anything else** (no GitHub origin) is identified by its git common dir, or by its folder path outside git.

**What counts as "waiting"** for the count and the Dock badge: everything that would sit in that workspace's Needs you
queue (held permission requests, open questions and plans), plus overseer proposal cards waiting for a click (the
watcher's "fix to confirm" cards included). Failing checks are not counted; they notify. *(My call.)*

### The switch

- The profile tabs in the top bar are replaced by a segmented **switch** naming each workspace: `Work | Private`.
  With one workspace there is no switch, as with the tabs today.
- **⌃1, ⌃2, …** select workspaces in switch order, as does a click. They don't fire while typing. *(My call. ⌘1 is
  taken by the app's own menu.)*
- **The accent:** the active workspace's colour shows as a thin accent along the top of the window, on the active half
  of the switch, and on the Glue mark in the header. The rest of the palette stays as it is. Default colours are blue
  for Work and violet for Private, and the user can change them. *(My call.)* Amber stays reserved for "needs you".
- **The count:** the inactive workspace's half of the switch carries a number when something there needs you, e.g.
  `Private ·1` in amber. Nothing else about it is shown anywhere.
- **What carries over from profile switching today:** an unsent message asks before switching, and requests held for
  the other workspace stay held and come back when you switch to it.

### Every workspace keeps working (the user's decision)

Switching changes what you **see**, never what **runs**. While Private is in focus, Work carries on in full:
- **Its PR watcher** still asks its agents to fix failing PRs.
- **Messages held for a busy agent** still go out when it's free.
- **An overseer answer under way** finishes.
- **Its repositories** are still polled, and a failing check notifies ("Work: a check failed").

So the server holds **one complete set of state per workspace**: sessions, follows, terminals, inbox, held requests,
overseer, watcher, GitHub targets, and the environment (Claude profile, later Codex home and keys) that every action
and every spawned process uses. There is no longer one global "current profile" that actions read. Every send path
takes its workspace explicitly. Switching is then instant: the page is simply shown another workspace's
already-live state, with no clear-and-reload.

What stays per page rather than per workspace: which workspace is in focus, the open session, drafts in the message
box, and folded queues.

### The seal

This is enforced in the server, not in the page:

- **What reaches the page:** the snapshot carries the **active workspace's** data only. For each other workspace it
  carries exactly `{ id, name, color, waiting: <number> }`. No session, request, repository or GitHub data from an
  inactive workspace is ever serialised to the page.
- **Actions:** every action (answer, reply, interrupt, end, remove, mode switch, terminal, launch, log hand-off,
  overseer proposal) checks that its target belongs to the active workspace and refuses otherwise. The existing check
  for held requests ("That request belongs to a profile that is not on the board") generalises to all of them.
- **The overseer:** one per workspace, as today it is one per profile. Its digest and the transcripts it reads come
  only from its own workspace. It runs on that workspace's own Claude login.
- **The PR watcher:** acts only on pull requests in its workspace's repositories, and only messages that workspace's
  sessions.
- **Launching:** New agent launches under the active workspace's profile. A folder assigned to the other workspace is
  refused with a plain message ("chai-expense-tracker is in Work. Switch to Work to start an agent there.").
- **GitHub:**
  - **The GitHub panel** lists only repositories assigned to the active workspace.
  - **"Your open pull requests anywhere":** results are filtered to the active workspace's repositories.
  - **Repositories in no workspace** show only as a count with a way to sort them ("3 repositories aren't in a
    workspace yet · Sort"). Sorting asks Work or Private for each one. *(My call. Showing their names in both
    workspaces would leak.)*
- **Notifications:** for the active workspace, as today. For an inactive one, the text is only
  `Private: 1 needs you` (or `Private: a check failed`), with no names or text, and clicking it switches to that
  workspace. *(My call.)*
- **Dock badge:** counts everything that waits on you across all workspaces, since it is only a number. *(My call.)*

### Folders: Glue asks

- **When launching:** if the folder's repository is in no workspace, the launcher shows an inline choice before
  **Launch**: "Is chai-expense-tracker Work or Private?". The active workspace is preselected, a quieter **Both** is
  offered beside them, and the answer is remembered.
- **A session started in a terminal:** it already belongs to the workspace whose profile it runs under. If its
  repository is unassigned, its row asks once, inline: "Remember chai-expense-tracker as Work?", answered with
  **Yes** or **It's Private**. Until answered, nothing else changes. *(My call.)*
- **Mismatch:** a session whose profile's workspace differs from its repository's workspace (e.g. a private login in
  a work repo) still shows on its profile's board, with its own name and conversation, because those came from that
  login. Everything that comes from the repository (its name, branch, checkout, pull request and checks) is withheld
  and replaced by "Works in a repository from Work". Its row and details warn about the mismatch. Glue doesn't stop
  the session, because it runs outside Glue, but it never hands it work from either side. *The rule throughout:
  session data follows the session's workspace, repository data follows the repository's workspace, and a thing shows
  only when its workspace is the active one.* *(My call.)*
- **Unsorted repository:** a session of the active workspace working in an unsorted repository shows its repository,
  branch and pull request as today, since the active login already reached them. The PR watcher doesn't act on it
  and the GitHub panel doesn't list it until the question is answered. *(My call.)*
- **Suggestions:** to avoid asking about every repository on day one, a repository that only one profile's past
  sessions have worked in is offered with that workspace preselected. It is still a question, never a silent
  assignment. *(My call.)*
- **Changing it later:** assignments are listed in a Workspaces section of the setup checklist, where a repository
  can be moved or forgotten.

### First run and the setup checklist

- Existing users: on first start, every Claude profile becomes a workspace named after its folder (`claude`,
  `claude-contract`), with default colours. The setup checklist gains a **Workspaces** step to rename them and pick
  colours. This user will name them Private and Work there.
- The checklist's other steps (Claude sign-in, Connect, first agent, GitHub, alerts) apply per workspace, and show
  for the active one.

## Constraints from the code as it is

- `server.mjs` keeps one active `profile`, with module-level `sessions`, `inbox`, `follows`, `terms`, `childEnv`,
  `configDir`, and one overseer and watcher. `switchProfile` clears them and re-reads the roster. Since every workspace
  keeps working, this becomes **one state object per workspace**, created at start for every workspace, each with its
  own roster poll (`claude agents --json` under its profile), its own `childEnv`, and its own overseer and watcher.
  Switching only changes which workspace a page is shown. This refactor is the bulk of the work, and the riskiest part
  for the seal: every send path (reply, launch, resume, mode switch, terminal, overseer call, watcher fix, log
  hand-off) must take the workspace's environment, never a global one.
- Hook events from another profile are dropped today (`otherProfile`). They route to their workspace's state instead,
  found from the event's transcript path (`profileDirOf`). Held permission requests already carry a `profileDir`.
- The roster is polled at today's pace for every workspace while a page is open, and at the daemon's quiet pace
  otherwise. The poll interval may be tuned if several workspaces cost too much.
- `overseer.json` already keeps its conversation and feed per profile id. Keep those ids as workspace ids so nothing is
  lost. `watcher.json` is **not** per profile: it holds one global Auto-fix switch and a memory keyed by repository and
  PR number. Auto-fix becomes a per-workspace switch, starting from today's value in each. Its memory stays keyed by
  repository and PR, shared, so a pull request in a repository that's in two workspaces is never asked about twice.
  *(My call.)*
- `prefs.json` is shared and merged on write (`savePrefs`). Workspaces and repository assignments need durable storage
  of their own beside it, e.g. `workspaces.json`.
- The GitHub poller (`github.mjs`) is shared and keyed by repository. The seal is applied when building
  `snap.github`, `forSession`, the "mine" list and notifications, not by running two pollers on one account.
- The page builds the profile tabs in `renderProfile`. The switch replaces them. The banners (sign-in, Connect) are
  per workspace.

## Left to the builder

- How the per-workspace state is structured, as long as only counts from inactive workspaces leave the server.
- The storage format for workspaces and assignments, and how the existing per-profile files map onto it.
- The exact accent treatment, within "thin top accent, the switch, the mark".
- Tests. The seal deserves server tests that assert nothing from an inactive workspace appears in a snapshot or a
  digest, and that cross-workspace actions are refused.

## The road after this (each gets its own design)

2. **Codex as a second agent kind.** Codex 0.169 is installed on this Mac (not signed in yet). It has stable lifecycle
   hooks (`PreToolUse`, `PermissionRequest`, …) that run commands, so Glue ships a small forwarder. It also has
   `codex queue --thread … --message …` to message a session, `--worktree`, `exec --json`, and a background daemon.
   Codex sessions join the board with a badge, approvals answer from Glue, and launching and messaging work as for
   Claude. Each workspace gets its own Codex home folder and sign-in step.
3. **OpenRouter.** A key per workspace, kept in the Keychain. A Provider and Model choice in New agent: Codex through
   its OpenRouter model provider, and Claude Code through `ANTHROPIC_BASE_URL`, which OpenRouter only guarantees with
   Anthropic's own models. The overseer can run on it too.
4. **Roles and routing.** The user decides the hand-offs: per workspace, roles such as Build, Review PRs, Fix failing
   CI and Triage, each mapped to an agent and model, with empty roles falling back to today's behaviour. The overseer
   proposes by role, and the PR watcher routes by role. **The orchestrator itself runs on a cheaper model:** with one
   provider, that provider's cheaper tier (Sonnet or Haiku over Opus, a mini model on Codex); with several, the
   cheapest available. The user can override it.
