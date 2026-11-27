# Paste goals: a text box that makes goals and their parts

**Asked (2026-11-27):** "a text box where we drop text - that should create goals and sub items". Approved option: split
structured text locally, with a "Let Claude sort it" button for messy text, and always a preview before anything is made.

## What it is
- Home's goal head gets **Paste goals** next to **+ New goal**. It opens a box: a textarea (paste, type or drop a
  .txt/.md file) and a live preview underneath, one row per goal with its parts and a tick to leave it out.
- Pasting multi-line text into the one-line **+ New goal** box opens this box with that text.
- **Create N goals** makes them all in one go (one save, one broadcast). Nothing is made before that click.
- **Let Claude sort it** sends the text to `claude -p` (Sonnet, on the workspace's default Claude login, no tools,
  JSON schema, the same as Ask Glue's calls). Its answer is written back into the textarea as an outline
  (`# Goal` / `- part`), so the preview and any edits work the same way as for pasted text.

## How text splits (HomeBoard.outlineOf, shared by the page and the tests)
1. `#` headings are goals. Everything under one, bulleted or not, becomes a part.
2. No headings, but some lines are indented deeper than others: the shallowest lines are goals, deeper lines are parts.
3. All at one depth, a mix of plain and bulleted lines: plain lines are goals, bulleted lines are parts.
4. All at one depth, in blocks split by blank lines: each block's first line is the goal, the rest are parts.
5. Otherwise (one flat list or prose): the first line is the goal, every other line is a part.
Bullets (`-`, `*`, `+`, `•`, `1.`, `1)`, `[ ]`/`[x]`), `**bold**` marks and a title's trailing colon are taken off.
Lines are cut to the server's limits (120 for a goal, 300 for a part). At most 30 goals and 50 parts per goal.

## Approaches considered
- Local split only: instant and free, but messy notes come out as one big goal.
- Claude only: handles anything, but every paste waits 10–30 s and uses the login, even for a clean list.
- **Picked: local split first, Claude on request**, with Claude's answer fed back in as text, so there is one preview
  and one way to edit.

## Non-goals
Item states from `[x]`, notes, files, or linking spaces. Claude never creates anything itself: its answer is only text
in the box.
