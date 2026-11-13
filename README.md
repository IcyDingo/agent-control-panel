# Agent panel

A local browser page that shows every Claude Code session on this machine and lets you answer
them without switching terminals.

## Get started

You need a Mac (macOS 14 or newer) with Node 20 or newer, and Claude Code 2.1.303 or newer.

```bash
git clone https://github.com/IcyDingo/agent-control-panel.git
cd agent-control-panel
./install.sh
```

`install.sh` checks for Node 20+ and Apple's Command Line Tools (`xcode-select --install`; Xcode
itself isn't needed), tells you what to install if something is missing, and builds **Agent
Panel.app** into `~/Applications`. Then:

1. Open **Agent Panel**. macOS may ask whether it may use your Documents folder: the panel reads the
   repositories your sessions work in.
2. If you use more than one Claude Code profile, pick yours under **Profile**, top right.
3. Follow **Set up the panel**, the checklist the panel opens with. Each step ticks itself as it's done:
   - **Sign in to Claude.** The panel has no login of its own: the overseer and new agents run on the
     profile's Claude Code login. **Sign in in Terminal…** opens Terminal running `claude auth login` on that
     profile (or copy the command).
   - **Connect this profile.** It adds the panel's hooks to that profile's `settings.json` (and keeps a copy of
     the old file). Sessions you start after that show up on the board; one already running keeps asking in its
     terminal until it restarts.
   - **Start your first agent**, with **New agent** or `claude` in any terminal.
   - Optional: **GitHub** (`gh auth login`, again in Terminal; the panel stores no token) and **Desktop alerts**.

   **Done** (or **Hide for now**) puts it away, remembered in `prefs.json`; **Setup** in the overseer's header
   brings it back.
   Later on, a lapsed login shows by itself. Signed out of Claude, an amber banner says so with **Sign in in
   Terminal…** and **Copy command**, and goes once you're back in. A signed-out profile's tab gets a red dot
   (amber still means not connected). With `gh` signed out, the GitHub button turns amber and its panel has the same
   Terminal sign-in. The panel looks every few minutes while a page is open, when you come back to its window, and
   at once when the overseer, a launch or a reply fails with a login error.
4. The first **Done** starts a short tour: the rail, **Answering here**, **New agent**, the overseer, GitHub and the
   keys, one at a time (→ or Enter next, ← back, Esc ends it). **Take the tour** under the checklist runs it again.

`install.sh` also installs a background service, so the panel keeps holding requests and answering hooks when the app
isn't open; `./install.sh --no-daemon` skips it.

Keep the folder where you cloned it: the service and the app run the panel from there. To update, `git pull`
and run `./install.sh` again: it rebuilds the app and restarts the service on the new code. To use it without the app,
see [Run it](#run-it). To take it out again, see [Uninstall](#uninstall).

Everything stays on your Mac: the server listens on 127.0.0.1 only, and the page fetches nothing but its typeface
(from Google Fonts).

**The board** stacks four queues in a rail on the left: **Needs you**, **Working**, **Idle** and
**Finished**. Needs you is always open. Click any other queue's header to fold it to one line, which
keeps its count and the name of its newest session; the panel remembers what you folded, and starts
with Idle and Finished folded. Drag the rail's right edge to widen it (double-click for the default).
Each session is one row: its state square, its name, what it is doing (the tool it runs, or what it asks
for: `Bash`, `Asks`, `Plan`, with `sub:` in front when a subagent is asking) and its age. Hover a row for its
branch, folder and the full text; hover its right end for Interrupt, End or Remove. A session with
subagents gets a chevron, and while one of them runs or waits its tree is open under the row: each
subagent with its own square, title and age, `asks you` in amber when a request waits on it, and
`done` when it has finished. The tree folds by itself 20 seconds after the last one finishes; the chevron
(or → and ←) wins until a new subagent starts. Click a subagent row to open its session with that
subagent marked in the details.

The keys move you: ↑ and ↓ step through the rows and open each session as they go (into an open tree
too), → and ← unfold and fold the selected session's subagents, `n` jumps to the next session that
needs you, and `/` opens a find field that filters the rows by name (Esc clears it). None of them fire
while you type. Click a row to open its panel in the rest of the window. The
panel reads like a chat: one line on top with its name, state, kind, mode and age (Expand and Close
are the two icons at its right), the conversation in the middle, and what it's asking and the box to
write in pinned along the bottom. The box carries one chip for its mode, model and effort; click it to
change any of them. What the box will do is the Send button's tooltip. The chat keeps
to reading width on a big screen. Its details sit in a column on the right: its folder and branch, the
command that reopens it, its subagents (each titled with the task its parent gave it) and the buttons that
stop it. The column's **Details** tab folds it to a strip, and dragging its left edge widens it (double-click
for the default). On a narrow panel the same details sit under the conversation. **Expand** gives the panel
the whole window (**Collapse** brings the board back). When the open session goes away, the top of Needs you takes its place;
close it yourself and the space offers that one instead. On a narrow window the rail takes the width
and an open session covers it.

Each row's tooltip names the session's **branch**: which branch, in a repository's main checkout or in a
worktree. The panel says which worktree of which repository, and
names the other live sessions in the same checkout, since they share its branch and files (one that
switches the branch switches it for all of them). Where a session works comes from its transcript, so it
follows a session that moves into a worktree after it starts, which `claude agents` doesn't (it keeps the
folder the session started in). When a session edits files in other checkouts, its panel lists those too
("Also edits files in agent-control-panel (main)"). Branches are read from the files under `.git`, never
by running git.

When a session or subagent asks for something, the request appears in its panel:

- **Permission:** allow it, edit the command first, allow and remember, or deny with a reason.
- **Question** (`AskUserQuestion`): pick an option per question, or type your own answer.
- **Plan** (`ExitPlanMode`): read the plan, then approve it (in auto mode, or asking before edits)
  or send it back with what to change.

**New agent** launches a background session (`claude --bg`) with a prompt, folder, name, agent type,
model and permission mode (rows of buttons), and effort (a slider; **Default** leaves it to your profile's
own default). The folder can be any folder: **Choose…** opens the Mac's folder
dialog, and typing a path suggests the folders under it. A folder Claude Code hasn't been trusted in
yet needs `claude` run there once first, to accept its trust prompt.

**Its own worktree** launches it with `claude --worktree`: Claude Code makes
`.claude/worktrees/<name>` on a new branch `worktree-<name>`, starting from the remote's default
branch (`origin/main`, say), or from the current commit when the repo sets
`worktree.baseRef: "head"`. The name follows the agent's name unless you type one; left blank,
Claude picks one. The launcher says where it will land before you launch. The switch is off for a
folder outside git. For the first few seconds the session is still in the folder you picked, while
Claude Code fetches and makes the worktree. Removing the session later removes its worktree too,
unless the worktree holds work.

The panel is dark unless you pick otherwise: the moon button, top right, offers **Dark**, **Light** or **Match
the Mac**, remembered in that browser (or the app).

It fills the gaps in `claude agents` (agent view): agent view can't answer a permission prompt
without attaching, it doesn't list sessions in other terminals until you `/bg` them, and it gives
subagents no rows of their own.

## Run it

```bash
node server.mjs            # or: npm start
open http://127.0.0.1:4747
```

Node 20+, and `python3` (it comes with macOS's command-line tools) for the helpers that work a background
session's screen: switching its mode, answering a question it no longer holds, running a `/command`. Nothing to
install. `ACP_PORT` changes the port; if you change it, change the hook URLs too.

Installed with `./install.sh`, the panel also runs as a launchd service (`local.agent-panel`, or
`local.agent-panel.<port>` on another port): `launchctl print gui/$UID/local.agent-panel` shows it,
`launchctl kickstart -k gui/$UID/local.agent-panel` restarts it, and its log is
`~/Library/Logs/Agent Panel/daemon-<port>.log`. `node server.mjs daemon install|remove|status` manages it.

## The Mac app

`app/build.sh` builds **Agent Panel.app** in `~/Applications`: the panel in a window of its own, with
its own icon. Open it like any app, or keep it in the Dock.

- Opening it uses the background service's server, or any panel server already running, or starts one of its own
  (its log is `~/Library/Logs/Agent Panel/server-4747.log`). Quitting stops a server the app started and leaves
  one it didn't alone.
- If the server it was using goes away, it starts its own after a few seconds. One it started that
  stops after running a while is started again.
- The Dock icon counts the requests waiting on you, and bounces when a new one arrives while you're
  in another app. Closing the window keeps the panel connected: the count stays live and requests are
  still held. Click the Dock icon to bring the window back; ⌘Q quits.
- the bell (**Turn on desktop alerts**) gives you the Mac's own notifications. Clicking one opens that session.
- The title bar follows the panel's theme.
- **File › New Agent** (⌘T) opens the launcher, and the **New agent** button shows the shortcut. In a
  browser ⌘T opens a new tab, so there the button shows none.
- Links to other sites open in your browser. ⌘R reloads, and starts a server if none answers;
  ⌘= / ⌘- / ⌘0 zoom.

An app opened from the Dock gets no shell environment, so the build bakes in this folder's path,
node's path and your shell's `PATH`. Build it again when one of those moves (an nvm upgrade, say).
`ACP_PORT=<port> app/build.sh` builds a separate app for a panel on another port.

The first time it starts the server, macOS asks whether Agent Panel may use your Documents folder: the
panel lives there, and it reads the sessions' repositories. The app is signed for this Mac only, so a
rebuilt app may ask again.

## Profiles

Each Claude Code profile is a config folder: `~/.claude` for plain `claude`, `~/.claude-<name>` for
one started with `CLAUDE_CONFIG_DIR=~/.claude-<name>`. The panel shows one profile at a time.
The header shows them as tabs by folder name (`claude`, `claude-work`); a tab's tooltip gives its
account and plan from `claude auth status`, and a dot marks one whose hooks don't point at the panel.
Click a tab to switch. With one profile, there are no tabs.

- Switching swaps the board to that profile's sessions, and new agents launch in it.
- A request held for the old profile's sessions stays held, out of sight, and shows again when that
  profile is back; a permission request from a profile that isn't on the board is held the same way.
  An unsent message is dropped. When there is one, it asks first.
- The choice is remembered, in `~/Library/Application Support/Agent Panel/prefs.json` (`ACP_PREFS`
  names another file, so a second panel on another port keeps a choice of its own). Without one,
  the panel starts in the profile it was started under (`CLAUDE_CONFIG_DIR`), else the first one whose
  hooks point at it, else plain `claude`'s.

A profile's sessions report here only once its settings have the hooks. When a profile doesn't have
them, the panel shows **Connect this profile**. Clicking it adds the entries from
`hooks.example.json` that the profile's `settings.json` lacks. It changes nothing else in the file,
and keeps a dated copy of the old file beside it. Requests from a profile the panel isn't showing are
left to their terminals.

## The rail

Needs you comes first. Below it, every other live session sits under the repository it works in, in
name order so the sections hold still while agents work: the header names the repository (its folder
is in the tooltip) and, when one checkout of it is in use, that checkout and its branch. With two or more
checkouts in use (the main one and worktrees), a quiet label heads each checkout's sessions. Sessions
outside any repository are under Other folders, and ended ones under Finished. A session under Needs
you names its repository on its row. The open session's header shows its repository, checkout and
branch as chips, its folder beneath (a click copies it), and its pull request when it has one.

## GitHub

The panel watches the GitHub repositories agents work in, through your own `gh` CLI. It stores no
token: when `gh` is missing or signed out, it says so once and shows nothing else.

- A repository is found from `origin` in its git config (github.com only); the panel never runs git
  in it, and calls `gh` with `-R github.com/<owner>/<repo>` from its own folder.
- It watches open pull requests on the branches agents are on, and every open pull request of yours in
  any repository (one `gh search prs --author @me` every few minutes), the latest runs on the default
  branch, and the last few merges.
- **GitHub** in the top bar opens a panel on the right listing them, each with its state in its colour:
  failing, stuck (checks running over 30 minutes), running, ready or passing, open, draft, and merged
  in the last day. Its count and colour say the worst of them; it stays open until you close it. A repository section gets a CI pill, a session row a dot
  for its PR's checks, and Details a Pull request block with the checks, the failing ones by name,
  whether it can merge, and its review state.
- It polls each repository every minute while a page is open, every 20 seconds while something
  runs, and every 5 minutes with no page (1 minute while something runs). Errors back off to 15
  minutes. At most six repositories, the most recently active first.
- A failure notifies once, as a macOS notification, so it reaches you with no page open: a PR's
  checks failing at a new commit, or a run on the default branch failing. After a restart it won't
  repeat one, and only failures from the last 15 minutes notify.
- **Send the failing log to** _the session_ fetches the failing steps' log, trims it, and shows the
  exact message before it goes, through the same path as a reply typed here.
- `ACP_GITHUB=off` turns it off.

## The PR watcher

It sees each pull request on an agent's branch through to merging. When one **fails its checks**, **conflicts
with its base**, gets **changes requested**, or has **checks stuck** running over 30 minutes, it tells the agent
on that branch to fix it and push again: the failing steps' log, or what to do about the conflict, the review or
the stuck run.

- A background session is told at once, through the same path as a reply typed here. A terminal session Claude
  Code lists gets a card in the overseer to confirm, since a message closes Claude in its terminal. One the panel
  knows only from its hooks can't be messaged: you get a notification saying whom to tell.
- Each problem is asked about once per commit (a changes-requested review once, until it changes), at most three
  fixes per pull request; after that you are told it is over to you. A message that doesn't go through is tried
  again five minutes later.
- Every fix asked shows in the overseer's feed and as a macOS notification, and the GitHub panel marks the pull
  request with how many fixes were asked (`fix 1/3`).
- **Auto-fix** in the GitHub panel turns it off and on. What it asked is kept in `watcher.json` beside `prefs.json`,
  so a restart never asks twice.

## The overseer

With no session open, the panel shows the overseer: one chat that knows every session on the board.
Ask what needs you, what everyone is doing, or what is failing, or say what you want done.

- Each message is one headless `claude -p` call on the profile's own Claude Code login, with no
  tools, from an empty folder of its own. It reads a digest of the board: each session's state,
  repository, branch, current tool, what it asks you, its subagents, what it last said, its pull
  request and checks, plus the folders a new session may start in and the feed of what happened. It
  may ask to read a session's recent conversation, twice at most per answer.
- It only proposes. A proposal (tell a session something, start one in a known folder, interrupt
  one) shows as a card with its target and exact words, which you can change, and runs only when you
  click it. It can't answer permission requests or approve plans, pick a model or a permission mode,
  or send a message that starts with `/` or `!`. A card says when sending would restart a session
  (for a terminal session, that closes Claude in its terminal). Proposals expire after an hour.
- Its model is Sonnet unless you pick another under its box. Its conversation and feed are kept per
  profile, in `overseer.json` beside `prefs.json`.
- **What leaves the Mac:** the digest and the excerpts it reads go to the profile's own Claude
  account, as any Claude Code session's prompts do. Nothing goes anywhere else.

## Wire the hooks (once)

Click **Connect this profile** in the panel, or merge `hooks.example.json` into your user settings
yourself (`~/.claude/settings.json`, or `$CLAUDE_CONFIG_DIR/settings.json`). Sessions started after
that report to the panel; one that
was already running keeps asking in its terminal until you restart it. To try it
without touching your settings, run a single session with the hooks:
`claude --settings hooks.example.json`.

## How decisions work

- A permission request appears here **and** in the session's terminal at the same time.
  Whichever answers first wins.
- The panel holds a request only while a panel tab is open and **Answering here** is on.
  Otherwise it answers nothing and the terminal decides as usual. A reload (yours, or the app's when
  its health check is slow) isn't a closed tab: held requests wait 15 seconds for a page to come back.
- If the server isn't running, the hooks fail silently and Claude Code behaves as if they weren't there.
- **Allow edited command** sends your edit as the tool's input. **Edit full input** does the same
  for any tool, as JSON.
- **Allow and remember** saves the rules Claude Code itself suggested for that request (the same
  rules as the terminal's "don't ask again" option), never rules typed in the browser.
- A question is answered by sending its answers back as the tool's input. A plan is approved by
  sending the plan back as input, plus the mode to carry on in: a bare allow leaves the terminal's
  plan dialog open. Sending a plan back is a deny, with your feedback as the message.
- If the server restarts, an open tab reloads itself once the server is back: each start mints a new token.

When the terminal answers first, Claude Code leaves the panel's request open. The panel retires
the card when the tool's `PostToolUse` arrives, when Claude Code closes the request (a cancel), or,
for main-agent requests, when the session list shows the session is no longer waiting.

## A question or plan it no longer holds

A held request goes back to the session after an hour, or when the panel server restarts. For a terminal session that
is fine: its dialog is on your screen. A background session has no screen of yours, so the panel still shows its open
**question** (`AskUserQuestion`), read from its transcript, with the same card. **Send answers** puts them in on its
own screen the way you would: `answer-question.py` attaches in a pseudo-terminal, checks that question is what it
shows, presses each answer's number (or "Type something", your words, Enter) and submits. The panel then checks
that its conversation got exactly the answers you picked.

An open **plan** (`ExitPlanMode`) gets its usual card too. **Approve** and **Send back** go in on its screen through
`answer-plan.py`: it finds the choice by its words (they vary: "Yes, and use auto mode", "Yes, manually approve
edits", "Tell Claude what to change", or "Yes, and switch to default" without a plan file), presses it only while
`claude agents` says the session waits on a permission prompt and its transcript's open call is that plan, and types
your feedback after "Tell Claude what to change". The panel then checks its conversation says approved, or carries
your words.

- Questions and plans only. A permission prompt it no longer holds is shown, with `claude attach <id>` to answer it
  there: pressing Yes on a permission prompt from outside would go around Claude Code's permission system. A plan's
  choices are the ones its held card offers anyway.
- A question that takes several picks at once isn't pressed from here either.
- The question has to be in the transcript, and Claude Code writes it there before a `PreToolUse` hook runs, so this
  works for the sessions that report to the panel.

## Messaging a session

Every session's panel has a **Chat**, with a message box along its bottom that shows the session's
mode and has **Send**. The Chat follows the session's transcript as it is written: what you typed,
each piece Claude writes, every tool it calls with its state and how long it took, and a short look at
what the tool returned (click the tool's line to unfold it). A new line is on screen within a fraction
of a second of Claude Code writing it. Thinking and a tool's full output stay in the terminal. **Show
earlier** reads further back, and a compacted stretch shows as a note. It opens at the newest message
and keeps it in view as more arrive, unless you scrolled up to read. When its last reply ends with a
numbered or lettered list, each option shows as a chip that fills the box; add to it if you like.

**Terminal** (beside **Chat**, for a background session Claude Code still lists) shows the session's own
Claude Code screen: the panel runs `claude attach` in a pseudo-terminal (`pty-bridge.py`, Python's standard
library) and draws it with xterm.js (vendored in `public/vendor/xterm`, MIT). Type into it as in a terminal:
Esc, Shift+Tab, slash commands and its menus all work, and the session keeps running when you go back to
**Chat**, switch session or close the panel. One terminal per session is shared by the pages that open it,
and it lets go 15 seconds after the last one leaves. A session running in a terminal window of its own
doesn't open here: macOS lets no other program type into it.

**Enter** sends at once: the message leaves the box and shows in the chat as sending. If it doesn't
go through, it goes back into the box (ahead of anything you typed since) and the panel says why.
Shift+Enter starts a new line.
How a message gets in depends on the kind of session, because only Claude Code's own ways in count
as you: text a hook hands back reaches the model as hook output, and it rightly won't take
instructions from that.

**A background session** gets it straight away, working or not, the way agent view's reply does:
`claude --resume <session id> -- <message>` (without `--bg`) hands it to the running job as your
next message, then attaches. The panel runs that under `script` for a terminal, waits until the
message is in the transcript, and closes the client. The session isn't stopped or restarted. While
it works, the message arrives at its next step as "The user sent a new message while you were
working", exactly as if you'd typed it. A `/command` goes in another way (see Slash commands), and a
message that starts with `!` (a shell command) isn't sent from here.

**A background session that has stopped** (ended, finished and closed, or blocked) but is still listed
wakes up with your message: `claude --bg --resume <session id> -- <message>`, with no other flags,
starts the same job again under the same id, with the options it started with (name, model, effort,
mode) and in the same folder or worktree, unpushed work included. Nothing is removed first.

**A terminal session** has no way in from outside its terminal. So:

- **While it works**, the panel holds your message (**Send when it is done** asks twice). When its
  turn is over, with no subagent running and nothing waiting on you, the panel closes it and carries
  on as below. You can take a held message back, or type in its terminal instead.
- **At its prompt, or closed**, a reply restarts the conversation with your words as a real prompt:
  the panel sends SIGTERM (Claude closes cleanly), then
  `claude --bg --resume <session id> --name <name> -- <your reply>` carries the same conversation on
  in the background with the model, effort and mode it last used, or the ones you pick beside **Send**.
  `claude attach` opens it again.

Also:

- A session that hasn't saved a conversation yet (a terminal opened but never prompted) is
  refused before anything is closed: there would be nothing to resume.
- `claude agents` reports a session as busy for as long as a background task it started (a dev
  server, a watch) runs, even when its turn is over and it waits at its prompt. The panel reads the
  end of its transcript to tell the two apart, so such a session shows as idle. Closing it stops
  that task, and the panel says so before you confirm.
- What a session last said comes from its `Stop` hook, or from its transcript for a session that
  finished its turn before the panel started.
- A background session that is no longer listed starts again with `claude --bg --resume` and the
  name, model, effort and mode it last ran with.
- The session the panel server runs in takes no messages or End from here: closing it would stop the panel.

## Permission mode

A session's panel shows its permission mode (ask for each tool, accept file edits, plan, auto),
from its hook events or, after a panel restart, its transcript. Claude Code only changes a running
session's mode from its own screen (Shift+Tab) or with a permission answer, so:

- **A background session switches when you pick a mode** in the chat bar. `mode-switch.py`
  attaches to it in a pseudo-terminal (`claude attach`) and presses Shift+Tab until its footer shows
  that mode, in one burst so it doesn't sit in the modes in between, then closes. Not while it waits
  on you: Shift+Tab in an open dialog would answer it.
- **A terminal session** is on your screen, so Shift+Tab there. From the panel, the mode you pick in
  the chat bar is the one it carries on in once your message restarts it in the background.
- A main-agent permission request has a mode picker beside **Allow**: the allow also switches the
  session to it, the way an approved plan does (`setMode` for the session).

Bypass permissions is shown if a session is in it, but never offered, and a session whose Shift+Tab
cycle includes it isn't switched from here. The mode a session restarts in comes from your pick or
its transcript, never from a hook event: hooks carry no token.

## Model and effort

The chat bar also shows the model a session's replies run on (Opus 5.5 (1M), Sonnet 5.5, ...) and its effort level,
from the newest reply in its transcript. Pick another and it takes effect with your next message, which restarts the
session on it: Claude Code changes either for a running session only at its own prompt, and `/model` and `/effort`
there also make your pick the default for every new session. A restart (`claude --bg --resume ... --model --effort`)
changes this session alone.

- **A background session** restarts for it: **Restart and send** stops it if it is running, removes its job record
  (`claude rm`; the conversation stays), then resumes the same conversation under the same id with your message. While
  it works, the message waits until it is done. The record has to go because Claude Code resumes a listed job with the
  options it started with, and with any others starts a copy under a new id. One that works in its own worktree is
  not removed (that would take the worktree with it): it carries on as that copy, started from inside its worktree, so
  the same conversation goes on there under a new id, and the panel opens it. The old record stays on the board as
  ended and keeps the worktree; Claude Code refuses to remove it while the copy works there.
- **A terminal session** restarts with your message anyway, now on what you picked.
- A restart without a pick keeps what it ran on, `[1m]` included: the model is read as Claude Code asked for it
  (`requestedModel`), since the name a reply carries drops the 1M context.

The launcher has the same choices (**Model**, **Effort**) for a new agent.

## Slash commands

A message that starts with `/` is a command, run the way you would at the session's own prompt (`/remote-control` or
`/rc`, `/compact`, `/context`, a skill or a command of your own):

- **A background session that is running** takes no `/command` from outside (`claude --resume` refuses one), so
  `slash-command.py` types it at its prompt through `claude attach`, the way you would. It types only when Claude
  Code says the session is idle with nothing open and its screen shows an empty prompt. The command goes in with a
  space after its name, which closes the command list (Enter there would run whichever entry is highlighted). Then a
  fresh look at the screen must show exactly that command on the prompt line, nothing new above it, and the session
  still idle; only then does it press Enter, and otherwise it takes what it typed back off with Backspace. What the
  command printed shows in the chat. While the session works, the command waits until it is done (**Run when it is
  done**).
- **Any other session** gets it as the prompt it restarts with, as for a message.
- Refused here: a command that only opens a view or a menu on its screen (`/usage`, `/status`, `/config` without
  arguments, ...), which nobody would see in the background, and `/model` and `/effort` (use the menus). A command
  that opens a dialog anyway leaves the session waiting on it: the chat says so, and `claude attach` shows it.
- The first `/remote-control` ever asks once to confirm on the session's screen. Accept it there (`claude attach`) or
  in any terminal session; after that it connects without asking.

## Stopping and clearing sessions

Every control that stops something asks for a second click.

- **Interrupt** (a working session, or a single subagent in the panel): it stops at its next tool
  call, like pressing Esc. A session stays open for your next prompt; a subagent's session carries
  on without it. The panel refuses that next tool call through `PreToolUse`, and refuses a request
  that is waiting on you. A batch of tool calls already running still finishes.
- **End** (an idle session): `claude stop` for a background session; a terminal session gets
  SIGTERM, and Claude closes cleanly. The conversation is kept either way.
- **Remove** (a finished background session): `claude rm`. The transcript is kept. If its
  worktree has unpushed or uncommitted work, Claude Code refuses and it stays; the panel never
  forces it. A finished terminal session can only be **hidden** from the board.
- The queue headers have bulk versions: **Interrupt all** working sessions, **End idle**
  background sessions (terminal sessions are left alone, in case you're typing in one), and
  **Clear** finished ones.

## Sessions on a deleted version

Claude Code's updater deletes old versions while sessions still run them. Once the version a session runs is gone,
macOS can no longer name the program behind it when it checks a protected folder, so at its next check it refuses that
session, and everything it starts, `~/Documents`, `~/Desktop` and cloud folders ("Operation not permitted"). Granting
Full Disk Access doesn't help. A restart on the installed version does.

Every minute the panel checks each running session, in every profile, and the processes it was started from
(`versions.mjs`: one `ps` and one `lsof`, comparing each program file with what is on disk now).

- **A banner** over the board counts them, other profiles' sessions too: the one that loses access is often not the
  one on screen. **Show which** unfolds the list with each one's restart command; **×** puts the banner away until the
  list changes. A **toast** says when it finds a new one.
- **Its row** carries a small amber mark before its age, and **its panel** says why and how.
- **To restart**: a terminal session quits in its terminal and resumes with the command the panel gives you to copy.
  A background job is ended in the panel, then sent a message, and comes back on the installed version.

## Security

An endpoint that approves commands is worth protecting, even on localhost:

- It listens on `127.0.0.1` only and refuses any other `Host` header, which blocks DNS rebinding.
- Browser calls need a random token minted at each start, plus a same-origin `Origin`. That
  blocks other tabs from posting decisions.
- Hook endpoints refuse anything that carries an `Origin` header, so a web page can't inject fake requests.
- Hook endpoints take no token, so any program on this Mac can post them a made-up event. That changes only what the
  panel shows: every action checks Claude Code's own records again first (`claude agents`, the session's transcript),
  and a made-up permission request, if you answer it, answers only the program that sent it. A program running as you
  can already do anything you can; a shared key would have to sit in your Claude Code settings file, which other
  accounts on the Mac can usually read, so it wouldn't keep them out either.
- Nothing a request carries can stop the server: the `Host` is checked before anything else, and an error in one
  request ends that request alone.
- Launch, messages, mode switches, folder suggestions, the folder dialog, interrupt, end and remove
  take the same token and Origin. They run `claude`
  through argv with no shell, and check every value first: the folder must exist, the model and
  permission mode come from a fixed list (no bypass-permissions), and names and agent types have
  a fixed character set.
- The embedded terminal takes the same token and Origin for every keystroke, opens only for a background
  session Claude Code lists, and only a page that opened it can type into it. Its library is served from
  three fixed paths.
- Ending a terminal session signals only a pid read fresh from `claude agents`, only when that
  process is still `claude`, and never the session the panel server itself runs in.
- `claude` is started without the `CLAUDE*` variables of the session that started the server
  (except `CLAUDE_CONFIG_DIR`), so a launched session doesn't take itself for a child of it.
- What agents, CI and GitHub wrote reaches the overseer as reported data inside tags it is told never
  to take as instructions, with `<` and `>` taken out; what it proposes still needs your click, and
  the server checks every proposal again when you click (the session is live, the folder is one it
  knows and this profile trusts, the text is not a command).
- A remote URL can carry a token: the panel keeps only the owner and repository name it parsed.
## Uninstall

Run `./install.sh --uninstall` from the clone: it removes the background service and `~/Applications/Agent Panel.app`.
Then remove the hook entries that point at `127.0.0.1:4747` from each profile's settings, and delete
`~/Library/Application Support/Agent Panel` and `~/Library/Logs/Agent Panel`.
