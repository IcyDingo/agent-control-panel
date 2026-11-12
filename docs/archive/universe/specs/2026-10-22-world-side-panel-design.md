# World's side panel: an icon rail with one card at a time

Design, 2026-10-22, from a brainstorm with the panel's owner. **(owner)** marks what the owner decided, **(call)** a
decision made while writing this that the owner has not ruled on. The mockups are in
`docs/superpowers/specs/2026-10-22-world-side-panel-options.html`, row C (rows A and B were the options not picked).

## Context

World has a column of boxes down the right of the map, in two places that share `public/world.js`:

- **The app**, `#world` in `public/index.html`: nine separate `.w-box` cards (Profile, Moment, Home, Build, Send a
  rocket, Push the frontier, Moments, Today's work, totals). On a laptop screen most of it is below the fold, every
  box repeats its own explanation, and the map is narrowed by a 288px column of cards.
- **Online**, the galaxy page `hub/public/system.html` (`/@handle`): the owner's card with the mosaic of days, Home,
  Moments, and for the owner an "Owner" box with push, rocket and build orders. Home's level shows twice (in the card
  and in the Home box).

The owner wants the panel designed "slightly better", the same way on both. Building is not only on Home: it targets
Home or any colony **(owner)**. Today the app builds on whichever planet the map is looking at (`here` in world.js, set
by the Home / colony / Map buttons at the bottom left) and only the box title says so ("Build on Ember"); the site's
owner orders pick it from a dropdown (`#o-on`).

## What it becomes

**An icon rail with one card at a time (option C)** **(owner)**. On both pages:

- A **rail** of icon buttons docked at the top right, under the top bar: 56px wide, the panel's glass surface
  (`--panel` at ~92%, 1px `--line`, 14px corners), icons 44px square. Hairline dividers group them.
- Clicking an icon opens its **card** to the rail's left: 320px wide, same surface, its own close button. One card at
  a time; clicking the open card's icon again, or its close button, closes it and leaves the map clear. The card
  scrolls inside itself when taller than the window.
- The open icon is amber (`--amber` on `--amber-dim`), like the selected zoom button today.

### In the app

| Rail icon | Card |
|---|---|
| Your avatar | **Profile**: avatar, name, `@handle · x, y`; "Active N days · N colonies · N builds · World since Month Year" (World's own `startedAt`, which the Mac has signed in or out; the hub's join date is not fetched) **(call)**; **the mosaic of the last 100 days** as on the galaxy page **(owner)**; Your page and Edit profile links; "Synced N min ago" and Sign out. Signed out: the sign-in-with-GitHub text and flow from today's Profile box, and the mosaic still shows, since the Mac knows its own worked days **(call)**. |
| Cube | **Build**: a row of planet chips, Home first then each colony by name. **The build target stays `here`**, the place the map is looking at, as today: a chip click is the same as the bottom-left button for that place (it flies there and changes `here`), and flying anywhere moves the lit chip **(owner: build on other planets; call: the chip row and the rule)**. On Map zoom the chip for `here` stays lit (zooming out does not change `here`), and a build from there flies in afterwards as `build()` does today. On a bare planet no chip is lit and the card says to pick a planet you own. Then the description box, the price, and a button that names the planet ("Build on Ember"); "Built on Ember" lists the last few builds there. |
| Rocket | **Send a rocket**: today's box. With no bare planet found yet, the card says to push the frontier first instead of being hidden. A small amber dot on the icon when the frontier has found a bare planet **(call)**. |
| Compass | **Push the frontier**: today's box. |
| Star | **Moments**: the list. Clicking a star on the map opens this card with that moment's details at the top (today's `#w-moment` box) **(call)**. |
| Bar chart | **Today's work**: today's numbers, the totals line and the note on lines removed and stars. |

- **Home's level moves to a small box at the top left** (268px): "Home · Level 5", XP to the next level with the
  green bar, "Green coasts → Forests" and "+337 today" in amber. Always Home's, whatever the map is looking at
  **(call)**.
- Credit stays in the top bar.
- **A card is open when World opens: Build the first time, then whichever card was open last** (kept in
  `localStorage`, per the panel's habit for folded queues) **(owner: a card open; call: Build first, then the last one)**.

### Online (galaxy page)

| Rail icon | Who sees it | Card |
|---|---|---|
| The owner's avatar | everyone | **Profile**: today's `#sys-card` (avatar, name, handle and coordinates, bio and links, "Level 5 · Green coasts", the stats line, the mosaic). No XP bar: the public projection has no XP, and none is added. The separate Home box goes; its level is in this card **(call)**. |
| Star, with the count | everyone | **Moments**. |
| Rocket | the owner only | **Your orders**: credit at the top; Build / Rocket / Push as tabs inside the card; Build has the same planet chips as the app (replacing `#o-on`), and the button names the planet; the "your Mac runs it" notes at the bottom. |

- **The galaxy page gets the colony buttons at the bottom left, for visitors too** (colonies are already public in the
  projection), so anyone can fly to a colony and see what was built there. The owner's Build chips work as in the app:
  a chip flies the map there, and the order's target is the place the map is on **(call)**. This needs world.js to show
  colony buttons in read-only mode and to tell the page when `here` changes (or expose a fly-to), which is in scope.
- The rail looks and behaves the same as the app's: an icon is amber only while its card is open. The owner's orders
  icon sits under a divider, and its tooltip says "Your orders (only you see this)" **(call)**.
- Opens with Profile showing, for visitors and the owner alike **(call)**.
- No top-left level box online: the level is in the Profile card **(call)**.

### Narrow screens

Below today's breakpoints (760px in the app, 900px on the site) the rail becomes a row of the same icons under the
map, and the open card sits under it full width, as the stacked boxes do today **(call)**.

## Goals

- The map gets the width back: nothing but the rail is on the right when no card is open.
- Every thing you can do is one click from the rail, and the rail looks the same in the app and online.
- Building on a colony is as obvious as building on Home, in both places.
- The app's Profile shows your activity the way your public page does.

## Non-goals

- No new data, prices, orders or API calls. The hub sees exactly what it sees today; the projection is unchanged.
- The board, Space view, the landing page, `/me` and `/download` are untouched.
- No light theme for World (it has none today).

## Anti-goals

- **A hidden thing nobody finds.** Every icon has a visible tooltip and an accessible name, and the rocket's dot means
  something is waiting. If a card's state needs attention (a build running, an order your Mac hasn't picked up), the
  icon shows it.
- **Breaking the shared ids.** world.js looks elements up by id on both pages, and `body.w-readonly` hides the owner's
  boxes for visitors. Keep that contract, or change both pages and world.js together.
- **A visitor seeing the owner's numbers.** Credit, today's work, XP numbers and orders stay owner-only, as now.

## Constraints

- Plain HTML, CSS and JS in the existing files, no framework or build step: `public/index.html` (`#world` markup and
  its CSS block), `public/world.js`, `hub/public/system.html`, `hub/public/hub.css` (whose World rules are copied
  from the panel's, so both change together).
- The palette, type (Geist / Geist Mono in the app, the system stack on the site) and controls (`.btn`, `.field`)
  stay as they are. Hairlines over shadows; the flyout card may have the one soft shadow the profile menu has.
- The app's mosaic draws from the worked days world.js already has (the same list the projection sends as `worked`);
  it reuses the look of `Hub.daysMosaic` in `hub/public/hub.js` (copied, not linked, as hub.css copies the panel's).
- Keyboard: the rail is a group of toggle buttons (`aria-pressed`), Tab reaches each, Enter / Space opens; Esc keeps
  its current meaning (leave World in the app).

## Left to the builder

- Icon drawing (inline stroke SVG like the mockups, or the panel's CSS-drawn marks), exact sizes and spacing.
- How the cards are switched (a class on the aside, `hidden` on sections), and how state is remembered.
- How to show "a build is running" or "order waiting for your Mac" on an icon.
- Tests: what the existing `test/world-*.test.mjs` and `test/hub-*.test.mjs` should gain, if anything.

## Seen while doing this, not part of it

- `universe.cashegg.com/@icydingo` in a fresh browser opens behind a cookie-consent dialog that is empty apart from
  Accept / Reject / Confirm. It looks like a consent setting on the Cloudflare zone rather than the hub's own page.
