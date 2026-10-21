# World: a universe your agents' work pays for

Design, 2026-10-21. Concept agreed in a brainstorm with the panel's owner; the mockup next to this file
(`2026-10-21-world-mockup.html`, open it in a browser) shows the look and the flow with simulated numbers.

Marked throughout: **(owner)** is what the owner asked for or confirmed, **(call)** is a decision made while writing
this that the owner hasn't ruled on, and the section "Left to the builder" lists what is deliberately open.

## Intent

A pure world builder inside the agent panel. Everything your agents get done earns credit. The world grows by itself
as the work comes in, and you spend credit to steer where it grows and to build what you describe. It starts as almost
nothing and, after weeks of work, becomes a universe you made and can fly around in.

Why: a sense of accumulated progress that the board (which only shows what is happening now) can't give, and a small
reward for good habits: removing code pays more than adding it. It is meant to be fun, not a dashboard.

Who: the owner first, and anyone who installs the panel from the public repository. So nothing may depend on how
someone organises their work: one repository or twenty, one profile or several **(owner)**.

## What the person sees

**A separate view called World**, opened from its own button next to Space view in the header **(call: Space view
stays exactly as it is, for watching agents)**. Full screen like Space view, with the same night sky in both themes, a
top bar (World, where you are, your credit, Back to board) and a side panel.

**No agents in it (owner).** Agents may drift across the sky as decoration (small satellites for sessions that are
running), but they do nothing: no clicks, no hover cards, no state colours to read **(owner)**.

**Two places, one continuous zoom** (wheel, pinch, or buttons):

- **Close up, a planet.** On first open there is one: **Home**, a bare grey rock in the dark. Work slowly turns it into
  a living world (oceans, land, city lights, an atmosphere), and what you build sits on it or around it.
- **Zoomed out, the map.** Home is a small point in the dark. Work slowly lights the space around it. You can drag to
  look around and click a planet to fly to it.

**What the map holds:**

- **Moments**: stars that mark a stretch of work, such as a finished week, a big cleanup day, or a milestone. Opening
  one shows what was done then: commits, lines written and removed, credit earned. They are about time, never about
  repositories **(owner)**.
- **Bare planets** the frontier uncovers now and then.
- **Colonies**: bare planets you sent a rocket to. Each is a place you build up just like Home **(owner)**.

**The side panel:**

- **Today's work**: commits, lines written, lines removed, today's multiplier, credit earned today.
- **Build on <the planet you're looking at>**: a text box, its price, and **Build it**.
- **Send a rocket**: shown when the map holds a bare planet; flying there lands a colony, and you name it.
- **Push the frontier**: pick a direction on the map by dragging from the planet you're on.

The rocket is the one set piece: the view zooms out, the rocket flies from where you are to the bare planet, and then
the view flies in to the new colony. The mockup shows this.

## How credit is earned (owner)

- **Base income**: the tokens your agents use, plus the lines in your commits.
- **Lines removed are a multiplier, never a cost.** A day that removes a lot earns more than a day that only adds.
- **Lines are counted from git commits**, not from edits, because edits get rewritten many times before anything is
  kept **(owner)**.

Starting formula **(call, to tune)**: per calendar day,
`credit = (lines added / 10 + tokens / 10,000) × multiplier`, where
`multiplier = 1 + 3 × removed / (added + removed)`, rounded to one decimal. The multiplier applies to the whole day.
Intent for tuning: in the first week, a normal working day buys about one thing; later, prices rise so it stays a
choice. With the owner's last week (about 30 commits and 11,000 added lines on a weekday) the formula gives roughly
1,000–2,500 credit a day; the mockup's prices (frontier 4,000, build 6,000, rocket 8,000) assume that.

### Where the numbers come from

- **Tokens**: the transcripts of the profile the panel is showing, main sessions and subagents
  (`<projects>/<project>/<session>.jsonl` and `<session>/subagents/*.jsonl`), summing each assistant entry's
  `message.usage`: `output_tokens + input_tokens + cache_creation_input_tokens`. Cache reads are left out
  **(call)**: they run to millions per session and would drown every other number.
- **Commits**: the repositories that profile's sessions worked in (the panel already resolves each session's working
  folder and edited files to a git top; worktrees count as their main repository). In each, the commits since World
  started whose **author and committer** both match that repository's `user.email`, with `--no-merges`, each commit
  hash counted once even when several worktrees hold it. Author and committer both being you is what keeps a squash or
  merge made on GitHub (committer GitHub) from counting a second time **(call)**.
- **Lines**: `git log --numstat` for those commits. Binary files are skipped. Lockfiles and other generated files
  must not swamp the numbers; how (an ignore list, a per-file cap, or both) is the builder's.
- **Your identity** in a repository is the email git itself resolves there (`git config user.email` run inside it,
  so global settings and `includeIf` count) **(call)**. A repository where git resolves none counts nothing, and the
  side panel says so rather than silently showing zero.
- **Profiles count on their own (call).** A repository used from two profiles can earn in both Worlds; keeping them
  apart would need state shared across profiles, which isn't worth it.

### The balance (call)

- Balance = credit earned − credit spent. Buying needs the full price in the balance.
- **Days are local calendar days.** Today's credit is live: it moves as commits and tokens arrive, and today's
  multiplier is recomputed with them.
- **Purchases are final.** Each one stores the price paid; later price changes never rewrite it, and nothing is
  refunded.
- A recount can lower a past day (a rebase drops commits, transcripts get cleaned up). That lowers the balance, which
  may go below zero; it shows as 0 and buying waits until work brings it back. The world itself never shrinks: what
  was bought or grown stays.

## How the world grows

**On its own**, from credit *earned* (spending never shrinks it):

- Home goes through stages: bare rock, oceans, land, cities with lights, an atmosphere. The mockup's stages are a
  fine start.
- The lit area of the map widens around Home.
- Moments appear as their stretch of work ends (a week closes, a cleanup day ends).

**By your choice**, from credit *spent*:

- **Push the frontier**: a push buys a stretch of frontier in the direction you dragged, and that stretch lights up
  over the following days as credit keeps being earned, the way the mockup's two lobes grow **(call)**. Pushes stack:
  several can point anywhere, and a new push in the same direction extends that lobe. The moments that appear along
  a lobe are the ones from the work done while it grew.
- **Send a rocket**: to a bare planet the frontier found. It lands a colony and you name it. **Bare planets only come
  from the frontier (owner)**, so pushing is how you find places to build. Roughly one per push or two, so a planet
  feels like a find **(call)**.

The world is therefore drawn from three things: the seed, the list of purchases, and the credit earned per day.
- **Build**: you describe something, and it is built on or around the planet you are looking at **(owner)**.

### Building from a description

The description really shapes what appears **(owner agreed to this proposal)**. The server asks Claude to turn the
words into pieces the renderer knows how to draw, then draws them:

- **Verify first**, before building this part: on the minimum supported Claude Code, a call made as below runs with
  the panel's hooks off and never appears on the board. If it can't be made to, stop and bring that back.
- One non-interactive call per build, made only when the person clicks **Build it**: `claude -p --model haiku
  --json-schema <schema>`, with no tools, under the profile the panel shows. The prompt holds the catalogue of
  drawable pieces, the planet's current state and the description; the answer picks pieces and their parameters
  (kind, colour, size, where on the planet or in orbit, how many) plus a short caption.
- The call must not show up on the board or trip the panel's own hooks: run it with hooks disabled
  (`--settings '{"disableAllHooks": true}'`) and without saving a session, from the same scrubbed environment the
  panel's other `claude` spawns use.
- Credit is taken only when a build comes back and draws. If Claude can't be reached, the profile isn't signed in,
  or the answer doesn't validate, nothing is spent and the person is told why.
- First catalogue **(call)**: moon, rings, ring city, city lights, forest or land colour, ocean colour, atmosphere
  tint, mountains, domes, space station, space elevator, aurora, beacon. Every piece must draw at both zoom levels.

## Persistence

- **Starts from nothing (call, not objected to)**: the first time someone opens World, it records that moment, and
  only work after it counts. No backfill from older transcripts or commits.
- **One World per Claude Code profile (call)**, since the credit comes from that profile's sessions. Switching
  profile in the header switches World.
- Kept in `~/Library/Application Support/Agent Panel/` next to `prefs.json`: a start time, a random seed, the earned
  totals per day (recomputed and replaced, so a recount never double counts), and an append-only list of what was
  bought (frontier pushes with their direction, rockets, builds with the description and the pieces Claude chose). The
  world is drawn from the seed plus that list, so it looks the same after every restart.

## Goals

- It starts as almost nothing and visibly grows with work, with no action needed.
- Spending credit is the way to make it yours: direction, colonies, things you described.
- Removing code is the best-paid kind of work.
- It is pleasant to fly around in after a month: zoom, drag, open moments, visit colonies.

## Non-goals

- Anything keyed to repositories.
- Controlling or watching agents from World.
- Sharing, leaderboards, several people in one world.
- Counting work from before the first open.

## Anti-goals: it fails, even if it works, when

- It slows the panel. Transcript and git reads stay off the request path, are incremental and cached, and give up
  quickly; on a failure World shows the last numbers it had.
- It spends tokens nobody asked for. The only model call is the one behind **Build it**.
- It writes to a repository. Git is read only.
- Credit is inflated by double counting (worktrees, squash merges, generated files).
- It reads like a dashboard. Numbers live in the side panel; the canvas is the world.

## Constraints

- The panel's own rules: Node standard library only, one `public/index.html` with no build step, macOS, the
  profile model, and the security model (every new `/api` route takes the per-start token; nothing new listens beyond
  127.0.0.1).
- Fits a 13" screen, like the rest of the panel; respects reduced motion.
- Public repository: no personal data in code, fixtures or docs.

## Order of delivery (call)

Each slice ships on its own and is usable:

1. Earning and persistence: credit from tokens and commits, the balance, the World view with Home growing by itself,
   the lit map, and the side panel's numbers.
2. The frontier and moments.
3. Rockets and colonies.
4. Building from a description.

## Left to the builder

- The credit formula's constants, the prices and how they rise (intent above).
- How moments are chosen and named, and how often bare planets turn up (intent above).
- Drawing: the renderer, palettes beyond the mockup, animation, how pieces from the catalogue look.
- The JSON schema for builds and how the catalogue grows.
- The storage format.
- Whether agents drift across the sky at all in the first version.
