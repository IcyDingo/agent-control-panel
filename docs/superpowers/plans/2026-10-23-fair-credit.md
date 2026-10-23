# Fair Credit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** World pays for a day of work by lines, commits and active time on one flattening curve, with new prices, Home levels past 12, growing colonies, and old earnings kept. (Repositories added by hand were built in Task 5 and then removed at the owner's request; repositories come from agent sessions only.)

**Architecture:** The formula and the ladders are pure functions in `world.mjs`. The store (`createWorld`) records active 5-minute slots from transcripts and from working-tree changes, stamps each day with its credit and XP under the rules in force (old before the switch day, new from it), and everything downstream (balance, Home, moments, colonies) reads those stamps. The public projection goes to version 3 for Home levels past 12 and colony stages; the hub accepts it before any Mac sends it.

**Tech Stack:** Node 20+ ES modules, no dependencies, `node --test`, git CLI, canvas drawing in `public/world.js`.

**Spec:** `docs/superpowers/specs/2026-10-23-fair-credit-design.md`

## Global Constraints

- `work = lines changed (added + removed) + 20 × commits + 60 × active hours`, active hours capped at 10 a day.
- `credit = round(65 × log2(1 + work ÷ 50))`; XP for a day = `round(credit ÷ 3)`.
- Active slot = 5 minutes, local time; at most 120 slots (10 hours) count per day.
- Tokens earn nothing; they still mark a slot active and are still shown.
- Prices: build 150, frontier 300, probe 400, rocket 1,200. Push light 600, probe travel 500.
- Days before the switch day keep the old formula and old XP; the switch day is the local day after the new version first runs.
- A purchase keeps its price and its light or travel threshold; purchases without a stored threshold use 3,000.
- Home: the 12 `LEVELS` stay; past 4,000 XP a new level every 1,000 XP, numbered on from 13.
- Colonies: six stages, Landing site, Outpost, Domes, Green patches, Township, City, fed by half the XP earned since the colony landed; City at 2,000 colony XP; a feature every 1,000 colony XP after City.
- Credit, XP, lines, tokens, active time, prices and repository paths never leave the Mac in the projection; only level, stage and colony stage do.
- Projection version 3; the hub and the page keep reading 1 and 2.
- The hub is deployed (signed release) before workers update.

## Review Focus

1. A `world.json` from before this change (no `newFrom`, no `active`, purchases without thresholds): balance unchanged on first load, pushes and probes in flight keep moving at 3,000. Test in Task 3.
2. ~~A repository removed by hand that an agent session later works in: it stays removed. Test in Task 5.~~ Dropped with Task 5.
3. A repository where git is busy (`index.lock` present), deleted or moved: the work-tree scan skips it without an error and without marking a slot. Test in Task 4.
4. An old Mac (projection v2, status with `multiplier` and no `active`) talking to the new hub, next to a new Mac sending v3: both accepted. Test in Task 6.
5. A day that straddles the switch: today's credit is the old formula until midnight, the new one after; `peak` never goes down. Test in Task 3.

---

### Task 1: The day's work and its credit

**Files:**
- Modify: `world.mjs:18-35` (replace `multiplier`, `dayCredit`, `FULL_DAY`, `dayXp`)
- Test: `test/world.test.mjs`

**Interfaces:**
- Produces:
  - `SLOT_MIN = 5`, `MAX_SLOTS = 120`.
  - `dayWork({ added = 0, removed = 0, commits = 0, slots = 0 }) -> number`.
  - `dayCredit(x) -> integer`, the new formula.
  - `dayXp(x) -> integer` = `round(dayCredit(x) / 3)`.
  - `oldDayCredit(x)` and `oldDayXp(x)`: the current formulas, renamed, with `multiplier` kept as a private helper.

- [ ] **Step 1: Write the failing tests** `the new day credit follows the spec's table` and `old days keep the old formula`

```js
assert.equal(dayCredit({ slots: 3 }), 25);                                    // 15 minutes
assert.equal(dayCredit({ added: 20, removed: 10, commits: 1, slots: 36 }), 162); // 3 hours, one 30-line fix
assert.equal(dayCredit({ slots: 48 }), 165);                                  // 4 hours, nothing committed
assert.equal(dayCredit({ added: 100, removed: 50, commits: 3, slots: 96 }), 253); // a typical full day
assert.equal(dayCredit({ added: 2000, removed: 1000, commits: 10, slots: 96 }), 404);
assert.equal(dayCredit({ slots: 288 }), dayCredit({ slots: 120 }), 'past 10 hours, time stops counting');
assert.equal(dayCredit({ tokens: 5_000_000 }), 0, 'tokens alone earn nothing');
assert.equal(dayXp({ added: 100, removed: 50, commits: 3, slots: 96 }), 84);
assert.equal(oldDayCredit({ added: 300, removed: 0, tokens: 1_000_000 }), 130);
assert.equal(oldDayXp({ added: 3000, tokens: 0 }), 100);                      // 300 credit, a full day under the old rules
```

- [ ] **Step 2: Run** `node --test test/world.test.mjs`. Expected: FAIL, `dayWork`, `oldDayCredit` and `oldDayXp` are not exported.
- [ ] **Step 3: Implement** the four functions and the constants in `world.mjs`. Update the file's header comment to say how credit is earned now.
- [ ] **Step 4: Run** `node --test test/world.test.mjs`. Expected: these pass. Other World tests that assume the old formula fail until Task 3; note which ones.
- [ ] **Step 5: Commit** `feat(world): a day's work is lines, commits and active time, on one flattening curve`

### Task 2: Ladders: Home past 12, and colony stages

**Files:**
- Modify: `world.mjs:36-49` (`LEVELS`, `homeLevel`, `homeReach`)
- Test: `test/world.test.mjs`

**Interfaces:**
- Consumes: days stamped with `xp` (Task 3 stamps them; the tests here pass `{ xp }` objects directly).
- Produces:
  - `levelOf(xp) -> { level, stage, at, next: { level, name, at } | null }`.
  - `HOME_FEATURES`: an array of names, at least 12, for levels 13 and up. Past the end of the array they repeat with a numeral ("Beacon II").
  - `homeLevel(days, today)`: reads `days[d].xp`, same return shape as now.
  - `homeReach(xp)`: unchanged up to 4,000 XP, then grows 4 map px per further 1,000 XP, at most 60 px more.
  - `COLONY_STAGES = ['Landing site', 'Outpost', 'Domes', 'Green patches', 'Township', 'City']` at colony XP `[0, 100, 300, 700, 1300, 2000]`.
  - `colonyStage(colonyXp) -> { stage: 1..n, name }`: past City, each 1,000 colony XP is one more stage, named from `COLONY_FEATURES`, repeating like Home's.

- [ ] **Step 1: Write the failing tests** `levels past Twin moons come every 1,000 XP` and `a colony grows through its six stages`

```js
assert.deepEqual([levelOf(3999).level, levelOf(4000).level, levelOf(4999).level, levelOf(5000).level], [11, 12, 12, 13]);
assert.equal(levelOf(5000).stage, HOME_FEATURES[0]);
assert.equal(levelOf(4000).next.at, 5000, 'the ladder never ends');
assert.equal(levelOf(4000 + 1000 * (HOME_FEATURES.length + 1)).stage, `${HOME_FEATURES[0]} II`);
assert.ok(homeReach(10_000) > homeReach(4000) && homeReach(1e9) <= homeReach(4000) + 60);
assert.deepEqual([0, 99, 100, 1999, 2000, 3000].map((x) => colonyStage(x).name),
  ['Landing site', 'Landing site', 'Outpost', 'Township', 'City', COLONY_FEATURES[0]]);
```

- [ ] **Step 2: Run** `node --test test/world.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** in `world.mjs`. `homeLevel` sums `days[d].xp` and calls `levelOf`. Pick the feature names: each must be something `public/world.js` can draw at Home's or a colony's zoom (for example satellites, a brighter atmosphere, a ring of lights, a nearby star, a second sun's glow).
- [ ] **Step 4: Run** `node --test test/world.test.mjs`. Expected: these pass.
- [ ] **Step 5: Commit** `feat(world): Home keeps levelling past Twin moons, and colonies have stages`

### Task 3: The store: switch day, stamped days, slots from transcripts, prices and thresholds

**Files:**
- Modify: `world.mjs`, these parts:
  - `readTokens` (~438-481)
  - `PRICES` and `PUSH_LEN, LIGHT_CREDIT` (~55-58)
  - `frontierOf` (~100)
  - `momentsOf` (~126-176)
  - `createWorld`: load, `scanTokens`, `daysOf`, `summary`, `buy`, `build`, `probe`
- Test: `test/world.test.mjs`, `test/world-build.test.mjs`, `test/world-probe.test.mjs`, `test/world-frontier.test.mjs`

**Interfaces:**
- Consumes: Task 1's `dayCredit`, `dayXp`, `oldDayCredit`, `oldDayXp`, `SLOT_MIN`, `MAX_SLOTS`; Task 2's `levelOf`, `colonyStage`, `homeLevel`.
- Produces:
  - `readTokens(...)` also returns `slots: { [day]: number[] }`: the 5-minute slot indexes, 0 to 287 local, of every assistant reply it counted.
  - `st.active: { [day]: number[] }`: sorted, unique slot indexes. `st.newFrom: 'YYYY-MM-DD'`, set once to the day after first load when missing. Both are optional in `valid()`, so the store version stays 2.
  - `markActive(day, slot)` inside the store, used by Task 4.
  - `daysOf()` returns each day as `{ added, removed, commits, tokens, slots, credit, xp }`. `credit` and `xp` come from the new functions when `day >= st.newFrom`, else the old ones with the old inputs. `momentsOf(days, ...)`, `homeLevel` and every `earned` sum read `x.credit` and `x.xp`, never a formula.
  - `PRICES = { frontier: 300, rocket: 1200, build: 150, probe: 400 }`; `PUSH_LIGHT = 600`; `PROBE_TRAVEL = 500`. A frontier purchase stores `light: PUSH_LIGHT` and a probe stores `travel: PROBE_TRAVEL`. `frontierOf` and probe progress use `p.light ?? 3000` and `p.travel ?? 3000`.
  - `summary().today` is `{ day, commits, added, removed, tokens, active (minutes), credit }`, with no `multiplier`.
  - `summary().planets[i].colony` gains `stage` and `stageName` from `colonyStage(half the XP earned since the colony's rocket landed)`.
  - The colony build prompt's state names the stage, for example `a colony at its Domes stage on a rust planet`.

- [ ] **Step 1: Write the failing tests**, each named after what it checks:
  - `readTokens marks the slot of each reply`: two replies at 09:01 and 09:07 local give slots `[108, 109]` for that day.
  - `a World from before keeps its balance`: an old-shape `world.json` (no `newFrom` or `active`, tokens and lines on past days, one purchase at the old price) gives the same `earned`, `balance` and Home XP after load as `oldDayCredit` and `oldDayXp` sum to. `st.newFrom` is the day after `now`.
  - `the switch day counts the old way until midnight`: work on the load day earns `oldDayCredit`; the same work on the next day earns `dayCredit`. `peak` never goes down across the switch.
  - `in-flight purchases keep their thresholds`: a probe without `travel` bought before still needs 3,000 credit; a new probe arrives after 500. The same for push light, 3,000 against 600.
  - `prices are the new ones, and a purchase keeps the price it was bought at`.
  - `a colony's stage follows half the XP since it landed`.
  - `today shows active minutes and no multiplier`.
- [ ] **Step 2: Run** `node --test test/world*.test.mjs`. Expected: the new tests FAIL, and so do the old ones that assumed the old formula.
- [ ] **Step 3: Implement** in `world.mjs`. Fix the existing World tests that assumed the old formula or the old prices, by changing their expected numbers. Change no other behaviour to make them pass.
- [ ] **Step 4: Run** `npm test`. Expected: all pass, except projection and page tests that need Task 6.
- [ ] **Step 5: Commit** `feat(world): days are stamped by the rules in force, slots come from replies, and the new prices`

### Task 4: Active time from working-tree changes

**Files:**
- Modify: `world.mjs` (`createWorld`: a new `scanWorkTrees()`, called from `scan()` when `git` is true)
- Test: `test/world.test.mjs`

**Interfaces:**
- Consumes: Task 3's `markActive(day, slot)`, `st.repos`.
- Produces:
  - `treeFingerprint(repo, run) -> Promise<string | null>`. It runs `git --no-optional-locks -C <repo> status --porcelain=v1 -z --untracked-files=normal`, then joins each listed path with its file's size and `mtimeMs` and hashes the result.
  - It returns `null` when `.git/index.lock` exists, when the repository is gone, or when git fails.
  - `st.trees: { [repo]: string }` holds the last fingerprint. A slot is marked active for `now` when a repository's fingerprint differs from the stored one and both are non-null.

- [ ] **Step 1: Write the failing tests**:
  - `an edit in a counted repository marks the slot`: a temp git repo, scan, edit a file, scan again, and the slot of `now` is in `st.active`.
  - `nothing changed marks nothing`: two scans with no edit.
  - `a busy, missing or broken repository is skipped`: create `.git/index.lock`, delete the repo, and point it at a non-repo folder. `scan()` resolves, nothing is marked, and the stored fingerprint is kept.
  - `the first look only records`: a repository's first fingerprint marks nothing.
- [ ] **Step 2: Run** `node --test test/world.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** `treeFingerprint` and `scanWorkTrees` in `world.mjs`. Use the same `xcode-select` guard as `scanCommits` and the store's `run`, with a 10-second timeout.
- [ ] **Step 4: Run** `node --test test/world.test.mjs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(world): a change in a counted repository's working tree marks the slot active`

### Task 5: Repositories by hand: the list, the command line, the panel

> **Removed (owner, 2026-10-23).** Built, then reverted: the owner found it confusing and it risks counting the same work twice. Repositories come from agent sessions only.

**Files:**
- Create: `world-repos.mjs`
- Modify:
  - `world.mjs`: `scanTokens` and the scans read the list
  - `cli.mjs`: a `world add|remove|list` command and the usage line
  - `server.mjs`: `/api/world/repos` (GET lists, POST `{ add | remove: path }`), plus `pickFolder` reuse
  - `public/world.js` and `public/index.html`: a "Repositories" part in World's side panel
- Test: `test/world-repos.test.mjs`

**Interfaces:**
- Produces, in `world-repos.mjs`, all over the file `world/repos.json` beside `world.json`, `{ "added": [paths], "removed": [paths] }`, mode 600:
  - `readRepos(file) -> { added: string[], removed: string[] }`.
  - `addRepos(file, dir, { find }) -> { added: string[] }`. If `dir` is a git repository it is added; if it is a folder, `find(dir)` returns every repository at most 3 levels under it, skipping `node_modules` and dot-folders. Paths are stored real (`realpathSync.native`). Adding takes a path off `removed`.
  - `removeRepo(file, path) -> boolean`. The path goes on `removed` and off `added`.
- In `world.mjs`, each scan's repository set is `st.repos ∪ added − removed`. Repositories found from agent sessions that are on `removed` are never added back.
- The CLI prints one repository per line for `list`, each marked `(added by hand)` or `(found from an agent session)`.

- [ ] **Step 1: Write the failing tests**:
  - `a repository added by hand is counted`: its commits count with no agent session.
  - `a folder adds every repository under it, 3 levels deep, not inside node_modules`.
  - `a repository removed by hand stays removed when an agent works in it again`.
  - `node server.mjs world add, list, remove`: against a temp `ACP_PREFS`, like `test/web-orders.test.mjs`.
  - `the panel lists and changes them`: `/api/world/repos` through the server's test harness, if one exists for `/api/world/*`; otherwise the module tests cover it.
- [ ] **Step 2: Run** `node --test test/world-repos.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement** the module, then the CLI, the route and the panel part. The panel part uses the existing folder dialog (`pickFolder`) and lists repositories with a Remove button each. Paths are shown only in the panel, never sent to the hub.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(world): repositories can be added and removed by hand, from the panel and the command line`

### Task 6: Projection version 3 and the hub

**Files:**
- Modify:
  - `world.mjs`: `PROJECTION_VERSION`, `publicProjection`, `validProjection`, `READS`
  - `hub/systems.mjs`: `UPLOADS`, the stage lookup at line 65 and the default at line 100, `cleanStatus`
- Test: `test/world-projection.test.mjs`, `test/hub-systems.test.mjs`, `test/hub-api.test.mjs`

**Interfaces:**
- Consumes: Task 2's `levelOf`, `colonyStage`; Task 3's colony `stage`.
- Produces:
  - `PROJECTION_VERSION = 3` and `READS = [1, 2, 3]`.
  - In v3, `home.level` is any integer from 1 to 1,000, and `stage` is rebuilt from `levelOf` (the level's start XP), never taken from the upload. A colony is `{ name, day, stage }`, with `stage` an integer from 1 to 1,000 and its name rebuilt from `colonyStage`.
  - v1 and v2 are read exactly as now. A v2 colony reads as stage 1.
  - Hub `UPLOADS = [1, 2, 3]`. The stored `stage` column uses the rebuilt name.
  - Hub `cleanStatus`: `today.multiplier` is optional, and `today.active` is optional (minutes, 0 to 1,440). The owner's view passes through whichever came.

- [ ] **Step 1: Write the failing tests**:
  - `a v3 projection carries Home past 12 and colony stages`.
  - `the stage names are rebuilt, never trusted`: an upload with a made-up stage name is stored with the real one.
  - `v1 and v2 still read`.
  - `the hub takes a v2 upload from an old Mac and a v3 one from a new Mac`.
  - `the hub takes a status with multiplier and no active, and one with active and no multiplier`.
  - `nothing private leaves`: the v3 projection has no credit, XP, active time or path. Extend the existing allow-list test.
- [ ] **Step 2: Run** `node --test test/world-projection.test.mjs test/hub-*.test.mjs`. Expected: FAIL.
- [ ] **Step 3: Implement**. In `server.mjs` `ownerStatus()`, send `today.active` and drop `multiplier`.
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(world,hub): projection 3 carries Home past 12 and colony stages; the hub reads 1 to 3`

### Task 7: What the pages show

**Files:**
- Modify:
  - `public/world.js`: `LEVEL_XP` line 28, `drawHome` ~147, `drawPlanet` ~244, the today panel ~1074, the cleanup moment ~1029-1038
  - `public/index.html`: the board's World line at ~2633
  - `hub/public/system.html`: the owner's prices and today line
- Test: `test/world-projection.test.mjs` (page reading), and by eye

**Interfaces:**
- Consumes:
  - the summary's `today.active`;
  - `home.level`, which can be above 12;
  - `colony.stage` and `colony.stageName`;
  - the exported `LEVELS`, `HOME_FEATURES`, `COLONY_STAGES` and `COLONY_FEATURES`. `public/world.js` takes these from the summary or the projection, not from a copied table.

- [ ] **Step 1: Change the today panel** to rows for Active time (`3 h 20 min`), Lines changed, Commits and Credit today, plus Tokens with the note `not counted toward credit`. No multiplier row. The board line reads `… lines, N commits, 3 h 20 min active, N credit earned.`
- [ ] **Step 2: Change the cleanup moment.** It keeps its name and its "A day that removed more than it added." line, drops "Removing pays most." and the `×` multiplier.
- [ ] **Step 3: Draw Home's features past level 12**, one per level from `HOME_FEATURES`, at Home's normal zoom, without covering builds. Each feature eases in like the existing stages.
- [ ] **Step 4: Draw colony stages** on `drawPlanet`, over the planet's look:
  - Landing site: a lander.
  - Outpost: a few lights.
  - Domes: lit domes.
  - Green patches: green on the land.
  - Township: night lights.
  - City: dense lights and a glow.

  Post-City features follow `COLONY_FEATURES`. Builds still draw on top.
- [ ] **Step 5: Check by eye** in the panel (`http://127.0.0.1:4747/world`) and on a local hub, using the Docker setup from `hub/README.md` with `HUB_DEV_LOGIN=1`, at levels 1, 9, 12, 13 and 20 and a colony at each stage. Do this by temporarily seeding a `world.json`; do not commit the seed. No console errors under the hub's CSP.
- [ ] **Step 6: Run** `npm test`. Expected: PASS.
- [ ] **Step 7: Commit** `feat(world): the pages show active time, Home past Twin moons and colony stages`

### Task 8: The README and the release order

**Files:**
- Modify:
  - `README.md`: the World section on how credit is earned, prices, Home, colonies, and which repositories count (those an agent session worked in)
  - `hub/deploy/README.md`: a short "Releases that change the projection" note: deploy the signed release to the hub first; workers follow by their daily update
- Test: none (docs)

- [ ] **Step 1: Rewrite the README's credit section** from the spec:
  - the formula in words, and the table of example days;
  - tokens earn nothing;
  - what counts as active and what doesn't. Say plainly that time spent reading with no file changing and no agent working is not counted.
- [ ] **Step 2: Document the rest**:
  - the prices and the timings;
  - Home past 12 and colony stages;
  - which repositories count: World finds them from agent sessions (the session's folder → its git repository); there is no way to add one by hand;
  - that credit earned before the change is kept.
- [ ] **Step 3: Add the deploy note.**
- [ ] **Step 4: Run** `npm test`. Expected: PASS.
- [ ] **Step 5: Commit** `docs: how World pays now, and the release order`
