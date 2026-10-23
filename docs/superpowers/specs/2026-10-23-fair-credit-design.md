# Fair credit: what a day of work is worth in World

Design, 2026-10-23. Agreed in a conversation with the panel's owner. It changes how World turns work into credit and
XP, what things cost, and how Home and colonies grow. The World design (`2026-10-21-world-design.md`) still holds
wherever this one says nothing.

Marked throughout: **(owner)** is what the owner asked for or confirmed, **(call)** is a decision made while writing
this that the owner hasn't ruled on, and the last section lists what is deliberately left to the builder.

## Intent

World should treat every developer close to equally **(owner)**. Today a day's credit is `(lines added ÷ 10 + tokens ÷
10,000) × a removal bonus of 1 to 4`, with no ceiling, and commits earn nothing. So:

- a developer who writes good code with few changes is punished: one careful 30-line fix earns a hundredth of a big day;
- tokens decide most of it, so running more agent wins, and a loop that churns files tops everything;
- the removal bonus is easy to game (delete a file, add it back);
- a day spent investigating, debugging or reviewing, with nothing committed yet, earns little or nothing.

What the owner wants instead:

- **Not punished for small, good changes**, and **not punished for doing a lot of work** either: more work still pays,
  but on a curve, so the gap between people stays modest **(owner)**.
- **Agent or not must not matter**: someone coding by hand and someone using agents earn the same for the same work
  **(owner)**.
- **Not only shipping counts**: a day working on something that isn't committed yet still earns **(owner)**.
- **Something to buy most days**: prices low enough that the game stays fun, not "4,000 to do anything" **(owner)**.
- **Credit already earned is kept** **(owner)**.
- Home keeps growing for long-time players, and colonies grow too **(owner)**.

## Goals, non-goals, anti-goals

Goals:

- With the same number of working days, two developers of different styles end up close to each other in credit and
  XP: a careful day and a typical full day differ by well under 2 times, and even a huge day earns about 1.6 times a
  typical one. The formula below is what is built; this goal is how it is judged when it is tuned, not a test to pass
  **(call)**. More lines do earn somewhat more, because the owner asked that a lot of work is not punished; an agent
  that writes many lines therefore earns a little more for the same hours, on the flattening curve, and that is
  accepted.
- A typical working day buys a build; a typical week brings a few builds, a push or probe or two, and about one colony.
- Home and every colony keep changing for months, not weeks.

Non-goals:

- Cheat-proofing. Everything is counted on the player's own Mac, so a determined player can always fake work (a trivial
  commit, a file touched every few minutes). The aim is that honest players are treated alike and that grinding and
  token burn stop paying, not that cheating is impossible.
- Comparing players with each other (leaderboards). Nothing here publishes credit, XP or work numbers; the public
  projection stays shape only.

Anti-goals (a failure even if it works):

- A formula where running more agents, or leaving one running, earns more than doing the same work by hand.
- A balance that drops, or a purchase that is undone, when this ships.
- A day that needs a commit to be worth anything.

## How a day's work is measured

All of it is on the Mac, per local calendar day, as today.

**Lines changed in your own commits.** Added and removed lines count the same: removing code is good work, but no
longer a multiplier **(owner: agent-neutral, not gameable; the 1-to-4 bonus goes)**. The current rules for which
commits are yours, the lockfile exclusions and the 2,000-lines-per-file cap stay as they are.

**Commits.** Each commit of your own counts as 20 lines changed **(call)**, so a small, focused commit is worth
something on its own.

**Active time.** The day is split into 5-minute slots **(call)**. A slot is active when, during it, anything moved:

- the uncommitted changes in one of your counted repositories changed (the working tree's diff against HEAD is not the
  same as at the last look), or
- an agent session of a shown profile did a turn (tokens were used).

Either makes the slot active; a slot is counted once, whatever moved in it. Hand edits and agent edits look the same to
it, so the measure does not care who typed the code **(owner)**. Active time counts at most 10 hours a day **(call)**,
so an agent left running overnight cannot farm it.

**For now, active time is only these two signals (owner).** Time spent reading code, in a debugger or reviewing in a
browser, with no file changing and no agent working, is not seen and earns nothing. Watching an editor, a terminal or
the keyboard would need a macOS privacy permission and is not part of this design. The README must not promise that
thinking time counts.

**An agent counts whether or not someone is at the keyboard (call).** A `/loop`, a scheduled job or a background
session left running marks its slots active like any other agent turn; the 10-hour cap is the only limit. So one
always-running agent can earn close to a full day every day, weekends included. Counting only agents a person prompted
recently is the alternative if that turns out to be abused.

**Tokens earn nothing.** They are still counted and shown in the panel (today's numbers), and they still mark a slot
active, but they add no credit by themselves **(owner: agent or not must not matter)**.

**Repositories without agents.** Today World learns a repository only from an agent session that ran in it. A developer
who never uses an agent would have no repositories counted, which breaks "agent or not must not matter". The player
must be able to add a repository (or a folder of repositories) to World by hand, from the panel and from the command
line, and remove one **(call; required for the owner's agent-neutral rule)**.

## Credit

    work   = lines changed + 20 × commits + 60 × active hours        (active hours capped at 10)
    credit = round(65 × log2(1 + work ÷ 50))

**(call: the weights and the curve's shape are the proposal the owner accepted. The scale, 65, is chosen so that a
typical full working day earns about 250, the figure the prices and the pacing below were agreed against; the owner
first saw the same curve with 100, which put a full day near 390. All of it is expected to be tuned.)**

| A day | Work | Credit |
|---|---|---|
| 15 minutes of anything | 15 | about 25 |
| 3 hours and one careful 30-line fix | 230 | about 160 |
| 4 hours investigating with an agent, nothing committed | 240 | about 165 |
| A typical full day: 8 active hours, 150 lines, 3 commits | 690 | about 250 |
| A huge day: 3,000 lines, 10 commits, 8 hours | 3,680 | about 400 |

Each doubling of work adds the same credit: more always pays, and 100 times the work is worth about 4 times the credit.
There is no daily cap on credit; the curve is the limit.

## XP and Home

XP for a day = the day's credit ÷ 3, rounded **(owner accepted)**. The curve already flattens big days, so the separate
"past a full day, each doubling adds 50" rule goes. A typical full day is about 85 XP, a huge one about 135.

Home's 12 levels and their XP thresholds stay as they are **(owner)**. At about 80 XP a working day: Clouds within
the first hour, Oceans on day one or two, Terraformed in about five weeks, Twin moons in about ten.

**Past Twin moons, Home keeps growing (owner).** Every further 1,000 XP (about 12 typical working days) is a new level
that adds one small feature to Home, from a fixed sequence, for example a new satellite, a brighter atmosphere, a ring
of lights, a nearby star **(call: the features and their order are the builder's; each must be visible at Home's
normal zoom and must not crowd out what was built there)**. Levels after Twin moons are numbered on (13, 14, ...) and
named after their feature. Home's light on the map, which now stops growing at Twin moons, grows a little with each
of these levels too **(call)**.

## Colonies grow

Today a colony is a bare planet with craters forever, changed only by builds. From now on each colony grows by itself
**(owner)**:

- A ladder of six stages: Landing site, Outpost, Domes, Green patches, Township, City **(call: names and looks are
  the builder's within that progression, from raw to settled)**.
- Fed by the XP earned after the colony landed, at half speed: a colony's XP is half of all the XP earned since its
  rocket landed. Every colony grows at once from the same XP; there is nothing to feed by hand.
- Paced so a colony reaches City in about 8 to 10 weeks of typical work (about 1,700 to 2,100 colony XP) **(call: the
  exact thresholds)**. After City it gains a small feature every so often, like Home past Twin moons.
- A colony keeps its planet's look (rust, ice, sand, violet); its stages are drawn on top of it.
- Builds still sit on top of the stage. Claude's build prompt describes the colony's stage, as it describes Home's
  level today.

Colonies founded before this ships grow from the XP earned since their own landing, the same as new ones, so an old
colony appears already grown on the first day **(call)**.

## Prices and timings

Against about 250 credit for a typical day **(owner accepted)**:

| Item | Price | About |
|---|---|---|
| Build | 150 | under a day |
| Push the frontier | 300 | a day |
| Probe | 400 | a day and a half |
| Rocket (a new colony) | 1,200 | a working week |

The things that happen as credit is earned after a purchase scale with it:

- A pushed region of the frontier lights up as 600 more credit is earned (today 3,000) **(call)**.
- A probe arrives after 500 more credit is earned (today 3,000, the same constant as the push) **(call)**.

Prices stay the same however many of a kind were bought, as today. A purchase keeps the price it was bought at, as
today; it must also keep the light and travel thresholds it was bought with, so pushes and probes in flight when this
ships finish as they were promised.

## Switching over

**Credit already earned is kept (owner).** On the first run of the new version, World records the day it switched.
Days before it keep their old credit and old XP, worked out by the old formula, for good; days from it on use the new
one. The balance is old earnings plus new earnings minus everything spent, so it never drops at the switch. Under the
new prices that balance buys a lot at once; that is intended.

The day the new version first runs is still counted the old way; the new rules start at the next local midnight
**(call)**. The worker updates at some time of day, and by then the morning may have earned (and spent) a lot under the
old formula; counting that day again under the new one could make the balance drop, which the owner ruled out. For the
same reason `peak` (the most ever earned, which lights pushes and moves probes) never has to go back: earnings only
ever add.

The public projection carries Home's level, which today may not be above 12, and it will carry each colony's stage.
That is a new projection version. The hub must accept it before any Mac sends it, so the hub is deployed (signed
release) before the workers update, as with probes. A hub that runs the new version still accepts the older ones.

## What the person sees change

- The panel's "today" numbers show active time, lines, commits and the day's credit; tokens stay visible but are no
  longer part of the credit. The removal multiplier disappears, and so does the "cleanup" moment's line "Removing pays
  most" (the moment itself may stay as "a day that removed more than it added") **(call)**.
- Prices on the panel and the website are the new ones.
- Home shows levels past 12 with their names; colonies show their stage.
- The README's description of how credit is earned is rewritten to match.

## Left to the builder

- How the 5-minute slots are sampled and stored (they never leave the Mac), and how cheaply the working-tree check runs
  on many repositories (it must not slow the Mac or touch a repository while git is busy in it).
- How a repository is added and removed by hand: the panel control, the command line, and whether a folder adds every
  repository under it.
- The drawing of colony stages and of Home's features past Twin moons, within the progressions above.
- The exact colony XP thresholds and post-City features, within the pacing above.
- Tests: the formula's examples above, the switch keeping old balances, in-flight purchases keeping their thresholds,
  and the projection's new version accepted by the hub alongside the old ones.
