# Several GitHub accounts

## Intent
The owner works in more than one GitHub account (a private one and a work one, matching workspaces such as Privat and
CHAI). Today Glue reads pull requests and CI, and merges, through gh's one active account: a workspace whose
repositories belong to the other account shows nothing, or the wrong thing. Asked: "plan for multiple github accounts".

## Goals
- Each workspace uses the GitHub account its work belongs to, for everything Glue does on GitHub: pull requests, CI,
  merges, CI logs, the PR watcher.
- The agents a workspace starts push and open pull requests as that account too.
- Glue still stores no token: gh keeps the accounts; Glue asks gh for a token when it needs one, holds it in memory.

## Non-goals
- GitHub Enterprise hosts (github.com only, as today).
- A per-repository account inside one workspace (a workspace is "how I work"; its repositories share an account). May
  come later as an override.

## How it works
- **Accounts are gh's own.** gh (2.40 and later) keeps several accounts per host (`gh auth login` adds one, `gh auth
  status` lists them). Glue lists them in Settings › GitHub and adds one by running `gh auth login` in Glue's terminal
  or in Terminal, as it does for Claude logins.
- **Each workspace picks one** in Settings › Workspaces (a row "GitHub", beside its logins), defaulting to gh's active
  account. Kept in the workspace store.
- **Glue's own calls** (github.mjs polls, merges, CI logs, the PR watcher) run with `GH_TOKEN` set to that account's
  token, from `gh auth token --hostname github.com --user <account>`, read once per poll round and held in memory only.
  The poller already works per workspace, so each workspace's repositories are read with its own account. Repositories
  in two workspaces with different accounts are read once per account.
- **Agents** a workspace starts (Claude Code and OpenCode) get `GH_TOKEN` for its account in their environment when it
  is not gh's active account, so their `gh pr create`, and `git push` through gh's credential helper, act as it.
- **When it goes wrong:** an account signed out in gh shows on its row in Settings › GitHub ("signed out: run gh auth
  login"), and that workspace's GitHub panel says so, like today's signed-out state.

## Settings
- GitHub, alerts & Auto-fix › GitHub CLI: one row per account (✓ signed in, its login, which workspaces use it), and
  "Add a GitHub account" (runs `gh auth login`).
- Workspaces: a "GitHub" row per workspace, a picker of the accounts.

## Constraints
- No token written to disk by Glue; tokens never reach a page or a log.
- Old installs keep working: no account picked means gh's active one, exactly as now.
- Tests: the poller given two workspaces with two accounts runs each workspace's gh calls with its own GH_TOKEN; the
  account list parsed from `gh auth status`; a signed-out account reported on its own.

## Left to the builder
- How long a token is held before it is read again (minutes, not hours).
- Exact wording on the rows.
