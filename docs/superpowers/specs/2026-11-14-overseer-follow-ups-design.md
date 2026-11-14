# Overseer: a "Follow up" list of agents that stopped before the job was done

## Context

Today the overseer page is a chat plus a feed. The only thing it surfaces by itself is "N sessions need you", which
counts formal requests only (permission prompts, plans, AskUserQuestion). An agent that ends its turn with a question in
prose ("Should I also migrate the old table?") or stops partway ("3 of 5 endpoints done…") just lands under **Idle**,
and the user has to notice it. The ask: the overseer page should pull those agents up and let the user act on each
right there.

Decided with the user: **a model check on every stop.** When an agent ends a turn, one cheap, tool-less Haiku call
reads its last message and labels it *done*, *needs your answer* or *stopped short*, with a drafted reply. Anything
other than *done* becomes a card in a **Follow up** list at the top of the overseer page.

## Design

### Approaches considered
- **Model check per stop (picked):** most accurate, and it drafts a reply. Costs one small Haiku call per stop.
- Text rules only: free, but misses and false flags, and no drafted reply.
- Rules flag, model on click: cheap, but rules still decide what shows up.

### Behaviour
- **Trigger:** a top-level turn ends (the `Stop` hook without `agent_id`, server.mjs:466; OpenCode busy→idle,
  server.mjs:2859), the session has a `lastMessage`, and it can be replied to (`canReply` rules: not `hostsPanel`).
  Skipped when it already holds a request (it's under Needs you anyway) or a message is queued for it (it will carry
  on by itself).
- **One check per stop:** a new stop for the same session replaces the old check (abort it). At most 2 checks run at
  once per workspace; extras wait in line. 30 s timeout. If a check fails (no Claude login, error), there's no card
  and one line in the server log. No error card. *(my call)*
- **The call:** `claude -p --model haiku` on the workspace's default Claude login, run like the overseer's own calls
  (no tools, no hooks, no MCP, nothing saved, its own `--session-id`, in the overseer's empty folder so it never shows
  on the board). Always Haiku, even when the overseer chat uses another model. *(my call: cheap, and fast enough)*
- **Schema:** `{ verdict: 'done'|'needs-answer'|'stopped-short', ask: string ≤200 (the question, or what's left),
  reply: string ≤1000 (a suggested message to the agent, never starting with / or !) }`. The prompt gives the
  session's name, folder/branch and the last message as data with tags stripped (same `flat`/`plain` helpers), and
  never as instructions.
- **A card goes away by itself** when the session starts working again, ends, gets a held request, or has a newer
  stop than the one checked. This is worked out when the list is read, from the board, so no extra hooks. It also
  goes when the user sends from it or clicks **Dismiss**.
- **Off switch:** Settings › Overseer gets "Check agents when they stop", on by default (`glue.followUps` in
  glue-prefs). *(my call: it costs money, so it should be easy to turn off)*

### The page
A `#h-follow` block at the top of the overseer's scroll area, above `#h-next`:

```
Follow up · 2
┌ fix-login · needs your answer ─────────── 3m ┐
│ Should I also migrate the old sessions table? │
│ ▸ What it said                               │
│ [ Yes, migrate it and add a test.         ]  │  ← drafted reply, editable
│ It reads this at its next step.              │  ← tellEffect wording, as in actCard
│ [Send] [Open] [Dismiss]                      │
├ api-docs · stopped short ──────────────── 9m ┤
│ 2 of 5 endpoints left undocumented            │
│ [ Keep going and finish the remaining… ]     │
│ [Send] [Open] [Dismiss]                      │
└──────────────────────────────────────────────┘
```
- Edits to a card survive re-renders (same keyed-node approach as `renderOvThread`/`ovEdits`).
- The rail's Overseer row detail counts these too: "2 to follow up" (or "1 to confirm · 2 to follow up").
- `waitingOf(wsId)` (server.mjs:309) adds open follow-ups, so the workspace badge counts them.
- The overseer chat's digest gains a line per flagged session: `follow-up: needs your answer: <ask>`, so asking
  "what needs me?" covers them.

### Not included
"Ask overseer about this one" button, a card for *done*, notifications/push for follow-ups. Easy to add later.

