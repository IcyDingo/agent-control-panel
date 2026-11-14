# Spaces in the rail

## Intent

The rail groups agents by repository. The owner wants to group them by **what they are working on**: named spaces
such as "Checkout redesign" or "Billing bug", each holding the agents on that piece of work, even when those agents
are in different repositories. The goal is a rail ordered the way the owner thinks about the work.

A **space is not a workspace.** A workspace is one Claude login today (the tabs in the top bar), and stays as it is
in this change. A space lives inside one workspace. Making workspaces independent of the login (an OpenCode-only
workspace, several Claude logins in one) is a separate project, designed after this one.

## Goals

- Named spaces in the rail, above the repository sections, each listing the agents you put in it.
- You decide which space an agent is in: pick one when you start it, or move it later.
- Agents you never sort stay in their repository sections exactly as today. Nothing changes until you make a space.
- Spaces last until you delete them, so the next agent can start into "Billing bug" after the last one finished.

## Non-goals

- No automatic grouping (by branch, or suggested by the overseer). Possible later.
- No drag and drop between sections. Moving goes through a picker.
- No spaces shared across workspaces, and no nesting (a space holds agents, not repositories or other spaces).
- No change to workspaces, Needs you, Other folders or Finished.

## Anti-goals

- A space's name, or which agents it holds, must never reach a page or notification of another workspace. Treat
  space names like repository names: the existing rule ("a repository's name must not reach another workspace's") holds.
- Agents must never move between sections on their own. Only a click by the owner moves one.

## Approaches considered

1. **Spaces on top, repositories below for the rest (picked).** Spaces sit after Needs you. An agent in a space shows
   only there; every other agent stays in its repository section, then Other folders, then Finished. Nothing changes
   until a space exists, and unsorted agents keep today's grouping.
2. **Spaces replace repositories.** Every agent is in a space or in "No space". Simpler, but it throws away the repo
   grouping and puts every unsorted agent into one bucket.
3. **Spaces with repositories inside.** It shows which repos a job spans, at the cost of two levels of nesting and a
   taller rail.

The owner picked 1.

## What the owner sees

```
Sessions
  Overseer
Needs you
  ● cart-ui           needs you            ← an agent that needs you shows here, as today
Checkout redesign   1   1 needs you        ← a space: its count and "needs you", like a repo section
  ● cart-api                 p             ← each row names its repository, as rows under Needs you do
Billing bug         1
  ● fix-invoice
p                   1                      ← agents with no space, by repository, as today
  ● docs-cleanup
Other folders
Finished
```

### The rail
- Spaces come right after Needs you, in the order they were made.
- A space section looks and behaves like a repository section: a header with name and count, "N needs you" when
  agents of it wait under Needs you (the count, as for a repository, leaves out the agents shown under Needs you), folding (kept per workspace, as repository folds are), the slim rail's hairline,
  and the slim-rail rule that a folded section keeps its working or failing agents visible.
- **Header (my call):** a space header keeps the repository header's bulk buttons (Interrupt all, End idle) for its
  own agents, and adds Rename and Delete. It has no branch line under its name, since a space spans repositories;
  instead each row in a space names its repository, as rows under Needs you already do.
- An agent in a space is listed in that space instead of its repository section. If it needs you, it shows under
  Needs you (and the space header counts it), exactly as an agent of a repository does today.
- A finished agent goes to Finished as today. A space whose agents have all finished stays, with "No agents right
  now" under its header, so the owner can start the next one into it. In the slim rail an empty space is hidden.
- Find (`/`) and the arrow keys work across space sections as they do across repository sections.

### Making and managing spaces
- **New agent** gets a "Space" field: "None" (default), each existing space, and "New space…", which asks for a name
  inline. The launched agent lands in that space as soon as it shows in the rail.
- *(Added 2026-11-14.)* **A + on each space and repository header** opens New agent already in it: the space picked
  (or None, for a repository) and the folder filled in (a space's newest agent's folder, else New agent's usual one).
  The form starts short: what it should do, one line saying where it goes and what it starts with, **More options**
  for every other field, and Launch. New agent from the top bar stays the full form.
- **Moving an agent:** the session's details (the side column, or under the conversation on a narrow panel) get a
  "Space" picker with the same choices. Picking one moves the agent at once; "None" sends it back to its repository
  section.
- **A space's header** gets Rename and Delete, shown on hover and focus like the existing section tools. Delete asks
  to confirm the same way the bulk actions do ("Delete?"), and sends its agents back to their repository sections.
- Names: 1–40 characters, trimmed, unique in the workspace ignoring case.

## How it is kept

- Glue keeps spaces on the server, per workspace, alongside the workspace store (`workspaces.mjs`,
  `workspaces.json`, 0600). Each workspace has its list of spaces (`id`, `name`, in order) and which session is in
  which space. Every page and the desktop app see the same spaces.
- The snapshot for a workspace (`snapshot(wsId)`) carries only that workspace's spaces, and each session carries its
  space id (or none). No other workspace's page gets either.
- Membership is by session id. **Every continuation inherits the space (my call):** when an agent continues in OpenCode
  (`continuedFrom`), or a reply to a background job in its own worktree starts a copy under a new id (`continuedAs`
  in `reply()`), the new session joins the old one's space and the old session keeps it too, so neither moves on its
  own. The worktree copy needs the same "remember the space for this result id" step as launch, since `continuedAs`
  lives only in memory.
- At launch, the server remembers the space chosen for the launch result's id and applies it when that session
  appears, the same way the page already matches `launchedId` to a session by `id` or `sessionId`.
- Membership of sessions that are gone for good (removed, or no longer known after a restart and a grace period) is
  pruned so the file stays small.
- API: the page's existing pattern of POST actions with the token (`/api/space/...` for create, rename, delete, move),
  each acting on the page's own workspace only, refusing a space id or session of another workspace.

## Constraints

- Node standard library only on the server; the page stays one `public/index.html` with no build step.
- Existing tests keep passing; spaces get tests in the style of `test/workspaces.test.mjs` (store) and
  `test/workspaces-server.test.mjs` (server, including the anti-goal that another workspace's page sees no space).
- Today's rail behaviour is unchanged for anyone who never makes a space.

## Left to the builder

- The exact shape of the store additions and API names, and the grace period before pruning.
- How "New space…" asks for a name (inline field or small prompt), and the wording of empty and confirm states,
  in the panel's existing voice.
- Whether Settings › Workspaces also lists spaces. Not required.
- Whether the overseer's context names each session's space. It would help "what is everyone doing", but it is optional.
