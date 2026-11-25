# Home as goals: a light tree per goal

Supersedes `2026-11-24-home-overview-design.md` (#104, never built) and the layout of `2026-11-24-home-board-design.md`
(#102). Builds on Issues (`2026-11-25-issues-design.md`, merged as #109 and #110).

## Intent
The owner wants Home "simple and ideally visually easy to see what's going on", "less list and more pro active action
oriented", a place to "orchestrate from", where they "just watch what is going on, click and adjust, to keep
everything flowing". Every version that showed spaces and agents (lists, cards, lanes, pills, a map of workers) was
turned down: "it all feels the same as the side panel". What settled it: **the side panel is the workers, Home is the
work**. Home shows the goals (the issues) and how far each is from its outcome: "outcome oriented", not tasks or agents.

Of the outcome views the owner picked a git-tree ("I liked the git tree version, should just be better"), asked that
parallel work read as parallel ("what if some are working in parallel"), then asked whether a drawn graph was overkill.
The answer was a **light tree** drawn like `git log --graph`: one line per branch. They asked for it to be made better
(the question on the line with a drafted answer, stalls caught, the next part named, calm goals shrinking, when it last
shipped) and for a **collapsed** form of a goal, then said "build this".

## Goals
- Per goal, at a glance: how far it is, what is being worked on right now (in parallel), and what is in the way, with
  the one click that clears it.
- A goal collapses to one line that still carries its most pressing move and its button.
- Nothing that needs the owner gets lost: every agent that waits on them shows on Home, in a goal or outside any.

## Non-goals
- No change to the side panel, the agent view, Ask Glue's chat (it stays at the bottom of Home), or the heatmap.
- Editing issues (rename, reorder, notes, files, link a space) stays in the Issues panel on the right. Home adds only
  what it needs inline: a new goal, pick up, and the stop actions below.
- No order of execution or dependencies between items.

## Anti-goals
- Home must not repeat the side panel: no space cards, no agent lists, no counts line.
- No transcripts or long agent output on Home.
- Nothing redraws under the owner while they type in an opened stop (per-goal signatures and `syncChildren`).

## Approaches considered
1. Lists (#104). Turned down as crowded.
2. Action views (one at a time, decision tiles, a briefing). "I don't want these views."
3. Focus and periphery; officer/managers/soldiers; a world map of workers. "Not simple and effective enough"; "it all
   feels the same as the side panel".
4. The work by goal (chosen): a list, a kanban board, two panes, outcome cards, a bar per goal, a drawn git graph, and
   the **light tree** (chosen, with collapsing). The drawn graph was judged too tall and heavy for a default; it may come
   back later as an option.

## Design

### Layout
```
Goals                                                            Expand all · + New goal
▸ AI-drafted cash advances  ● ◯     asks: where should it start?  [Send "Chat first"]  ▰▱▱▱ 1/5
▾ Pages load in under 2 s                       last shipped 20 min ago                ▰▰▰▱ 9/14
   ├ ● Image sizes        PR #8862 fails 3 tests                   [Ask to fix]
   ├ ◯ Cache headers      running tests · 1 min
   ╰ ◯ Lazy-load charts   no change for 25 min                     [Nudge]
     ◌ Next: Preload fonts · +1 more                               [Pick up]
▸ Entra login mails reach every user  ●   PR #8850 green           [Merge]             ▰▰▰▱ 3/5
▸ Issues are picked up from Glue          nobody on it             [Pick up next]      ▰▱▱▱ 2/6
▸ Outside any goal  ● ◯                   chai-expense asks you    [Allow]
Reached today: Flat state dots
[ Ask Glue … ]
```

### A goal is an issue
Each issue of the workspace is a goal; its title is the outcome. Its items are its parts:
- **shipped**: items `done` (merged, with a PR number, or ticked);
- **branches**: items `working`;
- **ahead**: items `todo`, in list order.

### A goal's line (collapsed and open)
`▸`/`▾`, the title, then (collapsed only) one small dot per branch in that branch's colour, then the goal's **most
pressing move** in words with its button, then a progress bar and "shipped/total". Open, the words become "last shipped
<ago>" (or "nothing shipped yet") and the move moves to its branch. A click on the line (not a button) opens or closes it.

### An open goal: the light tree
Under the line, one row per branch, joined by `├` and `╰`: the tip dot, the item's text, where it stands in words, and
its button if it has one. Then one row for what is ahead: "Next: <first todo item> · +N more" with **Pick up** (the
Issues panel's pick-up, with its first-time form when the issue has no folder yet). A goal with no items shows "Add the
first part" (opens the Issues panel at it).

### Where a branch stands, first match wins
Decided in `public/home-board.js` from the item, its session, the held requests, Ask Glue's follow-ups and the PR:
| Case | Dot | Words | Button(s) |
|---|---|---|---|
| a request waits (held or open) | amber | "asks: <the question or the command, short>" | plain request: Allow / Deny; otherwise Answer… |
| a follow-up asks you | amber | "asks: <the ask>" | Send "<drafted reply, short>" and Answer… |
| its agent failed | red | "failed: <first sentence>" | Pick up again (and Dismiss in the opened stop) |
| its PR's checks fail | red | "PR #n fails <n> checks" | Ask to fix |
| its PR can be merged | green, filled | "PR #n green" | Merge (two clicks) |
| a follow-up says it stopped short | amber ring | "stopped: <what is left>" | Keep going |
| it works but nothing changed for 20 min | amber ring | "no change for N min" | Nudge |
| it works | green ring | what it runs (`busyLine`) · N min | none |
| idle | grey ring | "idle N min" | none |
| its agent finished or is gone, nothing merged | grey | "agent finished" | Pick up again |
| no session yet | grey ring | "starting" | none |

- "Send <drafted reply>" sends Ask Glue's drafted reply as it stands (the follow-up's `send`); "Answer…" opens the stop.
- "Ask to fix" sends one reply: "The checks on PR #n fail (<names>). Fix them and push." "Nudge" sends: "You have shown
  no progress for N minutes. Say where you are, and carry on." Both go through the reply route, so they queue while the
  agent works.
- "No change" means no hook event, tool or message from that session for 20 minutes while the page reads it as working.
- A red tip from a failed agent can be dismissed as today (`dismissKey`, held until the agent does something new); a
  dismissed tip reads grey "agent finished".

### Opening a stop
A click on a branch row opens a small panel under it (one at a time across Home; Esc or a second click closes it), with
what that stop needs, reusing what Home has today: the request card (`buildCard`) or the follow-up's reply box, Allow/Deny;
"Tell it…" (one line, sent as a reply), Interrupt, Open agent; the failing checks and Ask to fix; Dismiss for a failed one.

### A goal's most pressing move, and the order
The goal takes its first branch in this order: asks you, broken, ready to merge, stopped short or stalled; else
"moving · shipped <ago>" (no button) while something works; else "nobody on it" with **Pick up next** when an item is to
do; else "all parts shipped" for a reached goal. Goals are ordered the same way (asks you, broken, ready to merge,
stalled, moving, nobody on it), keeping the Issues list order within each.

### Opening and collapsing
- A goal is open when something in it asks you, broke, or is ready to merge, and the owner has not collapsed it since that
  thing appeared; otherwise collapsed. Collapsing stores the goal's current signature of what needs the owner; it opens
  by itself again only when that changes. Kept per browser (like other page prefs).
- "Expand all" / "Collapse all" at the head.

### Reached and quiet goals
- Items get a `doneAt` when they are done (older done items have none). A goal whose items are all done (at least one)
  is **reached**: it leaves the list and shows on one line "Reached today: <titles>" for the rest of the local calendar
  day of its last `doneAt`, then is not shown on Home (it stays in the Issues panel).
- No separate quiet fold: collapsed goals are already one line each.

### Outside any goal
One more goal-like entry, last, "Outside any goal", for agents on the board that need the owner or work, and are not
the agent of a **working** item: no progress bar, no ahead row. It lists, as branches with the same tips and buttons:
agents that work or idle in no working item; and agents that need the owner whatever their state (a request, a follow-up,
a failed one not dismissed, a mergeable PR), finished or not. Main agents count like any agent here (their requests,
follow-ups and failures show; their own work does not count as "work"). A space's main agent whose updates are held
or which is stopped with updates waiting shows here too, with **Wake it** / **Carry on** (`/api/main/wake`). Hidden when
empty; follows the same collapse rules.

### What goes from Home
The counts line, the space cards (and the main agent's report block on them), the Needs-you list and its "Send N
replies". The main agent's reports are read in its own conversation; the Settings and toast lines that say it "reports
on Home" say "reports in its conversation" instead.

## Constraints
- Deciding logic in `public/home-board.js`, unit-tested: a goal's parts and tips, its move, the order, open/collapse, the
  reached line, Outside any goal.
- `issues.mjs` records `doneAt` (tested).
- Reuse: `needsList`'s inputs, `plainAsk`, `inlineAsk`, `busyLine`, `syncChildren`, `buildCard`, `fuAct`/`mergeSession`,
  the Issues panel's `pickUp`, `/api/reply`, `/api/interrupt`, `/api/main/wake`.
- The page's colour tokens, light and dark; flat dots; tints, not outlines. Keyboard: j/k move between the buttons on
  Home, Enter presses the one in focus (not while typing).
- Checked in a second Glue on a spare port with its own data folder.

## Left to the builder
- Spacing, sizes, exact short words, how a line shortens at narrow widths.
