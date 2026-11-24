# Home as an overview: what needs you, then what is running

Supersedes the layout of `2026-11-24-home-board-design.md` (#102). Its deciding logic (`public/home-board.js`: who
needs you, `plainAsk`, `inlineAsk`, `bulkReplies`, dismissals, `syncChildren`) and its actions stay.

## Intent
After #102 the owner said Home "still feels way to croweded when even few agents are running", turned down three
calmer variations of the same lists ("none of them are good"), and then described what they want, in their words:
"Put the agents that need me first: anything blocked, waiting for my approval or input, or failed, each with one line
saying what it needs. Under that, one row per running space with its goal and whether it is making progress. Hide
finished agents and counts of agents, and never show raw logs or full transcripts on Home. Open those only from a row I
click into. In general an easy overview easy to manage etc."

Then, on what a space's goal is and how progress is judged, the owner picked (2026-11-24): "I'll write the goal myself
when I create a space, and it stays editable later. Until I set one, show the newest agent's task, shortened. Moving
means an agent acted in the last 10 minutes or pushed a commit, stalled means nothing for 20 minutes while something
should be running, and waiting on me means an agent is in Needs you."

A goal is one line saying what the space is for: what the owner wants done when its work is finished ("Rebuild the
checkout cart on the v2 API"). It is the owner's label for the work, shown on Home; it instructs no agent.

## Goals
- Home answers two questions at a glance: what needs me, and is each piece of running work getting anywhere.
- Every item is one line. Anything longer opens only from a row the owner clicks.
- The few actions that are a whole answer in one click stay on the line (Allow/Deny, Merge); the rest open on click.

## Non-goals
- No change to the side panel, the agent view, Ask Glue's chat, the heatmap, the main agent, or the migration work.
- The goal is not given to agents, Ask Glue or the main agent in this round.

## Anti-goals
- No finished agents, no counts of agents, no logs or transcripts on Home (not even folded: "What it said" goes).
- No row that moves or redraws under the owner while they type in it (keep `syncChildren` and per-row signatures).

## Design

```
Home   Opus · proposes, you confirm
NEEDS YOU
● migrate-db  Trial    Wants to run npm run migrate                 [Allow] [Deny]
● cart-api    Trial    Asks which login should remember the repo    [Reply…]
● docs-sync   Docs     Failed: 3 tests fail in docs/build           [Open]
● pricing     Billing  PR #42 is green and waits for your merge     [Merge]
RUNNING
Trial                 Rebuild the checkout cart on the v2 API      ● Moving · last change 3 min ago
Billing               Monthly invoices with levies                 ● Stalled · nothing for 40 min
chai-expense-tracker  Entra login mail check                       ● Waiting on you
[ Ask Glue … one line, as today ]
```

### Needs you
- The same agents as today's Needs you (`HomeBoard.needsList`: waiting on the owner, Ask Glue's follow-ups, failed and
  not dismissed, green PRs), in the same order, each once. Heading "Needs you", no count. Hidden entirely when empty
  (no empty-state box): then Running comes first.
- **One line per agent:** state light, name, its space (or repository) in small text, one line saying what it needs,
  then at most one action group on the right. What it needs, by kind:
  - a plain tool request (`plainAsk`): "Wants to run `<command>`" / "Wants to read `<file>`" etc., cut to the line with
    an ellipsis; **Allow** and **Deny**. Because the line may cut the command, the full command (`inlineAsk`) shows in the
    row's tooltip and in the row opened below; Allow on a cut line is still the whole command as before.
  - another request (question, plan, edit, MCP tool): "Asks: <question>" / "Plan ready for review" / "Wants to edit
    <file>" / "<tool>"; **Answer…**, which opens the row (below).
  - waiting with no request the panel can read: its side-panel line ("Waiting in its terminal"); **Open**.
  - a follow-up: Ask Glue's one-line ask ("Asks which login…", or "Stopped with work left: <what>"); **Reply…** (or
    **Keep going…** for work left), which opens the row with the drafted reply.
  - failed: "Failed: <first sentence of its last message>"; **Open**, and **Dismiss** in the opened row.
  - a green PR: "PR #n is green and waits for your merge"; **Merge** (two clicks, as today).
  - a space's main agent with updates waiting (`snap.mains[space]`: it is stopped, or its notices are held after many
    with no word from you): "Main agent of <space>: stopped, 3 updates wait" / "…: updates held, 3 wait"; **Wake it** /
    **Carry on** (`/api/main/wake`, as the old card did). A new kind in `needsList` (`main`), after green PRs, keyed by
    the main agent's session (taken from all of `snap.sessions`, since a stopped one may have left the board). *(My call,
    after the builder check: Home's old card was the only place this showed, and it is the owner's to unblock.)*
- **Opening a row:** a click on the line (not on a button) or on Answer… / Reply… / Keep going… unfolds that one row
  under its line: the drafted reply box with Send / Keep going and Merge (today's follow-up actions), or the agent view's
  own request card (today's Answer), or the full command for a plain request. One row open at a time; Esc or a second
  click folds it. A link in the opened row, "Open agent", opens the agent itself, which is the only place for its
  conversation. Nothing in an opened row shows its last message or transcript.
- **Send N replies** stays at the heading, as today, shown with two or more sendable follow-ups.

### Running
- **One row per running space**, in the order the spaces were made, then one row per repository for running agents in no
  space (repository name), then "Other folders". A space or repository is running while it has at least one agent on
  the board that is not finished and is not its main agent. Spaces with nothing running are not shown.
- **The row:** the space's name; its **goal** (or, until one is set, the newest running agent's first prompt, shortened
  to the line, in the dimmer colour so it reads as a stand-in); and its **progress** on the right.
- **Progress**, decided in `home-board.js` from what the page has (each agent's state, `lastEventAt`, and its PR head
  `sha` and when that was first seen), first match wins:
  1. **Waiting on you** (amber): any agent of the space is in Needs you.
  2. **Moving** (green) "· last change N min ago": any agent of the space acted (a hook event, a tool, a message) in the
     last 10 minutes, or one of its pull requests got a new head commit in the last 10 minutes.
  3. **Stalled** (amber) "· nothing for N min": an agent of the space is working (`busy`) and nothing happened in the
     space for 20 minutes or more.
  4. Otherwise **Quiet** (dim) "· last change N min ago". *(My call: the 10–20 minute gap, and a space whose agents
     are all idle with nothing in Needs you, need a word; neither is moving nor stalled.)*
  The main agent's own activity does not count as progress, but a main agent in Needs you does make its space "Waiting
  on you". *(My calls, after the builder check:)* "Acted" is read from real activity times (the last tool's time and the
  last message's time), not from when the panel first saw a session, so a restart of Glue does not make every space
  "Moving" for ten minutes. "Pushed a commit" is a pull request whose head commit the page has seen change in the last
  10 minutes; the page remembers each PR's head commit and when it changed, and a head first seen after a page load does
  not count as a push.
- **Opening a row:** a click unfolds it in place: the main agent's latest report line when it has one, then its running
  agents, one line each (state light, name, what it is doing: the tool it runs, or "idle 12m"), each opening the agent.
  No finished agents, no counts. One space open at a time; a second click folds it. The row's ⋯ (shown on hover and
  when open) holds Edit goal…, Turn on/off main agent, Interrupt all, End idle.

### Goals
- A space keeps `goal`: one line, up to 120 characters, empty by default. Kept with the space in the workspace store,
  reaching only its own workspace's page.
- **Set it when making a space:** the two places a space is made (New agent's "New space…" and the Space picker in an
  agent's details) show, under the name, a second field "Goal (optional)"; Enter in either field makes the space with
  both.
- **Edit it later:** "Edit goal…" in the space's ⋯ on Home and in the side panel opens a one-line field in place; Enter
  saves, Esc cancels, empty clears it. Route: `/api/space/goal { id, goal }`; `/api/space/create` takes an optional
  `goal`.
- **The stand-in:** the server reads each session's first prompt from its transcript once and sends it as `firstAsk`
  (up to 200 characters, one line). Until a goal is set, the row shows the newest running agent's `firstAsk`.

### What goes from Home
- The head line of counts, the cards grid (summaries, PR lines, "+N more", "+N finished"), the main agent's report
  block on cards, "What it said" in follow-ups, the empty Needs-you box.

## Constraints
- Reuse what #102 built: `needsList`, `plainAsk`, `inlineAsk`, `bulkReplies`, `closesTerminal`, `dismissKey`,
  `pruneDismissed`, `syncChildren`, the follow-up actions (`fuAct`, `mergeSession`), the request cards (`buildCard`).
- New deciding logic (which spaces run, their stand-in goal, their progress) in `home-board.js` with unit tests.
- The goal in the store and routes with tests; the page checked in a second Glue on a spare port with its own data
  folder, as before.

## Left to the builder
- Spacing, type and colours within the page's tokens and the owner's taste (tints, not outlines; short).
- Exact words of each one-line "what it needs", within the kinds above.
