# Overseer page, redesigned: a timeline on top, a "Waiting on you" board, and the chat docked at the bottom

## Context

The owner found the overseer page's UI/UX "very bad". Today it is a long chat with follow-up cards on top and grey event
lines (now folded) mixed into the conversation. From three mocked layouts they picked the **board + timeline** one, with
changes:
- **A timeline on top** for events, instead of events in the chat.
- **The board shows only what the sidebar doesn't.** The rail already has Needs you (permission prompts, questions),
  Working, Idle and Finished, so none of that is repeated here. The board holds what only the overseer works out: agents that
  finished but ask something ("should I merge this?") or stopped with work left. That's **one lane, "Waiting on you"**.
- **Merge from the card:** when a waiting agent's PR is green, its card gets **Merge #N**, and Glue merges it itself
  (`gh pr merge`, with the repo's default method) after one confirm click.

## Design

```
┌ ◼ Overseer · Sonnet ─────────────────────────────────────────────────────┐
│ 12:30 ··●····●●···◉····●·····●··                       now   [Clear]  │  ← timeline: a dot per event
│              ◉ CI failed on #12 · 14:05  (hover / focus)               │
│                                                                        │
│ WAITING ON YOU  3                                                      │
│ ┌──────────────────────────┐ ┌──────────────────────────┐ ┌───────────┐│
│ │ auth-ui · Asks you     × │ │ api-docs · Unfinished  × │ │fix-login ×││
│ │ Should I merge #14?      │ │ 2 of 5 endpoints left    │ │Migrate th…││
│ │ PR #14 ✓ checks·approved │ │                          │ │           ││
│ │ [ Yes, merge it.       ] │ │ [ Carry on with the…   ] │ │[ Yes, mi… ]││
│ │ [Merge #14] Send  Open ↗ │ │ [Keep going]   Open ↗    │ │[Send] Open││
│ └──────────────────────────┘ └──────────────────────────┘ └───────────┘│
├────────────────────────────────────────────────────────────────────────┤
│ ◼ 2 PRs are green; fix-login asks about a migration.      2 to confirm ⌃│  ← chat dock, collapsed
│ [ Ask the overseer…                                   ] [Sonnet] [Send] │
└────────────────────────────────────────────────────────────────────────┘
```

**Timeline** (`#h-time`, replaces events in the chat)
- One dot per event from the workspace feed (`ov.feed`, up to 200). The range runs from the oldest event in the last 24 h to
  now, at least 1 h, labelled at the start, middle and "now". Dots that would overlap stack into up to 3 rows.
- Colours reuse the feed's existing `data-t` colours: red for failures, amber for needs you, green for done or merged, blue
  for started or fix sent, grey for everything else. Loud events (the existing `LOUD` set) are larger.
- Hover or keyboard focus shows a one-line tooltip with the text and time. Clicking a dot that belongs to a session opens
  it. **Clear** sits at the right end, using the existing `/api/overseer/clear-feed` with a confirm click.
- An empty feed shows a thin empty track with "No events yet".

**Board** (`#h-board`, built from today's `#h-follow` cards)
- One lane, **Waiting on you · N**: the open follow-ups (`snap.overseer.follow`), both *asks you* and *unfinished*, as
  cards in a responsive grid (`repeat(auto-fill, minmax(260px, 1fr))`), newest first.
- A card holds the name, a tag (Asks you or Unfinished), × to dismiss, the question or what's left, and a PR line when the
  session has one (from `s.gh.pr` in the snapshot). It also has the drafted reply (one line that grows on focus, edits kept
  as today in `fuEdits`) and its actions:
  - **Send** (⌘↩) for Asks you, **Keep going** for Unfinished (it sends the drafted reply, so the label says what it does).
  - **Merge #N** when the PR is green: not a draft, and `mergeState === 'CLEAN'` (checks pass, no conflicts, review
    satisfied). It uses `armBtn` ("Merge #14" → "Confirm merge #14"). On success the card closes, and the merge shows up on
    the timeline when the poller sees it.
  - **Open ↗** opens the session.
- Empty: one quiet line, "Nothing waits on you. Agents that finish with a question or with work left show up here."
- **Removed:** the `#h-next` "N sessions need you" banner, since the rail's Needs you already shows it.

**Chat dock** (the chat moves to the bottom)
- Collapsed (the default): one line with the overseer's latest reply (its first sentence), a "N to confirm" badge when
  proposals wait, ⌃ to expand, and the composer and model picker below it.
- Expanded (⌃, focusing the composer, sending, or a new proposal arriving): the thread opens upward to about 60% of the
  page and scrolls. It holds only you, the overseer, and its proposal cards. The events and fold lines in the thread are
  gone, since the timeline has them. **Clear chat** sits in the dock's header. The intro and starter chips show inside
  the dock when the chat is empty.
- Whether it's expanded is remembered per browser (in try/catch `localStorage`, like other page conveniences).

**Merge (server)**
- `github.mjs`: `forSession()` adds `sha` to `pr`. A new `merge({ slug, number, sha })` runs
  `gh repo view <slug> --json viewerDefaultMergeMethod`, then
  `gh pr merge <n> --repo <slug> --merge|--squash|--rebase --match-head-commit <sha>`. Nothing deletes branches: GitHub's
  own repo setting decides that, so an agent's worktree is never touched. After a merge it calls `refresh()`.
  `classify()` turns errors into words.
- `server.mjs`: `/api/github/merge { sessionId }`. It checks that the session exists, `slugUsableIn(slug, ctx.focus)`, and
  that `sessionGh` for its place has a PR that is still green as the last poll saw it. It then merges with that `sha`, so
  a commit pushed since can't be merged blind. On success it closes the session's follow-up (`overseer.follow` dismiss,
  recorded as merged) and adds a timeline event.

