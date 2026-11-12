# Hub hardening (slice 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The hub can face the internet: every write and sign-in path is rate-limited, limits see the real visitor behind Caddy, crawlers are told what to index, and an unlisted galaxy cannot be found by scanning.

**Architecture:** One new module, `hub/limits.mjs`, holds in-memory token buckets keyed by a name and a subject (an IP or an account id). `hub/server.mjs` declares a limit on each route that changes state or costs something, and answers `429` with `retry-after` when a bucket is empty. `hub/config.mjs` gains `HUB_TRUST_PROXY`, which decides whether the client address comes from the socket or from the last `X-Forwarded-For` entry Caddy appended.

**Tech Stack:** Node stdlib only, ESM `.mjs`, `node:test`.

**Spec:** docs/superpowers/specs/2026-10-22-social-universe-design.md (API table: limits per route; "Rate limits in `hub/limits.mjs` (in-memory token buckets)"; "`robots.txt` allows `/` and `/@*` only; unlisted pages add noindex").

## Global Constraints

- No dependencies; Node 22.13+ for the hub.
- Errors are `{ ok: false, error: 'a sentence' }`; 429 carries a `retry-after` header in whole seconds.
- Nothing a request carries may throw out of the handler.
- Tests share one hub per file; limits must not trip unrelated tests (the test hub passes generous rates).

## Rulings

- Device token polling is paced by the device code's own `slow_down`; its per-IP limit is 30/min, not the spec's 5/min, because a Mac polls every 5 s (12/min) by design. `POST /api/device/code` stays at 5/min/IP.
- Rockets, friends and chat are not built yet (slices 6–7); their limits come with them.
- "Unlisted" means reachable by link, not by search or scan: `GET /api/systems/at?x&y` answers 404 for an unlisted account, and the page and API answers for an unlisted galaxy carry `x-robots-tag: noindex`. The handle lookup still works (that is the link).
- Event pruning: the live module keeps nothing on disk, so there is nothing to prune.

## Review Focus

- An `X-Forwarded-For` header sent by a visitor straight to the hub (no proxy) must not let them pick their own bucket: without `HUB_TRUST_PROXY=1` the header is ignored.
- A bucket for an IP that never comes back must not stay in memory forever: the table is pruned.
- A limited request must not have consumed anything (an order is not placed, a device code not minted) and must not have read the body.
- The 429 body is JSON like every other error, so `hub.mjs` on the Mac reports it as a sentence.
- `retry-after` is at least 1.

---

### Task 1: `hub/limits.mjs`

**Files:** Create `hub/limits.mjs`, `test/hub-limits.test.mjs`.

**Interfaces:**
- Produces `createLimits({ now = Date.now, rates = RATES })` → `{ take(name, subject) → { ok: true } | { ok: false, retryAfter: seconds }, size() }`; `RATES` exported: `{ signin: [10, 60_000], device_code: [5, 60_000], device_poll: [30, 60_000], approve: [10, 60_000], profile: [10, 60_000], system: [12, 60_000], status: [30, 60_000], order: [10, 60_000], order_step: [30, 60_000] }` as `[n, perMs]`.
- Token bucket: capacity `n`, refills `n` per `perMs` continuously. An unknown name is a bug: `take` throws.
- Prune: when the table passes 5,000 entries, every full bucket is dropped.

- [ ] Tests: n calls pass, the n+1th fails with `retryAfter >= 1`; after `perMs` the bucket is full again; subjects are independent; names are independent; unknown name throws; pruning drops full buckets and keeps empty ones.
- [ ] Implement; `node --test test/hub-limits.test.mjs` passes.

### Task 2: `HUB_TRUST_PROXY` and the client address

**Files:** Modify `hub/config.mjs`, `hub/server.mjs`; tests in `test/hub-db.test.mjs` (config) and `test/hub-api.test.mjs`.

- `loadConfig`: `trustProxy: env.HUB_TRUST_PROXY === '1'`.
- `clientIp(req)`: with `trustProxy`, the last non-empty entry of `x-forwarded-for` (Caddy appends the peer it saw); else `req.socket.remoteAddress`. Falls back to the socket when the header is missing or empty.

### Task 3: Limits on the routes

**Files:** Modify `hub/server.mjs`; tests in `test/hub-api.test.mjs`.

- `createHub(config, { fetch, now, rates })`; `rates` passes to `createLimits`.
- Route option `limit: [name, 'ip' | 'account']`. Checked in `handle()` after the auth check and before the body is read. Refused: `429 { ok: false, error: 'Too many requests; try again in N seconds.' }` with `retry-after: N`.
- Routes: `/login/github`, `/auth/github/callback`, `/auth/dev` → signin/ip. `/api/device/code` → device_code/ip. `/api/device/token` → device_poll/ip. `/api/device/approve|deny` → approve/account. `PATCH /api/me/profile` → profile/account. `PUT /api/me/system` → system/account. `PUT /api/me/status` → status/account. `POST /api/me/orders` → order/account. claim/done → order_step/account.
- Tests (a third hub with default rates and the fake clock): the 6th device code in a minute is 429 with `retry-after`, a minute later it is 200; the 11th dev sign-in from one address is 429 but another address (via `x-forwarded-for` with trust on) is not; without trust the header is ignored (both count as 127.0.0.1); an order refused by the limit does not exist afterwards.

### Task 4: Unlisted is unfindable

**Files:** Modify `hub/server.mjs`; tests in `test/hub-api.test.mjs`.

- `/api/systems/at`: 404 when the account is unlisted.
- The system page route and `/api/systems/@handle`: `x-robots-tag: noindex` when the account is unlisted (the page route looks the handle up; unknown handles are still the 200 shell, which scripts itself to noindex).
- Test: bob sets `visibility: 'unlisted'`; by handle 200 with the header; by coordinates 404; the page has the header; alice (public) has neither.

### Task 5: Docs

**Files:** Modify `hub/README.md`, `README.md` (Hub and Security sections).

- Settings table gains `HUB_TRUST_PROXY`. "Before it faces the internet" becomes "Limits" (the table of rates, the 429 shape). Behind Caddy: set `HUB_TRUST_PROXY=1`. Docker: a compose example with the volume and the four variables. Backup unchanged.
- Main README's Hub section: one line on limits and the unlisted meaning, if it describes visibility.
