# Exploring from colonies, and probes into the Universe

Design, 2026-10-22, from a brainstorm with the panel's owner. **(owner)** marks what the owner decided, **(call)** a
decision made while writing this that the owner has not ruled on.

## Context

World's map today is a star of spokes. Every push of the frontier leaves from Home toward an angle (`frontierOf` in
`world.mjs`): a push within 20° of an earlier lobe makes that lobe longer, any other starts a new one 60 px out from
Home. A colony is a dead end: you can build on it, nothing leaves from it. The map's widest zoom, **Map**, shows the
whole galaxy and stops there.

Every signed-in account has a permanent spot on the hub, on a sunflower spiral (`hub/coords.mjs`, `placeOf`), shown as
`x, y` on the Profile card and the galaxy page. Nothing draws that spiral: the app and the page both stop at Map, and
the hub has no way to list galaxies in an area. The earlier social-universe design (`2026-10-22-social-universe-design.md`,
"Universe zoom and visit mode") described a zoom that showed every nearby sun at once. This design replaces that part.

The owner wants three things: exploring from colonies, a dark patch walled in by light to light up, and a Universe you
can zoom out into where you start alone and find others by sending probes **(owner)**. It stays 2D **(owner)**.

## Goals, non-goals, anti-goals

Goals:
- Colonies matter: landing one opens a new place to explore from, so rockets and pushes feed each other.
- The map grows like a tree, and a pocket of dark it rings is filled in.
- The Universe opens by working, the way your galaxy did: you begin alone, and each probe finds one more galaxy.

Non-goals this round:
- Telling a galaxy it was found (no notification system exists yet; "@you's probe reached you" is a later step).
- An in-app visit mode. A found galaxy opens its page on the hub in the browser **(call)**.
- Probes from the site's owner orders. Probes are bought in the app only **(call: keeps the first round small; an
  order tab can follow)**.
- 3D, and a fly-through view **(owner)**.

Anti-goals:
- A probe that finds nothing. Paying 4,000 for empty space feels bad; a probe always finds someone, or cannot be bought.
- Revealing an unlisted galaxy. Unlisted means reachable by its link and nothing else; probes never find one, and one
  that becomes unlisted after it was found disappears from every Universe that had it.
- A changed past. Every push already bought keeps its shape and its planets exactly where they are.

## 1. Exploring from colonies

**Where a push leaves from** **(owner)**. A push is bought `{ kind: 'frontier', ang, from }`, where `from` is `'home'`
or the id of a planet with a colony on it. A bare planet, a planet not yet found, or an unknown id is refused ("Push
from Home or one of your colonies."). Pushes bought before this change have no `from` and count as from Home.

**The shape.** A lobe keeps a start point: Home's lobes start 60 px out from Home along their angle (as now); a
colony's lobes start 30 px out from the colony, inside the colony's own light **(call)**. A push joins a lobe only when
it leaves from the same place and points within 20° of that lobe; otherwise it starts a new lobe at its own place.
`PUSH_LEN` (150), the lobe's width rule, `LIGHT_CREDIT` (3,000) and the chance of finding a planet (first push always,
then one in two) are unchanged, and a planet's id stays `p<index of its push>`. A planet found in a colony's lobe is a
planet like any other: a rocket can land there, and you can push from that colony in turn.

**Price.** 4,000, as every push **(owner, already)**.

**In the app.** The Push card gets a "Push from" row of place chips, Home then each colony by name, the same chips as the
Build card. The lit chip follows `here` like Build's: flying to a colony makes it the place a push leaves from, and on a
bare planet (or one not yours) the card says "Pick Home or one of your colonies to push from." Aiming (the list of
directions, and **Aim on the map**) and the aiming arrow work from the chosen place, not from Home **(call)**.

**Online.** The owner's Push tab in **Your orders** gets the same chip row; an order carries `from`, and the hub's order
check (`hub/orders.mjs`) accepts `'home'` or `p<digits>` and the Mac's `buy` decides the rest, as it does for a rocket.

**The Map zoom fits everything opened.** `extent()` and `zFit()` in world.js measure from each lobe's start, so a
branch past today's 1.8 zoom cap still fits; the cap rises as far as it needs to **(builder: the exact rule)**.

## 2. A dark patch walled in by light lights up

**The rule** **(owner)**: any patch of dark the light completely surrounds, so that it cannot be reached from the dark
outside without crossing light, is drawn lit, as if the work had filled it. What counts as "dark" is what a person
sees as dark on the map: the same threshold the map's darkness is drawn at, so a pocket that looks closed is closed and
one with a visible gap still leaks **(builder: the threshold and the way it is computed, e.g. a flood fill from the
edge over `paint()`'s sample grid)**. Its edge is soft like every other light, and it is drawn the same in the app and
on the galaxy page (both use world.js). It is drawing only: it finds no planet, earns nothing and is not stored;
it is worked out from the current light each time the light is drawn **(call)**. Light never goes back, so a pocket
once closed stays closed; the fill is computed at a fixed resolution in map px (not on a grid stretched to the map's
size), so a pocket does not open again because the map grew **(call)**.

## 3. The Universe

**Where it is.** One zoom out past Map, on both pages: a **Universe** button joins **Home** and **Map** at the bottom left,
and scrolling out past Map's zoom goes there **(owner)**. Your galaxy shrinks to its sun at the centre, labelled
`You · x, y`. Around it a dark field and a far starfield that drifts slower than the near one as you pan, for depth in
2D **(call)**. Signed out, the app has no Universe zoom **(owner)**; the button is replaced by a hint "Sign in to
explore the Universe" that opens the Profile card **(call)**.

**Scale.** The Universe is drawn in hub units (the spiral's coordinates), centred on your own spot, zoomed to fit you
and every galaxy you have found, with a minimum width so a lone sun is not huge **(builder: the minimum)**. The galaxy
map and the Universe do not share a scale: crossing from Map to Universe fades the one into the other **(call)**.

**At first you are alone** **(owner)**. With nothing found yet, the Universe shows only your sun, and the Probe card
says "Send a probe to find the galaxies around you."

### Probes

**Buying one** **(owner)**. A new **Probe** card on the app's rail (a probe icon, shown only when signed in), with a
direction (a list of eight like the Push card's, or **Aim on the map** on the Universe view) and **Send a probe —
4,000** **(owner: price)**. `PRICES.probe = 4000`, flat like the rest.

**What it finds** **(owner: always finds someone, the cone, never an unlisted galaxy; call: the numbered details)**. When you buy it, the Mac asks the hub for its target, and
the purchase is final only once the hub answered:
1. The nearest galaxy, measured from your spot, within 30° either side of the direction you picked (a 60° cone).
2. If none is in the cone, the nearest galaxy anywhere.
3. A candidate is a listed (public) account that has a system on the hub, is not you, and is not one you have found or
   have a probe on the way to.
4. If there is no candidate at all, nothing is spent and the card says "There's no one new to find yet." The card asks
   the hub before you press, so the button is disabled with that text rather than failing **(call)**.
5. The hub is unreachable: nothing is spent; "The hub can't be reached, so a probe can't be aimed. Try again later."

**Its flight.** The probe arrives once you have earned 3,000 more credit (`LIGHT_CREDIT`), about ten normal days, the
same rule as a push's light **(owner)**. Until then the Universe shows it as a small moving light leaving your sun along the
direction you **aimed** (not the bearing to its target, which would give the target away), out to a fixed distance in
hub units at the fraction of the way it has come, the same in the app and on the page **(call)**. On arrival it is shown
at its target; one found by the fallback (rule 2) arrives away from where it was aimed, which is the surprise. A dot on
the Probe icon while one is on the way, like the rocket's dot **(call)**. More than one can fly at once **(call)**.

**When it arrives** the galaxy is found, for good: its sun appears in your Universe at its spot, with its @handle on
hover (always shown when fewer than ten are found), and a toast "Your probe found @kim's galaxy." Clicking it opens
`https://universe.cashegg.com/@kim` (the hub the panel uses) in the browser **(call)**. If @kim has since set their
galaxy to unlisted, or deleted the account, the sun is not drawn anywhere, in your app or on your page, and is not
counted; the probe stays spent **(call)**.

**What is kept.** The purchase is kept like any other, with the target's permanent coordinates and the sender's own:
`{ kind: 'probe', at, price, earnedAt, ang, by: { x, y }, to: { x, y } }`. Coordinates, not a handle or an account id,
because they never change and a handle can **(call)**. A probe belongs to the account whose spot is `by`: signed in as
another account (the Mac signed out and into a different one), those probes and their finds are not drawn, not counted
and not sent to the hub, and they come back if the first account signs in again **(call)**. Two Macs on one account
already share one galaxy page by last upload; probes add nothing new to that. The name shown for a found galaxy is fetched from the hub by those coordinates
(`GET /api/systems/at`, which already answers only for listed galaxies); a galaxy whose lookup fails is not drawn.

### The galaxy page online

The page gets the same Universe zoom, showing the galaxies its owner has found; a click there goes to that galaxy's
page on the same site. This is what lets pages link to each other **(owner)**. A visitor sees each found galaxy's sun
and handle, and probes in flight as moving lights without their target; nothing private (no balance, no credit) is
shown **(call)**.

## The hub side

- **Finding a target**: a new authenticated call from the Mac (token, like `PUT /api/me/system`), given the direction
  and the coordinates already found or targeted, answering the target's coordinates and handle, or "no one new". It
  applies the candidate rule above using the accounts table (`x`, `y`, visibility) and the systems table (has a
  system). Rate-limited per account like the other `me` calls **(builder: the route name, the limit)**. A probe only
  costs credit on the Mac, so the hub keeps no record of probes; it answers and forgets **(call)**.
- **The projection** gains each lobe's start (`from` place and start point) and a `probes` list: per probe its angle,
  how far it has come (0 to 1), and `to` only once it has arrived. `PROJECTION_VERSION` goes to 2. The hub keeps
  accepting version 1 from a Mac not yet updated, reading every lobe as from Home and no probes, so a hub deployed
  first does not break anyone's page **(call)**. `validProjection` bounds the new fields like the old ones.
- **The owner status** (`cleanStatus` in `hub/systems.mjs`) accepts `prices.probe` when present and does not require
  it, for the same reason.
- **Orders**: a `frontier` order may carry `from` (section 1). A Mac not yet updated would ignore `from` and push from
  Home, spending 4,000 on the wrong push. So the page shows the "Push from" chips only when the owner's stored
  projection is version 2, and the hub refuses a `from` other than `'home'` while it is version 1 ("Update the panel
  on your Mac to push from a colony.") **(call)**.

## Where it lives

- `world.mjs`: `frontierOf` with starts per place and joining per place; `buy` for `from` and for `probe` (with an
  injected hub lookup so tests run without a network, as `build` takes `ask`); `PRICES.probe`; the summary and the
  projection; `validProjection` for versions 1 and 2.
- `public/world.js`: lobes drawn from their start, the walled-in fill in `paint()`, `extent`/`zFit`, the Universe zoom
  and its drawing, the Push card's chips, the Probe card.
- `public/index.html`: the Probe rail button and card, the Push card's chip row, the Universe button, styles.
- `hub/`: the target lookup route, version 1 and 2 projections, `prices.probe`, the `from` on orders;
  `hub/public/system.html`: the Push tab's chips, the Universe zoom on the page.
- `server.mjs` (the panel's server): the probe purchase route calling the hub, beside the build and rocket routes.
- `README.md`: Push the frontier (from colonies, walled-in dark), the Universe and probes; the hub section's "a map of
  everyone's suns is the next slice" line is replaced.
- Tests beside the existing `test/world-*.test.mjs` and the hub's tests.

## Left to the builder

The darkness threshold and fill method; the Universe's minimum width and the fade between zooms; the target route's
name and limit; how the starfield is drawn; icon artwork; exact copy not quoted above.
