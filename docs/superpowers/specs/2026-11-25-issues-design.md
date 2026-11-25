# Issues: a list of work in the side panel that agents pick up

> **Status: built (2026-11-25).** Lives on the right beside GitHub (see "On the right, beside GitHub"). Notes were added
> while building (see "Notes"). The space goal is stored and set by Issues; its display on Home waits for the Home
> overview build.

## Intent
The owner asked (2026-11-25): "can we in the left side create a todo list for this that needs to be worked on and that
we can set agents to work on can clicking somehting like pick up … maybe like issues Header and then sub items". Asked
where the work comes from, the owner said "what do you think?"; Claude proposed a list Glue keeps itself, tied into
spaces, and the owner said "lets do this". So Glue becomes a place to queue work as well as to watch it.

Depends on the Home overview design (`2026-11-24-home-overview-design.md`) for a space's **goal**: an issue's title is
its space's goal. Build after it, or with it.

## Goals
- An **Issues** panel on the right, opened from its own button in the top bar, in the same column as GitHub's side bar
  but a container of its own: each issue a header, its items one line each under it.
- **Pick up** on an item starts an agent on it in the issue's space, in one click once the issue knows its folder.
- Each item shows on its own whether it is to do, being worked on (by which agent), or done.
- Typing an issue or an item is as quick as typing a line.

## Non-goals
- No GitHub issues: nothing read from or written to GitHub in this round. (Importing or linking one can come later.)
- No assigning items to a running agent, no main agent picking items up, no due dates, labels, priorities or owners.
- No change to how agents are started, other than starting one from an item.

## Anti-goals
- The list never gets in the way of the agents below it: it folds to its header, and done issues fold away.
- An item is never marked done by guessing: done is a merged pull request from its agent's branch, or the owner's tick.
- Nothing of one workspace's issues reaches another workspace's page.

## Approaches
- **A list Glue keeps itself, tied into spaces (picked).** Instant to type, private, across repositories, no GitHub
  noise; "done" comes from the merged pull request Glue already polls.
- **GitHub issues.** History and sharing, but slower to write, one repository each, and more of the GitHub noise the
  owner has complained about.
- **Both, synced.** Two sources of truth to reconcile; not worth it before the simple one is used.

## Design

```
ISSUES                                       +        ← folds to its header
▾ Checkout on the v2 API              Trial  ⋯ +
    ○ Cart endpoint                       [Pick up]
    ● Cart page               cart-ui · working
    ✓ Remove the old cart route      merged #91
▸ Monthly invoices                      2 to do
```

### What an issue and an item are
- **Issue:** a title (one line, up to 120 characters), an optional space, an optional folder (where its agents start),
  and its items in order. Made with the section's +; the title is typed in place, Enter saves.
- **Item:** one line of text (up to 300 characters), its state, and, once picked up, the session working on it.
  Made with the issue's +, typed in place; Enter saves and opens the next empty line, Esc stops.
- Kept per workspace in the workspace store (with the spaces), so they survive restarts and reach only their own
  workspace's page. Routes under `/api/issue/*`: create, rename, delete, item add, item edit, item delete, move (an item
  within its issue, or an issue among issues), tick/untick, pick up.

### Issue and space
- An issue's space is made the first time anything in it is picked up: a new space named after the issue (the side
  panel's space names are unique, so a clash gets " 2"), with the issue's title as its **goal**. From then on the two
  move together: renaming the issue renames the space and its goal; the space's "Edit goal…" stays the space's own (an
  issue's title is not changed by it).
- An issue can instead be linked to an existing space, from its ⋯ ("Use space…"), before or after pick-up. *(My call,
  after the builder check:)* the issue keeps whether it made its space. Only a space the issue made follows the issue:
  renaming the issue renames that space and its goal (a name clash gets " 2"). A linked space is never renamed by the
  issue; linking sets its goal to the issue's title only when it has none. Renaming a space never renames its issue.
- Deleting an issue leaves its space and agents as they are. Deleting its space unlinks the issue (it makes a new space
  at its next pick-up).

### Pick up
- **The first pick-up of an issue** opens New agent's short form, filled in: the item's text as the prompt, with the
  issue's title above it as context ("Part of: Checkout on the v2 API"), the issue's space, and the folder of that
  space's newest agent if it has one. Launching keeps that folder on the issue.
- **Every pick-up runs in a worktree of its own** (named after the item), so agents on one issue never share a checkout
  or a branch, whatever Settings' new-agent default says. *(My call, after the builder check: without it, parallel
  pick-ups edit the same files on the same branch, and "done by its pull request" cannot work.)*
- **Every later pick-up** starts the agent at once, in the issue's folder and space, with the choices made in the first
  pick-up's form, which the issue keeps (agent kind, login, model, effort, mode), with no form. Shift-click (or "Pick up
  with options…" in the item's ⋯) opens the form instead, and what is chosen there becomes the issue's choices.
- The started agent is linked to the item by the launch id, as spaces link their sessions today, and the item becomes
  "being worked on". An item can be picked up again only once its agent has finished or is gone.
- The prompt the agent gets: the item's text, then one line "This is part of: <issue title>." Nothing else is added.

### Notes
*(Added 2026-11-25: the owner asked "how context can be given?" and, offered notes, said "i like the note thing".)*
- **An issue's notes:** free text, up to 4,000 characters, lines kept: background, links, constraints, what done means.
  Under the issue's title, its first line shows (dim, one line; a click edits); written in a box that grows, Enter adds
  a line, ⌘↩ saves, Esc leaves them as they were. "Add notes…" / "Edit notes…" in the issue's ⋯.
- **An item's note:** up to 1,000 characters, for what applies to that item only. A small ✎ after the item's text (its
  note as the tooltip; a click edits); "Add a note…" / "Edit note…" in the item's ⋯.
- **What a pick-up sends:** the item, its note, "This is part of: <issue title>.", then "Context for this issue:" and
  the issue's notes, each part only when there is one, separated by blank lines. The first pick-up's form is filled
  with the same, to change before launching.

### An item's state
- **To do** (○): not picked up, or the owner chose "Back to to do" in the item's ⋯ (shown once its agent has finished
  or is gone; the agent itself is left as it is).
- **Being worked on** (●): its agent is on the board. The line shows the agent's name and what it is doing in a word
  (working / needs you / idle), and a click opens the agent.
- **Done** (✓): a pull request from one of its agent's branches was merged, or the owner ticked it (click the circle).
  Shows "merged #n" or "done". Unticking puts it back to to do. *(My calls, after the builder check:)* the item records
  every branch other than the default one that its agent was seen on after pick-up (agents often make their own
  branch). The server, not the page, decides done by merge and records it in the store, so it is caught even when the
  agent was cleared from the board before the merge: Glue's GitHub poller keeps following the open pull requests of
  branches recorded on items that are not done, as it follows agents' branches today, and checks the merged list for
  them.
- An agent that finished with no merged pull request leaves its item "being worked on", marked "agent finished", until
  the owner ticks it or picks it up again.
- When every item of an issue is done, the issue folds and drops to the bottom of the list, dimmed; its ⋯ has Delete.

### On the right, beside GitHub
*(Changed 2026-11-25, the owner's words: "this should live right side share github side bar so if both opeen stacked",
"and have a button at top", "but they should be two different containers".)*
- **Two containers:** Issues and GitHub are separate panels, each its own rounded card (as `.gh-side` is today) with its
  own header, close and scrolling, with the page's usual gap between them. They share the column, never a card.
- **A button in the top bar,** "Issues", next to the "GitHub" button and drawn like it, with how many items are to do
  as its small count (none shown at 0). It opens and closes the Issues panel, which stays as the owner leaves it across
  reloads, as GitHub's does.
- **The same place as GitHub's side bar:** the right-hand column (`.gh-side`'s place, after the session panel). With one
  of the two open, it takes the whole column. With both open, they stack in that column, **Issues above GitHub**, each
  with its own header (title, its close ×) and its own scrolling; the split is half and half, and a panel that needs
  less than its half gives the rest to the other. *(My call: which goes on top, and the split.)*
- **Slim and narrow, as GitHub's:** the column's slim strip (GitHub's existing ‹ fold) folds both panels to the strip,
  each showing its icon and count; under 860px the column covers the window, as GitHub's does, still stacked.
- Esc closes the panel that has focus.
- Inside the Issues panel: the issues, each a header with its +, its ⋯ and its fold; open, its items; folded, "n to
  do". A + at the panel's head adds an issue. Items and issues can be dragged to reorder; the keyboard can move them
  with Alt+↑/↓.
- The left side panel is unchanged: no Issues section there.

## Constraints
- The page is one file with `el()` and `patch()`; the deciding logic (an item's state from sessions and merged pull
  requests, which issue folds) in `public/home-board.js` or a module of its own, with unit tests; the store and routes
  with tests, as the spaces have.
- The launch reuses `/api/launch` and the short form's code; linking by launch id reuses how spaces claim sessions.

## Left to the builder
- Spacing, type, colours (the owner's taste: tints, not outlines; short); the drag affordance.
- The exact words on lines and buttons.
