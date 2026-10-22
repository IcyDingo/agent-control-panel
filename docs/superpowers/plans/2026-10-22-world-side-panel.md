# World side panel (icon rail) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace World's column of boxes, in the app and on the galaxy page, with an icon rail that opens one card at a time, with planet chips for building on Home or any colony and the activity mosaic in the app's Profile.

**Architecture:** The existing boxes keep their ids (world.js finds them by id on both pages) and are wrapped in card sections; a rail of buttons switches which card shows. world.js owns the rail (both pages), the Build chips, the app's mosaic, and two new hooks the galaxy page uses: `AgentWorld.flyTo(id)` and `opts.onPlace(id)`.

**Tech Stack:** Plain HTML/CSS/JS in `public/index.html`, `public/world.js`, `hub/public/system.html`, `hub/public/hub.css`. No build step. Node's test runner for the existing tests.

**Spec:** `docs/superpowers/specs/2026-10-22-world-side-panel-design.md` (mockups: `docs/superpowers/specs/2026-10-22-world-side-panel-options.html`, row C)

## Global Constraints

- Keep every id world.js looks up on both pages (`w-level`, `w-stage`, `w-xp`, `w-bar`, `w-next`, `w-xp-today`, `w-bar-today`, `w-credit`, `w-build-*`, `w-rocket-*`, `w-push-*`, `w-dir`, `w-aim`, `w-moment`, `w-m-*`, `w-moments*`, `w-today*`, `w-total`, `w-noemail`, `w-pf-*`, `w-home`, `w-map`, `w-colonies`, `w-where`, `w-side`, `w-canvas`).
- Card visibility never uses the `hidden` attribute of a box world.js already toggles: wrap boxes in `section.w-card[data-card]` and toggle the wrapper.
- Visitors never see credit, today's numbers, XP numbers or orders (`body.w-readonly` stays as is).
- No new data: no change to `world.mjs`, the projection, `hub.mjs`, `server.mjs` or any hub API.
- Rail: 56px wide, buttons 44px, `--panel` ~92% surface, 1px `--line`, 14px radius; card 320px, 12px radius; open icon `--amber` on `--amber-dim`.
- Narrow screens: below 760px (app) / 900px (site) the rail is a row under the map and the open card sits under it full width.
- `localStorage` reads and writes are wrapped in try/catch.

## Review Focus

- **No colonies yet** (the owner's real state): Build shows one chip, Home; the rocket card says to push the frontier first; nothing throws.
- **Map zoom or a bare planet in view**: on Map zoom the chip for `here` stays lit; on a bare planet no chip is lit and Build says to pick a planet you own.
- **A build or order in flight while switching cards**: closing or switching cards doesn't lose the text or the busy state; the icon shows busy.
- **Signed out in the app**: Profile shows the sign-in flow and still the mosaic and stats.
- **Visitor on the galaxy page**: rail has Profile and Moments only; colony buttons appear bottom-left; no owner-only number anywhere.

Each is checked in Task 5's browser pass.

---

### Task 1: The rail and cards in world.js

**Files:**
- Modify: `public/world.js` (wire(), flyTo(), showBuild(), showRocket(), showColonies(), pick(), showMoments(), show(), showHub(), window.AgentWorld)

**Interfaces:**
- Produces, markup contract both pages follow: `#w-rail` holds `button[data-card="<name>"]`; `#w-side` holds `section.w-card[data-card="<name>"]`, each with a close `button.w-card-x`. Rail buttons carry `aria-pressed`, a `title` and an `aria-label`.
- Produces: `openCard(name: string | null): void` (private): shows that card, `aria-pressed` and `.on` on its button, everything else hidden; `null` closes all. A click on the open card's button, or its `.w-card-x`, calls `openCard(null)`. Remembers the name in `localStorage[opts.card.key]` when `opts.card?.key` is set.
- Produces: `enter(summary, options)` accepts `options.card = { key?: string, first: string }`; the first card is the remembered one if it still has a rail button, else `first`. No `options.card`: no card opens.
- Produces: `AgentWorld.flyTo(id: string): void` (the existing flyTo) and `options.onPlace?: (id: string) => void`, called at the end of every flyTo.
- Produces: rail button classes `has` (amber dot: the rocket button while a bare planet exists) and `busy` (blue dot: the build button while `buildingOn`).

- [ ] **Step 1: Rail wiring.** In `wire()`, when `$('w-rail')` exists, set each rail button's `onclick` to toggle its card, and each `.w-card-x` to `openCard(null)`. In `enter()`, after `show(summary)`, open the first card per `options.card`.
- [ ] **Step 2: Build chips.** `showBuild()`: `#w-build-title` reads `Build`; render `#w-build-on` as one `button.w-place` per place (Home, then each `planets().filter(colonyOf)` by colony name), each with `data-place`, a planet dot `<i>` styled from `LOOK[p.look][0]` (Home: `#4a86c0`), `aria-pressed` = `here === id`, `onclick = () => flyTo(id)`; rebuild only when the list signature changes, otherwise just toggle `.on`/`aria-pressed`. The build button reads `Build on ${placeName(here)}` (busy: `Building on …`). When `here` is not yours, hide `#w-build-box` (as today) and show `#w-build-none` ("Pick Home or one of your colonies to build there."); chips stay visible above both. Toggle `busy` on the rail's build button.
- [ ] **Step 3: Rocket empty state and dot.** `showRocket()`: with no bare planet, show `#w-rocket-none` ("Push the frontier to find a planet first.") instead of leaving the card empty; toggle `has` on the rail's rocket button by `list.length > 0`.
- [ ] **Step 4: Moments.** `pick(id)` with a moment calls `openCard('moments')` when a rail exists. `showMoments()` toggles `#w-moments-none` ("No moments yet. A week of work, a big cleanup or a new level adds a star.") inverse of `#w-moments-box`.
- [ ] **Step 5: Colonies in read-only.** Remove `showColonies()`'s read-only early return, so the galaxy page gets colony buttons. `flyTo()` calls `opts.onPlace?.(id)` last; export `flyTo` on `window.AgentWorld`.
- [ ] **Step 6: The HUD's text.** In `show()`: `#w-next` = `${h.stage} → ${h.next.name}` (top level: `${h.stage}, the top level`); `#w-xp-today` = `+${fmt(today)} today` with the old sentence moved to its `title`.
- [ ] **Step 7: The app's mosaic and stats.** Add `daysMosaic(worked: string[]): HTMLElement` to world.js, copied from `Hub.daysMosaic` in `hub/public/hub.js` with its `hashOf`, `pick` and `mosaic` (same classes `days`, `mosaic`, `q1..q4`, `a0..a2`, `cap`, 20 columns). In `show()`, when `$('w-pf-days')` exists and not read-only: fill it with `daysMosaic(w.worked ?? [])`, rebuilt only when `w.worked` changes; `#w-pf-stats` = `Active N days · N colonies · N builds · World since <Month Year of w.startedAt>` using `w.daysActive`, colonies from `planets().filter(colonyOf).length`, `w.builds.length`.
- [ ] **Step 8: The rail avatar.** In `showHub()`, put `avatarOf(a)` (signed in) into `#w-rail-avatar`, and a person mark (signed out) otherwise; same `_sig` caching as `#w-pf-avatar`.
- [ ] **Step 9: Run the tests.** Run: `npm test`. Expected: all pass (world.js has no Node tests; this guards nothing else moved).
- [ ] **Step 10: Commit.** `git add public/world.js && git commit -m "feat(world): a rail of cards, build chips for every planet, the app's mosaic"`

### Task 2: The app's World markup and CSS

**Files:**
- Modify: `public/index.html` (`#world` markup ~lines 835-922; World CSS ~lines 455-520; the `AgentWorld.enter` call ~line 2512)

**Interfaces:**
- Consumes: Task 1's markup contract, card names `profile`, `build`, `rocket`, `push`, `moments`, `today`, and `options.card`.

- [ ] **Step 1: Markup.** Inside `#w-side`: `nav#w-rail` (aria-label "World tools") with buttons in this order: profile (`<span id="w-rail-avatar">`), divider, build (cube), rocket (rocket), push (compass), divider, moments (star), today (bar chart); inline stroke SVG icons as in the mockup. Then the cards: `profile` wraps `#w-profile` plus `#w-pf-stats` (p) and `#w-pf-days` (div) placed outside `#w-pf-in`/`#w-pf-out` so they show signed out; `build` wraps `#w-build-on` (radiogroup "Where to build"), `#w-build-box`, `#w-build-none`; `rocket` wraps `#w-rocket-box` and `#w-rocket-none`; `push` wraps `#w-push-box`; `moments` wraps `#w-moment`, `#w-moments-box`, `#w-moments-none`; `today` wraps `#w-today-box` and `#w-total-box`. Move the Home box out of `#w-side` into `div.w-hud` (top left), keeping its ids. Each card gets a heading row and a `.w-card-x` close button; drop the boxes' own `h2` where the card heading repeats it.
- [ ] **Step 2: CSS.** `.w-side` becomes a flex row anchored top right (card left of rail), `.w-rail`, `.w-card`, `.w-place` chips (28px, 14px radius, `.on` amber), the `has`/`busy` dots, `.w-hud` (268px, top left at `var(--sp-top) + 14px`), copied `.mosaic`/`.days` rules from hub.css. `side()` in world.js keeps reading `#w-side`'s left edge, so the map centres in what the rail and card leave. Narrow (≤760px): rail as a horizontal row, card full width under it, HUD static above.
- [ ] **Step 3: Enter with a card.** The `AgentWorld.enter` call passes `card: { key: 'acp.world.card', first: 'build' }`.
- [ ] **Step 4: Commit.** `git add public/index.html && git commit -m "feat(world): the app's World as a rail of cards with Home's level top left"`

### Task 3: The galaxy page

**Files:**
- Modify: `hub/public/system.html`, `hub/public/hub.css` (World section ~lines 190-261)

**Interfaces:**
- Consumes: Task 1's contract, `AgentWorld.flyTo`, `options.onPlace`, `options.card`. Card names `profile`, `moments`, `orders`.

- [ ] **Step 1: Markup.** `#w-side` gets `nav#w-rail` (aria-label "Galaxy"): profile (owner's avatar, filled by `card()`), moments (star, with `#w-rail-n` count), divider, orders (rocket; the button and its divider `hidden` unless the viewer owns the galaxy; title "Your orders (only you see this)"). Cards: `profile` wraps `#sys-card`; `moments` wraps `#w-moment`, `#w-moments-box`, `#w-moments-none`; `orders` wraps `#w-owner`. The Home box (`w-level` …) stays in the markup, `hidden`, for world.js. The read-only spend boxes stay where they are, hidden by `body.w-readonly`.
- [ ] **Step 2: Orders as tabs with chips.** In `#w-owner`: credit at the top (`#o-balance` as "6,101 credit"), a tablist Build / Rocket / Push switching the three `.own-ctl`, Build first. Replace `select#o-on` with `div#o-on` of `button.w-place` chips (Home + `sys.planets` with a colony), filled in `fill()`; a chip click calls `AgentWorld.flyTo(id)`. Keep the build target in a variable `buildOn` set by `options.onPlace` (bare planet: `null`, build button disabled, `#o-build-why` "Pick Home or one of your colonies."). The build button reads `Build on <name>`; the order posts `on: buildOn`.
- [ ] **Step 3: Enter.** `AgentWorld.enter(…, { readOnly: true, card: { first: 'profile' }, onPlace, … })`; `card()` also puts `avatar(profile, 26)` into the rail's profile button and drops the "Level · stage" duplicate only if it now repeats (it stays once, in the card).
- [ ] **Step 4: CSS.** Same rail/card/chip/dot rules as the app (copied, as hub.css already copies World's rules); `.sys-card .days` no longer bleeds past a card edge it doesn't have. Narrow (≤899px): rail as a row under the canvas, card full width.
- [ ] **Step 5: Run the tests.** Run: `npm test`. Expected: all pass (hub-server tests serve these files).
- [ ] **Step 6: Commit.** `git add hub/public/system.html hub/public/hub.css && git commit -m "feat(hub): the galaxy page's rail, with your orders and planet chips for the owner"`

### Task 4: Docs

**Files:**
- Modify: `README.md` (the World paragraph, if it describes the side boxes)

- [ ] **Step 1:** Update any README sentence that describes World's boxes to the rail and cards. Commit with the spec, plan and options page: `git add README.md docs/superpowers && git commit -m "docs: World's side panel as a rail of cards"`

### Task 5: Browser pass

- [ ] **Step 1: The app from this worktree.** Write a `world.json` like `test/world-projection.test.mjs`'s `rich()` (21 days of tokens, a push, a rocket landing colony "Vesta" on `p0`, a build on Home) under a temp `ACP_PREFS` folder's `world/`, then run `ACP_PORT=4790 ACP_PREFS=<tmp>/prefs.json node server.mjs`, open `http://127.0.0.1:4790/world`. Expected: Build card open; chips Home and Vesta; clicking Vesta flies there and the button reads "Build on Vesta"; Map keeps Vesta lit; a bare planet lights no chip and shows the pick-a-planet line; Profile shows sign-in, stats and the mosaic; reload remembers the last card; rocket icon dot only with a bare planet; 700px wide stacks.
- [ ] **Step 2: The site.** `HUB_DEV_LOGIN=1 HUB_PORT=4849 node --no-warnings=ExperimentalWarning hub/server.mjs` (with a temp data dir if the config takes one), sign in as a dev user, open its `/@handle` signed in and in a private context. Expected: owner sees Profile/Moments/Orders, Orders has Build/Rocket/Push tabs and a Home chip; visitor sees only Profile/Moments; 800px wide stacks.
- [ ] **Step 3:** Fix what fails, re-run `npm test`, commit fixes.
