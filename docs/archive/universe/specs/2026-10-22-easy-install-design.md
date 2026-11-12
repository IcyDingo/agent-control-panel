# Easy install: the worker alone, one line, linked from the website

Design, 2026-10-22. **(owner)** = decided by the owner in conversation. **(call)** = decided here, marked for review.

## Intent

Today, getting a galaxy in the Universe means cloning the repository, running an installer that wants Node and Apple's
Command Line Tools, building a Mac app, opening it, connecting a profile, and then signing in with a code. Most of
that serves the panel app, the session board. The galaxy needs none of it: it needs the background service that
counts work and syncs, and a link to an account.

The owner wants two things **(owner)**: an install that a person who has only ever used Claude Code can do, and the
choice to run just the worker and use the website for everything else. The worker becomes the product's default; the
app is an extra for people who want the board.

## Goals

- From the Download page to a growing galaxy in one pasted line and one click, with nothing to type back.
- No git, no Xcode tools, no app build on the default path. Node is the one requirement, because the worker is Node.
- Signed in on the website, the line already carries the link: the install ends with "Your galaxy: …/@you".
- The worker keeps itself current, so nobody runs `git pull` again.
- The panel app stays available, installed the way it is today, on top of a worker that is already there.

## Non-goals

- Replacing the panel app or its installer. Its path (clone, `./install.sh`) is unchanged this round.
- Windows or Linux. The worker is launchd.
- Installing Node for the person. The script says what to install and where, and stops.
- A signed, notarized package or a Homebrew formula. Later, if the one line is not enough.

## Anti-goals (it fails even if it works when)

- The one line can be used to link a stranger's Mac to your account long after you copied it: the link code is
  one-time and expires in 15 minutes.
- An update replaces a working worker with a broken one and leaves nothing to go back to: the previous version is
  kept and a failed start rolls back.
- The worker phones home for updates when the person said not to: a setting turns it off and is honoured.
- Private data leaves the Mac through the install or the update: the install sends nothing but the link claim;
  the update downloads only.

## The flow, as the person meets it

1. **Download page**, signed out: one line, `curl -fsSL https://universe.cashegg.com/install | sh`. Signed in: the
   same line with a link argument, `… | sh -s -- --link <code>`, and the sentence "This line links the worker to
   @you. It works once, for 15 minutes." A button makes a fresh one.
2. **Terminal.** The script prints what it checks and does, in the installer's existing voice:
   - macOS 14 or newer. Node 20 or newer, else: "Install Node from nodejs.org (the LTS installer), then run the line
     again." and stop. Claude Code present, else a warning, not a stop: the galaxy grows once it is used.
   - Downloads the current release as an archive (no git), into
     `~/Library/Application Support/Agent Panel/worker/<sha>/`, and points `worker/current` at it.
   - Installs the background service (today's launchd agent, `local.agent-panel`, running a small launcher that
     starts `current/server.mjs` with `ACP_DAEMON=1`) and waits for it to answer.
   - With `--link`: claims the code; prints "Linked to @you. Your galaxy: https://universe.cashegg.com/@you". Without:
     starts the device sign-in, prints the code, opens the approval page in the browser, waits.
   - Ends with: how to see the galaxy, that the worker updates itself, and the two lines to turn that off or remove
     everything.
3. **Website.** The galaxy page is the interface: the owner's box (balance, prices, Push, Send a rocket, Build), the
   profile, the devices list. Nothing in the flow mentions the app unless the person goes looking.
4. **The app, optionally.** A second block on the Download page: "Want the session board too?" with today's three
   lines. `install.sh` finds the worker already installed and keeps it (see below).

## Decisions

| Topic | Decision |
|---|---|
| Default install | The worker alone; the app is the optional second block **(owner)** |
| How | One line, `curl … /install \| sh`, served by the hub **(owner, from the proposal)** |
| Linking | Pre-approved device code carried in the line; one-time, 15 min; a fresh one on demand **(call)** |
| Where the worker lives | `~/Library/Application Support/Agent Panel/worker/<sha>` with a `current` link **(call)** |
| What is a release | The hub says: `GET /api/release` → the commit to run and its archive address. The commit is **the one the hub itself was deployed from**: `update.sh` records it, so workers follow deploys, never bare merges to `main`. The owner can pin another with `HUB_RELEASE` **(call)** |
| Self-update | Daily check by the worker; on by default; `worker/update.json` `{ "auto": false }` turns it off; the previous version is kept and a version that cannot start is rolled back by the launcher **(call, owner asked)** |
| Requirements | Node 20+, macOS 14+. Apple's Command Line Tools are optional: without them the worker counts tokens but not commits, and the script says so and goes on **(call)** |
| Panel app on top | `install.sh` keeps using the clone it runs from (today's behaviour), and when a worker service exists it replaces it with one that runs from the clone, saying so; `./install.sh --uninstall` puts nothing back. The two never run side by side on one port **(call)** |
| Worker on top of the app | The one line on a Mac whose service already runs from a clone takes the service over, saying so: "The background service ran from <path>; it now runs from the worker install and updates itself. The app keeps working with it." The app reuses any server on its port, so nothing else changes **(call)** |
| Re-running the line signed in | `login --link` on a Mac that is signed in does nothing and says so: "Already signed in as @you. This Mac stays linked to @you; to switch, run `node server.mjs logout` and then the line again." The Mac cannot tell whose account a link names without spending it, so the sentence is the same for both cases, and the unspent link expires on its own **(call)** |

## Hub side

- **`GET /install`**: the script, `text/plain`, from `hub/public/install.sh`, no-cache like the pages. Also
  `/install.sh` for people who type it. Not behind the bot check (it is under no `/api/`, so the Cloudflare rule gets
  a second path, or the script moves to `/api/install`; the deploy README records whichever).
- **`POST /api/me/links`** (web, Origin, limit `approve`/account): mints a device code and approves it for the
  account at once, label "Worker on a Mac"; returns `{ ok, code: <device_code>, expires_in: 900 }`. Only one unspent
  link per account: a new one replaces the old. The Mac collects the token the way it already does, with one poll of
  `POST /api/device/token`. No new state, no new table: `device_codes` as it is, status `approved`.
- **`GET /api/release`** (pub, 30 s public cache): `{ ok, sha, url }`. `url` is GitHub's archive for the commit
  (`https://codeload.github.com/IcyDingo/agent-control-panel/tar.gz/<sha>`). `sha` is `HUB_RELEASE`, a full 40-hex
  commit; `hub/deploy/update.sh` writes it (the checkout's HEAD after the pull) into `release.env`, which `compose.yml`
  reads beside `.env`, so the hub always names the commit it runs and the Mac never gets ahead of the hub's projection
  version or API. Unset, the route answers 503 with a sentence; the worker treats that like any failed check. No
  GitHub polling.
- **Download page**: the one line, signed in with the link; "Make a new link" button (calls `/api/me/links`); the
  requirement sentence; the app block below. The profile page's devices list already shows the linked worker.
- **Cloudflare**: the rule that skips the bot check for `/api/` also covers the script's path.

## Mac side

- **`hub/public/install.sh`** (the script; a plain POSIX `sh` script, 150 lines at most): flags `--link <code>`,
  `--uninstall`, `--no-update`. Checks (macOS, Node, Claude Code, and `xcode-select -p` for the Command Line Tools:
  missing ones are a sentence, "Commits won't count until you run `xcode-select --install`; tokens count from now",
  not a stop); when a service already runs from somewhere other than `worker/`, says it is taking it over (Decisions);
  downloads `/api/release` (through the hub, so the rule applies) and the archive with `curl`; extracts with `tar`
  into `worker/<sha>`; verifies the archive's top folder is `agent-control-panel-<sha>`; writes `worker/run.sh` (the
  launcher, below) and `worker/update.json` when `--no-update`; runs `node worker/<sha>/server.mjs daemon install
  --program worker/run.sh` (the existing command, with the launcher as the program); waits on readiness
  (`curl http://127.0.0.1:4747/`); then `node worker/current/server.mjs login --link <code>` or plain `login`.
  `--uninstall`: `daemon remove`, delete `worker/`, say what is left (`hub.json`, `world.json`, logs) and how to
  delete them.
- **`worker/run.sh`** (the launcher, written by the script, 30 lines, never versioned): what the plist runs. It reads
  `worker/current`, and before `exec node current/server.mjs` it handles a switch: `worker/switch` (written by the
  update, one line `<to> <from> <tries>`, so the launcher needs no JSON parser) means a new version is being tried. If
  `worker/started` already names `to`, the switch file is removed. Otherwise `tries` goes up, and at 3 the launcher
  points `current` back at `from`, writes `worker/rolled-back` (one line `<to> <time>`; the panel's snapshot shows it,
  the hub is not told this round), and removes the switch file. A version that cannot start therefore costs at most three launchd restarts
  (30 s with `ThrottleInterval 10`), and the launcher is the one thing that is always present and never updated.
  `node` is found the way the plist finds it today (`ACP_NODE` baked at install).
- **`cli.mjs`**: `login --link <code>` writes the pending code to `hub.json` and polls once (the code is approved
  already); on `ok` prints the galaxy address; signed in already, see Decisions. Everything else as today.
- **`daemon.mjs`**: `launchdPlist` and `install` take a `program` (a path the plist runs instead of `node server.mjs`),
  because Node resolves `current` to the real folder and a plist naming `worker/<sha>` would break at the first
  update. The app's `install.sh` keeps passing none, so its plist is unchanged.
- **`update.mjs`** (new): `checkForUpdate({ hub, now, workerDir, running })`: once a day under `ACP_DAEMON`, when
  `worker/update.json` does not say `"auto": false`: `GET /api/release`; if `sha` differs from `running` (the real
  folder name of the code that is running), download the archive to `worker/<sha>.tmp`, verify the top folder, move
  it to `worker/<sha>`, write `worker/switch`, point `current` at it, and exit with code 0 so launchd starts the new
  one through the launcher. On start, the worker writes `worker/started` with its sha. Versions other than `current`
  and the one `switch`/`rolled-back` name are deleted. A worker that starts but whose update path is broken is
  replaced by running the one line again (the script installs over whatever is there); that is the stated limit.
- **`server.mjs`**: under `ACP_DAEMON` and only when it runs from under `worker/` (so an app-installed service never
  self-updates), schedules the daily update check and writes `worker/started`; `snapshot().version` carries the sha so
  the panel's About line and `node server.mjs status` can show it. World's commit scan asks once per scan whether
  the Command Line Tools are present (`xcode-select -p`) and skips `git` when they are not, so a Mac without them never
  gets Apple's install dialog from a background job.
- **`install.sh`** (the app's): when `worker/current` exists, says "The background service will run from this folder
  from now on (it was running from the worker install)", installs the service from the clone as today, and leaves
  `worker/` in place.

## Security

- The link code is the device flow's own `device_code`: random, hashed at rest, 15 minutes, spent on first use. The
  page shows it only to the signed-in owner, with the sentence that it links a Mac to their account. A spent or
  expired code makes the script fall back to the normal sign-in, with a sentence saying why.
- The script is served from the hub over https; the archive comes from GitHub over https; the hub names the commit it
  runs itself, so a person can read exactly what will run (`/api/release` is public). No checksums beyond the commit
  name this round; a signed release is a later step.
- The worker's update check sends nothing but the request; it carries no token.
- `curl | sh` is what it is: the Download page links the script's source beside the line, so anyone can read it first.

## Copy on the Download page

Heading "Get the worker". "One line in Terminal. It installs a small background service that counts your agents'
work and keeps your galaxy here up to date. You need a Mac on macOS 14 or newer and Node 20 or newer. Claude Code does
the rest; with Apple's Command Line Tools your commits count too." Below the line, signed in: "This line links the worker to @handle. It works once, for 15 minutes. [Make a
new link]". Signed out: "Sign in with GitHub first and the line links the worker for you; or run it now and approve a
code in the browser." Then "Want the session board too?" with the app's three lines and its own requirements.

## Tests

- `test/hub-api.test.mjs`: `/install` served as text with no-cache; `POST /api/me/links` needs a web session and the
  Origin, answers a code that `POST /api/device/token` turns into a token at once, a second link replaces the first
  (the first polls to 410 and its token is revoked), the code expires; `/api/release` answers `HUB_RELEASE` with the
  codeload address, 503 when it is unset.
- `test/hub-client.test.mjs`: the link sign-in with an approved code signs in with one poll; a spent one is reported
  so the CLI can fall back to a fresh device login; the hub unreachable is an error, not a fallback.
- `test/update.test.mjs` (new): with a fake hub and a temp `worker/` folder: same sha does nothing; a new sha is
  downloaded, verified, `switch` written, `current` moved and the process asked to exit; a bad archive (wrong top
  folder) is discarded; `{ "auto": false }` never asks; old folders are pruned.
- `test/daemon.test.mjs`: a plist with `program` runs that path and nothing else; without it, today's plist.
- `test/worker-run.test.mjs` (new): the launcher with a stub `node` in a temp `worker/`: no switch file → runs
  `current`; a switch whose `to` is in `started` is removed; a switch that fails three starts points `current` back at
  `from` and writes `rolled-back`.
- `test/install-sh.test.mjs` (new): runs the script with a fake `PATH` (stub `node`, `curl`, `tar`, `launchctl`,
  `xcode-select`) in a temp HOME: stops without Node with the nodejs.org sentence; goes on without the Command Line
  Tools with the commits sentence; installs into the right folder and writes the launcher; passes `--link` through;
  says it takes over a clone-based service; `--uninstall` removes the service and the folder and lists what is left.
- `test/world.test.mjs`: with the tools reported missing, a scan makes no `git` call.
- Manual: on a clean user account on this Mac, the one line from the Download page, signed in; the galaxy appears;
  `install.sh` on top keeps the galaxy and switches the service.

## Rollout

1. Hub: `/api/release` and `update.sh` writing `release.env`, `/api/me/links`, `/install`, the Download page.
2. Mac: `daemon.mjs` `program`, `login --link`, the launcher, `update.mjs`, the tools check in World, the script, the
   installer's awareness of the worker.
3. Deploy the hub; test the line on a clean account; then the README's Get started leads with the line and keeps the
   app path under "The session board".
