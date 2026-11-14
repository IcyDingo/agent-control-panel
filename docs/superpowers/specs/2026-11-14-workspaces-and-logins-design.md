# Workspaces and logins: a workspace is how you work, logins are what it runs on

Date: 2026-11-14. Status: design, for review. It replaces the rule "a workspace is exactly one Claude Code profile" in
`2026-11-13-workspaces-design.md`. Everything else in that design (the switch, the seal, every workspace keeps working,
repositories owned by workspaces) stands.

## Why

The user: "I don't want workspaces to be determined by Claude profiles." A workspace is **how they work**: Work and
Private, each with its repositories, GitHub, overseer, spaces and agents. Logins are **resources** a workspace uses, and
there can be several per provider: two Claude subscriptions, a ChatGPT login and an OpenAI API key. Today every Claude
profile folder Glue finds becomes a workspace, a workspace has exactly one Claude login, and adding a Claude account
(the unmerged Providers branch) makes a new workspace. That is the thing to undo.

The user wants several Claude logins in one workspace, so an agent can run on another subscription while one is at its
limit. This was decided earlier and parked; see "Next" below.

## Goals

1. Workspaces are Glue's own: you create, name, colour, order and remove them. No folder on disk decides they exist.
2. Logins are their own things, listed per provider in Settings › Providers: Claude logins and OpenAI (Codex) logins.
   Adding a login never adds a workspace.
3. A workspace uses any number of logins per provider, with one **default** per provider.
4. One login can be used by several workspaces (the user's decision).
5. New agent runs on the workspace's default Claude login, and you can pick another of its logins there.
6. Upgrading changes nothing you can see: today's workspaces keep their names, colours, repositories, spaces, overseer
   conversations and sessions, each with its current Claude login attached.

## Non-goals

- Moving a session that hit its limit to another login (the parked "continue under your other login?"). It needs this
  design first, and gets its own (see "Next").
- Running agents on Codex. OpenAI logins can be added, signed in and attached; agents on Codex come later.
- Several OpenCode logins. OpenCode stays one service per computer, usable by every workspace, with its providers
  connected inside OpenCode (as today).
- Several GitHub accounts. One `gh` login, shared, as today.

## Anti-goals (this fails even if it works)

- A Claude profile folder appearing, by itself, as a workspace.
- A session showing in a workspace that doesn't use its login, except where its repository puts it there (below).
- The seal weakened: one workspace's sessions, names, transcripts or repository data on screen while another is active.
  Sharing a login between workspaces is the user's explicit choice, like sharing a repository; it doesn't make either
  workspace's sessions visible in the other.
- Glue switching logins by itself, ever. Which login runs is always what you picked, or the workspace's default.
- A busier screen for someone with one workspace and one login. It looks as it does today.

## Approaches

1. **Logins as records of their own, which workspaces refer to.** *(Picked: it is the model the user approved.)*
   `workspaces.json` gains a `logins` list. Each Claude login points at the profile folder Claude Code keeps it in
   (that is only storage). Each workspace lists the logins it uses. The server keeps state per login (roster, sign-in,
   hooks) and per workspace (sessions shown, overseer, watcher, spaces).
2. **Keep workspace = profile, and let a workspace borrow extra profiles.** Rejected: workspaces would still come from
   profile folders, which is exactly what the user doesn't want.
3. **One Claude config folder, with Glue swapping its credentials between accounts.** Rejected: Claude Code keeps one
   login per config folder, so swapping would pull the login out from under running sessions. It is also the kind of
   automatic account rotation the earlier decision ruled out.

## How it behaves

### Logins

- A **Claude login** is a Claude Code profile folder: `~/.claude` (plain `claude`) or `~/.claude-<name>` (run with
  `CLAUDE_CONFIG_DIR`). It has a **label** you choose ("Personal Max", "Client"), its account (email and plan, read
  from the folder), whether it is signed in, and whether its hooks point at this panel (live updates).
- An **OpenAI login** is a Codex home folder: `~/.codex` for the first one, `~/.codex-<name>` for the others (run with
  `CODEX_HOME`). It has a label and how it is signed in (ChatGPT or an API key, read with `codex login status`).
- **Adding one from Glue:**
  - *Add a Claude login*: a label; Glue makes a new profile folder with Glue's hooks already in its `settings.json`,
    then opens its sign-in in Settings' own terminal (or in Terminal).
  - *Add an OpenAI login*: a label; Glue makes the Codex home, then **Sign in with ChatGPT** (in Settings' own
    terminal) or **Use an API key** (handed to `codex login --with-api-key` on stdin, never kept).
  - In both cases the folder name comes from the label (slugged, made unique). Folders are named by Glue and never
    reused or overwritten.
  - The new login is attached to the workspace in view and becomes its default for that provider if it has none.
- **Found on disk:** a Claude profile folder (or `~/.codex`) that Glue doesn't know yet becomes a login **in no
  workspace**. Settings › Providers lists it with "Not used by any workspace" and a way to attach it. Its sessions show
  nowhere until it is attached. Providers says how many sessions it has, as a number only. *(My call: the seal-safe
  default. A login nobody has placed can't be shown in a workspace nobody chose.)*
- **Removing a login** detaches it from every workspace and forgets it in Glue. Its folder stays on disk, since Claude
  Code or Codex keep the login there. Glue says so and offers to show it in Finder. A login still listed in a running
  session's roster can't be removed until those sessions end. *(My call.)*

### Workspaces

- A workspace has a name, a colour, its repositories and spaces (as today), and **its logins**: per provider, a list
  and a default.
- **Settings › Workspaces** gains **New workspace** (a name and colour; it starts with the workspace in view's default
  Claude login attached, which you can change) and **Remove** (not the last one). Each workspace row gains a **Logins**
  line: chips per provider, the default marked, with add and remove.
- **Removing a workspace**: its logins stay, now used by fewer workspaces. Its repositories go back to unsorted. Its
  spaces and overseer conversation go. Glue refuses while sessions it launched in that workspace are still running.
  *(My call.)*
- A workspace with **no Claude login** can still be shown. New agent and its overseer say "This workspace has no Claude
  login yet" with a link to Settings › Providers.

### Which workspace shows a session

A session runs on exactly one login: the profile whose roster lists it, or whose `projects/` holds its transcript.
Which workspace shows it, in order:

1. **Started from Glue** (New agent, a continuation, the watcher's fix): the workspace it was started in. Glue records
   `sessionId → workspace` when it launches, and keeps the record while the session is live (pruned like the spaces
   members).
2. **Its repository is in a workspace that uses its login**: that workspace. If several do, the login's **home**
   workspace if it is one of them, else the first in switch order.
3. **Its repository is in a workspace that doesn't use its login** (for example a private login working in a work
   repository): the login's home workspace, with the repository's data withheld. This is today's "mismatch" rule,
   unchanged.
4. **Its repository is unsorted, or it has none**: the login's home workspace, with today's inline question
   ("Remember chai-expense-tracker as Work?").
5. **Its login is in no workspace**: nowhere, only counted on the login in Settings › Providers.

A login's **home** is the first workspace, in switch order, that uses it. It moves when that workspace stops using it.
Glue picks it; there is no separate control. *(My call.)*

Once a session is shown in a workspace, it stays there while it lives, even if a repository is sorted later. Only a
new session follows the new rule. *(My call: the same as "no moving a running session between workspaces".)*

### Running things

Everything Glue starts for a session runs under **that session's login**, never the workspace's:

- reply, resume, slash commands, mode switch, answering questions and plans, stop, remove, the embedded terminal;
- the trust check and the trust terminal (trust is per profile in Claude Code);
- the worktree settings Claude Code reads from the profile's `settings.json`;
- the "your default" effort in New agent, read from the picked login's `settings.json`.

**New agent:** a **Login** select shows when the workspace has more than one Claude login, defaulting to its default.
The trust check follows the picked login. With one login it isn't shown.

**The overseer** of a workspace runs on that workspace's default Claude login (or on an OpenCode model, as today). Its
digest reads only that workspace's sessions, whatever logins they run on.

**The PR watcher** messages a session through the session's own login, as today through `reply`.

### Sign-in and live updates, per login

- Sign-in state (`claude auth status`), the account, and hooks (live updates) are per login, read as today but per
  login rather than per workspace.
- **The signed-out banner** shows when a Claude login the active workspace uses is signed out, naming the login's
  label: "Personal Max is signed out." Its buttons sign that login in.
- **The live updates banner and Settings › Live updates**: per login, for the logins the active workspace uses.
- **First run**: Glue needs the active workspace's default Claude login signed in, with live updates on.

### What the page sees (the seal)

- The snapshot's `profile` (one profile's info) becomes `logins`: the logins the **active** workspace uses, each with
  `{ id, label, provider, isDefault, signedIn, connected, effort, account? }`. A login's account (email, plan) shows
  only to a page whose active workspace uses it, as the account is shown for the focus only today.
- **Settings › Providers** lists every login with its label, its sign-in state and which workspaces use it. Its email
  shows only when the workspace in view uses it, or no workspace does (it was just found or just added). *(My call.)*
- For other workspaces, the snapshot still carries only `{ id, name, color, waiting }`.

### Settings › Providers

- **Claude**: one block per Claude login: its label (editable), account, sign-in (**Sign in here**, **In Terminal…**,
  **Copy command**), live updates, "Used by: Work, Private" (chips; attach and detach here too), and Remove. Then **Add
  a Claude login**. The in-Settings sign-in terminal from the Providers branch is kept.
- **OpenAI**: Codex installed or not (**Install in Terminal…**), then one block per OpenAI login: its label, how it is
  signed in, sign in or out, "Used by", Remove. Then **Add an OpenAI login**. "Agents on Codex: coming next" stays.
- **OpenCode**: unchanged. One for the computer, shared by every workspace.

### Upgrading (from `workspaces.json` v1)

On first start after the upgrade:

- Every workspace keeps its id, name, colour, order, repositories, spaces and focus. Its id stays its overseer's key and
  file name (`overseer-<id>.json`), so overseer conversations carry over.
- Every profile folder that is a workspace today becomes a Claude login with the same id, labelled with the workspace's
  name. It is attached to that workspace, is its default, and has it as home.
- `~/.codex`, when it exists, becomes an OpenAI login, attached to the workspace whose login is the plain `~/.claude`
  (or the first workspace).
- `prefs.json`'s `profile` (the focus at start) is read once as the workspace id and then left alone. Focus already
  lives in `workspaces.json`.
- Nothing on disk outside Glue's own data folder is touched.

With one workspace and one login, the screen is the same as before the upgrade.

## Constraints from the code as it is

- **Discovery** (`listProfiles`, `syncWorkspaces`, `store.sync`, `FALLBACK`, `dropWorkspace` in `server.mjs`;
  `createStore`/`sync` in `workspaces.mjs`) is the one place workspaces come from today. It becomes "discover logins".
  Workspaces come only from the store.
- **The `W` record** (`{ id, profile, env, info, setup, roster… }`) splits in two:
  - a **login** record: profile/home dir, env, info, sign-in state, roster seeding and errors;
  - a **workspace** record: the logins it uses, overseer, watcher switch, spaces.
- The roster poll (`readRoster`, `pollAll`) runs **per Claude login** that some workspace uses (or that is unattached,
  for the count), not per workspace.
- **Session ownership** today is "the profile that lists it" (`setWs` in `readRoster`, `namesProfile`/`wsOfEvent` for
  hooks, `wsIdOfSession`, `transcriptFile`). Each session gains `s.login` (its login, from roster or transcript path),
  and `s.ws` is decided by the rule above.
- **Every `envOf(ws)` / `ws.profile` use** listed in the map (reply, background send, slash commands, mode, answers,
  stop/rm, terminal, trust, worktree settings, login, effort, version restart text) becomes the session's login, or the
  picked login for a launch.
- **The overseer** keys on `overseerId(ws().profile)`. It becomes the workspace id, the same value for every existing
  workspace, and `askModel` runs under the workspace's default Claude login.
- **Codex**: `codex.mjs`'s `codexHome(ws)` is keyed by the workspace today (Providers branch). It becomes keyed by the
  OpenAI login.
- **The unmerged Providers branch** (`worktree-luminous-wibbling-crown`): its in-Settings sign-in terminal
  (`spawnTerm`, `loginTermOpen`) and Codex routes are kept, keyed by login instead of workspace. Its "Add a Claude
  account = new workspace" (`createProfile`) becomes "Add a Claude login".
- The **seal tests** in `test/workspaces-server.test.mjs` keep their meaning. Most fixtures build workspaces from
  `.claude-*` folders, and change to build them from `workspaces.json` with logins.

## Left to the builder

- The exact `workspaces.json` v2 shape, as long as it holds: workspaces (name, colour, order, per-provider logins and
  default), logins (provider, label, folder, home), repositories, spaces, focus, and launched sessions. Migration from
  v1 must be lossless and tested.
- How login and workspace state are structured in the server, as long as only `{ id, name, color, waiting }` of an
  inactive workspace leaves it.
- The look of the login chips and the Login select, within today's Settings and launcher style.
- How the poll is paced across several logins.
- Tests. At minimum:
  - a found profile folder adds a login, not a workspace;
  - a workspace with two Claude logins shows sessions from both rosters;
  - a shared login's sessions land by the rule (launched-in, then repository, then home);
  - a launch on a picked login runs under its env;
  - an unattached login's sessions are in no snapshot;
  - v1 → v2 migration keeps every id, name, colour, repository, space and overseer file.

## Next (its own design)

**Continue under another login.** When a Claude session hits its usage limit, Glue asks "Continue on Personal Max?",
listing the workspace's other Claude logins, beside today's "Continue in OpenCode". On yes it hands the work over by
full continuation: the transcript is copied into the other login's profile and resumed there with `claude --resume`.
A summary brief is the fallback if resuming across profiles fails. Glue never switches by itself. (Decided 2026-11-13,
parked until logins existed.)

## Calls made while building (from the review)

The user asked for no more questions, so these were settled by the builder:

1. **A removed login stays removed.** Its folder goes on a hidden list in `workspaces.json`, so discovery doesn't add
   it back. Settings › Providers says how many logins are hidden and offers **Show them again**. Adding a login for that
   folder on purpose takes it off the list.
2. **Detaching a login from a workspace never moves running sessions.** A session already shown there stays until it
   ends; new sessions follow the rule. The same applies when a login's home moves.
3. **A fresh install gets a workspace per profile found**, each with that profile attached as its Claude login (with
   no profile at all, one workspace on plain `~/.claude`). Only folders found *later* become logins in no workspace.
4. **Every session's placement is kept**, not only Glue-launched ones: `placed: { sessionId → { ws, at } }` in
   `workspaces.json`, dropped 14 days after the session was last seen live. A session no record knows (an old
   transcript) belongs to its login's home; one whose login is in no workspace is nobody's to touch.
5. **Discovery also finds `~/.codex-*` folders**, as OpenAI logins in no workspace.
