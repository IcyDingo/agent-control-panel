# Main agents and their workers

## Intent
The owner wants more work done in parallel, organised in three levels: Home and Ask Glue on top, one **main agent** per
space that leads that space's work on a top model, and under it the **workers** it starts on cheaper models. Home shows
only the main agents; the side panel shows each space with its main agent first and its workers under it.

```
HOME  (Ask Glue on top, sees every main agent)
┌ Checkout redesign ────────────┐ ┌ Billing bug ─────────────────┐
│ ★ checkout-lead · Opus        │ │ ★ billing-lead · Opus        │
│ 5 workers: 3 working,         │ │ 2 workers: both done         │
│   1 needs you, 1 done         │ │ "PR #91 is green, ready"     │
│ "API is done, UI half way"    │ └──────────────────────────────┘
└───────────────────────────────┘
SIDE PANEL
Checkout redesign
  ★ checkout-lead      main · Opus
  ● cart-api           worker · Sonnet
  ● cart-ui            worker · Sonnet
```

## Goals
- A space can have one main agent: a real Claude Code session, started by the owner with the space's goal.
- The main agent starts its own workers, without a click: real background sessions in its space, each in its own
  worktree, on a model it picks from the ones the owner allows.
- It hears back when workers stop, checks their work, and reports to the owner.
- Everything runs inside limits the owner sets.

## Non-goals
- No OpenCode main agents or workers. No hand-over of a main agent. No adopting an existing session as a worker.
- Ask Glue stays as it is: no tools, proposals only. It never starts a main agent or a worker.
- Workers never start workers.

## Anti-goals
- A main agent must not be able to act outside its own space: not on other spaces' sessions, not on another
  workspace, not on Glue's settings, and never by holding the page's token.
- A main agent must never choose a worker's permission mode, folder or login.
- Nothing about a space or its main agent may reach another workspace's page.

## Approaches
- **A real session as main agent, starting workers through tools Glue hands it (picked by the owner).** Most parallel,
  fewest clicks; the first time agents start agents in Glue, so it needs limits.
- Workers as Claude Code's in-session subagents: the smallest change, but workers are not rows in the side panel,
  share one worktree, and cannot be opened or messaged.
- The main agent proposes and the owner starts: keeps "nothing starts without a click", but it waits on the owner at
  every step.
- The main agent running `claude --bg` itself, or a command line through Bash: Glue could enforce no limits.

## What was checked with the real CLI (Claude Code 2.1.330)
- `claude --bg --mcp-config <file> --allowedTools mcp__glue` gives a background session the tools, and it calls them
  in `default` mode without a permission prompt. The flags are kept with the job.
- The server's `instructions` reach the session, so the main agent's standing brief travels with its tools.
- A message handed to the running session (`claude --resume <id> -- text`, as Glue sends) keeps the tools. So does
  waking a stopped one: "woke session with its saved options (--mcp-config, --allowedTools, …)".
- A **copy** of the conversation (started while the original still runs) has none of the flags, so no tools.
- A worker started with `--worktree` from a main agent in its own worktree gets `.claude/worktrees/<name>` under the
  main repository, on branch `worktree-<name>`, from the **remote default branch**: not from the main agent's branch.
  It does not see the main agent's unpushed commits.
- Claude Code first asks the server `server/discover`; answering "method not found" makes it fall back to `initialize`.
- A background job that finished its turn is listed as `state: done, status: idle` with its process still up. The
  panel calls `done` finished everywhere else, so a main agent resting while its workers work looked "not up": a real
  main agent was not told its worker had stopped until this was seen. For a main agent, up means on the roster and not
  stopped or failed. Its card and Ask Glue's board say "waiting for its workers" or "between turns".
- The whole loop was run for real on a spare port: a main agent on Haiku started one worker through its tools, Glue
  started it in a worktree of its own, and when it finished the main agent got Glue's notice and reported.
- With live updates off for a login no Stop hook arrives, so the panel reads what a worker said from its transcript
  when the roster shows it stopped working.

## Design

### A space's main agent (part A)
- **Kept** on the space, in the workspace store: `main: { sessionId, launchId, model, repo, at }`. The slot is taken
  at launch with the id the launch gave and `sessionId: null`, and claimed when the session shows up (also with no page
  open; kept across a restart; given back after ten minutes if it never shows). A member a main agent started carries
  `worker: true` and its model.
- **One per space, while it is up.** A main agent moved out of its space, or whose space is deleted, is an ordinary
  session again; one not seen for fourteen days gives the slot back.
- **Starting one:** `/api/launch { main: true, space }`. Refused before anything runs when no space is picked, the agent
  is OpenCode, the folder is not in a git repository, or the space has a main agent that is up or was just started.
  It starts on the model picked in the form, else on `mainAgents.model` (Opus).
- **The page:** a "Main agent of this space" switch under the Space field in New agent (it preselects the main agents'
  model), and "Start main agent…" in a space's ⋯ menu. Home gets a "Main agents" section above the heatmap, a card per
  main agent on the board. The rail lists the main agent first in its space with a ★, tagged `main · Opus`; workers are
  tagged `worker · Sonnet`.
- **Ask Glue's board** leads with main agents, each with its workers under it in a line each. A worker of a main agent
  that is up is listed only there, unless it needs the owner or has a follow-up. Without a main agent the board is as
  it was.

### Workers (part B)
- **How the main agent reaches Glue:** a small MCP server (`glue-mcp.mjs`, stdio) forwarding to `/agent/*` on the local
  server with a key that belongs to one space. The key's hash is kept on the slot; the key itself is only in a 0600
  file passed by path. It resolves to one workspace and space, and nothing in a request can widen that.
- **Tools:** `start_worker { name, task, model }`, `list_workers`, `read_worker { worker, turns }`,
  `tell_worker { worker, text }`. None ends a session, answers a permission, sets a mode or touches settings.
- **Limits** (`mainAgents` in Glue's settings): whether main agents may start workers at all, the models a worker may
  get (Sonnet and Haiku), how many workers one main agent may have at once (4) and in all (12). Fixed: a worker starts
  in the main agent's repository, in its own worktree, on Glue's default permission mode, on the main agent's login.
- **Hearing back:** the main agent ends its turn after starting workers and does not poll. Glue sends it one message
  when workers stop, fail or ask something, batched (ten seconds after the last, forty-five at most after the first)
  and never twice for the same last message. A worker's words go in `<worker>` tags with `<` and `>` taken out, under
  a line saying the notice is automatic. A worker of a main agent that is up gets no follow-up card: its question goes
  to the main agent. Permission prompts still go to the owner.
- **The brief** tells the main agent that a worker starts from the remote default branch, so work a worker needs must
  be pushed first or kept by the main agent itself.

### Hardening (part C)
- `interrupt_worker`: stop one of its own workers at its next tool call.
- After forty notices to one main agent with no word from the owner in between, its notices are held. Any message from
  the owner to it (the page's reply, or a proposal of Ask Glue's the owner confirmed), or "Carry on" on its card, counts
  afresh. The count is in memory: a restart of the panel starts it again.
- A notice never restarts a main agent that is not up. Its card says how many updates wait; "Wake it" sends them, which
  restarts it in the background with the options it was started with (Claude Code gives a woken job those back).
- A job that finished its turn and was then stopped stays listed as `done`, with no process: up means done *with* a
  process. Seen when a stopped main agent still read "between turns".
- A per-main-agent "May start workers" switch, and its count, in its details.
- A main agent restarted with a model, effort or mode the owner picked is passed its tools again (Claude Code starts it
  with only the options given). One that carries on as a copy in its worktree hands the copy its slot, with its key,
  login, switch and count.

### What a review of the workers part changed
- The key file is one per launch, named on the slot, never one per space: a main agent that was replaced is still
  started with the path of its old file, and must find nothing there.
- The tools that do something (start, tell, interrupt) work only while the space's main agent is up or just started.
- A place is taken before a launch is waited for, so calls made at once cannot all take the last one.
- `tell_worker` needs a free place to wake a worker that finished its turn, and never restarts one that was stopped.
- A worker's fingerprint for notices is how it stopped plus what it said, so one that fails with nothing new is told of.
- A task may not start with `/` or `!`, as a message may not.

## Honest limits
A worker's report reaches an agent that has tools. The tags, the fixed notice line and the bounded tools lower the
risk of a worker steering its main agent; they do not remove it. A main agent in `auto` mode is the owner's risk to take.
The key is least privilege, not a wall: any agent with a shell can already fetch the page and its token.
