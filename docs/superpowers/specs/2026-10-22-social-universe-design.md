# Social universe: a hub, headless install, and visiting each other's systems

Design, 2026-10-22, agreed in a brainstorm with the panel's owner and approved as a plan the same day. It supersedes the
"Sharing, leaderboards, several people in one world" non-goal of `2026-10-21-world-design.md`; everything else in that
spec still holds. **(owner)** marks what the owner decided, **(call)** a decision made while writing this that the owner
has not ruled on.

## Context

World today is single-player and single-Mac: credit from agent work grows Home, and the owner spends it on frontier
pushes, colonies and builds. Its spec (docs/superpowers/specs/2026-10-21-world-design.md) listed sharing as a
non-goal. The owner now wants the opposite: a **social dev universe**. Every developer grows a system with Home at its
centre and a sun beside it; others fly over and visit; each person has a small profile; a rocket sent to a friend's
coordinates is a friend request; linked friends chat. And a developer should be able to install once and have all of
this happen **without ever opening the panel**.

Two facts about today's code shape the work:

- Usage is counted only while `server.mjs` runs, and only after someone clicked **World** once (`world.open()` is the
  only thing that sets `startedAt`). Only Agent Panel.app starts the server, and it stops it on quit. No launchd job.
- Everything listens on 127.0.0.1 with a per-start token and same-origin checks. There is no user beyond the Claude
  Code profile, and nothing reachable from another machine.

So the feature needs a daemon on the Mac and a hosted **hub** in the middle.

## Decisions

| Topic | Decision |
|---|---|
| Where the universe lives | A hub the owner hosts, location open; one Node process, runs anywhere **(owner)** |
| Sign-in | GitHub at launch, accounts shaped so Google / email can be added later **(owner)** |
| No-panel use | `install.sh` adds a launchd agent that keeps the server running and syncing; the hub website shows your system with the same renderer; the Mac panel becomes optional **(owner)** |
| System shape | Home stays at map (0,0); a **sun** sits near Home, lights the system, marks it on the universe map **(owner)** |
| What strangers see | Planets, colonies, builds with captions, moments, Home's level, days active, colony count, small profile. Never tokens, lines, credit, repo names, build prompts **(owner)** |
| Universe map | Permanent coordinates per account in a spiral universe, shown on the profile; zoom out past your system to see nearby suns **(owner)** |
| Rocket to a friend | A friend request; they accept or ignore; accepting links both **(owner)**. Costs **2,000 credit, flat** **(owner)** |
| Chat | Separate direct messages between linked friends, on the hub site and in the panel **(owner)** |
| Two Macs, one account | Last writer wins; the panel says when another Mac is syncing **(owner)** |
| Hub address | Placeholder constant; build and test against a local hub on port 4848 **(owner)** |

## Goals, non-goals, anti-goals

Goals: install once, forget it, and a month later have a system worth showing. Visiting a friend is one click from
your own map. The hub holds only what a stranger may see.

Non-goals this round: leaderboards or ranking by numbers; group chat; building on another's system; providers beyond
GitHub; non-Mac clients.

Anti-goals, it fails even if it works when: the hub being down slows or breaks the panel (all hub I/O is off the
request path, fire-and-forget, with timeouts); private data leaves the Mac (the payload is an allow-list projection,
never `world.json`); the daemon and the Mac app fight over the port; strangers can message you without an accepted
link.

## Architecture in one picture

```
Mac (per developer)                                   Hub (owner hosts)
 launchd → node server.mjs  (ACP_DAEMON=1)             node hub/server.mjs  (SQLite via node:sqlite)
   world.mjs scan every minute ──publicProjection──▶   PUT /api/me/system   (Bearer client token)
   hub.mjs      device-flow login, hub.json 0600  ◀──  POST /api/device/*   (hub is the auth server)
   hub-sync.mjs debounced push, backoff            ◀──  GET /api/me/events   (SSE: rockets, chat)
   /api/hub/*   proxies for the page (same-origin)      GET /@handle, /, /me, /friends, /chat (plain HTML+JS)
 Agent Panel.app / browser: public/world.js             hub/public/* reuses public/world.js read-only
```

The page never talks to the hub. The panel server proxies, so the token stays in `hub.json` and the page stays
same-origin, which keeps today's security model intact.

## New and changed files

Root (panel), all Node stdlib, one concern per file like `trust.mjs`:

| File | Role |
|---|---|
| `daemon.mjs` (new) | launchd plist text, install/remove/status via `launchctl`; pure, testable |
| `paths.mjs` (new) | `appSupportDir()` and the `ACP_PREFS` rule, shared by server and CLI |
| `cli.mjs` (new) | `node server.mjs login|logout|status|daemon install|remove|status` |
| `hub.mjs` (new) | hub client: credentials file, `request()`, device flow, SSE `stream()` + pure `parseSse()` |
| `hub-sync.mjs` (new) | `createHubSync({hub, projection})`: debounce, hash skip, heartbeat, backoff |
| `world.mjs` | `sunOf`, `daysActive`, `publicProjection`, `validProjection`, `PRICES.hail`, `hailTarget`, `buy({kind:'hail'})` |
| `server.mjs` | argv dispatch to CLI; `ACP_DAEMON` autostart + `EADDRINUSE` wait; hub wiring; `snapshot().hub`; `/api/hub/*` |
| `public/world.js` | sun at both zooms, `readOnly`, universe layer, visit mode, friend rocket flight, parked rockets |
| `public/index.html` | side panel sections: Profile, Friends & rockets, visit card; chat drawer; unread badge |
| `install.sh` | `--no-daemon`, `--uninstall`, daemon step, new Done text |
| `README.md` | Run it, Mac app, new "Always on", World, new "Hub", Security, Uninstall |
| `docs/superpowers/specs/2026-10-22-social-universe-design.md` (new) | this design, superseding the 2026-10-21 non-goal |

Hub, in this repo under `hub/` (it imports `../world.mjs` and serves `../public/world.js` byte-for-byte; Node 22.13+
for the hub only, `node:sqlite` behind `hub/db.mjs` so the API is wrapped in one place) **(call)**:

`server.mjs` (routing, static, SSE), `config.mjs` (env), `db.mjs` (migrations, statements), `coords.mjs`,
`validate.mjs`, `accounts.mjs`, `auth.mjs`, `systems.mjs`, `links.mjs`, `chat.mjs`, `live.mjs`, `limits.mjs`,
`public/{index,system,me,friends,chat}.html`, `public/{hub,universe}.js`, `public/hub.css`, `Dockerfile`, `README.md`.

Env: `HUB_PORT` (4848), `HUB_DATA`, `HUB_PUBLIC_URL` (its host is the only accepted `Host`), `HUB_GITHUB_CLIENT_ID`,
`HUB_GITHUB_CLIENT_SECRET`, `HUB_TRUST_PROXY`, `HUB_DEV_LOGIN=1` (a `dev` provider for local runs and tests, refused
when the public URL is https).

## Design details

### Headless install (daemon.mjs, install.sh, server.mjs)

- Plist `~/Library/LaunchAgents/local.agent-panel[.<port>].plist` (label rule mirrors `app/build.sh:13-14`):
  `ProgramArguments [node, <repo>/server.mjs]`, `WorkingDirectory <repo>`, env `PATH` (baked like `build.sh:46`),
  `ACP_PORT`, `ACP_DAEMON=1`; `RunAtLoad`, `KeepAlive`, `ThrottleInterval 10`, `ProcessType Background`, both log
  paths to `~/Library/Logs/Agent Panel/daemon-<port>.log` (not the app's `server-<port>.log`: two writers would
  interleave). Install = write plist, `launchctl bootout` (ignore failure), `launchctl bootstrap gui/$UID <plist>`.
- `server.mjs`: `const DAEMON = process.env.ACP_DAEMON === '1'`. In the `listen` callback (line ~1573):
  `if (DAEMON && !world.started()) openWorld()`, so World starts at install and `startedAt` is install time. Add
  `server.on('error')`: under the daemon, `EADDRINUSE` waits 5 s and retries instead of dying, so an app-started
  server from before the install is not fought and the daemon takes the port when it quits. Without this, KeepAlive
  would relaunch every 10 s forever.
- Mac app needs no change: `app/main.swift:125-213` reuses any server that answers and only stops one it started.
- `install.sh`: `--no-daemon` keeps today's behaviour; after `app/build.sh`, `node daemon.mjs install`, then wait up
  to 10 s for `curl http://127.0.0.1:$port/`; new Done text ("runs in the background, World grows whether or not you
  open it"; update = `git pull && ./install.sh` restarts the service). `--uninstall`: bootout, remove plist and app,
  print the two manual steps (hooks in settings.json, the Application Support and Logs folders).

### The sun (world.mjs, world.js)

- `SUN_DIST = 90`, `SUN_R = 9`, `SUN_LOOKS = ['gold','white','orange','blue']`; `sunOf(seed)` puts it at angle
  `2π·hash(seed,'sun')` (hash at world.mjs:67), look by `hash(seed,'sun look')`. Planets start past
  `LOBE_START + PUSH_LEN/2`, so it never sits on one **(call)**. `summary()` gains `sun` and `daysActive`.
- world.js: on the map, `drawSun` (corona gradient, disc, six faint slowly rotating rays, none when reduced motion)
  drawn after the sky, before Home; the sun joins `lit()` in `paint()` (world.js:70) and the `sig`. Close up, the
  light direction on Home, planets and built pieces (`drawHome` ~142, `drawPlanet` ~185, `drawBuilt` ~234, city
  lights ~305) comes from the sun's angle, plus a warm off-canvas glow in that direction. `hit()` ignores the sun.

### The public projection (world.mjs, shared with the hub)

Allow-list copy, never a spread, like `validBuild`:

```
{ pv: 1, seed, since: 'YYYY-MM-DD', daysActive, home: { level, stage }, reach, sun,
  frontier: [{ang, bought, lit, tip}], planets: [{id, x, y, look, colony: {name, day}|null}],
  moments: [{id, kind, name, day, from, x, y}], builds: [{id, on, caption, pieces, day}] }
```

Stripped by construction: `earned, spent, balance, prices, today, home.xp, noEmail, gitFailed` (repo paths),
`moments[].info` (commits, lines, credit), build `description`, exact timestamps, hail purchases. `validProjection(p)`
returns a fresh object or `null`: frontier ≤ 64, planets ≤ 256, moments ≤ 4000, builds ≤ 1000 each through
`validBuild`, colony names through `colonyName`, ids `^p\d{1,4}$` / `^b\d{1,4}$`, finite numbers within ±1e6, dates
`^\d{4}-\d{2}-\d{2}$`, `level` in range, `seed` in `[0, 2^31)`. The hub re-validates every PUT and stores the
re-serialised result; the panel validates everything it fetches from the hub before the renderer sees it. When world.js
draws a visited system it derives Home's drawing XP from the level's threshold in `LEVELS` **(call)**.

### Hub data model (hub/db.mjs, migration v1)

`accounts(id, ordinal UNIQUE, handle UNIQUE NOCASE, x, y UNIQUE(x,y), name, bio, link, avatar, visibility
'public'|'unlisted', show_friends, handle_changed_at, created_at)`;
`identities(provider, subject PK, account_id, login, email, avatar, linked_at)` with `provider='github'` now,
`'google'|'email'|'dev'` later and nothing in `accounts` changing;
`sessions(id_hash, account_id, expires_at)`; `client_tokens(id, hash, account_id, label, scopes, device, created_at,
last_used_at, revoked_at)`; `device_codes(hash, user_code, expires_at, interval, status, account_id, token_plain)`;
`oauth_states`; `systems(account_id PK, pv, seq, hash, device, snapshot, level, stage, days_worked, colonies, builds,
received_at)`; `rockets(id, from_id, to_id, status pending|accepted|ignored|cancelled, sent_at, answered_at)`;
`friends(a<b, since)`; `messages(id, thread, from_id, to_id, body, sent_at)`; `reads`; `events(id, account_id, kind,
data, at)` pruned past 7 days; `schema_version`.

Handle: `^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$`, reserved `{me, api, device, login, logout, chat, friends,
universe, home, admin, hub}`, default GitHub login lowercased or `login-<ordinal>`, changeable once per 7 days **(call)**.

Coordinates (`hub/coords.mjs`): Vogel sunflower spiral, `r = 60·√ordinal`, angle `ordinal·π(3−√5)`, ±12 hashed
jitter, rounded to integers; neighbours are ≈106 apart so every pair stays > 60; `(0,0)` is never issued; permanent
**(call)**.

### Auth

- Website: GitHub OAuth, no scope; `identities('github', numeric id)`; session cookie `hub_s` HttpOnly, SameSite=Lax,
  Secure on https, 30 days. Writes need cookie **and** `Origin === HUB_PUBLIC_URL`, as the panel does. No CORS anywhere.
- Mac: a **hub-native device flow** (RFC 8628 shape). `POST /api/device/code` → `{device_code, user_code 'BKQT-7W3N',
  verification_uri_complete, expires_in 900, interval 5}`; the user approves at `/device?code=` after signing in with
  GitHub; the hub mints `hub_` + 32 random bytes, stores its sha256 in `client_tokens`, parks the plain token until the
  one `POST /api/device/token` poll that collects it (`428 authorization_pending`, `429 slow_down`, `410`, `403`,
  `200 {token, account:{id,handle,x,y}}`). The Mac never holds a GitHub token, and a future Google user approves a
  device the same way **(call)**.
- Client token scope `client`: PUT system, rockets, friends, chat, SSE, `GET /api/me`, `DELETE /api/me/tokens/self`.
  It cannot edit the profile or manage other tokens.
- `~/Library/Application Support/Agent Panel/hub.json`, mode 0600, tmp+rename:
  `{v:1, url, device, token, account:{id,handle,x,y}, lastSync:{seq,hash,at}, pending:{device_code,user_code,
  verification_uri_complete,expires_at}}`. `pending` survives a restart. `hub.mjs` re-reads when the mtime changes,
  so `node server.mjs login` in a terminal is picked up by the running daemon.

### Hub HTTP API

`{ok:true,…}` / `{ok:false, error:'a sentence'}`; 400, 401, 403, 404, 409, 413, 422, 429 (+`retry-after`).
**pub** = none; **web** = cookie (+Origin on writes); **tok** = Bearer; **any** = web or tok.

| Endpoint | Auth | Notes |
|---|---|---|
| `GET /healthz`, static files, pages `/`, `/@:handle`, `/me`, `/device`, `/friends`, `/chat[/@:handle]` | pub | |
| `GET /api/systems/@:handle`, `GET /api/systems/at?x&y` | pub | `{profile, stats:{level,stage,daysWorked,colonies,builds,lastActive}, system, friends|null}` |
| `GET /api/universe?x0&y0&x1&y1` | pub | window ≤ 4000², ≤ 500 suns `{handle,x,y,level,colonies,active}`; unlisted excluded |
| `GET /api/search?q` | pub | handle prefix, ≤ 20 |
| `GET /login/github`, `GET /auth/github/callback`, `POST /logout`, `POST /auth/dev` | pub/web | dev only with `HUB_DEV_LOGIN=1` |
| `POST /api/device/code`, `POST /api/device/token` | pub | 5/min/IP |
| `POST /api/device/approve|deny {user_code, label}` | web | |
| `GET /api/me` | any | account, identities, tokens (web only), counts |
| `PATCH /api/me/profile {handle?,name?,bio?,link?,visibility?,showFriends?}` | web | bio 160, name 40, link 200 https? |
| `DELETE /api/me/tokens/:id` / `/self` | web / tok | |
| `PUT /api/me/system {pv, seq, device, snapshot}` | tok | 12/min, 512 KB; 422 invalid; 409 `stale` when `seq <` stored (logged, client keeps pushing: last writer wins) |
| `GET /api/me/rockets`; `POST /api/me/rockets {to:{handle}|{x,y}}`; `DELETE /api/me/rockets/:id`; `POST …/:id/accept|ignore` | any | 10/day, one pending per pair, 30-day cooldown after ignore with the same wording as "already on its way" |
| `GET /api/me/friends`; `DELETE /api/me/friends/@:handle` | any | |
| `GET /api/me/chat`; `GET /api/me/chat/@:handle?before&limit`; `POST /api/me/chat/@:handle {body}`; `POST …/read {upTo}` | any, friends only | 30/min, body ≤ 2000 |
| `GET /api/me/events` | any (Bearer header, never `?t=`) | SSE: `rocket`, `rocket_answered`, `friend`, `unfriend`, `message`, `read`, `profile`; `Last-Event-ID` replays from `events` |

Rate limits in `hub/limits.mjs` (in-memory token buckets). Pages: `/` universe canvas (`universe.js`, drag, wheel,
search); `/@handle` = the `#world` skeleton from `public/index.html:824-889` minus the spend boxes, `AgentWorld.enter(
system, {readOnly:true, universe, me})` and a profile card; `/me` profile + devices + device approval; `/friends`;
`/chat`. `robots.txt` allows `/` and `/@*` only; unlisted pages add noindex. Web-only users cannot send rockets
(they have no credit; the hint says to aim from the panel) **(call)**.

### Panel side: sync and proxies (server.mjs, hub.mjs, hub-sync.mjs)

- `hub = createHub({file, hubUrl: process.env.ACP_HUB ?? DEFAULT_HUB})`; `hubSync = createHubSync({hub,
  projection: () => publicProjection(worldSummary())})`.
- `scanWorld` (server.mjs:1342) calls `hubSync.schedule()` after every scan (it hashes, so no change = no PUT);
  `buyInWorld`, `buildInWorld`, `openWorld` call `schedule({urgent:true})`. Debounce 10 s (urgent 1 s), skip on equal
  hash, heartbeat every 30 min so `active` stays fresh, backoff 30 s → 10 min on failure, `401` stops until the file
  changes. Never throws, never awaited on the request path.
- `snapshot()` (~1427) gains `hub: {configured, loggedIn, me, login:{userCode, verificationUri, expiresAt}|null,
  sync:{lastOk, lastError, nextAt}, friends, rockets:{incoming, outgoing}, threads:{[handle]:{unread,lastAt,lastId}}}`.
  The token never appears in a snapshot.
- New `ACTIONS` (server.mjs:1552, inherit token + Origin): `/api/hub/status`, `/api/hub/login/start|cancel`,
  `/api/hub/logout`, `/api/hub/profile {bio, link}`, `/api/hub/sync`, `/api/hub/universe {x,y,w,h}` (30 s cache),
  `/api/hub/system {handle}|{x,y}` (validated with `validProjection`), `/api/hub/rocket {to}`,
  `/api/hub/rocket/answer {id, accept}`, `/api/hub/chat/history|send|read`.
- `hubLive`: the hub SSE is held only while a page is connected to `/events` (start at server.mjs:1520, stop with
  `releaseTimer` 1528-1531), so a headless daemon keeps no idle connection. Events update `hubState` and `broadcast()`;
  chat messages are not in the snapshot, the page refetches when `threads[h].lastId` moves (same pattern as
  `loadChat`, index.html:1514-1524) **(call)**.
- Avatars shown only from `https://avatars.githubusercontent.com/`.

### Friend rockets (world.mjs, server.mjs, world.js)

- `PRICES.hail = 2000`, flat like builds. `hailTarget(raw)`: `@handle` (GitHub rules) or `"412, -88"` / `{x,y}` with
  integers ≤ 1e6. `buy({kind:'hail', to})` records `{kind:'hail', at, price, earnedAt, to:{handle,x,y}}`; a second
  hail to the same target within 7 days is refused **(call)**. Hails are not in the projection.
- `/api/hub/rocket`: refuse self → check balance → resolve on the hub (already friends / pending) → `POST
  /api/me/rockets` → `world.buy` (if that fails after the hub accepted, `DELETE` the rocket) → urgent sync, broadcast.
  Credit is only taken once the hub holds the rocket.
- world.js: flight `kind:'hail'` leaves from where you are toward the friend's direction and fades past the edge
  (reduced motion: toast only). Incoming rockets park near the sun, nose toward it, bobbing; click scrolls to the
  Friends box; Accept lands it on Home and toasts "You and @kim are linked", Ignore removes it. New incoming rockets
  toast on the board even with World closed (compare ids in `es.onmessage`, like the level toast at ~1063).

### Universe zoom and visit mode (world.js, index.html)

- `UNIT = 60` map px per hub unit **(call, matches the spiral's spacing)**; `Z_UNIVERSE = zFit() + 1.4`, reachable
  only when signed in (else a hint "Sign in to see the systems around you"). Past `zFit()` the own system fades to its
  sun; a constant-seed far starfield; nearby suns from `/api/hub/universe` (debounced 300 ms, refetch when the bbox
  moves > 20 %, 60 s cache); friends ringed; labels on hover or when < 30 on screen; own label `You · 412, −88`.
  `Universe` button beside `Map`. `hit()` tests suns first; click → visit.
- Visit: `world` swaps to the fetched projection (`mine` kept; `update()` applies to `mine` only), `make(seed)`,
  `paint()`, fly to their Home; body class `w-visiting` hides Build, Push, Rocket, Today, Friends, Profile; a visit
  card shows avatar, @handle, bio, link, coords, level and stage, colonies · moments · builds, since; buttons
  `Send a rocket` (prefills the Friends box; disabled when already friends) and `Back to my system`. Esc leaves the
  visit before leaving World (index.html ~2708). `pick()` tolerates `info == null`.

### Panel UI additions (index.html)

- Profile section at the top of `#w-side`: avatar, @handle, coordinates, bio, link; `Sign in with GitHub` → shows the
  user code and link, "Waiting…", Cancel; `Edit profile` (bio 160, link 200); sync line ("Synced 2 min ago" /
  "Hub unreachable, last synced …" / "Another Mac is syncing this account" / "Sign in again"); Sign out.
- Friends & rockets section: incoming rows (Accept / Ignore), friends rows (Visit / Chat (n)), hail input + price +
  button, errors.
- Chat drawer on the left inside `#world` (same recipe as `.space .drawer`, index.html ~698): header, thread,
  `Show earlier`, composer; reuse `.composer`, `.msg.you`, add `.msg.them`; plain text via `el(..., {text})`, never
  `md()`; optimistic send like `outbox` (~1525). Unread count on the World button when World is closed
  (`renderWorldBtn` ~2483). Fits a 13" window; below 900 px the drawer covers the side panel.

## Order of delivery (each slice ships alone, tests green)

0. **Spec**: write `docs/superpowers/specs/2026-10-22-social-universe-design.md` from this plan; note it supersedes
   the sharing non-goal of the 2026-10-21 spec.
1. **Headless + launchd**: `daemon.mjs`, `paths.mjs`, `cli.mjs` (daemon commands), `install.sh` flags, `server.mjs`
   autostart + port wait, README, uninstall. `test/daemon.test.mjs` (plist content, `plutil -lint`, escaping, label
   rule, install/remove with a fake `run`). Usable alone: install, forget, World grows.
2. **Sun + projection** (no hub): `sunOf`, `daysActive`, `publicProjection`, `validProjection`; world.js sun and
   lighting, `readOnly` option. `test/world-universe.test.mjs`, `test/world-projection.test.mjs` (allow-list keys; the
   JSON contains no `/Users`, `tokens`, `credit`, `added`, `description`; validator rejects extra keys, 25-char colony
   names, 1001 builds, NaN; round-trips its own output).
3. **Hub skeleton, local**: `hub/{config,db,coords,validate,accounts,auth(web+dev),systems,server}.mjs`, pages `/`,
   `/@handle`, `/me`, `PUT /api/me/system`, public reads, Dockerfile; `node hub/server.mjs` on 4848 with
   `HUB_DEV_LOGIN=1`. Tests: `hub-coords` (determinism, spacing > 60 for 1..20000, no (0,0)), `hub-validate`,
   `hub-api` (real HTTP on port 0: sign in two dev users, PUT valid / 422 / 409 / 413, public read has no `today`,
   universe window, unlisted hidden, Origin missing → 403).
4. **Device flow + tokens + sync + profile**: `hub/auth.mjs` device flow, `hub.mjs`, `hub-sync.mjs`, `cli.mjs login|
   logout|status`, server wiring and `/api/hub/status|login|logout|profile|sync`, Profile section. Tests: `hub-auth`
   (token mint/hash/verify/revoke, device state machine, slow_down, return_to must be local), `hub` (parseSse over
   partial chunks, hub.json 0600 and mtime re-read, device polling, 401 flips loggedIn, fetch throw → `{ok:false}`),
   `hub-sync` (fake timers: three schedules → one PUT, equal hash skipped, backoff 30 s then 60 s, 401 stops, heartbeat).
   Run end to end against the slice-3 hub with `ACP_HUB=http://127.0.0.1:4848`.
5. **Universe + visit**: `/api/universe`, `/api/search`, `universe.js` on the hub, panel proxies, world.js universe
   layer and visit mode, visit card.
6. **Friend rockets**: `hub/links.mjs`, `hub/live.mjs` (SSE + events table), `PRICES.hail`, `hailTarget`, `buy`,
   `/api/hub/rocket*`, flight and parked rockets, Friends box, `/friends` page. Tests: hail pricing flat, target
   parsing edge cases, 7-day refusal with advanced `now`, absence from the projection; hub-api rocket → SSE at the
   recipient → accept → friends.
7. **Chat**: `hub/chat.mjs`, `/chat` pages, `hubLive` relay, chat endpoints, drawer, unread badge. Tests: hub-api
   send/receive/read, unfriend blocks chat; `hubLive` unit test with a fake stream.
8. **Hardening + deploy docs**: `hub/limits.mjs` everywhere, `robots.txt`, `unlisted`, event pruning, `hub/README.md`
   (env, Caddy snippet, backup), README "Hub" section and Security bullets, fill in `DEFAULT_HUB` when known.


## Verification

- `npm test` green after every slice (95 tests today; each slice adds the files named above).
- Slice 1 manual: `./install.sh`, `launchctl print gui/$UID/local.agent-panel` shows it running, `world.json`
  appears without opening anything, open Agent Panel.app and confirm the app's `server-4747.log` gets no new start
  line, ⌘Q leaves the daemon answering on 4747, `./install.sh` again restarts it, `./install.sh --uninstall` removes it.
- Slice 2 manual: the sun shows on the map and lights Home from its side close up; reduced motion stops the rays.
- Slices 3–7 manual, with two dev accounts on a local hub (`HUB_DEV_LOGIN=1 node hub/server.mjs` and two panels via
  `ACP_PREFS` on two ports): `node server.mjs login` fills the profile card within a minute; `hub.json` is 0600;
  killing the hub leaves World working and the side panel saying "Hub unreachable"; zoom out shows both suns; click
  visits the other system with no spending controls; send a rocket from A, see it park at B, accept, both friend lists
  update; chat live in both panels and on the hub's `/chat` page; markdown-looking text renders as plain text.
- Privacy check: with the hub running, `sqlite3 data/hub.sqlite 'select snapshot from systems'` contains no `/Users`,
  `tokens`, `credit`, `added`, `description`.
- 13" window and reduced motion checked for every new panel section.
