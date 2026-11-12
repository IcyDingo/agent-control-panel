# Clean Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Quieter chrome: a trimmed top bar, one-line banners, a one-line session header, no duplicate now-line, one options chip in the reply box, side actions in a row.

**Architecture:** All in `public/index.html`: CSS for `.btn.icon`, the folded banner, the header meta line, the chip and its popover, the two-column side actions; JS edits in `countsInto`, `renderOld`, the `d-head` patch, the `d-line` patch, `renderCompose` (chip label + popover), the notify button. Every existing id and handler stays.

**Tech Stack:** Vanilla browser JS and CSS, one HTML file.

**Spec:** `docs/superpowers/specs/2026-11-04-clean-pass-design.md`

## Global Constraints

- No behaviour change: `#d-mode`, `#d-model`, `#d-effort`, `#d-send`, `#armed`, `#notify`, `#new-agent`, `.d-expand`, Close keep their ids, handlers and effects.
- Icon buttons: `.btn.icon`, 24×24, inline stroke SVG, `aria-label` and `title`.
- Text other than names and headings uses `--fg-dim` or stronger.
- Nothing hidden that the owner needs to act on: the restart list is one click away; every hint string survives as a tooltip.

## Review Focus

1. The banner × must not hide a new deleted-version session that joins later. (Task 1 scenario: dismiss, add a session to `oldVersions`, banner returns.)
2. The popover must close on Escape without the global Escape closing the session. (Task 3 scenario.)
3. The chip label must track a select change at once. (Task 3 scenario: change `#d-mode` in the popover, label updates.)
4. A waiting session with a request still shows its now-line (the request card is elsewhere; the line names the ask). (Task 2 scenario.)
5. Narrow drawers (<900 px) keep the two side buttons readable (they fall under the chat). (Task 4: hand check.)

---

### Task 1: Top bar and banners

**Files:** `public/index.html` top bar markup (~555-570), `.top`/`.counts` CSS, `countsInto` (~1252), `renderOld` (~1270), notify (~833).

- [ ] **Step 1 (RED):** scenario group 5 checks: `#notify` has `aria-label` and class `icon`; `#counts` text does not contain "0 "; `.switch` label text is "Answering here"; with `oldVersions` of two entries injected into `snap` (page-side, by evaluating `snap.oldVersions = […]; render()`), `#old-ver` is ≤ 34 px tall, contains a button "Show which", clicking it reveals a `ul`, the × hides the banner, and injecting a third entry brings it back.
- [ ] **Step 2:** CSS `.btn.icon { width: 24px; padding: 0; justify-content: center; color: var(--fg-dim); } .btn.icon svg { width: 13px; height: 13px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }`; `.banner.old` becomes `display:flex; align-items:center; gap:10px; min-height:30px; padding-block:4px` with `.banner.old ul` shown only when `.open` (full width, `flex-basis:100%`).
- [ ] **Step 3:** markup: `#notify` → `<button class="btn icon" id="notify" aria-label="Turn on desktop alerts" title="Turn on desktop alerts" hidden><svg …bell…></svg></button>`; switch label text `Answering here`.
- [ ] **Step 4:** `countsInto` skips zero queues. `renderOld`: `let oldOpen = false, oldDismissed = '';` summary span + `Show which`/`Hide` button toggling `oldOpen` + `×` setting `oldDismissed = key` where `key = list.map(o => o.sessionId).sort().join(',')`; `b.hidden = !list.length || oldDismissed === key`.
- [ ] **Step 5 (GREEN):** run group 5 part 1; `node --check`; commit `Chrome: trimmed top bar, one-line restart banner`.

### Task 2: Header line and now-line

**Files:** `d-head` patch (~1310-1330), `.d-top*`/`.d-facts` CSS, `d-line` patch (~1343), `d-info` (~1348) for the moved rows.

- [ ] **Step 1 (RED):** scenario: with a busy session open, `.d-top` height ≤ 48 and `.d-facts` absent and `.d-meta` text matches `/Working · Headless · .* · up/` (hook-only sessions have no mode: the mode segment is omitted); `.d-expand` has `aria-label`; `#d-line` is hidden while busy; with a held request (waiting) `#d-line` is visible and names the ask.
- [ ] **Step 2:** header: `el('div', { class: 'd-top' }, glyph, h2.d-name, span.d-meta(text), grow, expand icon btn, close icon btn)`; meta text `[stateWord, KIND[s.kind] || 'Headless', s.mode ? modeOf(s.mode) : null, s.startedAt ? 'up ' + ago(...) : null].filter(Boolean).join(' · ')` (the age moves into the meta and updates through the existing `setText(.age)` → change that line to update `.d-meta`); drop `.d-facts`; keep notes; move `sharers`/`elsewhere` into `d-info` as `dt Shares with` / `dt Also edits`.
- [ ] **Step 3:** `d-line`: compute `showNow = st === 'waiting' || st === 'stopping' || isOver(s) || Boolean(s.leftRosterAt)`; `$('d-line').hidden = !showNow`; patch as before when shown.
- [ ] **Step 4 (GREEN):** run; commit `Session header on one line; the now-line only when the thread cannot show it`.

### Task 3: Options chip and popover

**Files:** compose markup (~608-620), `.c-bar`/`.c-mode` CSS, `renderCompose` (~1744-1775), send-hint (~1772).

- [ ] **Step 1 (RED):** scenario: `#d-opts` exists; `.c-pop` exists and is hidden; the three selects are inside `.c-pop`; clicking `#d-opts` shows `.c-pop`; Escape hides it and leaves `open` unchanged; changing `#d-mode` updates the chip text; `#d-send-hint` is empty or hidden when the text is not "Switching…", and `#d-send` has a non-empty `title`.
- [ ] **Step 2:** markup: `<div class="c-opts"><button class="btn quiet small" id="d-opts" aria-haspopup="dialog" aria-expanded="false"></button><div class="c-pop" id="d-pop" role="dialog" aria-label="Mode, model and effort" hidden>` + the three selects + `</div></div>`; CSS `.c-opts { position: relative } .c-pop { position: absolute; left: 0; bottom: calc(100% + 6px); display: grid; gap: 6px; padding: 8px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--raise); box-shadow: 0 12px 28px -16px var(--shade); z-index: 7 } .c-pop .c-mode { width: 100%; border: 1px solid var(--line); border-radius: 6px }`.
- [ ] **Step 3:** JS: `chipLabel()` joins the selected option text of the three selects with ` · `, called at the end of `renderCompose` and in each select's `onchange` (before their existing bodies); `#d-opts` toggles `#d-pop` and `aria-expanded`; a document `pointerdown` outside `.c-opts` closes it; Escape inside the popover closes it with `stopImmediatePropagation`.
- [ ] **Step 4:** hint: keep `setText($('d-send-hint'), to ? 'Switching…' : '')` and set the former sentence as `title` on `#d-send`; CSS `.c-hint:empty { display: none }`.
- [ ] **Step 5 (GREEN):** run; commit `Reply box: one options chip with a popover; hints as tooltips`.

### Task 4: Side actions and finish

**Files:** `.side-acts` CSS (~300), README (the session panel paragraph).

- [ ] **Step 1:** `.side-acts { grid-template-columns: 1fr 1fr } .side-acts .hint { grid-column: 1 / -1 }`; buttons get `small` to fit at 220 px.
- [ ] **Step 2:** README: the session panel paragraph (name/facts/options) says the header is one line, the options chip, and the folded banner.
- [ ] **Step 3:** full scenario (groups 1–5), `npm test`, console grep; screenshot of the live panel with this session open after merge. Commit `Side actions side by side; README`.
