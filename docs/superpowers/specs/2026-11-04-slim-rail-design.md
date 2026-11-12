# Slim rail: one-line sessions, subagent trees, keys

*Design, 2026-11-04. The owner chose option C of the mockups (https://claude.ai/artifact/5GKcpam2Cs9KxJp71r1DDp); the calls marked "my call" are the author's.*

## Intent

The rail on the left of the board should be slim and fast to move through: one line per session, a session's
subagents nested under it in a small tree, and the keyboard doing the moving. Today's tiles are two-line cards with
borders and 8 px gaps; 320 px wide, four or five fit above the fold and the mouse is the only way around.

## Goals

1. **One line per session.** A 26 px row: a chevron slot, the state square, the name, the current tool (working or
   waiting sessions only), the age. No card border; hover highlight; the open session has a 1 px ring; a session that
   needs you sits on an amber tint with its tool name in amber.
2. **A space for each agent and its subagents.** A session with subagents gets a chevron; unfolded, its subagents hang
   under it as 24 px rows with tree lines, each with its own state square, title (or agent type) and age or outcome.
3. **Keys move you.** With focus outside text fields and no dialog open: ↑/↓ move the selection through the visible
   rows and open that session as they go; → unfolds the selected session's subagents, ← folds them; `n` jumps to the
   next session that needs you; `/` opens a find field that filters rows by name; Esc clears the find, then closes the
   open session as today. The rail's bottom shows the keys in one quiet strip.
4. **Nothing lost.** Everything the tile showed stays reachable: the branch and folder in the row's tooltip, the
   current tool's full text in the tooltip, the restart mark for a deleted Claude Code version as a small amber mark
   before the age, the hover action (Interrupt / End / Remove) in its place at the row's right, and the section bulk
   buttons (Interrupt all, End idle, Clear) in the section header.

## Non-goals

- Changing the drawer, the Chat, or the subagent details column. A subagent row in the rail opens its session and
  highlights that subagent in the details; the details themselves are unchanged.
- Redesigning the section model (Needs you, Working, Idle, Finished) or the fold-per-section behaviour.
- A full command palette. `/` filters names only.
- Touch layouts: under 860 px the rail keeps today's narrow behaviour, with the new rows.

## Anti-goals

- Rows that jump or re-order under the pointer while you aim at them. Subagent trees must not unfold or fold while
  the pointer is over that session's rows.
- Density that costs legibility: 13 px names, 11.5 px mono details, 4.5:1 contrast on every text, 26 px minimum row
  height (the hover action button stays 22 px).
- Keys that fire while you type. Every shortcut checks it is not in a text field, the launcher or a dialog.

## Design

### Rows

- Session row: `button.srow[data-state]` with a 12 px chevron slot (empty when the session has no subagents), a 7 px
  state square, the name (weight 500, ellipsis), a short mono detail, and the age (`ago(startedAt)`, right-aligned,
  26 px). Height 26 px, radius 5 px, padding 0 8 px 0 6 px.
- **The detail (my call).** A `busy` or `stopping` row shows `lastTool.tool`. A `waiting` row shows what is asked, from
  the pending request as today's `askText()` derives it: the tool name (`Bash`), `Asks` for a question, `Plan` for a plan
  review, with `sub:` in front when the ask comes from a subagent, and `+N` when more wait; with no request it shows
  `terminal`. Idle, finished and failed rows show nothing: the gist of the last message, "closed 3m ago" and the error
  note move to the tooltip and remain in the drawer. (This is the one place C drops something the old tile had in
  view; the owner can ask for a last-said gist back on idle rows.)
- The row's `title` is the tooltip: branch/worktree line, the folder, the full ask or current tool text, and for idle
  or finished rows the last-said gist or the ended/closed note.
- State colours as today: amber waiting, `--run` busy, `--idle-body`-like grey idle, `--ok` finished, `--stop` failed
  and stopping. Open row: `box-shadow: inset 0 0 0 1px var(--fg)`; waiting rows: `background: var(--amber-dim)`.
- **Text colour (my call).** Every rail text that is not the name uses `--fg-dim` (about 6:1 on the panel in both
  themes); `--fg-faint` fails 4.5:1 and is not used for text in the rail, headers and key strip included.
- The hover action (today's `.qstop`) stays, absolutely placed over the age on hover/focus-within, same confirm flow.
- Subagent row: `button.sub[data-state]`, 24 px, indented 24 px, tree lines drawn with `::before`/`::after` hairlines
  in `--line-strong`; a 5 px square; the title (`a.title ?? a.agentType`); then `ago(startedAt)` while running, `done`,
  `stopped`, or `asks you` in amber when a permission waits on it. Click: open the session and highlight that subagent
  in the details (`tasksOpen.add(agentId)` plus a scroll into view).
- Section header: 28 px, uppercase 11.5 px, weight 600, `--fg-faint` (amber for Needs you), count in mono; today's
  fold toggle and `peek` label stay; bulk buttons become the `small` 20 px variant.
- The rail's default width becomes 260 px (`--rail-w`); the drag bounds become 220 to 560 px.

### Unfolding (my call)

A session's tree is open while any of its subagents is `running` or `waiting`; it folds 20 s after the last one
finishes. A manual toggle (chevron click, → or ←) wins until a new subagent starts in that session, which resets to the
automatic rule. Folded or open state is page memory (a `Map` by session id), not persisted.

The pointer rule applies to automatic changes only, and (amended after review, my call) to the whole rail: while
the pointer is anywhere over the rail, no tree folds or unfolds by itself, because a tree above the pointer would
shift the row under it. The deferred changes apply together when the pointer leaves the rail. A chevron click or a
key acts at once. A new subagent row appearing in an already-open tree is appended at once.

Arrow keys from the page body count as the rail's only while the last click was in the rail (amended after review):
after a click into the conversation, the arrows scroll it, as they do anywhere else. ← with a subagent selected folds
the tree and selects its session, so ↓ continues from there.

### Selection and keys (my call)

- The selection is the open session (`open`); there is no separate cursor. ↑/↓ move `open` to the previous/next
  session row in the rail's visual order (across sections, skipping folded sections) and call `render()`, which opens
  it. When the selected session's tree is open, ↓ from it steps into its subagent rows (each selects the session and
  highlights that subagent), then on to the next session.
- → unfolds the selected session's tree (if it has subagents), ← folds it.
- `n` opens the next session in Needs you after the current one (wrapping), as the existing `asking()` order.
- `/` focuses a find field (`input#rail-find`, 26 px) at the top of the rail; typing filters session rows by
  case-insensitive substring of the name, sections with no match collapse to their header, counts show `shown/total`.
  Esc clears and hides the field; an empty field on blur hides it.
- Shortcuts are ignored when `dlg.open`, when `e.target` is inside `textarea, input, select, [contenteditable]`,
  `[role=menu]` or `[role=separator]` (the pane grips keep their own arrow keys), or when a modifier other than Shift is
  held. The arrow keys act only when focus is on `body` or inside the rail (`#board`); `n` and `/` act anywhere else
  too.
- Under the find filter, ↑/↓ move among the rows that match, starting from the open session when it matches, else
  from the first match; `n` skips filtered-out sessions; the drawer keeps showing the open session even when it no
  longer matches. Holding ↓ opens a session per step; the follow request is debounced by 120 ms so a held key does not
  flood the server.
- A subagent selected from the rail (click or arrow) sets `subFocus` (an agent id in page state); the details column
  marks that subagent's row with a `.focus` class on every render (so it survives the keyed rebuilds), unfolds the
  details column if it was folded away, and scrolls the row into view. Any other selection clears it.
- The key strip: `↑↓ move · → subagents · n next needs you · / find`, 11 px, at the rail's bottom; hidden when the
  rail is narrower than 240 px.

### What goes

- The tile's second line (tool + argument, or last message) and the `where` line. Both live in the tooltip and the
  drawer. The `N subs` badge goes: the tree shows them.

## Verification

No page test harness exists. The builder verifies with: `node --check` on the extracted inline scripts; a headless
Chrome load of a throwaway server with the console grep printing nothing; a scripted scenario against the throwaway
server that POSTs synthetic hook events (`SubagentStart`, `PreToolUse`, `SubagentStop`, a `PermissionRequest` hook as
`test/live-server.test.mjs` does) so the page shows a tree, an `asks you` row and the 20 s fold; and a hand check on the
owner's panel after merge: a session with running subagents shows its tree and folds 20 s after they finish; ↑/↓/→/←/n// behave as above
and never fire inside the reply box; the hover action still confirms and runs.

## Left to the builder

- Exact tree-line geometry and the chevron glyph (reuse the existing `.chev` rotation pattern).
- How the find field looks when empty; whether it animates in.
- The highlight used for a subagent selected from the rail in the details column.
- Whether the "shown/total" count renders as `3/6` or `3 of 6`.
- A saved rail width in `localStorage` keeps overriding the new 260 px default; that is fine.
