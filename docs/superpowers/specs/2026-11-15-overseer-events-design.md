# Overseer: folded events, and clearing them

## Why
Events (an agent finished its turn, started, CI, merges…) sit in the overseer's chat as grey lines, up to 40 of them.
Every agent stop adds one, so they crowd out the conversation, and Clear only emptied the chat.

## Approaches
- **Fold into one line (picked by the owner):** of each run of events between two messages, the ones that failed or
  need you stay in view; the rest fold into "12 events · 14:02–14:30", which opens on a click.
- A separate Activity timeline beside the chat: a bigger layout change.
- Show only important events, with a toggle for the rest: hides runs completely instead of summing them up.

Clearing: **separate buttons** (picked by the owner): Clear chat and Clear events, each on its own.

## Design
- Loud events, always shown: needs-you, failed, ci-failed, main-failed, fix-failed, fix-capped, fix-alert.
- A run with fewer than two quiet events shows them as they are. A fold you opened stays open across updates.
- The page considers the last 200 events (it showed only the last 40 before), since folding keeps them short.
- **Clear events** (`/api/overseer/clear-feed`, `overseer.clearFeed()`): empties the workspace's feed. The page shows none
  of it, and the overseer no longer reads it. The chat stays. Sequence numbers count on. `status().feedStart` (the seq at the
  clear) tells every open page to drop what it holds. Kept in the overseer's file.
- **Clear chat** is the old Clear, renamed. Each button shows only when there is something to clear, and asks you to confirm.
