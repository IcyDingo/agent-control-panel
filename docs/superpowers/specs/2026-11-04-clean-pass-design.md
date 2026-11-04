# Clean pass: quieter chrome around the board

*Design, 2026-11-04. The owner asked for a "more clean UI" and to make the calls without a menu of options; this records
the calls. Before/after mockup: https://claude.ai/artifact/T2jX87kTRiiBmnXBMFtRvT.*

## Intent

The board's chrome should get out of the way of the sessions: fewer words in the top bar, warnings that take one line
until asked, a session header that is one line, no line that repeats what the thread already shows, and a reply box
with one compact control instead of three dropdowns.

## Goals

1. **Top bar.** Brand, profile, the live dot, counts that only name non-zero queues (Needs you in amber when it is
   not zero), then a bell icon for desktop alerts, the answering toggle labelled "Answering here", the theme button
   and New agent. The "Paused" notice stays when the toggle is off.
2. **Banners fold to one line.** The deleted-version banner shows a one-line summary with a "Show which" button that
   unfolds today's list and a × that dismisses it for this page load (it comes back when a new session joins the list).
   The connect-profile banner is unchanged in content but uses the same one-line shape.
3. **Session header on one line.** State square, name, then `State · Kind · Mode · up 11h` in dim text, then Expand and
   Close as icon buttons with tooltips. "Shares this checkout with…" and "Also edits files in…" move to the details
   column as rows. The restart note and the short "sent" note stay under the header line when present.
4. **No duplicate now-line.** The pinned "Working · Bash …" line above the reply box goes while the session is working
   or idle, because the live thread's last row already shows it; it stays only for the states the thread cannot show
   (waiting with a request, stopping, closed, ended).
5. **One options chip in the reply box.** The three selects become one chip reading `Auto mode · Fable 5.1 · High`
   that opens a small popover holding the same three selects (so every existing handler keeps working); the helper
   sentence under the box becomes the Send button's tooltip, except the "Switching…" progress text, which stays
   visible.
6. **Side actions side by side.** Interrupt / End session (or Remove / Hide) sit in one row as two half-width buttons;
   the confirm hint shows beneath when armed.

## Non-goals

- Changing the rail (done in the slim-rail pass), the thread rows, the request cards or the launcher.
- Changing any behaviour: every button, select and handler keeps its id and effect.

## Anti-goals

- Hiding information the owner needs to act (the restart command, the full ask) rather than folding it one level down.
- A chip whose popover traps focus or blocks Enter in the textarea.

## Design notes (my calls)

- Icon buttons reuse `.btn.icon` (24×24, 13 px stroke icons inline SVG) with `aria-label`; the bell shows only while
  permission is `default`, as the link did.
- Counts: `countsInto` skips zero queues; when every queue is zero it shows nothing.
- The banner fold: `renderOld` renders `summary` + `Show which` + `×`; an `oldOpen` flag toggles the list; a
  `oldDismissedFor` string of the current session-id list hides it until the list changes.
- Header meta: `${stateWord} · ${KIND[s.kind] || 'Headless'} · ${modeOf(s.mode)} · up ${ago}`; the mode keeps the
  `bypassPermissions` red through a span.
- `nowLine` is shown only when `st` is `waiting`, `stopping`, or the session is closed or ended (`isOver` or
  `leftRosterAt`); `d-line` is hidden otherwise.
- The chip text comes from the selects' selected option labels; the popover is a `div.c-pop` positioned above the chip,
  toggled by the chip, closed on outside click or Escape; the selects move into it unchanged.
- `#d-send-hint` keeps the switching text; every other hint string becomes `title` on `#d-send`.
- `.side-acts` becomes a two-column grid with the hint spanning both.

## Verification

Headless-Chrome scenario against a seeded server for what seeding can reach (top bar, banner shape with a synthetic
list, header line height, hidden now-line while busy, chip present and selects inside the popover, side actions in
one row), `node --check`, the console grep, then a screenshot of the owner's live panel with this session open.
