# Paste a goal: a text box that makes one goal and its parts

**Asked (2026-11-27):** "a text box where we drop text - that should create goals and sub items". Approved option: split
text locally, with a "Let Claude sort it" button for messy text, and always a preview before anything is made.
**Changed the same day:** "the goal text box should only be for one goal and then creating it subparts - not many
goals". The first version (#128) split text into many goals; this one makes exactly one.

## What it is
- Home's goal head has **Paste a goal** next to **+ New goal**. It opens a box: a textarea (paste, type or drop a
  .txt/.md file) and a live preview underneath: the goal, then its parts, each with a tick to leave it out.
- Pasting multi-line text into the one-line **+ New goal** box opens this box with that text.
- **Create goal with N parts** makes the goal and its ticked parts in one go (one save, one broadcast) and opens the
  goal's page. Nothing is made before that click.
- **Let Claude sort it** sends the text to `claude -p` (Sonnet, on the workspace's default Claude login, no tools,
  JSON schema `{ title, items }`, the same kind of call as Ask Glue's). Its answer is written back into the textarea
  as text (the goal, then `- part` lines), so the preview and any edits work the same way as for pasted text.

## How text splits (HomeBoard.pastedGoal, shared by the page and the tests)
The first line with words is the goal; every line under it is a part, nested or not, headings included (untick what
you don't want). Markers (`#`, `-`, `*`, `+`, `•`, `1.`, `1)`, `[ ]`/`[x]`), `**bold**`, backticks and a title's
trailing colon are taken off. Lines are cut to the server's limits (120 for a goal, 300 for a part), 50 parts at most.

## Approaches considered
- Local split only: instant and free, but a messy paste gives a poor title and parts.
- Claude only: handles anything, but every paste waits a few seconds and uses the login, even for a clean list.
- **Picked: local split first, Claude on request**, with Claude's answer fed back in as text, so there is one preview
  and one way to edit.

## Non-goals
Several goals from one paste. Item states from `[x]`, notes, files, or linking spaces. Claude never creates anything
itself: its answer is only text in the box.
