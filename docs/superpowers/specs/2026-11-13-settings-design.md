# Settings: one place for every workspace and for Glue itself

Date: 2026-11-13. Status: design, for review. It comes before the Codex project (project 2 of the orchestrator road in
`2026-11-13-workspaces-design.md`) so that Codex and OpenRouter have a home when they arrive.

## Why

Workspaces landed, but their settings are scattered:
- the setup checklist, reached through a small **Setup** link that shows only when no session is open, and that shows
  only the workspace you're in;
- the Connect banner;
- the sign-in banner;
- the theme menu;
- the **Answering here** switch;
- the bell for alerts;
- Auto-fix inside the GitHub panel;
- the overseer's model under its composer.

The user asked "where do I set my profile, rename the spaces, see all, connect provider". There should be one place to
see and change all of it, for every workspace and for Glue as a whole, and it is where providers will go next.

## Goals

1. One **Settings** dialog holds every setting. Nothing that is a setting lives only somewhere else.
2. From either workspace you can see and act on both workspaces' identity and connection (names, colours, order,
   sign-in, Connect), without switching.
3. Glue-wide settings get a home: look, answering and alerts, agent defaults, maintenance, and where every repository
   belongs.
4. First run uses Settings instead of a separate checklist.

## Non-goals

- Building Codex or OpenRouter support. The Providers tab only reserves their place.
- Changing how workspaces are sealed outside Settings.
- A settings file format the user edits by hand.

## Anti-goals (this fails even if it works)

- **Anything from Settings' exceptions showing outside Settings.** The board, GitHub panel, overseer, notifications,
  title and badge stay exactly as sealed as today.
- **Account emails, sessions, PR titles or conversations of another workspace showing anywhere, Settings included.**
- A dialog so dense that the two things a new user must do (sign in, Connect) are hard to find.

## What the user decided

- **Placement:** a dialog, not a page or side panel.
- **Other workspace:** its name and colour are editable from either workspace. This replaces the earlier rule that
  only the workspace you're in can be renamed.
- **Acting on the other workspace:** Sign in and Connect are allowed for the workspace you're not in, without
  switching.
- **Sections:** Workspaces; Logins & connection; GitHub, alerts & Auto-fix; Providers (placeholder); and a **Glue**
  tab for app-wide settings. The Glue tab holds Look & keys, Answering & alerts, Agent defaults, About & maintenance,
  and **which repositories go where**.
- **First run:** Settings opens itself. The overseer-page checklist goes away, and the tour stays.
- **The seal exception:** Settings may show every repository's name and its workspace(s), and both workspaces'
  names, colours, order and signed-in/connected status. **These exceptions apply inside Settings only, nowhere
  else.**

## How it behaves

### Opening it

- **Where it opens from:**
  - a ⚙ button in the top bar, next to the theme button;
  - **⌘,** in the Mac app (a new **Glue › Settings…** menu item);
  - **,** in the browser when focus isn't in a text field. *(My call; the browser keeps ⌘, for itself.)*
- **The dialog:** centred and about 760 px wide, with tabs down its left side and the content on the right. Esc or ✕
  closes it. It uses the page's `<dialog>` pattern (as the New agent launcher does). It remembers the last tab within
  the page.
- **Removed:** the **Setup** link in the overseer header and the overseer-page checklist (`setupRows` /
  `renderSetup`).
- **Kept outside the dialog:**
  - the amber sign-in banner and the Connect banner (now with an **Open Settings** link);
  - the workspace switch, the Work/Private questions on session rows and in New agent, and the GitHub panel's
    **Sort** line;
  - the tour.

### Tab: Workspaces

- **Rows:** one row per workspace, in switch order. Each row has:
  - **name**: inline edit, 1–24 characters, unique;
  - **colour**: five swatches;
  - **order**: up/down buttons, which set ⌃1…⌃9.

  Every row is editable from either workspace (the user's decision). The row of the workspace you're in is marked
  "you're here".
- **Below the rows:** "Repositories in *<this workspace>*", with Move (Work / Private / Both) and Forget, and the
  "N repositories aren't in a workspace yet · Sort" line. This is today's checklist content, moved here.
- **With one workspace:** a single row (name and colour only, no order), plus a note that a second Claude Code profile
  (`~/.claude-<name>`) becomes a second workspace.

### Tab: Logins & connection

- **Blocks:** one block per workspace, in switch order.
- **Claude:** signed in ✓ or ✗.
  - For the workspace you're in, it also shows the account email and plan, as the old checklist did.
  - For the other one, only ✓ or ✗ (no email).
  - **Sign in in Terminal…** and **Copy command** work for every workspace, each opening Terminal on that workspace's
    own profile (the user's decision).
- **Connected:** whether that profile's `settings.json` points its hooks at Glue, with **Connect** for every workspace
  (the user's decision). It writes that workspace's own hooks and keeps a dated copy, as today.
- **Codex:** a disabled "Codex: coming next" line in each block. It is a placeholder.

### Tab: GitHub, alerts & Auto-fix

- **GitHub CLI** sign-in, which is shared, as today: signed in as *login*, or **Sign in in Terminal…** / Copy
  `gh auth login`.
- **Auto-fix**, the PR watcher, for the workspace you're in. Today it is a switch in the GitHub panel. That switch
  stays, and both show the same state.
- **Overseer model** for the workspace you're in. It mirrors the select under the overseer's composer, which stays.

### Tab: Providers

A short explanation, then one row per provider:
- **Claude Code**: active, shown per workspace with its sign-in status from the Logins tab;
- **Codex**: "Coming next: run agents with OpenAI's Codex", disabled;
- **OpenRouter**: "Coming next: any model, through your OpenRouter key", disabled.

No behaviour yet. Projects 2 and 3 fill these rows in.

### Tab: Glue (app-wide)

These settings apply to every workspace and every page. They are stored on the server, in a new `glue` object in
`prefs.json`, so the Mac app and a browser tab agree. *(My call.)*

- **Look & keys**
  - Theme: Dark / Light / Match the Mac. Today this is per browser in `localStorage`. It moves to the server, and
    `localStorage` stays only as the pre-paint cache so the first frame has the right colours.
    - **Upgrade:** when the server has no value yet, the first page to connect seeds it from its own `localStorage`
      (theme and folded queues). After that the server wins.
    - **Changes:** a change from any page or the app applies to all of them, through the content-free nudge described
      under "The seal". *(My call.)*
  - Which rail queues start folded (Idle and Finished today).
  - A read-only list of the keyboard shortcuts: ↑ ↓ → ← n / ⌃1–9 , Esc, and ⌘T in the app.
- **Answering & alerts**
  - **Answering here**: on or off. This is today's top-bar switch. It moves into Settings, and the top bar keeps only
    the existing "Paused: the terminal answers everything" notice when it is off. *(My call: fewer controls in the top
    bar. The notice keeps the important state visible.)*
    - **Not persisted:** as today, it resets to on whenever the server starts, including after **Restart**. A paused
      Glue never stays paused silently. *(My call.)*
    - **The tour:** its stop that pointed at the switch now points at the ⚙ ("Settings: logins, workspaces,
      answering, alerts"). *(My call.)*
  - **Desktop alerts**: turn on, or a note that they are blocked in System Settings › Notifications. The bell button
    in the top bar goes away.
  - **Which events notify**: three toggles, all on by default: requests waiting on you, CI failures, and the PR
    watcher.
    - Both the page's alerts (`alertNew` / `alertWorkspace`) and the server's macOS notifications (`notifyIn`) respect
      the same toggles.
    - "Desktop alerts: turn on" is the page's notification permission, as today. The server's notifications are
      governed by the toggles alone.
    - Removing duplicates between the two paths is out of scope. *(My call.)*
  - **Count in the title and Dock**: on or off. Off drops the `(n) ` prefix from the window title. The app's Dock badge
    reads the title, so it clears too, and a browser tab's title loses the count as well. No new app channel is
    needed. *(My call.)*
- **Agent defaults**
  - The New agent launcher's starting values: model, effort, permission mode, and "its own worktree" on or off. Today
    they start from fixed values. The launcher still lets you change them per launch.
  - The overseer model a newly created workspace starts with.
- **About & maintenance**
  - The version: `package.json` version plus the git short commit of the running server.
  - The background service: running or not (`daemon.mjs status()`), with **Restart**, which runs `launchctl
    kickstart -k`. The page then reconnects by itself, as it does after any restart.
  - Where Glue keeps its files (`~/Library/Application Support/Glue`) and logs (`~/Library/Logs/Glue`), each with
    **Show in Finder**.
  - How to update (`git pull && ./install.sh`) and uninstall (`./install.sh --uninstall`), as copyable commands.
- **Repositories** (the seal exception)
  - Every repository Glue knows of, with its workspace(s): Work, Private, Both, or *unsorted*.
  - "Knows of" means any repository in `workspaces.json`, any repository a live session works in, and any repository
    the GitHub poller watches (including the "mine" search).
  - Each row shows the label (`owner/name`, or the folder name for `git:`/`dir:` keys) and its workspace pills, with
    **Move** and **Forget**.
  - **Forget** returns the repository to *unsorted*: it is dropped from every workspace it is in. Each workspace pill
    also has a small ×, which takes the repository out of just that workspace. A repository Glue knows only from a
    live session or the GitHub poller (not in `workspaces.json`) shows as *unsorted* with Move and no Forget, because
    there is nothing to forget. *(My call.)*
  - Inside Settings, Move and Forget act on **any** repository and **any** workspace. That includes taking a
    repository out of the workspace you're not in, and adding the one you're in to a repository only the other holds.
    This lifts the two page rules from the workspaces project (a page may only remove its own workspace; a page may
    not claim a repository held only by others) inside Settings only. *(My call. It follows from "exceptions only
    inside Settings", since this list exists to put repositories where they belong.)*

### First run

- **When it opens:** when setup isn't done (`setupDone` false), Settings opens by itself on the **Logins &
  connection** tab.
- **What's highlighted:** the two required steps for the workspace you're in: Claude sign-in and Connect.
- **Done:** a **Done** button at the bottom of the dialog (or "Skip for now") sets `setupDone`, closes the dialog and
  starts the tour, as the checklist's Done does today. Existing users who already finished setup are not interrupted.
- **Closing it otherwise:** Esc or ✕ while setup isn't done closes it for that page load only. It opens again on the
  next load, until Done or Skip.
- **Who sees it:** it opens in every page whose focused workspace still lacks Claude sign-in or Connect.
- **Already set up:** a user whose `setupDone` is false but whose focused workspace is signed in and connected is
  marked done silently, with no dialog. *(My call.)*
- **Optional steps** (GitHub, alerts, naming workspaces) are plain settings in their tabs, not steps.

### The seal: what Settings may show, and nothing more

Settings is the only place where the page receives data about a workspace it isn't focused on beyond `{ id, name,
color, waiting }`. It may receive exactly:
- for every workspace: `id`, `name`, `color`, `order`, `signedIn` (true, false or unknown), `connected` (true or
  false), and the command that signs it in (its `CLAUDE_CONFIG_DIR`, a folder path the user owns anyway);
- for every workspace, its own settings (added 2026-11-14 for Settings' workspace picker): `autofix` (on or off) and
  `overseerModel`. These are settings, not content;
- for every repository Glue knows: `key`, `label`, and the workspace ids it is in;
- for the workspace in focus only: the account email and plan (as today).

It never receives another workspace's sessions, session counts beyond `waiting`, account email, PR titles, branches,
conversations or feed.

**Delivery:** this data is fetched from a Settings-only route when the dialog opens (and refetched on change). It is
**never** added to the SSE snapshot, so nothing else on the page can render it by accident.

**Change notification:** when anything Settings shows changes, the server sends a **content-free** SSE event named
`settings`, with no payload. Changes include a rename, a reorder, a sign-in finishing in Terminal, Connect, a profile
appearing, a repository moving, and a Glue pref changing. A page with Settings open refetches. A page without it only
reapplies Glue prefs it uses (the theme, folded queues, the title count). There is no polling. *(My call. A nudge with
no data keeps the seal tests simple.)*

## Constraints from the code as it is

- **Routes to relax:**
  - `POST /api/workspace/update` refuses a non-focused id (Ruling 24 of the workspaces build). It must accept any
    workspace id now.
  - `/api/profile/connect` refuses a non-focused id. It must accept any.
  - `/api/setup/login` signs in the focused workspace. It needs a `ws` parameter for any workspace.
  - Relax each of these on purpose, and keep them refusing unknown ids.
  - *(2026-11-14, the workspace picker.)* `POST /api/settings/autofix { ws, on }` and
    `POST /api/settings/overseer-model { ws, model }` change any workspace's Auto-fix and overseer model. The page
    routes `/api/watcher/enabled` and `/api/overseer/model` stay on the page's own workspace.
- `/api/workspace/assign` enforces "remove only your own; don't claim others' repositories" for pages. Settings needs
  a separate route (e.g. `POST /api/settings/assign`) without those two rules. Keep the page route as it is, so the
  board's and GitHub panel's questions stay sealed.
- `workspaces.mjs` has `order` but no way to change it. It needs `reorder(ids)`.
- **Notifications:** today's macOS notifications go through `notifyIn` in `server.mjs`, and the page's own alerts are
  in `alertNew` / `alertWorkspace`. Both must check the new per-event toggles.
- **The launcher:** its defaults are hard-coded in `public/index.html` (the `l-model`, `l-effort`, `l-mode` inputs and
  the worktree switch). They read from `glue.agentDefaults` when the launcher opens.
- **The theme:** it lives in `localStorage` under `acp.theme`, and is applied before paint by the inline script at the
  top of `index.html`. Keep that script, seeded from the server value once it is known.
- **The Mac app** (`app/main.swift`) gets a **Settings…** menu item (⌘,). It tells the page to open the dialog, the
  same way **New Agent** (⌘T) dispatches `glue:new-agent`.
- **Daemon status and restart:** these run `launchctl` against `local.glue` (or `local.glue.<port>`), as `cli.mjs`
  does. A server started without the service (`--no-daemon`, or the app's own server) shows "not installed" and no
  Restart.

## Left to the builder

- The exact dialog layout and visual details, within "a centred dialog about 760 px wide, with tabs on the left".
  Follow the page's existing tokens and components.
- How Settings data is cached while the dialog is open, and when it is refetched.
- The storage shape of `glue` in `prefs.json`, as long as unknown keys are kept and bad values fall back to defaults.
- Tests:
  - Server tests that the Settings route returns other workspaces' names, colours, status and repositories but never
    their email, sessions or PRs.
  - That nothing in Settings' data appears in any SSE frame.
  - That the relaxed routes act on another workspace.
  - That the page routes stay sealed.
  - That the notification toggles silence their events.
