# Home as a board: what needs you, then every space

> **Status: built (2026-11-24).** Changed while building, after the owner's note on the side panel's space cards ("tint
> the card slightly blue… just show total agents and how many working, not finished… main agent in the title"): Home's
> cards follow it too. A working card is tinted, not outlined; the summary is "N agents · M working · K need you", with
> no "+N finished"; the main agent is a "Main" pill in the card's title, with its report under it.

## Intent
The owner asked "does it still show all tasks?" and then: "we need home to be an efficient management space to control
and have overview". Today Home is an inbox, not an overview: it shows main-agent cards (only for spaces where one is
turned on, so usually none), "Waiting on you" (agents whose last turn Ask Glue's check judged a question or unfinished
work), and the Ask Glue chat. Every agent that is working, idle or finished, and every space as a whole, is only in the
side panel. The owner wants to open Home and, in one screen, see what every space is doing and act on what needs them,
without opening agents one by one. The owner picked approach A below.

## Goals
- One screen answers "what needs me?" and "what is each space doing?".
- What needs the owner can be acted on from Home in one click (or one edit and a click): answer a permission prompt,
  send a drafted reply, keep an agent going, merge a green pull request.
- Every space, and every agent outside a space, is visible on Home with its state.
- Fewer clicks: the drafted replies can go out together.

## Non-goals
- No change to the side panel, the agent view, Ask Glue's chat or what it proposes, the heatmap in the top bar, or the
  main agent itself (#99).
- No new server routes or server data: Home is built from what the page's snapshot already carries (`snap.spaces`,
  `snap.sessions`, `snap.pending`, `snap.overseer.follow`, each session's `gh`, `snap.mains`).
- No per-agent chat, terminal or details on Home: a row opens the agent as the side panel does.
- No other workspace's spaces or agents (the seal stays).

## Anti-goals
- Home must not jump while the owner reads it: cards keep a stable order, and rows keep their place unless their state
  changes.
- Nothing runs without a click: replies, merges and "Send all" are buttons; a merge and "Send all" ask for a second
  click to confirm, as merges do today.
- It must not become a second, bigger copy of the side panel: a space card sums its space up and lists its live agents
  in a line each; finished agents are a count, not rows.

## Approaches
- **A. A board of spaces, with "Needs you" on top (picked).** A "Needs you" block of everything waiting on the owner,
  acted on in place, then a grid of cards: one per space, plus the agents in no space grouped as the side panel groups
  them. Overview and control on one screen, built from what exists (follow-up cards, main-agent reports, GitHub state).
  It repeats some of the side panel, at a larger size.
- **B. A full action inbox.** Every decision waiting on the owner, ranked, with bulk actions; a line of counts for the
  overview. Strongest for control, but it does not show what the spaces are doing.
- **C. A table of all agents.** Sortable, multi-select rows. Densest overview, busy, and mostly the side panel again as a
  grid.

## Design

```
HOME   Opus · proposes, you confirm                  3 need you · 7 working · 4 idle · 2 PRs ready
┌ Needs you 3 ───────────────────────────────────────────────────────── [Send 2 replies] ┐
│ ● cart-api · Checkout     Bash: npm run migrate          [Allow] [Deny]       Open      │
│ ● docs-sync · Docs        Stopped short: tests left      [Keep going ▸ "Carry on…"]     │
│ ● billing-fix · Billing   Asks: v1 or v2 schema?   [ v2, keep the old route   ] [Send]  │
│                           PR #91 green                    [Merge #91]                   │
└─────────────────────────────────────────────────────────────────────────────────────────┘
┌ Checkout ──────────── ⋯ + ┐ ┌ Billing ───────────── ⋯ + ┐ ┌ shop (no space) ───── ⋯ + ┐
│ 4 agents: 2 working,      │ │ 2 agents: 1 needs you,     │ │ 1 working                 │
│ 1 needs you · +1 finished │ │ 1 idle · PR #91 ready      │ │                           │
│ Main agent, watching:     │ │                            │ │                           │
│ "API done, UI half way…"  │ │                            │ │                           │
│ ● cart-api   asks you     │ │ ● billing-fix   reply draft│ │ ● notes   Edit app.js     │
│ ● cart-ui    Edit cart.tsx│ │ ○ invoices      idle 1h    │ │                           │
│ ● cart-tests working      │ │                            │ │                           │
└───────────────────────────┘ └────────────────────────────┘ └───────────────────────────┘
[ Ask Glue … docked at the bottom, as today ]
```

### The head line
After "Home · model · proposes, you confirm": counts across the workspace's visible agents. How many need the owner,
are working, are idle, and how many of their pull requests are ready to merge. Each count is plain text; none of them is
a button. *(My call: a line, not tiles, so the board starts higher up.)*

### What "needs you" means (one meaning everywhere)
*(My call, after the builder check.)* An agent needs the owner when it has a row in the Needs-you block below: it is
waiting (`stateOf` is waiting: a pending request, or waiting in its terminal or on something the panel can't read), or
Ask Glue has a follow-up for it, or it failed, or its pull request is green and ready to merge. The head line, the
space cards' summaries, the amber on a card and the order of a card's rows all use this one meaning. On a card such an
agent's row says what it needs ("asks you", "reply drafted", "failed", "PR ready") instead of "idle 12m". The head
line's counts do not overlap: an agent that needs the owner is counted there only, the rest as working or idle; ready
pull requests are counted on their own, as pull requests.

### Needs you
One block above the cards, hidden when nothing needs the owner (then a single quiet line: "Nothing needs you."). It
replaces "Waiting on you". One row per agent: first the waiting ones in the order the side panel's "Needs you" uses
(`asking()` for the ones with requests, then the other waiting ones), then the follow-ups in the order Ask Glue gives
them, then failed ones, then ready pull requests. An agent appears once, with what it needs:

1. **A permission prompt, question or plan** (`snap.pending` for that session). The row shows the ask in a line (the
   side panel's `askText`). A plain tool permission gets Allow and Deny in the row, sent as the agent view sends them
   (`/api/decide`, or `/api/answer-open` for an open one). A question, a plan, an edit, or a prompt with more than one
   request gets "Answer", which unfolds the agent view's own request card for it in place (the existing card builders),
   so nothing about answering is new. *(My call: Allow/Deny inline only where one click is a whole answer.)*
2. **A follow-up** (`snap.overseer.follow`): what it asks or left, and the drafted reply in a box to edit, with Send or
   Keep going, and Merge #n when its pull request is green. This is today's follow-up card, laid out as a row; the same
   actions and routes.
   A waiting agent with no request the panel can read (in its terminal, an OpenCode error, a background job waiting on
   something unreadable) gets its side-panel line ("Waiting in its terminal") and Open.
3. **Failed** (an agent whose state is failed, with no follow-up): its last line, Open, and Dismiss. Dismiss hides it
   from Needs you on this page until it does something new (a new last message or state), as the page keeps its other
   view state; it is then counted as finished. *(My call.)* Until dismissed it counts as needing the owner, not as
   finished.
4. **Ready to merge** (its pull request is green by `mergeable()`, and it has no follow-up, which already carries Merge):
   "PR #n ready", and Merge #n, two clicks as today (`/api/github/merge` with its session). *(My call: the goal says
   merge a green pull request in one place, and most ready ones have no follow-up.)*

Each row names its space (or repository), and its name opens the agent. A pull request's state shows on the row when
it has one.

**Send N replies** at the block's head sends every follow-up's reply as it stands in its box (edited or not), never a
merge and never a permission. It asks for a second click ("Confirm: send 3 replies"), then shows each row's own result
as a single Send does. It shows only with two or more follow-ups it can send. A follow-up whose send would restart a
Claude running in a terminal (`how: 'restart'` on an interactive session, which closes it there) is left out, and the
confirm says so ("Confirm: send 3 replies · 1 left out: it would close Claude in its terminal"); that row keeps its own
Send. *(My call.)* This is the "Confirm all" the owner parked on 2026-11-21.

### The space cards
A grid of cards (filling the width, about 300px each, one column when narrow). One card per space of the workspace, in
the order the spaces were made, empty ones included. Then the agents in no space: one card per repository, by name,
then "Other folders" for agents in no repository. *(My call: a stable order, so the owner learns where each space is; a
space that needs them shows it with its count. Spaces never come and go with state; a repository card is there while
any visible agent of that repository is, finished ones included, so it stays until the side panel stops showing its
last agent; it never moves because of state.)* Finished agents in no space count as "+N finished" on their repository's
card (or Other folders); there is no Finished card. The card's + is the side panel's + for that repository, worked out
from the repository itself rather than from a side-panel section, which a repository with only finished agents has not.

A card has:
- **Head:** the space's name (a repository card: its name, and "no space"), ⋯ and +. The + is the side panel's + for that
  section (New agent in the short form, in the space's newest agent's folder). The ⋯ holds the side panel's section
  actions for it: Turn on/off main agent, Interrupt all, End idle, Clear (finished), Rename. Same functions. Deleting a
  space stays in the side panel only. *(My call: Home is for running the work; deleting is rare and destructive.)*
- **Summary:** "4 agents: 2 working, 1 needs you, 1 idle", the part that needs the owner in amber, and "+N finished"
  when it has finished agents. If its agents have open pull requests, one line: how many are failing, running, or ready
  to merge.
- **Main agent:** when the space has one, a short block: "Main agent, watching" (or its state) and the start of its last
  report, 3 lines at most. A click opens the main agent. "Wake it" / "Carry on" as the main-agent card has now, when
  updates wait for it. This replaces Home's separate "Main agents" section, which goes.
- **Agents:** the live agents (needs you, working, idle; not the main agent and not finished), a row each: its state
  light, its name, and a short detail (the side panel row's detail: the tool it runs, "asks you", or "idle 12m"), with
  its pull request number and checks colour when it has one. Needs-you first, then working, then idle. At most 6 rows,
  then "+N more", which unfolds the rest on that card. A click opens the agent, as a side-panel row does.
- **Empty space:** "No agents yet" and its +.

### What goes
- Home's "Main agents" section (its card's parts move into the space cards).
- Home's "Waiting on you" section (it becomes "Needs you").

### What stays
- The Ask Glue dock at the bottom, the proposals it makes and how they are confirmed.
- The heatmap in the top bar.
- Opening an agent from Home, and closing it back to Home, as today.

## Constraints
- The page is one file (`public/index.html`), no framework: elements made with `el()`, redrawn with `patch()` against a
  signature, as the side panel and the current Home do. Keep that, and keep redraws cheap (Home redraws on every
  snapshot).
- Reuse, don't copy: the side panel's grouping (`groups`, `sections`), row detail (`lineOf`), section actions
  (`bulksOf`, `watchSpace`, `quickLaunch`), the request cards (`cardShell` and its builders), the follow-up actions
  (`fuAct`, `fuMerge`), `mergeable`, `stateOf`/`colOf`.
- Both themes, and a narrow window (one column, the Needs-you rows wrapping their buttons under their text).
- Keyboard: every action is a button; rows that open an agent are buttons too.

## Left to the builder
- Spacing, type sizes and colours, within the page's existing tokens and the look of the side panel's space cards.
- Exactly which request kinds count as "a plain tool permission" for inline Allow/Deny (Bash, Read, Glob, Grep, WebFetch,
  WebSearch and MCP tools are the obvious ones; Edit, Write and NotebookEdit have a diff worth seeing and get "Answer").
- How "+N more" and "+N finished" unfold, as long as nothing else on the board moves.
- Tests: the page has no unit tests today; check it in a second Glue on a spare port with its own data folder, and a
  screenshot of each part.
