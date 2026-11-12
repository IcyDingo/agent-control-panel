# Exploring from colonies, and probes into the Universe — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pushes can leave from colonies, walled-in dark fills in, and a Universe zoom past Map shows the galaxies your probes found, in the app and on the galaxy page.

**Architecture:** `world.mjs` keeps the rules (lobes per place, probes as purchases, the projection v2 and its validator, the walled-in fill as a pure function that `world.js` copies). The hub gains a probe-target lookup, a names lookup, v1/v2 uploads and two new order shapes. `server.mjs` wires the app's routes to both. `world.js` draws lobes from their place, the fill, and the Universe; `index.html` and `hub/public/system.html` get the cards and tabs.

**Tech Stack:** Node ≥ 22 ESM, `node:test`, plain browser JS and canvas, no build step.

**Spec:** `docs/superpowers/specs/2026-10-22-branches-and-probes-design.md`

## Global Constraints

- Prices flat: `PRICES = { frontier: 4000, rocket: 4000, build: 4000, probe: 4000 }`.
- `PUSH_LEN` 150, `LIGHT_CREDIT` 3000, `JOIN` 20°, Home lobe start `LOBE_START` 60, colony lobe start 30.
- Pushes with no `from` are from Home; every existing test's numbers stay as they are.
- A probe's cone is 30° either side of its aim; the fallback is the nearest galaxy anywhere.
- Candidates: `visibility = 'public'`, has a row in `systems`, not the caller, not in `skip`.
- `PROJECTION_VERSION = 2`; the hub and `validProjection` also accept `pv: 1`.
- Copy quoted in the spec is exact: "Push from Home or one of your colonies.", "There's no one new to find yet.",
  "The hub can't be reached, so a probe can't be aimed. Try again later.", "Your probe found @kim's galaxy.",
  "Update the panel on your Mac to push from a colony.", "Sign in to explore the Universe",
  "Send a probe to find the galaxies around you.", "Pick Home or one of your colonies to push from."
- No secrets or private numbers in the projection; `publicProjection` stays an allow-list.
- Comment density and naming as the surrounding code (JSDoc one-liners, terse).

## Review Focus

1. A world.json from before this change (pushes without `from`, no probes) produces exactly today's summary and projection shape apart from the added `from: 'home'` and `probes: []`.
2. A Mac on version 1 talking to an updated hub: its uploads are accepted, its page shows only Home in Push from, and probe or colony-push orders are refused with the update message.
3. Signed into a different account than the one that sent probes: those probes are not drawn, not in the projection, and not in the `skip` list sent to the hub.
4. A pocket of dark with a visible gap stays dark; one fully ringed fills; growing the map doesn't reopen a filled pocket.
5. A probe bought while the hub is unreachable or returns no target spends nothing; a balance that drops while the hub answers is re-checked.

---

### Task 1: Pushes from colonies (world.mjs)

**Files:**
- Modify: `world.mjs` (`frontierOf`, `momentsOf`, `summary`, `buy`)
- Test: `test/world-frontier.test.mjs`

**Interfaces:**
- Produces: `frontierOf(purchases, peak, seed)` lobes `{ from, ox, oy, start, ang, pushes, lit, tip }` (`tip = start + lit`); summary `frontier[i] = { from, ang, bought, lit, tip }`; `buy({ kind: 'frontier', ang, from })`; exported `COLONY_LOBE_START = 30`.

- [ ] **Step 1: Write the failing tests** in `test/world-frontier.test.mjs`:
  - `'a push leaves from a colony, starting 30 px out from it'`: purchases `[push(0), rocket p0 'Vesta', { kind:'frontier', ang: Math.PI/2, from:'p0', earnedAt:0, price:4000, at }]`, earned enough; `frontierOf(...).lobes[1]` has `from:'p0'`, `ox/oy` equal p0's x/y, `start: 30`; a planet it holds (if any) lies at `ox + cos·along` etc.
  - `'pushes join only from the same place'`: a Home push at ang 0 and a p0 push at ang 0.1 make two lobes; a second p0 push at 0.15 joins the p0 lobe.
  - `'a push from a bare planet, an unknown place or a planet not found is refused'`: `buy({kind:'frontier', ang:0, from})` for `'p0'` bare, `'p9'`, `'nowhere'` → `{ ok:false, error:'Push from Home or one of your colonies.' }`, nothing saved.
  - `'a push with no from is from Home, and the summary says so'`: existing seeded world; `summary().frontier[0].from === 'home'` and every other field equals today's (`ang, bought, lit, tip`).
  - `'a moment along a colony lobe sits along that lobe'`: a week of work after the p0 push; its x/y lies within the p0 lobe's radius of the segment from (ox,oy).
- [ ] **Step 2: Run** `node --test test/world-frontier.test.mjs` — Expected: the new tests FAIL.
- [ ] **Step 3: Implement.** In `frontierOf`, for each push resolve `from = p.from ?? 'home'`, its origin `{0,0}` or the planet already pushed into `planets` with that id, and `start` 60 / 30; find a lobe with the same `from` within `JOIN`; planet position = origin + `toMap(ang, along, off)` with `along = start + before + …`. In `momentsOf` place along the lobe from its origin with `from = lobe.start * 0.6`. In `buy`, `from` other than `'home'` must be a planet in `s.planets` with a colony; keep `from` on the purchase only when it is not `'home'`.
- [ ] **Step 4: Run** `npm test` — Expected: all pass, including every existing frontier/colony/build/projection test unchanged.
- [ ] **Step 5: Commit** `feat(world): a push can leave from a colony`.

### Task 2: Walled-in dark (world.mjs pure function)

**Files:**
- Modify: `world.mjs` (new export `walledIn`)
- Test: `test/world-frontier.test.mjs`

**Interfaces:**
- Produces: `walledIn(grid: Float32Array, n: number, dark = 0.3): Float32Array` — a copy where every cell `< dark` that a 4-neighbour flood from the border over cells `< dark` does not reach is set to 1. `world.js` copies it verbatim (Task 6).

- [ ] **Step 1: Write the failing tests:**
  - `'a ring of light fills the dark inside it'`: 9×9 grid, ring of 1s at distance 3 from centre, 0 elsewhere → inside cells 1, outside 0.
  - `'a gap in the ring lets the dark out'`: same ring with one cell 0 → inside stays 0.
  - `'light is never dimmed'`: values ≥ `dark` come back unchanged; input not mutated.
- [ ] **Step 2: Run** — Expected: FAIL (`walledIn` not exported).
- [ ] **Step 3: Implement** with an explicit stack (no recursion).
- [ ] **Step 4: Run** `npm test` — Expected: pass.
- [ ] **Step 5: Commit** `feat(world): dark walled in by light counts as lit`.

### Task 3: Probes and projection v2 (world.mjs)

**Files:**
- Modify: `world.mjs` (`PRICES`, `summary`, new `probe`, `publicProjection`, `validProjection`, `PROJECTION_VERSION`)
- Create: `test/world-probe.test.mjs`
- Modify: `test/world-projection.test.mjs`, `test/hub-sync.test.mjs` (version and new fields)

**Interfaces:**
- Consumes: Task 1's `frontier[].from`.
- Produces:
  - `PRICES.probe = 4000`; `summary().prices.probe`.
  - `summary().probes = [{ id: 'q<i>', ang, by:{x,y}, to:{x,y}, progress, arrived }]` (`progress = min(1, max(0, (peak - earnedAt) / LIGHT_CREDIT))`).
  - `world.probe({ ang, me, find }) → Promise<{ ok, purchase } | { ok:false, error }>`; `find(ang, skip)` returns `{ ok:true, target:{x,y,handle} }`, `{ ok:false, none:true }` or `{ ok:false, error }`; `skip` = every `to` of probes with `by` equal to `me`.
  - `publicProjection(s, me = null)`: `pv: 2`; `frontier[i]` gains `from`; `probes` = probes whose `by` equals `me` (none when `me` is null), each `{ ang, progress }` plus `to` only when arrived.
  - `validProjection(p)`: accepts `pv` 1 (frontier read as `from:'home'`, `probes: []`) and 2; always returns pv 2. `from` must be `'home'` or a planet id in `p.planets`; `probes` ≤ 256, `ang` in [-π, π], `progress` in [0, 1], `to` integers within ±1e9 and present only when `progress === 1`.

- [ ] **Step 1: Write the failing tests** in `test/world-probe.test.mjs`:
  - `'a probe costs 4,000, asks the hub where it goes, and keeps where it was sent from and to'`: find returns `{x:120,y:-40,handle:'kim'}`; purchase `{kind:'probe', price:4000, ang, by:{x:10,y:20}, to:{x:120,y:-40}}`; balance down 4,000.
  - `'nothing is spent when the hub has no one new, or cannot be reached'`: `{ok:false, none:true}` → error "There's no one new to find yet. Nothing was spent."; `{ok:false, error:'x'}` → "The hub can't be reached, so a probe can't be aimed. Try again later."; no purchase saved.
  - `'signed out, a probe cannot be sent'`: `me: null` → "Sign in to send a probe."; find not called.
  - `'the balance is checked before asking and again after'`: short before → find not called; a push bought while find is pending leaves it short → refused, nothing saved.
  - `'the hub is told what this account already found or has on the way'`: skip passed to find equals the `to`s of probes with `by` = me, not another account's.
  - `'a probe arrives after 3,000 more credit'`: progress 0 at purchase, 0.5 after 1,500, arrived at 3,000.
  - `'the projection carries only this account's probes, and a target only once it arrived'`: `publicProjection(s, {x:10,y:20})` vs `{x:99,y:99}` vs `null`.
  In `test/world-projection.test.mjs`: `'a version 1 projection still reads, as from Home with no probes'`; `'a lobe from a planet that is not in the projection is refused'`; `'a probe target before arrival is refused'`; update `pv` expectations to 2.
- [ ] **Step 2: Run** `node --test test/world-probe.test.mjs test/world-projection.test.mjs` — Expected: FAIL.
- [ ] **Step 3: Implement** in `world.mjs`; `probe` mirrors `build`'s shape (balance check, await, re-check, then push and save). Update `hub-sync.mjs` call site in Task 5, not here; update `test/hub-sync.test.mjs` expectations only if they pin `pv` 1.
- [ ] **Step 4: Run** `npm test` — Expected: pass.
- [ ] **Step 5: Commit** `feat(world): probes, and the projection's version 2`.

### Task 4: The hub — uploads, orders, probe target, names

**Files:**
- Modify: `hub/systems.mjs` (`put` accepts pv 1|2 and stores the sent pv; `get` returns `pv`; `publicView.stats.pv`; `cleanStatus` takes optional `prices.probe`; new `candidates(accountId)`), `hub/orders.mjs` (`cleanBody`: frontier `{ ang, from? }`, probe `{ ang }`), `hub/server.mjs` (gate, `POST /api/me/probe`, `GET /api/systems/named`), `hub/limits.mjs` (rates `probe`, `named`)
- Test: `test/hub-systems.test.mjs`, `test/hub-orders.test.mjs`, `test/hub-api.test.mjs`

**Interfaces:**
- Produces:
  - `POST /api/me/probe` (token) body `{ ang, skip:[{x,y}] }` → `{ ok:true, target:{ x, y, handle } }` or `404 { ok:false, none:true, error:"There's no one new to find yet." }`.
  - `GET /api/systems/named?at=x,y;x,y` (public, ≤ 64 pairs) → `{ ok:true, galaxies:[{ x, y, handle, name, avatar, look }] }` for listed accounts with a system only (`look` = their snapshot's `sun.look`).
  - `publicView(...).stats.pv` (1 or 2; 0 with no system).
  - `POST /api/me/orders` refuses `{kind:'probe'}` and `{kind:'frontier', from ≠ 'home'}` with 409 "Update the panel on your Mac to push from a colony." (probe: "Update the panel on your Mac to send a probe.") when the stored pv < 2.
- [ ] **Step 1: Write the failing tests:**
  - systems: `'a version 1 upload is accepted and kept as version 1'`, `'a version 2 upload with probes is accepted'`, `'the owner status may say what a probe costs'`.
  - orders: `'a push order may name where it leaves from'` (`from:'p3'` kept, `from:'x'` refused), `'a probe order keeps its direction'`.
  - api: `'a probe finds the nearest public galaxy in its cone'` (three accounts with systems; aim at one), `'with no one in the cone it finds the nearest anywhere'`, `'unlisted, systemless, skipped galaxies and yourself are never found'`, `'no one new answers none'`, `'the names of found galaxies, listed ones only'`, `'probe and colony-push orders wait for a version 2 Mac'`.
- [ ] **Step 2: Run** `node --test test/hub-*.test.mjs` — Expected: new tests FAIL.
- [ ] **Step 3: Implement.** Cone: bearing from caller's `(x,y)` to each candidate, `angDiff ≤ π/6`, nearest by distance; fallback nearest of all. Rates: `probe: [30, 60_000]` per account, `named: [60, 60_000]` per ip **(call)**.
- [ ] **Step 4: Run** `npm test` — Expected: pass.
- [ ] **Step 5: Commit** `feat(hub): probe targets, found names, and version 2 systems`.

### Task 5: The panel's server and sync

**Files:**
- Modify: `server.mjs` (`buyInWorld` passes `from`; `probeInWorld`; routes `/api/world/probe`, `/api/world/found`; `runOrder` kind `probe`; `ownerStatus.prices.probe`), `hub-sync.mjs` (`publicProjection(summary, me)` with `me` from `hub.status().account`)
- Test: `test/hub-sync.test.mjs`

**Interfaces:**
- Consumes: Task 3's `world.probe`, Task 4's routes.
- Produces: app API `POST /api/world/probe { ang }` → `{ ok, world }`; `POST /api/world/found { at:[{x,y}] }` → `{ ok, galaxies }` (empty when signed out or unreachable); `POST /api/world/probe-ready` → `{ ok, ready }` (find with `ang: 0`, discarded).
- [ ] **Step 1: Write the failing test** in `test/hub-sync.test.mjs`: `'the upload carries only the signed-in account's probes'` (fake hub with account `{x:10,y:20}`; summary with two probes from different `by`; PUT body has one).
- [ ] **Step 2: Run** — Expected: FAIL.
- [ ] **Step 3: Implement.** `find` maps hub answers: 200 → target; 404 with `none` → `{ok:false, none:true}`; anything else → `{ok:false, error}`.
- [ ] **Step 4: Run** `npm test` — Expected: pass. Manual: `node server.mjs` starts.
- [ ] **Step 5: Commit** `feat(panel): probes and colony pushes through the panel's server`.

### Task 6: Drawing branches and the fill; the Push card's places (world.js, index.html)

**Files:**
- Modify: `public/world.js` (`lit`, `extent`, `zFit`, trails, aiming arrow and `aimAt` from the chosen place, `paint` at a fixed resolution with `walledIn`, Push card chips and `from`), `public/index.html` (Push card: `#w-push-from.w-places`, `#w-push-none`)
- [ ] **Step 1:** Origins: `originOf(l) = l.from === 'home' ? {0,0} : planet x/y`; `lit` measures along from origin and clamps to `[0, l.tip]` as now; extent and trails from origin. `zFit` cap rises to fit (`clamp(…, 1, 3)`).
- [ ] **Step 2:** `paint()`: `n = clamp(ceil(2E / 6), 128, 512)`; fill a `Float32Array` with `lit`, run `walledIn` (copied from world.mjs with a "world.mjs's walledIn" comment), draw from it; stars take their light from the filled grid.
- [ ] **Step 3:** Push card: chip row like Build's (Home, colonies), lit by `here`; on a place not yours show `#w-push-none` and disable; card text "Pick a direction from {place}."; `push()` sends `from: here`; aim and arrow from the place.
- [ ] **Step 4: Verify** in the browser (Playwright): a seeded world with a colony; push from it; lobe drawn from the colony; a hand-made ring of pushes fills its middle; `npm test` still passes.
- [ ] **Step 5: Commit** `feat(world): branches drawn from their place, and walled-in dark lit`.

### Task 7: The Universe zoom, the Probe card and the page's tabs

**Files:**
- Modify: `public/world.js`, `public/index.html`, `hub/public/system.html`, `hub/public/hub.css`
- [ ] **Step 1:** world.js: `opts.universe = { me:{x,y}, names(at) → Promise<galaxies>, visit(handle) }` or null. `Z_UNIVERSE = zFit() + 1.2`; zoom range extends there only with `opts.universe`. Past `zFit()+0.1` the map fades and the Universe draws: far starfield with parallax (pan × 0.3), your sun centred labelled `You · x, y`, found galaxies (arrived probes) at `(to - me)` in hub units scaled to fit with a minimum radius of 300 units, labels on hover or always when < 10, probes in flight at `me + dir(ang) · progress · 240`; `hit()` checks suns first → `visit(handle)`. A **Universe** button `#w-universe` after Map; signed out the button is replaced by `#w-universe-hint` "Sign in to explore the Universe" (opens Profile).
- [ ] **Step 2:** index.html: rail button `data-card="probe"` (hidden signed out) and its card: `#w-probe-dir`, `#w-probe-aim`, `#w-probe-price`, `#w-probe` ("Send a probe"), `#w-probe-why`, `#w-probe-err`, `#w-probe-none` ("Send a probe to find the galaxies around you." / "There's no one new to find yet."), `#w-probe-list` (on the way and found). Probe dot `has` while one is on the way. On arrival (an id newly arrived since the last update) toast "Your probe found @handle's galaxy.". Wire `opts.universe` in `enter`: `api('/api/world/found')`, visit opens `${hub.url}/@handle`.
- [ ] **Step 3:** system.html: `opts.universe` with `profile.x/y`, names from `GET /api/systems/named`, visit → `/@handle`. Owner orders: Push tab gets `#o-from.w-places` (Home + colonies; following `onPlace` like Build; only Home when `stats.pv < 2`), Probe tab (`data-tab="probe"`, `#o-probe-dir`, `#o-probe-price`, `#o-probe`), hidden when `stats.pv < 2`; `place({kind:'probe', ang})`; prices line includes Probe when known.
- [ ] **Step 4: Verify** in the browser: app signed in against a local hub with three seeded galaxies: zoom past Map, send a probe, earn to arrival, the sun appears and its click opens the page; the page shows the same; signed out shows the hint; the page's Probe tab places an order the Mac runs. `npm test` passes.
- [ ] **Step 5: Commit** `feat(world): the Universe, and probes to find the galaxies around you`.

### Task 8: README

**Files:** Modify `README.md` (Push the frontier: from colonies, walled-in dark; a Universe and probes section; Spending from your page: the Probe tab; replace "a map of everyone's suns is the next slice").
- [ ] **Step 1:** Write the sections in the README's voice. **Step 2:** `npm test`. **Step 3: Commit** `docs: exploring from colonies, and probes`.
