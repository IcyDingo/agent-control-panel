# Agent panel

A local browser page that shows every Claude Code session on this machine and lets you answer
them without switching terminals.

## Get started

You need a Mac (macOS 14 or newer) with Claude Code 2.1.303 or newer.

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
3. Click **Connect this profile**. It adds the panel's hooks to that profile's `settings.json` (and
   keeps a copy of the old file). Sessions you start after that show up on the board.

Keep the folder where you cloned it: the app runs the panel from there. To update, `git pull`, run
`./install.sh` again, then quit the app (⌘Q) and open it again. To use it without the app, see
[Run it](#run-it). To take it out again, see [Uninstall](#uninstall).

The panel stays on your Mac: its server listens on 127.0.0.1 only, and the page fetches nothing but
its typeface (from Google Fonts).

**The board** stacks four queues in a rail on the left: **Needs you**, **Working**, **Idle** and
**Finished**. Needs you is always open. Click any other queue's header to fold it to one line, which
keeps its count and the name of its newest session; the panel remembers what you folded, and starts
with Idle and Finished folded. Drag the rail's right edge to widen it (double-click for the default).
Each session is a tile with its name, how many subagents it's running, its age, and one line saying
what it's doing or what it last said. Click a tile to open its panel in the rest of the window. The
panel reads like a chat: its name and what you can do on top, the conversation in the middle, and
what it's asking, what it's doing now and the box to write in pinned along the bottom. The chat keeps
to reading width on a big screen. **Details** folds away its folder and branch, and **Expand** gives it
the whole window (**Collapse** brings the board back). Its subagents, each titled with the task its
parent gave it, get a column on the right when the panel is wide (its tab folds it to a strip) and sit
under the conversation when it isn't. When the open session goes away, the top of Needs you takes its place;
close it yourself and the space offers that one instead. On a narrow window the rail takes the width
and an open session covers it.

Each tile also shows the session's **branch**: a branch mark when it works in a repository's main
checkout, a folder mark when it is in a worktree. The panel says which worktree of which repository, and
names the other live sessions in the same checkout, since they share its branch and files (one that
switches the branch switches it for all of them). Where a session works comes from its transcript, so it
follows a session that moves into a worktree after it starts, which `claude agents` doesn't (it keeps the
folder the session started in). When a session edits files in other checkouts, its panel lists those too
("Also edits files in agent-control-panel (main)"). Branches are read from the files under `.git`, never
by running git.

**Space view** shows the same sessions full screen, as satellites orbiting you, each one a body in its
state's colour between two solar wings, flying along its orbit. Its orbit is its state: the inner
orbit needs you, then working, idle and finished. Background sessions carry a dish, subagents are
small satellites circling their session's, and a request shows as an amber tether to you. Click a satellite
for the same panel, click the centre to jump to the next request, and press Esc to go back.
**Earth**, bottom left, launches a new agent: a rocket lifts off and flies to a free slot on its
orbit, and the satellite appears where the rocket arrives and opens its wings. Its panel then opens,
unless you are typing in the open one. With reduced motion there is no flight: the satellite simply
appears.

**World**, next to Space view, is a world your agents' work builds (see World, below). Once it has
started, its button shows the credit you have to spend; hover it for today's commits, lines, tokens and
credit earned.

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

## The Mac app

`app/build.sh` builds **Agent Panel.app** in `~/Applications`: the panel in a window of its own, with
its own icon. Open it like any app, or keep it in the Dock.

- Opening it uses a panel server that is already running, or starts one (its log is
  `~/Library/Logs/Agent Panel/server-4747.log`). Quitting stops a server the app started and leaves
  one it didn't alone.
- If the server it was using goes away, it starts its own after a few seconds. One it started that
  stops after running a while is started again.
- The Dock icon counts the requests waiting on you, and bounces when a new one arrives while you're
  in another app. Closing the window keeps the panel connected: the count stays live and requests are
  still held. Click the Dock icon to bring the window back; ⌘Q quits.
- **Turn on desktop alerts** gives you the Mac's own notifications. Clicking one opens that session.
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
**Profile** in the header lists them by folder name (`claude`, `claude-work`), with each one's
account and plan from `claude auth status`, and switches between them.

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
- The panel holds a request only while a panel tab is open and **Answer prompts here** is on.
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

Every session's panel has a **Chat**: the conversation so far, read from its transcript, with a message
box with the session's mode and **Send** along its bottom. Each of your messages shows with the reply
Claude ended on (not its running commentary between tool calls); **Show earlier** reads further back,
and a compacted stretch shows as a note. It opens at the newest message and keeps it in view as more
arrive, unless you scrolled up to read. When its last reply ends with a numbered or lettered list,
each option shows as a chip that fills the box; add to it if you like.

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

- **A banner** over the board lists every one it finds, other profiles' sessions too: the one that loses access is
  often not the one on screen. A **toast** says when it finds a new one.
- **Its tile** says **restart**, and **its panel** says why and how.
- **To restart**: a terminal session quits in its terminal and resumes with the command the panel gives you to copy.
  A background job is ended in the panel, then sent a message, and comes back on the installed version.

## World

World starts the first time you open it, as a bare rock called Home in the dark, and terraforms on the days you work
from then on, with lit space widening around Home when you zoom out (scroll, or **Home** and **Map**; drag to look
around). No agents in it: their work only arrives as credit. While it is open, its top bar says how many sessions need
you, and takes you back to the board at the first.

Credit is earned per calendar day: `(lines added ÷ 10 + tokens ÷ 10,000) × multiplier`, where lines removed raise the
multiplier from ×1 up to ×4, so a cleanup day pays best. The side panel shows today's numbers.

**Home levels up with XP** from the days you work. XP is never spent; credit is what you spend. A full day's work
(300 credit, about an hour of one agent working) gives 100 XP; past it, each doubling of the work gives 50 more (600
credit is 150 XP, 1,200 is 200), with no daily limit. So a productive day always moves Home further, while a runaway
loop can't jump far: a hundred times the work is under 5 days' XP. Thinking and iterating count through their tokens, shipping through commits. A day off pauses it, and XP
never goes back. The levels:

| Level | Home | XP |
|---|---|---|
| 1–3 | bare rock, clouds (within the first hour), oceans | 0, 15, 100 |
| 4–6 | continents, green coasts, forests | 300, 500, 800 |
| 7–9 | settlements with lights at night, cities under an atmosphere, terraformed with a moon | 1,200, 1,600, 2,000 |
| 10–12 | an orbital ring, a star port on it, twin moons | 2,600, 3,300, 4,000 |

Level 9 takes about a month of normal weekdays. World's side panel shows the level, the XP toward the next, and today's
XP; the board says so when Home reaches a new level.

- **Tokens** come from the transcripts of every Claude Code profile on this Mac, sessions and subagents: what was
  sent and written, once per reply. Cache reads don't count. There is one World, whichever profile the board shows.
- **Lines** come from your commits in the repositories those sessions worked in or edited files in: commits whose
  author and committer are the `user.email` git uses there, on any branch or remote. Others' commits, merges, the
  stash, and squashes GitHub makes for you don't count, and neither do lockfiles; a file counts at most 2,000 lines
  each way per commit. A repository where git has no `user.email` counts nothing, and World says so; so does one
  whose history git doesn't read out in time.
- Each repository's lines per day are the most any count has seen there. So deleting a branch after it was merged
  keeps its credit, and an amended, reworded or rebased commit replaces its old count instead of adding to it. (A
  `fixup!` commit squashed away after World counted it keeps its lines.) Git is asked for the last 30 days; older
  days keep what was counted.
- Work from before the first open doesn't count. World is kept in
  `~/Library/Application Support/Agent Panel/world/world.json`. Git is only read.

**Push the frontier** to spend credit. Pick a direction (from the list, or **Aim on the map**) and the dark that way
lights up as you keep working: a push opens 150 px of map and is fully lit after 3,000 more credit earned, about ten
normal days. A push within 20° of an earlier one makes that stretch longer. The first push always finds a planet and
each later one finds one half the time; it shows once the light reaches it, and a click flies there. The first push
costs 4,000, and each one after costs a quarter more. Light never goes back, even when a day's multiplier moves.

**Moments** mark the map where they happened: each finished week with work (Monday to Sunday), each finished day that
removed 500 lines or more and more than it added ("Big cleanup"), and each Home level from 3 up. The side panel lists
the newest; a click opens its card with what was done and flies to it.

**Send a rocket** to a bare planet the frontier found, and name the colony it lands (up to 24 letters, digits,
spaces, apostrophes or hyphens; not Home, and not another colony's name). The view pulls out, the rocket flies from
where you are, and the view flies in to the colony; with reduced motion it goes straight there. Colonies have a
button each beside **Home** and **Map**. A rocket costs 8,000 at first, and each one after costs a quarter more.

**Build** on Home or a colony: describe it (up to 300 characters) and press **Build it** or Enter. Claude turns the
words into pieces World can draw: moons, rings, a ring city, city lights, land and ocean colours, an atmosphere,
mountains, domes, space stations, a space elevator, aurora and beacons, each with a colour, size, place and count.
Every build costs 4,000, wherever it goes and however many came before. Credit is taken only when the answer draws:
if Claude can't be reached, the profile isn't signed in, or the answer doesn't fit, nothing is spent and the side
panel says why. One build at a time.

That call is the only time World uses Claude: `claude -p --model haiku` with a JSON schema, under the profile the
board shows, with hooks off, no tools, MCP servers or slash commands, and no session saved. It runs in
`~/Library/Application Support/Agent Panel/world/build`, and the board leaves it out
([design](docs/superpowers/specs/2026-10-21-world-design.md)).

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
- Ending a terminal session signals only a pid read fresh from `claude agents`, only when that
  process is still `claude`, and never the session the panel server itself runs in.
- `claude` is started without the `CLAUDE*` variables of the session that started the server
  (except `CLAUDE_CONFIG_DIR`), so a launched session doesn't take itself for a child of it.

## Uninstall

Remove the hook entries that point at `127.0.0.1:4747` from each profile's settings. Delete
`~/Applications/Agent Panel.app`, `~/Library/Application Support/Agent Panel` and
`~/Library/Logs/Agent Panel`.
