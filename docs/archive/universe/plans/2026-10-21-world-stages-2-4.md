# World stages 2–4: frontier, rockets, building

Spec: `docs/superpowers/specs/2026-10-21-world-design.md` (approved; Rasmus 2026-10-21: "please build the last parts …
meaning the remaining stages"). Slice 1 is on main. Each stage below ships on its own, with its tests, in one commit or
a few.

## Shape

- **world.mjs** decides everything that costs credit or must look the same after a restart: prices, purchases, the
  frontier's lobes, which planets it finds, the moments and where they sit. `summary()` hands the page finished
  geometry in map units (Home at 0,0; the map is 900 px across zoomed out).
- **public/world.js** only draws it and handles the view: focus, flying, aiming, the rocket set piece, clicks.
- **server.mjs** adds `/api/world/buy` and `/api/world/build` (token + origin, like every `/api` route), and the one
  Claude call behind **Build it**.
- **index.html** adds the side panel's boxes: Build, Send a rocket, Push the frontier, a moment's card.

## Calls (mine; the spec leaves them to the builder)

- **Prices**: frontier 4,000, build 6,000, rocket 8,000 (the mockup's). Each one bought of a kind raises the next of
  that kind by 25%, rounded to 100. A purchase stores what it cost.
- **Frontier**: a push buys 150 map px of lobe from Home in its direction; one within 20° of an existing lobe extends
  that lobe. A push lights up as credit is earned after it: fully after 3,000 credit (about ten normal days, a day or
  two for a heavy worker). Lobe shape is the mockup's. "Earned" here is the highest balance-earned World has seen
  (`st.peak`), so the world never shrinks when a day's multiplier moves.
- **Planets**: the first push always finds one; each later push finds one half the time (seeded). It sits in that
  push's stretch and is found once the light reaches it.
- **Moments**: each finished week with work (Monday to Sunday), each finished day that removed 500+ lines and more
  than it added ("Big cleanup"), and each Home level from 3 up ("Home: Oceans"). A moment sits in the light as it was
  that day: along the lobe that was growing then, else in Home's light. Never about repositories.
- **Rockets**: to a found, unclaimed planet; you name the colony (1–24 letters, digits, spaces, ' or -; unique, not
  "Home"). The set piece: zoom out, the rocket flies, the view flies in. Reduced motion skips straight there.
- **Building**: `claude -p --model haiku --output-format json --json-schema <schema> --settings '{"disableAllHooks":
  true}' --no-session-persistence --tools "" --strict-mcp-config --disable-slash-commands --session-id <uuid>`, stdin
  closed, run in `<prefs dir>/world/build`, under the shown profile. Verified on 2.1.306 (2026-10-21): hooks fire 22
  times without the setting and never with it; nothing is saved but an empty auto-memory folder. `claude agents`
  does list the call while it runs, so the panel ignores its own session ids. Credit is taken only after the answer
  validates against the catalogue; a failed call spends nothing and says why. One build at a time.
- **Catalogue**: moon, rings, ring city, city lights, land colour, ocean colour, atmosphere tint, mountains, domes,
  space station, space elevator, aurora, beacon; each piece has a colour, a size (small, medium, large), a place
  (north, south, equator, everywhere, orbit) and a count (1–12); 1–6 pieces and a caption of up to 80 characters per
  build. Every piece draws at both zoom levels.

## Tests

- `test/world-frontier.test.mjs`: prices, buying (balance, direction), lobes (joining, lighting, never shrinking),
  planets (first push finds one, found when lit), moments (weeks, cleanups, levels; stable and lit).
- `test/world-colonies.test.mjs`: rockets (found, unclaimed, names, balance), colonies in the summary.
- `test/world-build.test.mjs`: the schema and validation, the prompt, a build that draws (spent), one that fails
  (nothing spent), the Claude call's arguments.
- A browser check (`.scratch/`, not committed) against a test copy of the server with a seeded World: push, rocket,
  build, moments, both zoom levels, 13" and phone widths, no page errors.
