// World: a universe your agents' work pays for. The page opens it (window.AgentWorld.enter) with the server's summary
// and passes each later one to update(). Close up you see a planet: Home, which the work terraforms, or one the frontier
// found. Zoomed out, the map: the light the work spreads around Home, the lobes the frontier pushes out, the planets it
// finds, and the moments that mark stretches of work. world.mjs decides all of that; this draws it and runs the view.
(() => {
  const $ = (id) => document.getElementById(id);
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  function rng(seed) {
    return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  let cv = null, x = null, W = 0, H = 0, dpr = 1, raf = 0, t0 = 0, opts = {};
  let world = null, made = null, sky = null, skySig = ''; // the summary, what its seed makes, and its light (drawn once per change)
  let z = 0, zTo = 0, pan = { x: 0, y: 0 }, drag = null, focus = { x: 0, y: 0 }, focusTo = { x: 0, y: 0 }, here = 'home';
  let aiming = false, aimAng = null, picked = null, hover = null;
  let flight = null, sending = false, rocketSig = '', rocketHere = null, coloniesSig = '', momentsSig = ''; // a rocket on its way: its colony shows once it lands
  let card = null, daysSig = ''; // the rail's open card and the Profile's days as last drawn
  const MAP = 900, ZMAX = 40, scaleOf = (v) => Math.pow(ZMAX, 1 - v); // the map spans MAP px zoomed out, ×40 close up
  const LOBE_START = 60, lobeRadius = (along, tip) => 34 + 26 * along / (tip + 40); // world.mjs's lobe shape
  const BODY = { home: 6, planet: 4.5 }; // radius on the map, map px
  const LOOK = { rust: ['#d9a27f', '#8a4f33', '#2a1712'], ice: ['#dbe8f2', '#7f9fb8', '#1d2a36'], sand: ['#e6d3a3', '#a68a55', '#2e2516'],
    violet: ['#c9b3e0', '#6e5590', '#1f1730'] };
  const MOMENT = { week: '#cfe0ff', cleanup: '#7ee0a8', level: '#ffcf7a' };
  const SUN = { gold: '#ffd27a', white: '#eef2ff', orange: '#ffa65c', blue: '#bcd3ff' };
  /** world.mjs LEVELS' XP: a public projection of a system has a level but no XP, so Home is drawn at its level's start. */
  const LEVEL_XP = [0, 15, 100, 300, 500, 800, 1200, 1600, 2000, 2600, 3300, 4000];
  /** What the page reads from a summary or a projection. The names (Home's stage, a colony's stage name) are always the
   *  ones served; the drawing goes by the numbers. Pure, so test/world-projection.test.mjs runs them in node. */
  const read = {
    /** Where a level begins (XP): the 12 levels above, then world.mjs levelOf's rule, a new level every 1,000 XP. */
    levelXp: (level) => (level <= LEVEL_XP.length ? LEVEL_XP[Math.max(1, level) - 1] : LEVEL_XP.at(-1) + 1000 * (level - LEVEL_XP.length)),
    /** A colony's stage, 1 up; one stored before projection 3 has none and is a landing site. */
    stage: (colony) => (Number.isInteger(colony?.stage) && colony.stage >= 1 ? colony.stage : 1),
    stageName: (colony) => (typeof colony?.stageName === 'string' ? colony.stageName : 'Landing site'),
    /** Minutes active as "3 h 20 min", "45 min" or "2 h". */
    active: (min) => {
      const m = Math.max(0, Math.round(min ?? 0)), h = Math.floor(m / 60);
      return h ? `${h} h${m % 60 ? ` ${m % 60} min` : ''}` : `${m} min`;
    },
    /** Today's numbers as the today card lists them: no multiplier, and tokens shown but not paid for. */
    todayRows: (t) => [['Active time', read.active(t.active)], ['Lines changed', `+${fmt(t.added)} / −${fmt(t.removed)}`],
      ['Commits', fmt(t.commits)], ['Credit today', fmt(t.credit)], ['Tokens', `${fmt(t.tokens)}, not counted toward credit`]],
    /** The day's work in a line: the panel's World button and the galaxy page's orders say it the same way. */
    todayLine: (t) => `+${fmt(t.added)} / −${fmt(t.removed)} lines, ${fmt(t.commits)} commit${t.commits === 1 ? '' : 's'}, `
      + (t.active != null ? `${read.active(t.active)} active, ` : '') + `${fmt(t.credit)} credit earned.`,
  };
  const sun = () => world?.sun ?? null;
  let light = { lx: Math.cos(Math.PI * 1.25), ly: Math.sin(Math.PI * 1.25) }; // which way the sun is from Home: the lit side faces it

  function make(seed) {
    const r = rng(seed), stars = [], land = [], cities = [], craters = [], clouds = [];
    for (let i = 0; i < 900; i++) stars.push({ x: (r() - 0.5) * MAP * 1.6, y: (r() - 0.5) * MAP, b: r() });
    for (let i = 0; i < 26; i++) land.push({ u: r(), v: 0.15 + r() * 0.7, s: 0.04 + r() * 0.09, at: r() });
    for (let i = 0; i < 90; i++) cities.push({ on: land[Math.floor(r() * land.length)], a: r() * 7, d: Math.sqrt(r()) * 0.8, at: r() }); // each on a continent
    for (let i = 0; i < 26; i++) craters.push({ u: r(), v: r(), s: 3 + r() * 9 });
    for (let i = 0; i < 14; i++) clouds.push({ u: r(), v: 0.1 + r() * 0.8, w: 0.12 + r() * 0.2, at: r() });
    // Stars past the first map, for the frontier to light: their own sequence, so Home looks as it always has.
    const o = rng(seed + 2);
    for (let i = 0; i < 9000; i++) {
      const sx = (o() - 0.5) * 3600, sy = (o() - 0.5) * 3600, b = o();
      if (Math.abs(sx) > MAP * 0.8 || Math.abs(sy) > MAP / 2) stars.push({ x: sx, y: sy, b });
    }
    return { seed, stars, land, cities, craters, clouds };
  }

  // ---------- the view's size; the side panel takes the right edge when there is room
  const side = () => { const s = $('w-side'); return s && getComputedStyle(s).position === 'absolute' && s.offsetLeft > W / 2 ? W - s.offsetLeft : 0; };
  function fit() {
    dpr = window.devicePixelRatio || 1;
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }

  // ---------- the light: Home's, and the frontier's lobes
  const days = () => (world?.home?.xp ?? read.levelXp(world?.home?.level ?? 1) ?? 0) / 100; // in full days' work: Home's stages below are drawn on that scale
  /** 0 before day `a`, 1 from day `b`, linear between: each stage eases in over the days before it is named. */
  const ramp = (a, b) => clamp((days() - a) / (b - a));
  const g = () => Math.sqrt(Math.min(1, days() / 40)); // how far the lit map reaches: quick at first, all of it at the ladder's top
  const reach = () => world?.reach ?? 46;
  const lobes = () => world?.frontier ?? [];
  const planets = () => world?.planets ?? [];
  /** Where a lobe leaves from (map px): Home, or the colony it was pushed from. */
  const originOf = (l) => (l.from && l.from !== 'home' ? planets().find((p) => p.id === l.from) : null) ?? { x: 0, y: 0 };
  /** How the light grows with the world, worked out once per paint rather than for every point it lights: `w` widens
   *  each shape of light as Home levels up (terraforming it), colonies are founded and things are built, so a grown
   *  world's light reads as one cloud rather than patches; and each colony lights the space around it, a little more
   *  for each thing built there. */
  function shineOf() {
    const builds = world?.builds ?? [], colonies = planets().filter((p) => p.colony);
    const bloom = clamp(((world?.home?.level ?? 1) - 1) / 11 * 0.6 + colonies.length * 0.1 + builds.length * 0.015);
    return { w: 1 + 0.45 * bloom,
      colonies: colonies.map((p) => ({ x: p.x, y: p.y, r: 40 + 6 * Math.min(5, builds.filter((b) => b.on === p.id).length) })) };
  }
  let shine = { w: 1, colonies: [] };
  /** One shape's light: full through its middle, fading to nothing at its radius widened by the bloom. */
  const fall = (d, r) => clamp((1 - d / (r * shine.w)) * 1.6);
  function lit(mx, my) {
    let dark = 1 - fall(Math.hypot(mx, my), reach()); // where two lights' edges overlap they add up: no seam between them
    for (const l of lobes()) {
      const o = originOf(l), dx = mx - o.x, dy = my - o.y, ux = Math.cos(l.ang), uy = Math.sin(l.ang), along = clamp(dx * ux + dy * uy, 0, l.tip);
      dark *= 1 - fall(Math.hypot(dx - ux * along, dy - uy * along), lobeRadius(along, l.tip));
    }
    if (sun()) dark *= 1 - fall(Math.hypot(mx - sun().x, my - sun().y), 70); // the sun's own glow
    for (const c of shine.colonies) dark *= 1 - fall(Math.hypot(mx - c.x, my - c.y), c.r);
    return 1 - dark;
  }
  /** How far the world reaches from Home (map px): the light, the sun, what the frontier bought, the planets it found
   *  and the colonies' light, as far as the bloom has widened it. */
  const extent = () => Math.max(reach() * (shine.w + 0.15), ...(sun() ? [Math.hypot(sun().x, sun().y) + 70 * shine.w] : []),
    ...lobes().map((l) => Math.hypot(originOf(l).x, originOf(l).y) + (l.tip - l.lit) + Math.max(l.bought + 60, l.lit + lobeRadius(l.tip, l.tip) * shine.w)),
    ...planets().map((p) => Math.hypot(p.x, p.y) + 30), ...shine.colonies.map((c) => Math.hypot(c.x, c.y) + c.r * shine.w));
  /** world.mjs's walledIn, copied: the light on an n×n grid with every pocket of dark it walls in lit full. */
  function walledIn(grid, n, dark = 0.3) {
    const out = Float32Array.from(grid), open = new Uint8Array(n * n), stack = [];
    const reach = (i, j) => { const k = j * n + i; if (!open[k] && grid[k] < dark) { open[k] = 1; stack.push(k); } };
    for (let k = 0; k < n; k++) { reach(k, 0); reach(k, n - 1); reach(0, k); reach(n - 1, k); }
    while (stack.length) {
      const k = stack.pop(), i = k % n, j = (k - i) / n;
      if (i > 0) reach(i - 1, j);
      if (i < n - 1) reach(i + 1, j);
      if (j > 0) reach(i, j - 1);
      if (j < n - 1) reach(i, j + 1);
    }
    for (let k = 0; k < n * n; k++) if (grid[k] < dark && !open[k]) out[k] = 1;
    return out;
  }
  const CELL = 6; // map px per sample of the light: fixed, so a pocket closed at one size of map stays closed as it grows
  /** The light and the stars in it, drawn again only when the world changes, sampled small and drawn up smoothly so
   *  its edge is soft. A pocket of dark the light walls in is drawn lit. */
  function paint() {
    const grown = shineOf(), sig = JSON.stringify([world?.reach, world?.sun, lobes(), planets().map((p) => p.id), grown]);
    if (sky && sig === skySig) return;
    skySig = sig; shine = grown;
    const n = clamp(Math.ceil(2 * extent() / CELL), 128, 512), E = Math.max(extent(), n * CELL / 2), c = document.createElement('canvas');
    c.width = c.height = n;
    const gx = c.getContext('2d'), raw = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) raw[j * n + i] = lit(((i + 0.5) / n - 0.5) * 2 * E, ((j + 0.5) / n - 0.5) * 2 * E);
    const grid = walledIn(raw, n);
    for (let k = 0; k < n * n; k++) if (grid[k] > 0) { gx.fillStyle = `rgba(36,62,110,${0.45 * grid[k]})`; gx.fillRect(k % n, Math.floor(k / n), 1, 1); }
    /** The light at a point, pockets filled: the grid's cell, or the light itself off the grid. */
    const at = (mx, my) => {
      const i = Math.floor((mx / (2 * E) + 0.5) * n), j = Math.floor((my / (2 * E) + 0.5) * n);
      return i >= 0 && j >= 0 && i < n && j < n ? Math.max(lit(mx, my), grid[j * n + i]) : lit(mx, my);
    };
    sky = { E, glow: c, stars: made.stars.map((s) => ({ ...s, l: at(s.x, s.y) })).filter((s) => s.l > 0.02) };
  }

  function mix(a, b, k) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    return `rgb(${[16, 8, 0].map((s) => Math.round((pa >> s & 255) * (1 - k) + (pb >> s & 255) * k)).join(',')})`;
  }
  /** A #rrggbb colour at an opacity, darkened toward black by `dark` (0–1). */
  function rgba(hex, a, dark = 0) {
    const v = parseInt(hex.slice(1), 16);
    return `rgba(${[16, 8, 0].map((s) => Math.round((v >> s & 255) * (1 - dark))).join(',')},${a})`;
  }
  function label(text, lx, ly, color = '#8c96a4', size = 12) {
    x.font = `500 ${size}px Geist, system-ui, sans-serif`; x.textAlign = 'center';
    x.fillStyle = 'rgba(3,5,10,.8)'; x.fillText(text, lx + 1, ly + 1);
    x.fillStyle = color; x.fillText(text, lx, ly);
  }
  /** Home, level by level (world.mjs LEVELS): clouds over the rock, oceans, continents, green coasts, forests,
   *  settlements with lights at night, cities under an atmosphere, and a moon when it is terraformed; then an orbital
   *  ring, a star port on it, and a second moon. */
  function drawHome(cx, cy, R, t, detail, look = {}) {
    const spin = calm.matches ? 0 : t / 60000, drift = calm.matches ? 0 : t / 40000;
    // A land or ocean colour that was built shows at once, whatever the level.
    const clouds = ramp(0.03, 0.6), ocean = look.ocean ? 1 : ramp(0.4, 1), land = look.land ? Math.max(0.6, ramp(1.5, 4.2)) : ramp(1.5, 4.2);
    const green = look.land ? 1 : ramp(4, 6.2), forest = ramp(6.5, 9.5);
    const towns = ramp(10.5, 19), air = ramp(13, 17), moon = ramp(19, 20), ring = ramp(21, 26), port = ramp(28, 33), moon2 = ramp(36, 40);
    // The ring is tilted; its far half passes behind Home, its near half in front.
    const ringArc = (from, to) => {
      x.strokeStyle = `rgba(200,212,232,${0.5 * ring})`; x.lineWidth = Math.max(1.5, R * 0.05);
      x.beginPath(); x.ellipse(cx, cy, R * 1.65, R * 0.36, -0.25, from, to); x.stroke();
      x.strokeStyle = `rgba(160,176,204,${0.35 * ring})`; x.lineWidth = Math.max(1, R * 0.02);
      x.beginPath(); x.ellipse(cx, cy, R * 1.5, R * 0.32, -0.25, from, to); x.stroke();
    };
    if (ring > 0) ringArc(Math.PI, 2 * Math.PI);
    if (air > 0) {
      const a = x.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.25);
      a.addColorStop(0, `rgba(110,160,240,${0.4 * air})`); a.addColorStop(1, 'rgba(110,160,240,0)');
      x.fillStyle = a; x.beginPath(); x.arc(cx, cy, R * 1.25, 0, 7); x.fill();
    }
    x.save(); x.beginPath(); x.arc(cx, cy, R, 0, 7); x.clip();
    x.fillStyle = mix('#6b6660', look.ocean ?? '#24507f', ocean); x.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    for (const c of made.craters) {
      x.fillStyle = `rgba(40,38,36,${0.5 * (1 - ocean)})`;
      x.beginPath(); x.arc(cx - R + ((c.u + spin) % 1) * 2 * R, cy - R + c.v * 2 * R, c.s * R / 240, 0, 7); x.fill();
    }
    const at = (l) => [cx - R + ((l.u + spin) % 1) * 2.2 * R - 0.1 * R, cy - R + l.v * 2 * R]; // a continent's centre now
    for (const l of made.land) {
      if (l.at > land * 1.05) continue; // continents rise one by one
      const [lx, ly] = at(l);
      x.fillStyle = mix('#7b7569', look.land ?? '#4f7a52', green);
      x.beginPath(); x.ellipse(lx, ly, l.s * 2 * R, l.s * 1.2 * R, 0.3, 0, 7); x.fill();
      if (forest > l.at * 0.9) { // forests spread inland
        x.fillStyle = look.land ? rgba(look.land, 0.85 * forest, 0.45) : `rgba(36,74,46,${0.85 * forest})`;
        x.beginPath(); x.ellipse(lx + l.s * 0.2 * R, ly, l.s * 1.1 * R, l.s * 0.62 * R, 0.3, 0, 7); x.fill();
      }
    }
    for (const c of made.clouds) {
      if (c.at > clouds * 1.05) continue;
      x.fillStyle = `rgba(235,240,250,${0.22 * clouds})`;
      x.beginPath(); x.ellipse(cx - R + ((c.u + drift) % 1) * 2.4 * R - 0.2 * R, cy - R + c.v * 2 * R, c.w * R, c.w * 0.32 * R, -0.15, 0, 7); x.fill();
    }
    const sh = x.createRadialGradient(cx + light.lx * R * 0.45, cy + light.ly * R * 0.4, R * 0.2, cx, cy, R * 1.05);
    sh.addColorStop(0, 'rgba(255,255,255,.12)'); sh.addColorStop(0.55, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(2,4,10,.82)');
    x.fillStyle = sh; x.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    if (R > 30 && detail > 0) for (const c of made.cities) {
      if (c.at > towns || c.on.at > land * 1.05) continue;
      const [ox, oy] = at(c.on), ex = Math.cos(c.a) * c.d * c.on.s * 2 * R, ey = Math.sin(c.a) * c.d * c.on.s * 1.2 * R;
      const lx = ox + ex * Math.cos(0.3) - ey * Math.sin(0.3), ly = oy + ex * Math.sin(0.3) + ey * Math.cos(0.3);
      if (Math.hypot(lx - cx, ly - cy) > R * 0.96) continue;
      const night = (lx - cx) * light.lx + (ly - cy) * light.ly < -R * 0.05, d = Math.max(2, R / 110); // pale by day, lit at night
      x.fillStyle = night ? 'rgba(255,205,120,.9)' : 'rgba(228,224,212,.55)'; x.fillRect(lx, ly, d, d);
    }
    x.restore();
    if (moon > 0) { // terraformed: a moon arrives and circles Home
      const [mx, my] = moonAt(cx, cy, R, t);
      const m = x.createRadialGradient(mx - R * 0.05, my - R * 0.05, R * 0.02, mx, my, R * 0.16);
      m.addColorStop(0, `rgba(222,226,232,${moon})`); m.addColorStop(1, `rgba(96,102,112,${moon})`);
      x.fillStyle = m; x.beginPath(); x.arc(mx, my, R * 0.15, 0, 7); x.fill();
    }
    if (ring > 0) ringArc(0, Math.PI);
    if (port > 0) { // a star port on the ring's near side, its beacon blinking
      const th = 0.35 * Math.PI, ex = Math.cos(th) * R * 1.65, ey = Math.sin(th) * R * 0.36;
      const px = cx + ex * Math.cos(-0.25) - ey * Math.sin(-0.25), py = cy + ex * Math.sin(-0.25) + ey * Math.cos(-0.25), u = Math.max(3, R * 0.05);
      x.fillStyle = `rgba(214,220,230,${port})`; x.fillRect(px - u * 1.6, py - u * 0.5, u * 3.2, u); x.fillRect(px - u * 0.4, py - u * 1.4, u * 0.8, u * 2.8);
      x.fillStyle = `rgba(255,190,90,${port * (calm.matches ? 1 : 0.55 + 0.45 * Math.sin(t / 380))})`;
      x.beginPath(); x.arc(px, py - u * 1.5, Math.max(1.5, u * 0.35), 0, 7); x.fill();
    }
    if (moon2 > 0) { // a second, smaller moon on a wider orbit
      const a = (calm.matches ? 0 : t / 45000) + 2.4, mx = cx + Math.cos(a) * R * 2.15, my = cy + Math.sin(a) * R * 0.75;
      const m = x.createRadialGradient(mx - R * 0.03, my - R * 0.03, R * 0.01, mx, my, R * 0.1);
      m.addColorStop(0, `rgba(226,204,186,${moon2})`); m.addColorStop(1, `rgba(110,86,74,${moon2})`);
      x.fillStyle = m; x.beginPath(); x.arc(mx, my, R * 0.09, 0, 7); x.fill();
    }
  }
  /** Where Home's first moon is now: the moon base past Twin moons sits on it. */
  const moonAt = (cx, cy, R, t) => { const a = (calm.matches ? 0 : t / 30000) - 0.6; return [cx + Math.cos(a) * R * 1.75, cy + Math.sin(a) * R * 0.55]; };
  /** How many drawings Home's features past Twin moons and a colony's past City have: world.mjs HOME_FEATURES and
   *  COLONY_FEATURES, in their order (test/world-projection.test.mjs checks the counts agree). A level or stage past the
   *  last comes round again, "Beacon II", and its drawing shows once more, up to three times. */
  const HOME_LOOKS = 12, COLONY_LOOKS = 6;
  /** Which feature a level past 12 (or a colony stage past City, 6) draws: its index in the list, and which time round. */
  read.homeFeature = (level) => (level > LEVEL_XP.length ? { index: (level - 13) % HOME_LOOKS, round: Math.floor((level - 13) / HOME_LOOKS) } : null);
  read.colonyFeature = (stage) => (stage > 6 ? { index: (stage - 7) % COLONY_LOOKS, round: Math.floor((stage - 7) / COLONY_LOOKS) } : null);
  /** How much of Home's feature `i` there is, 0 to 3: each time round it eases in over the days before its level begins,
   *  like the stages in drawHome. */
  function homeHas(i) {
    let n = 0;
    for (let round = 0; round < 3; round++) { const d = read.levelXp(13 + i + HOME_LOOKS * round) / 100; n += ramp(d - 6, d); }
    return n;
  }
  /** Home past Twin moons: one feature a level, in HOME_FEATURES' order. Small and kept to Home's rim and the corners of
   *  its view, so what was built stays clear: the 'far' pass goes before the builds behind Home, 'near' after Home's
   *  face and before the builds on and in front of it. */
  function drawHomeFeatures(cx, cy, R, t, layer) {
    if (R < 16) return; // a dot on the map: too small to show them
    const T = calm.matches ? 0 : t, u = Math.max(1.2, R * 0.012), sunA = Math.atan2(light.ly, light.lx);
    const glow = (gx, gy, r, c, a) => { const g = x.createRadialGradient(gx, gy, 0, gx, gy, r); g.addColorStop(0, rgba(c, a)); g.addColorStop(1, rgba(c, 0)); x.fillStyle = g; x.beginPath(); x.arc(gx, gy, r, 0, 7); x.fill(); };
    const dot = (dx, dy, r, c, a) => { x.fillStyle = rgba(c, a); x.beginPath(); x.arc(dx, dy, r, 0, 7); x.fill(); };
    const far = layer === 'far', blink = (k) => (calm.matches ? 1 : 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(T / 420 + k)));
    const DRAW = [
      (a, j) => { // Satellite: a small craft on a tilted orbit, behind Home for half of it
        const th = T / (16000 + 4000 * j) + j * 2.3, tilt = 0.45 - 0.35 * j, ex = Math.cos(th) * R * (1.24 + 0.1 * j), ey = Math.sin(th) * R * 0.4;
        if ((Math.sin(th) < 0) !== far) return;
        const sx = cx + ex * Math.cos(tilt) - ey * Math.sin(tilt), sy = cy + ex * Math.sin(tilt) + ey * Math.cos(tilt), v = u * 1.4;
        x.fillStyle = rgba('#8fb4e8', 0.9 * a); x.fillRect(sx - v * 3, sy - v * 0.4, v * 2, v * 0.8); x.fillRect(sx + v, sy - v * 0.4, v * 2, v * 0.8);
        x.fillStyle = rgba('#e8ecf2', a); x.fillRect(sx - v * 0.7, sy - v * 0.7, v * 1.4, v * 1.4);
      },
      (a, j) => { if (far) glow(cx, cy, R * (1.12 + 0.03 * j), '#a8d4ff', 0.42 * a); }, // Bright air: a brighter rim of sky
      (a, j) => { // Ring of lights: lights along the orbital ring, turning with it
        const m = 22 + 12 * j;
        for (let k = 0; k < m; k++) {
          const th = (k + 0.5 * j) / m * 2 * Math.PI + T / 70000;
          if ((Math.sin(th) < 0) !== far) continue;
          const ex = Math.cos(th) * R * 1.65, ey = Math.sin(th) * R * 0.36;
          x.fillStyle = rgba('#ffe2a8', (far ? 0.5 : 0.95) * a);
          x.fillRect(cx + ex * Math.cos(-0.25) - ey * Math.sin(-0.25) - u / 2, cy + ex * Math.sin(-0.25) + ey * Math.cos(-0.25) - u / 2, u, u);
        }
      },
      (a, j) => { // Near star: a bright star in a corner of the view
        if (!far) return;
        const [sx, sy] = [[-1.25, 1.35], [-1.85, -0.25], [0.95, 1.45]][j];
        glow(cx + sx * R, cy + sy * R, R * 0.18, '#fff0d0', 0.5 * a);
        dot(cx + sx * R, cy + sy * R, Math.max(1.6, R * 0.03), '#fff6e6', a);
      },
      (a, j) => { // Aurora: green curtains over the south pole, then the north
        if (far) return;
        const pole = j === 1 ? -1 : 1, m = 14;
        for (let k = 0; k < m; k++) {
          const th = pole * Math.PI / 2 + (k / (m - 1) - 0.5) * (1.1 + 0.3 * j), wave = 0.04 * Math.sin(T / 800 + k * 0.9);
          const bx = cx + Math.cos(th) * R * 1.01, by = cy + Math.sin(th) * R * 1.01, top = R * (1.09 + wave);
          const g = x.createLinearGradient(bx, by, cx + Math.cos(th) * top, cy + Math.sin(th) * top);
          g.addColorStop(0, rgba('#7cf0b0', 0.4 * a)); g.addColorStop(1, rgba('#7cf0b0', 0));
          x.strokeStyle = g; x.lineWidth = Math.max(1, R * 0.03);
          x.beginPath(); x.moveTo(bx, by); x.lineTo(cx + Math.cos(th) * top, cy + Math.sin(th) * top); x.stroke();
        }
      },
      (a, j) => { // Beacon: a mast on the rim with a red light blinking
        if (far) return;
        const th = -0.35 + 0.55 * j, bx = cx + Math.cos(th) * R, by = cy + Math.sin(th) * R, tx = cx + Math.cos(th) * R * 1.08, ty = cy + Math.sin(th) * R * 1.08;
        x.strokeStyle = rgba('#c8d0dc', 0.85 * a); x.lineWidth = Math.max(1, R * 0.008);
        x.beginPath(); x.moveTo(bx, by); x.lineTo(tx, ty); x.stroke();
        glow(tx, ty, u * 5, '#ff5a4a', 0.35 * a * blink(j)); dot(tx, ty, u * 1.1, '#ff6a58', a * blink(j));
      },
      (a, j) => { // Second sun glow: warm light from the other side, and a rim of it on Home's night side
        const o = sunA + Math.PI + 0.6 * j * (j % 2 ? 1 : -1);
        if (far) glow(cx + Math.cos(o) * R * 2.4, cy + Math.sin(o) * R * 2.4, R * 1.7, '#ffb48a', 0.16 * a);
        else { x.strokeStyle = rgba('#ffc49a', 0.3 * a); x.lineWidth = Math.max(1, R * 0.018); x.beginPath(); x.arc(cx, cy, R * 0.995, o - 0.8, o + 0.8); x.stroke(); }
      },
      (a, j) => { // Comet trail: a comet high in the sky, its tail away from the sun
        if (!far) return;
        const [hx, hy] = [[1.45, -1.25], [-1.55, -0.75], [1.9, -0.4]][j], px = cx + (hx + 0.03 * Math.sin(T / 9000)) * R, py = cy + hy * R;
        const ex = px - light.lx * R * 0.7, ey = py - light.ly * R * 0.7, g = x.createLinearGradient(px, py, ex, ey);
        g.addColorStop(0, rgba('#d6ecff', 0.7 * a)); g.addColorStop(1, rgba('#d6ecff', 0));
        x.strokeStyle = g; x.lineWidth = Math.max(1.2, R * 0.02); x.lineCap = 'round';
        x.beginPath(); x.moveTo(px, py); x.lineTo(ex, ey); x.stroke(); x.lineCap = 'butt';
        dot(px, py, Math.max(1.4, R * 0.014), '#f2f8ff', a);
      },
      (a, j) => { // Moon base: lights on the first moon
        if (far) return;
        const [mx, my] = moonAt(cx, cy, R, t), r = rng(91 + j);
        x.fillStyle = rgba('#ffd89a', a);
        for (let k = 0; k < 3 + 2 * j; k++) x.fillRect(mx + (r() - 0.5) * R * 0.17 - u / 2, my + (r() - 0.3) * R * 0.14 - u / 2, u, u);
      },
      (a, j) => { // Shield halo: a thin shimmering shell around Home
        if (!far) return;
        x.strokeStyle = rgba('#8ee8ff', 0.4 * a); x.lineWidth = Math.max(1, R * 0.006); x.setLineDash([R * 0.05, R * 0.03]); x.lineDashOffset = -T / 200;
        x.beginPath(); x.arc(cx, cy, R * (1.17 + 0.05 * j), 0, 7); x.stroke(); x.setLineDash([]); x.lineDashOffset = 0;
      },
      (a, j) => { // Sky lanterns: warm lights rising off the night side and fading
        if (far) return;
        const r = rng(57 + j);
        for (let k = 0; k < 9; k++) {
          const th = sunA + Math.PI + (r() - 0.5) * 2, ph = ((T / 11000) + r()) % 1, d = R * (1.02 + 0.2 * ph);
          dot(cx + Math.cos(th) * d, cy + Math.sin(th) * d, u * 0.9, '#ffc070', a * (1 - ph) * 0.9);
        }
      },
      (a, j) => { // Far lighthouse: a distant light whose beam sweeps round
        if (!far) return;
        const [lx, ly] = [[1.55, 1.25], [-1.6, 0.6], [1.85, 0.45]][j], px = cx + lx * R, py = cy + ly * R, b = T / 2600 + j, w = 0.12;
        x.fillStyle = rgba('#fff3c4', 0.14 * a);
        x.beginPath(); x.moveTo(px, py); x.lineTo(px + Math.cos(b - w) * R * 0.55, py + Math.sin(b - w) * R * 0.55); x.lineTo(px + Math.cos(b + w) * R * 0.55, py + Math.sin(b + w) * R * 0.55); x.fill();
        glow(px, py, u * 5, '#fff3c4', 0.4 * a); dot(px, py, u * 1.1, '#fffbe8', a);
      },
    ];
    for (let i = 0; i < HOME_LOOKS; i++) {
      const n = homeHas(i);
      for (let j = 0; j < Math.ceil(n); j++) DRAW[i](clamp(n - j), j);
    }
  }
  /** The mascot: a small stone creature in the spirit of Rocky from Project Hail Mary, squared off like the hub's mosaic,
   *  standing on Home's north pole with one leg raised in greeting; the same figure the hub's landing shows
   *  (hub/public/hub.js MASCOT, 48 by 48 units). About half of Home's radius tall, and not drawn when Home is small. */
  function drawMascot(cx, cy, R) {
    if (R < 28) return;
    const u = clamp(R * 0.0075, 0.35, 0.85), LEG = '#5a5248', BODY = '#8f8678', TOP = '#aaa092', SPOT = '#6f675b', AMBER = '#e3ab3e';
    const poly = (pts, width) => { x.lineWidth = width; x.beginPath(); x.moveTo(pts[0], pts[1]); for (let i = 2; i < pts.length; i += 2) x.lineTo(pts[i], pts[i + 1]); x.stroke(); };
    const hand = (hx, hy, fingers) => { for (const [dx, dy] of fingers) { x.lineWidth = 1.5; x.beginPath(); x.moveTo(hx, hy); x.lineTo(hx + dx, hy + dy); x.stroke(); } };
    const box = (bx, by, w, h, r, fill) => { x.fillStyle = fill; x.beginPath(); if (x.roundRect) x.roundRect(bx, by, w, h, r); else x.rect(bx, by, w, h); x.fill(); };
    x.save(); x.translate(cx - 24 * u, cy - R - 41 * u); x.scale(u, u);
    x.strokeStyle = LEG; x.lineCap = 'round'; x.lineJoin = 'round';
    poly([12, 35, 4, 39, 3, 46], 3); poly([17, 37, 12, 42, 11, 46], 3); poly([24, 38, 24, 42, 24, 46], 3); poly([31, 37, 36, 42, 37, 46], 3); // four legs, splayed
    poly([34, 33, 42, 27, 44, 18], 3); // one raised
    const down = [[-2.4, 1.2], [0, 2.4], [2.4, 1.2]];
    hand(3, 46, down); hand(11, 46, down); hand(24, 46, down); hand(37, 46, down); hand(44, 18, [[-2.2, -2.2], [0.4, -3], [2.6, -1.4]]);
    box(9, 23, 30, 16, 4, BODY); box(9, 23, 30, 6, 4, TOP); // the body, a block of stone, lit on top
    x.fillStyle = SPOT; x.fillRect(14, 31, 3, 3); x.fillRect(26, 33, 2.5, 2.5); x.fillRect(33, 30, 2, 2); x.fillRect(21, 26, 2, 2); // square flecks
    x.fillStyle = AMBER; x.beginPath(); x.arc(45, 11.5, 1.5, 0, 7); x.fill(); // a chime of greeting
    x.restore();
  }
  const idSeed = (id) => [...id].reduce((h, ch) => h * 31 + ch.charCodeAt(0), made.seed) | 0;
  /** A planet the frontier found: a bare world in its own colours, with craters. A colony on it grows by stage (world.mjs
   *  COLONY_STAGES), over the planet's look: a lander, then a few lights, lit domes, green on the land, night lights, and
   *  a city's dense lights and glow; past City one feature a stage (COLONY_FEATURES). Builds draw on top. */
  function drawPlanet(cx, cy, R, p, colony, look = {}, t = 0) {
    const st = colony ? read.stage(colony) : 0;
    if (colony) { // a warm air, thicker as the colony grows
      const k = st >= 6 ? 0.5 : 0.18 + 0.03 * st, a = x.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.22);
      a.addColorStop(0, `rgba(240,180,120,${k})`); a.addColorStop(1, 'rgba(240,180,120,0)');
      x.fillStyle = a; x.beginPath(); x.arc(cx, cy, R * 1.22, 0, 7); x.fill();
    }
    const [c0, c1, c2] = look.land ? [mix(look.land, '#ffffff', 0.35), look.land, mix(look.land, '#000000', 0.8)] : LOOK[p.look] ?? LOOK.rust;
    const gr = x.createRadialGradient(cx + light.lx * R * 0.35, cy + light.ly * R * 0.35, 0, cx, cy, R);
    gr.addColorStop(0, c0); gr.addColorStop(0.6, c1); gr.addColorStop(1, c2);
    x.fillStyle = gr; x.beginPath(); x.arc(cx, cy, R, 0, 7); x.fill();
    if (R > 12) {
      const r = rng(idSeed(p.id));
      x.save(); x.beginPath(); x.arc(cx, cy, R, 0, 7); x.clip();
      for (let i = 0; i < 14; i++) { x.fillStyle = 'rgba(20,14,10,.28)'; x.beginPath(); x.arc(cx + (r() - 0.5) * 1.8 * R, cy + (r() - 0.5) * 1.8 * R, R * (0.03 + r() * 0.07), 0, 7); x.fill(); }
      if (colony) drawColony(cx, cy, R, p, st, t, 'ground');
      x.restore();
      if (colony) drawColony(cx, cy, R, p, st, t, 'sky');
    } else if (colony) { // a dot on the map: a light, two once it is a township
      x.fillStyle = 'rgba(255,205,120,.95)'; x.fillRect(cx + R * 0.15, cy - R * 0.2, 1.5, 1.5);
      if (st >= 5) x.fillRect(cx - R * 0.3, cy + R * 0.1, 1.5, 1.5);
    }
  }
  /** A colony at stage `st` on its planet: 'ground' on the face (clipped to it), 'sky' around it. Each stage keeps what
   *  came before, all of it gathered round one place on the face, so it reads as one settlement growing. */
  function drawColony(cx, cy, R, p, st, t, layer) {
    const T = calm.matches ? 0 : t, u = Math.max(1.5, R / 110), seed = idSeed(p.id);
    const night = (px, py) => (px - cx) * light.lx + (py - cy) * light.ly < -R * 0.05;
    const sunlit = (px, py) => clamp(1.2 - Math.hypot(px - (cx + light.lx * 0.45 * R), py - (cy + light.ly * 0.4 * R)) / (1.5 * R), 0.3, 1);
    const blink = (k) => (calm.matches ? 1 : 0.4 + 0.6 * (0.5 + 0.5 * Math.sin(T / 420 + k)));
    const hx = cx - R * 0.08, hy = cy + R * 0.12; // where the settlement is
    /** `k` spots spread round it (or round `ox`, `oy`), wider with `spread`, the same every frame. */
    const around = (salt, k, spread, ox = hx, oy = hy) => {
      const r = rng(seed + salt), out = [];
      for (let i = 0; i < k; i++) {
        const a = r() * 2 * Math.PI, d = Math.sqrt(r()) * spread * R, px = ox + Math.cos(a) * d * 1.3, py = oy + Math.sin(a) * d * 0.8;
        if (Math.hypot(px - cx, py - cy) < R * 0.93) out.push({ x: px, y: py, w: r() });
      }
      return out;
    };
    const domes = around(5, 7, 0.45).map((d) => ({ ...d, r: R * (0.05 + d.w * 0.05) }));
    const extra = (i) => (st >= 7 + i ? Math.min(3, Math.floor((st - 7 - i) / COLONY_LOOKS) + 1) : 0); // how many times past City feature i shows
    if (layer === 'ground') {
      if (st >= 4) for (const g of around(9, 10, 0.65)) { // Green patches: green on the land round the settlement
        x.fillStyle = `rgba(88,170,92,${0.75 * sunlit(g.x, g.y)})`;
        x.beginPath(); x.ellipse(g.x, g.y, R * (0.08 + 0.08 * g.w), R * (0.05 + 0.04 * g.w), 0.4, 0, 7); x.fill();
      }
      if (st >= 6) { // City: the settlement glows
        const g = x.createRadialGradient(hx, hy, 0, hx, hy, R * 0.6);
        g.addColorStop(0, 'rgba(255,196,120,.35)'); g.addColorStop(1, 'rgba(255,196,120,0)');
        x.fillStyle = g; x.beginPath(); x.arc(hx, hy, R * 0.6, 0, 7); x.fill();
      }
      if (st >= 3) for (const [i, d] of domes.entries()) { // Domes: lit from inside; garden roofs past City turn them green on top
        x.fillStyle = 'rgba(190,225,255,.4)'; x.beginPath(); x.ellipse(d.x, d.y, d.r * 1.4, d.r, 0, Math.PI, 2 * Math.PI); x.fill();
        if (extra(4) && i < 3 * extra(4)) { x.fillStyle = 'rgba(110,200,110,.75)'; x.beginPath(); x.ellipse(d.x, d.y - d.r * 0.55, d.r * 0.9, d.r * 0.4, 0, Math.PI, 2 * Math.PI); x.fill(); }
        x.fillStyle = 'rgba(255,205,120,.9)'; x.fillRect(d.x - u / 2, d.y - u * 1.4, u, u);
      }
      if (st >= 2) for (const l of around(13, 5, 0.25)) { // Outpost: a few lights, each with a glow round it
        const g = x.createRadialGradient(l.x, l.y, 0, l.x, l.y, u * 5);
        g.addColorStop(0, 'rgba(255,200,120,.5)'); g.addColorStop(1, 'rgba(255,200,120,0)');
        x.fillStyle = g; x.beginPath(); x.arc(l.x, l.y, u * 5, 0, 7); x.fill();
        x.fillStyle = 'rgba(255,220,150,1)'; x.fillRect(l.x - u, l.y - u, u * 2, u * 2);
      }
      const lights = st >= 6 ? 110 : st >= 5 ? 36 : 0; // Township: night lights; City: dense ones
      for (const l of around(17, lights, st >= 6 ? 0.75 : 0.55, hx - light.lx * R * 0.3, hy - light.ly * R * 0.3)) { // leaning to the night side, where they show
        const d = u * (1.1 + 0.7 * l.w);
        x.fillStyle = night(l.x, l.y) ? 'rgba(255,205,120,.92)' : 'rgba(236,228,210,.4)'; x.fillRect(l.x - d / 2, l.y - d / 2, d, d);
      }
      if (st <= 2) { // Landing site: the lander, its light blinking
        const lx = hx + R * 0.05, ly = hy - R * 0.02, v = Math.max(1.6, R * 0.05);
        x.fillStyle = 'rgba(0,0,0,.3)'; x.beginPath(); x.ellipse(lx, ly + v * 1.6, v * 2.2, v * 0.5, 0, 0, 7); x.fill();
        x.strokeStyle = 'rgba(200,206,216,.95)'; x.lineWidth = Math.max(1, v * 0.3);
        x.beginPath(); x.moveTo(lx - v * 0.8, ly + v * 0.4); x.lineTo(lx - v * 1.7, ly + v * 1.6); x.moveTo(lx + v * 0.8, ly + v * 0.4); x.lineTo(lx + v * 1.7, ly + v * 1.6); x.stroke();
        x.fillStyle = 'rgba(214,220,230,.98)'; x.beginPath(); x.moveTo(lx - v, ly + v * 0.6); x.lineTo(lx - v * 0.6, ly - v * 0.7); x.lineTo(lx + v * 0.6, ly - v * 0.7); x.lineTo(lx + v, ly + v * 0.6); x.fill();
        x.fillStyle = `rgba(255,190,90,${blink(1)})`; x.beginPath(); x.arc(lx, ly - v * 0.95, Math.max(1, v * 0.3), 0, 7); x.fill();
      }
      for (let j = 0; j < extra(2); j++) { // Harbour lights: a bay of water, pale blue lights along its shore
        const m = 16, ax = hx + R * (0.15 - 0.3 * j), ay = hy + R * (0.55 - 0.75 * j), rx = R * 0.36, ry = R * 0.11;
        x.fillStyle = 'rgba(34,78,128,.75)'; x.beginPath(); x.ellipse(ax, ay, rx, ry, 0, 0, 7); x.fill();
        x.fillStyle = 'rgba(196,232,255,.95)';
        for (let k = 0; k < m; k++) { const th = Math.PI * (1.05 + 0.9 * k / (m - 1)); x.fillRect(ax + Math.cos(th) * rx - u * 0.75, ay + Math.sin(th) * ry - u * 0.75, u * 1.5, u * 1.5); }
      }
      for (let j = 0; j < extra(3); j++) { // Rail ring: a line round the face, a train's light running along it
        const tilt = 0.12 - 0.3 * j, ry = R * (0.16 + 0.06 * j), oy = cy + R * (0.05 + 0.25 * j);
        x.strokeStyle = 'rgba(206,214,226,.55)'; x.lineWidth = Math.max(1, R * 0.012);
        x.beginPath(); x.ellipse(cx, oy, R * 1.02, ry, tilt, 0, Math.PI); x.stroke();
        const th = (T / 5000 + j) % Math.PI, ex = Math.cos(th) * R * 1.02, ey = Math.sin(th) * ry;
        x.fillStyle = 'rgba(255,236,190,.95)'; x.beginPath(); x.arc(cx + ex * Math.cos(tilt) - ey * Math.sin(tilt), oy + ex * Math.sin(tilt) + ey * Math.cos(tilt), u * 1.2, 0, 7); x.fill();
      }
      return;
    }
    for (let j = 0; j < extra(0); j++) { // Beacon tower: a tower on the rim, red at the top
      const th = -1.0 + 0.55 * j, bx = cx + Math.cos(th) * R * 0.97, by = cy + Math.sin(th) * R * 0.97, tx = cx + Math.cos(th) * R * 1.14, ty = cy + Math.sin(th) * R * 1.14;
      x.strokeStyle = 'rgba(200,208,220,.9)'; x.lineWidth = Math.max(1.2, R * 0.018);
      x.beginPath(); x.moveTo(bx, by); x.lineTo(tx, ty); x.stroke();
      x.fillStyle = `rgba(255,96,80,${blink(j)})`; x.beginPath(); x.arc(tx, ty, Math.max(1.5, R * 0.014), 0, 7); x.fill();
    }
    for (let j = 0; j < extra(1); j++) { // Orbital mirror: a bright panel in orbit, shining a little light down
      const th = T / 30000 + 2 + j * 2.1, mx = cx + Math.cos(th) * R * 1.3, my = cy + Math.sin(th) * R * 0.45 - R * 0.55, v = Math.max(2, R * 0.03);
      x.fillStyle = 'rgba(255,244,214,.1)'; x.beginPath(); x.moveTo(mx, my); x.lineTo(hx - R * 0.25, hy); x.lineTo(hx + R * 0.25, hy); x.fill();
      x.fillStyle = 'rgba(236,244,255,.95)'; x.beginPath(); x.moveTo(mx, my - v); x.lineTo(mx + v * 1.6, my); x.lineTo(mx, my + v); x.lineTo(mx - v * 1.6, my); x.fill();
    }
    for (let j = 0; j < extra(5); j++) { // Space lift: a cable up from the north, a car climbing it
      const th = -Math.PI / 2 + 0.3 + 0.45 * j, bx = cx + Math.cos(th) * R, by = cy + Math.sin(th) * R, tx = cx + Math.cos(th) * R * 1.75, ty = cy + Math.sin(th) * R * 1.75;
      x.strokeStyle = 'rgba(200,210,226,.7)'; x.lineWidth = Math.max(1, R * 0.008);
      x.beginPath(); x.moveTo(bx, by); x.lineTo(tx, ty); x.stroke();
      x.fillStyle = 'rgba(214,220,230,.95)'; x.fillRect(tx - u * 2, ty - u * 1.2, u * 4, u * 2.4);
      const k = calm.matches ? 0.5 : (T / 7000 + j * 0.4) % 1;
      x.fillStyle = 'rgba(255,214,140,.95)'; x.fillRect(bx + (tx - bx) * k - u, by + (ty - by) * k - u, u * 2, u * 2);
    }
  }
  // ---------- what was built: Claude's pieces from world.mjs's CATALOGUE, at any size from a map dot to close up
  const SIZE = { small: 0.6, medium: 1, large: 1.45 };
  /** Where on the face a place is, from the top (-1) to the bottom (1). */
  const BAND = { north: [-0.82, -0.38], south: [0.38, 0.82], equator: [-0.22, 0.22], everywhere: [-0.82, 0.82], orbit: [-0.82, 0.82] };
  /** What was built on a place, each piece with a seed of its own so it stays where it was put. */
  const piecesOn = (id) => (world?.builds ?? []).filter((b) => b.on === id).flatMap((b) => b.pieces.map((p, i) => ({ ...p, seed: idSeed(`${b.id}:${i}`) })));
  /** The newest land and ocean colours built there: they recolour the planet itself. */
  const lookOf = (pieces) => ({ land: pieces.findLast((p) => p.kind === 'land_colour')?.colour, ocean: pieces.findLast((p) => p.kind === 'ocean_colour')?.colour });
  /** A piece's spots on the ground, the same every frame: across (scrolling with the planet's spin) and down its band. */
  function spots(p, k, cx, cy, R, spin) {
    const r = rng(p.seed), [a, b] = BAND[p.place] ?? BAND.everywhere, out = [];
    for (let i = 0; i < k; i++) {
      const u = r(), v = a + (b - a) * r(), w = r();
      out.push({ x: cx - R + ((u + spin) % 1) * 2.2 * R - 0.1 * R, y: cy + v * R, w });
    }
    return out.filter((s) => Math.hypot(s.x - cx, s.y - cy) < R * 0.94);
  }
  /** Things in orbit: where each one is now, and whether it is behind the planet. */
  function orbits(p, k, cx, cy, R, t, near, far) {
    const r = rng(p.seed), out = [];
    for (let i = 0; i < k; i++) {
      const orb = R * (near + (far - near) * (k > 1 ? i / (k - 1) : 0.5) + 0.12 * r()), speed = 24000 + 16000 * r(), a = (calm.matches ? 0 : t / speed) + r() * 7;
      out.push({ x: cx + Math.cos(a) * orb, y: cy + Math.sin(a) * orb * 0.32, behind: Math.sin(a) < 0, i });
    }
    return out;
  }
  /** Built pieces in three passes around the planet's own drawing: 'back' (behind it), 'ground' (on its face, clipped),
   *  'front'. `home` says whether this is Home, whose own land and seas take the colours instead. */
  function drawBuilt(cx, cy, R, pieces, t, layer, spin, home) {
    if (!pieces.length) return;
    const dot = Math.max(1, R / 110), blink = (i) => (calm.matches ? 1 : 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t / 350 + i * 1.7)));
    const lit = (sx, sy) => clamp(1.25 - Math.hypot(sx - (cx + light.lx * 0.45 * R), sy - (cy + light.ly * 0.4 * R)) / (1.5 * R), 0.25, 1); // daylight from the sun's side
    if (layer === 'ground') { x.save(); x.beginPath(); x.arc(cx, cy, R, 0, 7); x.clip(); }
    for (const p of pieces) {
      const S = SIZE[p.size] ?? 1, n = p.count, c = p.colour;
      if (p.kind === 'atmosphere' && layer === 'back') {
        const out = R * (1.12 + 0.12 * S), g = x.createRadialGradient(cx, cy, R * 0.95, cx, cy, out);
        g.addColorStop(0, rgba(c, 0.5)); g.addColorStop(1, rgba(c, 0));
        x.fillStyle = g; x.beginPath(); x.arc(cx, cy, out, 0, 7); x.fill();
      } else if ((p.kind === 'rings' || p.kind === 'ring_city') && layer !== 'ground') {
        const tilt = (rng(p.seed)() - 0.5) * 0.7, city = p.kind === 'ring_city', from = layer === 'back' ? Math.PI : 0;
        for (let i = 0; i < (city ? 1 : Math.min(n, 4)); i++) {
          const rx = R * (1.3 + 0.22 * S + 0.13 * i), ry = rx * 0.24;
          x.strokeStyle = city ? 'rgba(200,208,220,.6)' : rgba(c, 0.55); x.lineWidth = Math.max(1, R * (city ? 0.05 : 0.03) * S);
          x.beginPath(); x.ellipse(cx, cy, rx, ry, tilt, from, from + Math.PI); x.stroke();
          if (city) for (let j = 0, m = 6 * n; j < m; j++) { // its lights, along the half on this side
            const th = from + (j + 0.5) / m * Math.PI, ex = Math.cos(th) * rx, ey = Math.sin(th) * ry;
            x.fillStyle = rgba(c, 0.95); x.fillRect(cx + ex * Math.cos(tilt) - ey * Math.sin(tilt) - dot / 2, cy + ex * Math.sin(tilt) + ey * Math.cos(tilt) - dot / 2, dot * 1.3, dot * 1.3);
          }
        }
      } else if (p.kind === 'moon' && layer !== 'ground') {
        for (const o of orbits(p, Math.min(n, 6), cx, cy, R, t, 1.7, 2.5)) {
          if (o.behind !== (layer === 'back')) continue;
          const mr = Math.max(1, R * 0.075 * S), g = x.createRadialGradient(o.x - mr * 0.3, o.y - mr * 0.3, mr * 0.1, o.x, o.y, mr);
          g.addColorStop(0, mix(c, '#ffffff', 0.35)); g.addColorStop(1, mix(c, '#000000', 0.55));
          x.fillStyle = g; x.beginPath(); x.arc(o.x, o.y, mr, 0, 7); x.fill();
        }
      } else if (p.kind === 'space_station' && layer !== 'ground') {
        for (const o of orbits(p, Math.min(n, 6), cx, cy, R, t * 0.6, 1.4, 1.9)) {
          if (o.behind !== (layer === 'back')) continue;
          const u = Math.max(1.2, R * 0.03 * S);
          x.fillStyle = rgba(c, 0.95); x.fillRect(o.x - u * 0.6, o.y - u * 0.6, u * 1.2, u * 1.2);
          x.fillStyle = rgba(c, 0.6); x.fillRect(o.x - u * 3, o.y - u * 0.35, u * 2, u * 0.7); x.fillRect(o.x + u, o.y - u * 0.35, u * 2, u * 0.7);
        }
      } else if (p.kind === 'beacon' && p.place === 'orbit' && layer !== 'ground') {
        for (const o of orbits(p, Math.min(n, 6), cx, cy, R, t * 0.8, 1.35, 1.8)) {
          if (o.behind !== (layer === 'back')) continue;
          x.fillStyle = rgba(c, blink(o.i)); x.beginPath(); x.arc(o.x, o.y, Math.max(1.2, R * 0.02 * S), 0, 7); x.fill();
        }
      } else if (p.kind === 'space_elevator' && layer === 'front') {
        const r = rng(p.seed);
        for (let i = 0; i < Math.min(n, 4); i++) { // from the rim up: north, south, at the equator's edges, or anywhere
          const j = (r() - 0.5), a = p.place === 'north' ? -Math.PI / 2 + j * 1.2 : p.place === 'south' ? Math.PI / 2 + j * 1.2
            : p.place === 'equator' ? (r() < 0.5 ? 0 : Math.PI) + j * 0.6 : r() * 2 * Math.PI;
          const bx = cx + Math.cos(a) * R, by = cy + Math.sin(a) * R, len = R * (0.7 + 0.4 * S), u = Math.max(1.2, R * 0.03);
          x.strokeStyle = rgba(c, 0.85); x.lineWidth = Math.max(0.8, R * 0.012);
          x.beginPath(); x.moveTo(bx, by); x.lineTo(bx + Math.cos(a) * len, by + Math.sin(a) * len); x.stroke();
          x.fillStyle = rgba(c, 0.95); x.fillRect(bx + Math.cos(a) * len - u, by + Math.sin(a) * len - u, 2 * u, 2 * u);
        }
      } else if (p.kind === 'aurora' && layer === 'front') {
        const poles = p.place === 'north' ? [-1] : p.place === 'south' ? [1] : [-1, 1], m = 12 + 2 * n;
        for (const pole of poles) for (let k = 0; k < m; k++) { // a curtain: many soft strands, rising and falling
          const th = pole * Math.PI / 2 + (k / (m - 1) - 0.5) * 1.4, wave = 0.05 * Math.sin((calm.matches ? 0 : t / 700) + k * 0.8);
          const bx = cx + Math.cos(th) * R * 1.01, by = cy + Math.sin(th) * R * 1.01, top = R * (1.1 + 0.1 * S + wave);
          const g = x.createLinearGradient(bx, by, cx + Math.cos(th) * top, cy + Math.sin(th) * top);
          g.addColorStop(0, rgba(c, 0.38)); g.addColorStop(0.4, rgba(c, 0.22)); g.addColorStop(1, rgba(c, 0));
          x.strokeStyle = g; x.lineWidth = Math.max(1, R * 0.04);
          x.beginPath(); x.moveTo(bx, by); x.lineTo(cx + Math.cos(th) * top, cy + Math.sin(th) * top); x.stroke();
        }
      } else if (layer === 'ground') {
        if (p.kind === 'ocean_colour' && !home) for (const s of spots(p, 3 + n, cx, cy, R, spin)) { // seas on a colony
          x.fillStyle = rgba(c, 0.8 * lit(s.x, s.y)); x.beginPath(); x.ellipse(s.x, s.y, R * (0.1 + 0.12 * s.w) * S, R * (0.06 + 0.07 * s.w) * S, 0.3, 0, 7); x.fill();
        } else if (p.kind === 'mountains') for (const s of spots(p, Math.min(24, n * 2), cx, cy, R, spin)) {
          const h = Math.max(1.5, R * 0.05 * S), k = lit(s.x, s.y);
          for (const [dx, sc] of [[-0.8, 0.7], [0, 1], [0.7, 0.8]]) {
            x.fillStyle = rgba(c, 0.9 * k); x.beginPath(); x.moveTo(s.x + (dx - 0.6 * sc) * h, s.y); x.lineTo(s.x + dx * h, s.y - h * sc); x.lineTo(s.x + (dx + 0.6 * sc) * h, s.y); x.fill();
          }
        } else if (p.kind === 'domes') for (const s of spots(p, n, cx, cy, R, spin)) {
          const dr = Math.max(1.2, R * 0.05 * S);
          x.fillStyle = rgba(c, 0.45 * lit(s.x, s.y) + 0.1); x.beginPath(); x.ellipse(s.x, s.y, dr * 1.4, dr, 0, Math.PI, 2 * Math.PI); x.fill();
          x.fillStyle = 'rgba(255,214,140,.9)'; x.fillRect(s.x - dot / 2, s.y - dot * 1.5, dot, dot);
        } else if (p.kind === 'city_lights') for (const s of spots(p, Math.min(72, n * 6), cx, cy, R, spin)) {
          const night = (s.x - cx) * light.lx + (s.y - cy) * light.ly < -R * 0.05, d = dot * (0.8 + 0.4 * S);
          x.fillStyle = rgba(c, night ? 0.95 : 0.35); x.fillRect(s.x - d / 2, s.y - d / 2, d, d);
        } else if (p.kind === 'beacon' && p.place !== 'orbit') for (const s of spots(p, Math.min(n, 6), cx, cy, R, spin)) {
          const b = blink(s.w * 9), d = Math.max(1.2, R * 0.02 * S);
          x.fillStyle = rgba(c, 0.25 * b); x.beginPath(); x.arc(s.x, s.y, d * 3, 0, 7); x.fill();
          x.fillStyle = rgba(c, b); x.beginPath(); x.arc(s.x, s.y, d, 0, 7); x.fill();
        }
      }
    }
    if (layer === 'ground') x.restore();
  }
  /** Where a rocket is `k` of the way along its flight (map px), and which way it points: a curve, bowed to one side. */
  function rocketAt(f, k) {
    const { from: a, to: b } = f, c = { x: (a.x + b.x) / 2 - (b.y - a.y) * 0.25, y: (a.y + b.y) / 2 + (b.x - a.x) * 0.25 }, u = 1 - k;
    return { x: u * u * a.x + 2 * u * k * c.x + k * k * b.x, y: u * u * a.y + 2 * u * k * c.y + k * k * b.y,
      dx: 2 * u * (c.x - a.x) + 2 * k * (b.x - c.x), dy: 2 * u * (c.y - a.y) + 2 * k * (b.y - c.y) };
  }
  const FLIGHT_MS = 2800;
  /** The rocket and its trail; true once it has landed. */
  function drawRocket(f, now, to) {
    if (now < f.at) return false; // the view is still pulling out
    const k = clamp((now - f.at) / FLIGHT_MS);
    x.strokeStyle = 'rgba(255,210,138,.4)'; x.lineWidth = 1.2; x.setLineDash([2, 5]); x.beginPath();
    for (let i = 0; i <= 30; i++) { const q = rocketAt(f, i / 30 * k), [qx, qy] = to(q.x, q.y); if (i) x.lineTo(qx, qy); else x.moveTo(qx, qy); }
    x.stroke(); x.setLineDash([]);
    const p = rocketAt(f, k), [rx, ry] = to(p.x, p.y);
    x.save(); x.translate(rx, ry); x.rotate(Math.atan2(p.dy, p.dx) + Math.PI / 2);
    x.fillStyle = '#ffc56a'; x.beginPath(); x.moveTo(-3, 7); x.lineTo(0, 13 + Math.random() * 4); x.lineTo(3, 7); x.fill();
    x.fillStyle = '#dfe5ee'; x.beginPath(); x.moveTo(0, -9); x.quadraticCurveTo(5, -2, 4, 7); x.lineTo(-4, 7); x.quadraticCurveTo(-5, -2, 0, -9); x.fill();
    x.fillStyle = '#c9584a'; x.fillRect(-6, 3, 3, 5); x.fillRect(3, 3, 3, 5);
    x.restore();
    return k >= 1;
  }
  /** The sun Home orbits: a corona and its disc. */
  function drawSun(px, py, r) {
    const c = SUN[sun().look] ?? SUN.gold, g = x.createRadialGradient(px, py, r, px, py, 3 * r);
    g.addColorStop(0, rgba(c, 0.35)); g.addColorStop(1, rgba(c, 0));
    x.fillStyle = g; x.beginPath(); x.arc(px, py, 3 * r, 0, 7); x.fill();
    x.fillStyle = c; x.beginPath(); x.arc(px, py, r, 0, 7); x.fill();
  }
  /** A moment: a four-pointed star in its kind's colour. */
  function drawMoment(px, py, m, on) {
    const r = on ? 4.2 : 3;
    x.fillStyle = MOMENT[m.kind] ?? '#fff';
    x.beginPath();
    for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 - Math.PI / 2, d = i % 2 ? r * 0.42 : r * 2.1; x.lineTo(px + Math.cos(a) * d, py + Math.sin(a) * d); }
    x.closePath(); x.fill();
    if (on) { x.strokeStyle = 'rgba(227,171,62,.8)'; x.lineWidth = 1.2; x.beginPath(); x.arc(px, py, 11, 0, 7); x.stroke(); }
  }
  /** The direction a push would take, from where it leaves: dashed, with an arrowhead. */
  function drawArrow(hx, hy, ang, len, a) {
    const ex = hx + Math.cos(ang) * len, ey = hy + Math.sin(ang) * len;
    x.strokeStyle = `rgba(227,171,62,${a})`; x.fillStyle = `rgba(227,171,62,${a})`; x.lineWidth = 2; x.setLineDash([6, 6]);
    x.beginPath(); x.moveTo(hx + Math.cos(ang) * 14, hy + Math.sin(ang) * 14); x.lineTo(ex, ey); x.stroke(); x.setLineDash([]);
    x.beginPath(); x.moveTo(ex + Math.cos(ang) * 10, ey + Math.sin(ang) * 10);
    x.lineTo(ex + Math.cos(ang + 2.5) * 9, ey + Math.sin(ang + 2.5) * 9); x.lineTo(ex + Math.cos(ang - 2.5) * 9, ey + Math.sin(ang - 2.5) * 9); x.fill();
  }

  // ---------- the Universe: your sun among the galaxies your probes found, drawn in hub units (the spiral's), not map px
  const PROBE_SHOW = 240; // how far out a probe on its way is drawn (hub units), at the fraction of the way it has come
  let found = [], foundSig = null, probeReady = null; // the found galaxies, named; whether a probe would find anyone
  let flying = new Set(), landed = []; // probes seen on their way here; the spots of those that arrived since, not yet toasted
  let foundRetry = 0; // after a lookup the hub didn't answer, when to ask again
  /** This account's spot in the Universe: the page's owner, or the account signed in here; null signed out. */
  const meSpot = () => opts.universe?.me?.() ?? (hubNow?.loggedIn && hubNow.account ? { x: hubNow.account.x, y: hubNow.account.y } : null);
  const universeOn = () => Boolean(opts.universe && meSpot());
  /** This account's probes, their target only once arrived: a summary has every account's (with `by`), a projection only its owner's. */
  function myProbes() {
    const me = meSpot();
    return (world?.probes ?? []).filter((q) => !q.by || (me && q.by.x === me.x && q.by.y === me.y))
      .map((q) => ({ id: q.id, ang: q.ang, progress: q.progress, to: q.progress >= 1 ? q.to : null }));
  }
  /** Ask for the found galaxies' names and suns when the spots change; unlisted ones come back missing and are not drawn. */
  function loadFound() {
    const at = universeOn() ? myProbes().filter((q) => q.to).map((q) => q.to) : [], sig = at.map((c) => `${c.x},${c.y}`).join(';');
    // A probe this session saw on its way that has now arrived gets a toast once its galaxy is named; finds from before
    // (a reopened World, signing in again) don't.
    if (universeOn()) for (const q of myProbes()) {
      if (!q.to) flying.add(q.id);
      else if (flying.delete(q.id)) landed.push(q.to);
    }
    if (sig === foundSig || (foundSig === null && Date.now() < foundRetry)) return;
    foundSig = sig;
    if (!at.length) { found = []; return; }
    opts.universe.names(at).then((list) => {
      if (foundSig !== sig) return;
      if (!Array.isArray(list)) { foundSig = null; foundRetry = Date.now() + 30_000; return; } // no answer: keep what was drawn, ask again in 30 s
      found = list;
      const named = landed.filter((c) => found.some((g) => g.x === c.x && g.y === c.y));
      landed = landed.filter((c) => !named.includes(c));
      if (!opts.readOnly) for (const c of named) opts.toast?.(`Your probe found @${found.find((g) => g.x === c.x && g.y === c.y).handle}'s galaxy.`);
      showProbe();
    }).catch(() => { if (foundSig === sig) { foundSig = null; foundRetry = Date.now() + 30_000; } });
  }
  /** The Universe's transform: your sun at the middle, zoomed to fit what you found (300 hub units across at least). */
  function uView() {
    const me = meSpot(), vw = W - side(), flying = myProbes().some((q) => !q.to);
    const far = Math.max(300, ...found.map((g) => Math.hypot(g.x - me.x, g.y - me.y) * 1.15), flying ? PROBE_SHOW * 1.15 : 0);
    return { me, cx: vw / 2 + pan.x, cy: H / 2 + pan.y, k: Math.min(vw, H || 800) * 0.42 / far };
  }
  /** A galaxy as the Universe shows it: a glowing core in its sun's colour and two arms of stars winding out, turning
   *  slowly. Its spot picks the tilt and the scatter, so a galaxy looks the same to everyone who has found it. */
  const spotSeed = (at) => ((at.x * 73856093) ^ (at.y * 19349663)) >>> 0;
  function drawGalaxy(px, py, r, t, look, at) {
    const c = SUN[look] ?? SUN.gold, rnd = rng(spotSeed(at));
    const tilt = 0.45 + 0.4 * rnd(), turn = rnd() * Math.PI, spin = calm.matches ? 0 : t / 90000;
    x.save(); x.translate(px, py); x.rotate(turn); x.scale(1, tilt);
    const g = x.createRadialGradient(0, 0, 0, 0, 0, r * 1.3);
    g.addColorStop(0, rgba(c, 0.75)); g.addColorStop(0.3, rgba(c, 0.22)); g.addColorStop(1, rgba(c, 0));
    x.fillStyle = g; x.beginPath(); x.arc(0, 0, r * 1.3, 0, 7); x.fill();
    for (let arm = 0; arm < 2; arm++) for (let i = 0; i < 90; i++) {
      const f = i / 90, a = spin + arm * Math.PI + f * 3.6 + (rnd() - 0.5) * 0.5, d = r * (0.1 + 0.9 * f) * (0.9 + 0.2 * rnd());
      x.fillStyle = f < 0.35 ? rgba(c, 0.85 - f) : `rgba(220,230,255,${0.75 - 0.6 * f})`;
      const dot = r > 20 ? 1.7 : 1.3;
      x.fillRect(Math.cos(a) * d, Math.sin(a) * d, dot, dot / tilt);
    }
    x.fillStyle = c; x.beginPath(); x.arc(0, 0, Math.max(1.6, r * 0.1), 0, 7); x.fill();
    x.restore();
  }
  /** What fills the Universe's dark, for looks only: nebula clouds, a band of dust and faint far-off galaxies that are
   *  nobody's (too small to click, never named). Your spot picks them, and they drift behind as you pan. */
  const NEBULA = ['#6b4fd8', '#2f8fb0', '#c0507a', '#3e6fd6', '#7a3fa0'];
  function drawScenery(a, t, me) {
    const r = rng(spotSeed(me) ^ 0x5eed), span = 1.6, wrap = (v, n) => ((v % n) + n) % n;
    const at = (depth) => [wrap(r() * W * span + pan.x * depth, W * span) - W * (span - 1) / 2,
      wrap(r() * H * span + pan.y * depth, H * span) - H * (span - 1) / 2];
    for (let i = 0; i < 9; i++) { // clouds: wide, soft, two blobs each so they aren't round
      const c = NEBULA[Math.floor(r() * NEBULA.length)], [nx, ny] = at(0.15), size = Math.max(W, H) * (0.18 + 0.22 * r());
      for (let j = 0; j < 2; j++) {
        const ox = nx + (r() - 0.5) * size, oy = ny + (r() - 0.5) * size * 0.6, g = x.createRadialGradient(ox, oy, 0, ox, oy, size);
        g.addColorStop(0, rgba(c, 0.11 + 0.08 * r())); g.addColorStop(0.5, rgba(c, 0.04)); g.addColorStop(1, rgba(c, 0));
        x.fillStyle = g; x.fillRect(ox - size, oy - size, size * 2, size * 2);
      }
    }
    // a band of dust and denser stars across the sky, like looking along a galaxy's disc
    const ang = r() * Math.PI, ca = Math.cos(ang), sa = Math.sin(ang), mx = W / 2 + pan.x * 0.25, my = H / 2 + pan.y * 0.25;
    const len = Math.hypot(W, H);
    x.save(); x.translate(mx, my); x.rotate(ang);
    const band = x.createLinearGradient(0, -H * 0.18, 0, H * 0.18);
    band.addColorStop(0, 'rgba(150,170,230,0)'); band.addColorStop(0.5, 'rgba(150,170,230,0.1)'); band.addColorStop(1, 'rgba(150,170,230,0)');
    x.fillStyle = band; x.fillRect(-len, -H * 0.18, len * 2, H * 0.36);
    x.restore();
    for (let i = 0; i < 700; i++) {
      const s = (r() - 0.5) * len * 1.6, off = (r() + r() + r() - 1.5) * H * 0.09;
      const px = wrap(mx + ca * s - sa * off, W), py = wrap(my + sa * s + ca * off, H);
      x.fillStyle = `rgba(215,225,255,${0.1 + 0.3 * r()})`; x.fillRect(px, py, 1, 1);
    }
    for (let i = 0; i < 28; i++) { // far-off galaxies: faint, small, behind everything
      const [gx, gy] = at(0.35), look = ['white', 'blue', 'gold', 'orange'][Math.floor(r() * 4)], size = 4 + 6 * r(), dim = 0.2 + 0.25 * r();
      x.globalAlpha = a * dim;
      drawGalaxy(gx, gy, size, t, look, { x: Math.floor(r() * 1e6), y: i });
    }
    x.globalAlpha = a;
  }
  function drawUniverse(a, t) {
    const u = uView(), to = (gx, gy) => [u.cx + (gx - u.me.x) * u.k, u.cy + (gy - u.me.y) * u.k];
    x.globalAlpha = a;
    const bg = x.createRadialGradient(u.cx, u.cy, 10, u.cx, u.cy, Math.max(W, H) * 0.8);
    bg.addColorStop(0, '#0a1020'); bg.addColorStop(1, '#020309');
    x.fillStyle = bg; x.fillRect(0, 0, W, H);
    const r = rng(7777); // far stars drift slower than near ones as you pan: depth, in 2D
    for (let i = 0; i < 320; i++) {
      const depth = 0.1 + 0.6 * r(), sx = ((r() * W + pan.x * depth) % W + W) % W, sy = ((r() * H + pan.y * depth) % H + H) % H;
      x.fillStyle = `rgba(220,230,255,${0.08 + 0.4 * depth})`; x.fillRect(sx, sy, depth > 0.55 ? 1.6 : 1, depth > 0.55 ? 1.6 : 1);
    }
    drawScenery(a, t, u.me);
    for (const q of myProbes()) if (!q.to) { // on its way: along where it was aimed, never toward its target
      const d = q.progress * PROBE_SHOW, [px, py] = to(u.me.x + Math.cos(q.ang) * d, u.me.y + Math.sin(q.ang) * d);
      x.strokeStyle = 'rgba(227,171,62,.35)'; x.lineWidth = 1; x.setLineDash([2, 6]);
      x.beginPath(); x.moveTo(u.cx, u.cy); x.lineTo(px, py); x.stroke(); x.setLineDash([]);
      x.fillStyle = '#e3ab3e'; x.beginPath(); x.arc(px, py, 2.6, 0, 7); x.fill();
    }
    for (const g of found) {
      const [px, py] = to(g.x, g.y);
      drawGalaxy(px, py, 30, t, g.look, g);
      if (hover === `@${g.handle}` || found.length < 10) label(`@${g.handle}`, px, py + 36, hover === `@${g.handle}` ? '#e3e7ed' : '#8c96a4', 12);
    }
    drawGalaxy(u.cx, u.cy, 44, t, sun()?.look, u.me);
    label(`${opts.universe.name ?? 'You'} · ${u.me.x}, ${u.me.y}`.replaceAll('-', '−'), u.cx, u.cy + 50, '#e3e7ed', 12);
    if (aiming === 'probe' && probeAng != null) drawArrow(u.cx, u.cy, probeAng, Math.min(W, H) * 0.22, 0.95);
    x.globalAlpha = 1;
  }

  // ---------- the frame
  let view = null; // the last frame's transform, for clicks and aiming
  function frame(now) {
    const t = now - t0, k = calm.matches ? 1 : 0.08;
    z += (zTo - z) * k; if (Math.abs(zTo - z) < 0.001) z = zTo;
    focus.x += (focusTo.x - focus.x) * k; focus.y += (focusTo.y - focus.y) * k;
    const s = scaleOf(z), vw = W - side(), cx = vw / 2 + pan.x - focus.x * s, cy = H / 2 + pan.y - focus.y * s;
    const to = (mx, my) => [cx + mx * s, cy + my * s], viewMin = Math.min(vw, H);
    const bodyR = (r) => Math.min(viewMin * 0.3 * r / BODY.home, r * s);
    view = { s, cx, cy, bodyR };
    const sa = sun() ? Math.atan2(sun().y, sun().x) : Math.PI * 1.25; // no sun: the old light from the top left
    light = { lx: Math.cos(sa), ly: Math.sin(sa) };
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = x.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.max(W, H) * 0.7);
    bg.addColorStop(0, '#0b1526'); bg.addColorStop(1, '#03050a');
    x.fillStyle = bg; x.fillRect(0, 0, W, H);
    const far = rng(made.seed + 1), n = Math.round(30 + 150 * g()); // more of the sky shows as the world grows
    for (let i = 0; i < 180; i++) {
      const a = 0.08 + far() * 0.18, px = far() * W, py = far() * H;
      if (i < n) { x.fillStyle = `rgba(220,230,255,${a})`; x.fillRect(px, py, 1, 1); }
    }
    const mapA = clamp((z - 0.15) / 0.5), seen = (px, py, r = 4) => px > -r && py > -r && px < W + r && py < H + r;
    if (mapA > 0) {
      x.globalAlpha = mapA;
      x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
      x.drawImage(sky.glow, cx - sky.E * s, cy - sky.E * s, 2 * sky.E * s, 2 * sky.E * s);
      for (const st of sky.stars) {
        const [sx, sy] = to(st.x, st.y);
        if (!seen(sx, sy)) continue;
        x.fillStyle = `rgba(225,235,255,${(0.25 + 0.6 * st.b) * st.l})`;
        const sz = st.b > 0.93 ? 2.2 : st.b > 0.75 ? 1.5 : 1;
        x.fillRect(sx, sy, sz, sz);
      }
      if (sun()) { const [ux, uy] = to(sun().x, sun().y), ur = Math.max(2.5, sun().r * s); if (seen(ux, uy, ur * 3)) drawSun(ux, uy, ur); }
      for (const l of lobes()) if (l.lit < l.bought) { // what the frontier bought and hasn't lit yet: a faint trail ahead
        const o = originOf(l), end = l.tip - l.lit + l.bought;
        const [ax, ay] = to(o.x + Math.cos(l.ang) * l.tip, o.y + Math.sin(l.ang) * l.tip), [bx, by] = to(o.x + Math.cos(l.ang) * end, o.y + Math.sin(l.ang) * end);
        x.strokeStyle = 'rgba(227,171,62,.35)'; x.lineWidth = 1.5; x.setLineDash([3, 7]);
        x.beginPath(); x.moveTo(ax, ay); x.lineTo(bx, by); x.stroke(); x.setLineDash([]);
      }
      for (const m of world.moments ?? []) {
        const [px, py] = to(m.x, m.y);
        if (!seen(px, py, 12)) continue;
        drawMoment(px, py, m, picked === m.id || hover === m.id);
        if ((picked === m.id || hover === m.id) && z > 0.4) label(momentTitle(m), px, py - 14, '#e3e7ed', 12);
      }
      x.globalAlpha = 1;
    }
    const detail = clamp((0.5 - z) / 0.35);
    const [hx, hy] = to(0, 0), hr = bodyR(BODY.home), hp = piecesOn('home'), spin = calm.matches ? 0 : t / 60000;
    if (detail > 0 && sun()) { // close up the sun is off the view: a warm glow at the edge on its side
      const gx = hx + light.lx * viewMin * 0.9, gy = hy + light.ly * viewMin * 0.9, c = SUN[sun().look] ?? SUN.gold;
      const wg = x.createRadialGradient(gx, gy, 0, gx, gy, viewMin * 0.7);
      wg.addColorStop(0, rgba(c, 0.18 * detail)); wg.addColorStop(1, rgba(c, 0));
      x.fillStyle = wg; x.fillRect(0, 0, W, H);
    }
    if (seen(hx, hy, hr * 3.2)) {
      drawHomeFeatures(hx, hy, hr, t, 'far');
      drawBuilt(hx, hy, hr, hp, t, 'back', spin, true);
      drawHome(hx, hy, hr, t, here === 'home' ? detail : 0, lookOf(hp));
      drawHomeFeatures(hx, hy, hr, t, 'near');
      drawBuilt(hx, hy, hr, hp, t, 'ground', spin, true);
      drawBuilt(hx, hy, hr, hp, t, 'front', spin, true);
      drawMascot(hx, hy, hr);
    }
    if (z > 0.5) label('Home', hx, hy - hr - 10, '#e3e7ed', 13);
    for (const p of planets()) {
      const [px, py] = to(p.x, p.y), r = bodyR(BODY.planet), colony = colonyOf(p), pp = colony ? piecesOn(p.id) : [];
      if (!seen(px, py, r * 3.2)) continue;
      drawBuilt(px, py, r, pp, t, 'back', 0, false);
      drawPlanet(px, py, r, p, colony, lookOf(pp), t);
      drawBuilt(px, py, r, pp, t, 'ground', 0, false);
      drawBuilt(px, py, r, pp, t, 'front', 0, false);
      if (z > 0.5 && colony) { label(colony.name, px, py + r + 20, '#e3e7ed', 12.5); label(read.stageName(colony), px, py + r + 35, '#8c96a4', 11); }
      else if (z > 0.5) {
        x.strokeStyle = 'rgba(227,171,62,.6)'; x.setLineDash([3, 4]); x.lineWidth = 1;
        x.beginPath(); x.arc(px, py, r + 7, 0, 7); x.stroke(); x.setLineDash([]);
        label('Bare planet', px, py + r + 20, '#8c96a4', 11.5);
      }
    }
    if (flight && drawRocket(flight, now, to)) land(flight);
    const uA = universeOn() ? clamp((z - zFit() - 0.15) / 0.6) : 0; // past Map, the Universe fades in over it
    if (aimAng != null && z > 0.4 && pushFrom() && uA < 1) { // from the place a push would leave from
      const o = placeOf(pushFrom()), [ox, oy] = to(o.x, o.y);
      drawArrow(ox, oy, aimAng, Math.max(90, Math.min(220, (LOBE_START + PUSH_PX) * s)), aiming ? 0.95 : 0.6);
    }
    if (uA > 0) drawUniverse(uA, t);
    view.uA = uA;
    const name = placeName(here), at = here !== 'home' && colonyOf(placeOf(here) ?? {});
    $('w-where').textContent = uA <= 0.5 && z < 0.3 && at ? `${name} · ${read.stageName(at)}`
      : uA > 0.5 ? 'Universe' : z < 0.3 ? name : z > 0.7 ? 'Map' : `Leaving ${name}`;
    raf = requestAnimationFrame(frame);
  }
  const PUSH_PX = 150; // world.mjs PUSH_LEN: how far a push reaches, for the aiming arrow

  // ---------- zoom, flying, aiming and clicks
  /** The zoom that shows the whole world: 1 is the first map, more is further out. */
  const zFit = () => {
    const vw = (W || 1200) - side(), need = Math.max(MAP * 0.5, extent()) / (Math.min(vw, H || 800) * 0.48);
    return clamp(1 + Math.log(need) / Math.log(ZMAX), 1, 3); // branches off colonies can reach far past the first map
  };
  /** The furthest out: the map, and past it the Universe when there is one to show. */
  const zMax = () => zFit() + (universeOn() ? 1.2 : 0);
  function zoomTo(v) {
    const was = zTo;
    zTo = clamp(v, 0, zMax());
    if (zTo < 0.2 || (was > zFit() + 0.5) !== (zTo > zFit() + 0.5)) pan = { x: 0, y: 0 }; // the Universe and the map pan apart
    for (const b of document.querySelectorAll('.w-zoom [data-place]')) b.classList.toggle('on', zTo < 0.5 && b.dataset.place === here);
    $('w-map').classList.toggle('on', zTo >= 0.5 && zTo <= zFit() + 0.5);
    $('w-universe')?.classList.toggle('on', zTo > zFit() + 0.5);
  }
  function showUniverse() { pan = { x: 0, y: 0 }; zoomTo(zMax()); }
  /** A place you can fly to: Home, or a planet the frontier found (map px). */
  const placeOf = (id) => (id === 'home' ? { x: 0, y: 0 } : planets().find((q) => q.id === id));
  /** A planet's colony, once its rocket has landed. */
  const colonyOf = (p) => (p.colony && flight?.id !== p.id ? p.colony : null);
  const placeName = (id) => { const p = placeOf(id); return id === 'home' ? 'Home' : (p && colonyOf(p)?.name) ?? 'Bare planet'; };
  function flyTo(id) {
    const p = placeOf(id);
    if (!p) return;
    here = id; focusTo = { x: p.x, y: p.y }; pan = { x: 0, y: 0 };
    zoomTo(0);
    if (world) { showBuild(); showRocket(); showPush(); }
    opts.onPlace?.(id);
  }
  function showMap(at = { x: 0, y: 0 }) { focusTo = { ...at }; pan = { x: 0, y: 0 }; zoomTo(zFit()); }
  /** What is under a point on the canvas: a planet, Home, or a moment. */
  function hit(px, py) {
    if (view?.uA > 0.5) { // the Universe: the galaxies you found
      const u = uView(), g = found.find((q) => Math.hypot(u.cx + (q.x - u.me.x) * u.k - px, u.cy + (q.y - u.me.y) * u.k - py) < 32);
      return g ? { galaxy: g } : null;
    }
    if (!view || z < 0.35) return null;
    const { s, cx, cy, bodyR } = view, d = (mx, my) => Math.hypot(cx + mx * s - px, cy + my * s - py);
    for (const p of planets()) if (d(p.x, p.y) < Math.max(12, bodyR(BODY.planet))) return { planet: p.id };
    if (d(0, 0) < Math.max(12, bodyR(BODY.home))) return { planet: 'home' };
    const m = (world.moments ?? []).find((q) => d(q.x, q.y) < 9);
    return m ? { moment: m } : null;
  }
  function aimAt(px, py) {
    if (aiming === 'probe') { const u = uView(); probeAng = Math.atan2(py - u.cy, px - u.cx); showProbe(); return; }
    const { s, cx, cy } = view, o = placeOf(pushFrom() ?? 'home'), ox = cx + o.x * s, oy = cy + o.y * s;
    if (Math.hypot(px - ox, py - oy) < 6 * s) return;
    aimAng = Math.atan2(py - oy, px - ox);
    showPush();
  }
  /** An Enter that only finishes an accent or an input method's word (WebKit says so with keyCode 229). */
  const composing = (e) => e.isComposing || e.keyCode === 229;
  function wire() {
    cv = $('w-canvas'); x = cv.getContext('2d');
    if ($('w-profile')) wireProfile(); // the panel's; the hub's page has no such box
    if ($('w-rail')) {
      personMark = [...($('w-rail-avatar')?.childNodes ?? [])].map((n) => n.cloneNode(true));
      for (const b of $('w-rail').querySelectorAll('[data-card]')) b.onclick = () => openCard(card === b.dataset.card ? null : b.dataset.card);
      for (const b of $('w-side').querySelectorAll('.w-card-x')) b.onclick = () => { const was = railButton(card); openCard(null); was?.focus(); };
    }
    cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomTo(zTo + e.deltaY * 0.0015); }, { passive: false });
    cv.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX - pan.x, y: e.clientY - pan.y, at: [e.clientX, e.clientY], moved: false };
      cv.setPointerCapture(e.pointerId);
      if (aiming) aimAt(e.offsetX, e.offsetY);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) { const h = hit(e.offsetX, e.offsetY); hover = h?.moment?.id ?? (h?.galaxy ? `@${h.galaxy.handle}` : null); cv.style.cursor = aiming ? 'crosshair' : h ? 'pointer' : ''; return; }
      if (Math.hypot(e.clientX - drag.at[0], e.clientY - drag.at[1]) > 4) drag.moved = true;
      if (aiming) aimAt(e.offsetX, e.offsetY);
      else if (z > 0.3) pan = { x: e.clientX - drag.x, y: e.clientY - drag.y };
    });
    cv.addEventListener('pointerup', (e) => {
      const was = drag;
      drag = null;
      if (!was || was.moved || aiming) return;
      const h = hit(e.offsetX, e.offsetY);
      if (h?.planet) flyTo(h.planet);
      else if (h?.moment) pick(h.moment.id);
      else if (h?.galaxy) opts.universe?.visit?.(h.galaxy.handle);
    });
    $('w-home').onclick = () => flyTo('home');
    $('w-map').onclick = () => showMap();
    if ($('w-universe')) $('w-universe').onclick = showUniverse;
    if ($('w-universe-hint')) $('w-universe-hint').onclick = () => openCard('profile');
    if ($('w-probe')) {
      $('w-probe-dir').replaceChildren(new Option('Direction', '', true, true), ...COMPASS.map((c, i) => new Option(c[0].toUpperCase() + c.slice(1), String(i * Math.PI / 4 - Math.PI / 2))));
      $('w-probe-dir').options[0].disabled = true;
      $('w-probe-dir').onchange = () => { probeAng = Number($('w-probe-dir').value); showProbe(); };
      $('w-probe-aim').onclick = () => setAim(aiming === 'probe' ? false : 'probe');
      $('w-probe').onclick = sendProbe;
    }
    new ResizeObserver(() => { if (raf) fit(); }).observe(cv);
    $('w-dir').replaceChildren(new Option('Direction', '', true, true), ...COMPASS.map((c, i) => new Option(c[0].toUpperCase() + c.slice(1), String(i * Math.PI / 4 - Math.PI / 2))));
    $('w-dir').options[0].disabled = true;
    $('w-aim').onclick = () => setAim(aiming === 'push' ? false : 'push');
    $('w-dir').onchange = () => { aimAng = Number($('w-dir').value); showPush(); };
    $('w-push').onclick = push;
    $('w-m-close').onclick = () => pick(null);
    $('w-rocket-name').oninput = showRocket;
    $('w-rocket-name').onkeydown = (e) => { if (e.key === 'Enter' && !composing(e) && !$('w-rocket').disabled) sendRocket(); };
    $('w-rocket-show').onclick = () => flyTo($('w-rocket-to').value);
    $('w-rocket').onclick = sendRocket;
    $('w-build-text').oninput = showBuild;
    $('w-build-text').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !composing(e)) { e.preventDefault(); if (!$('w-build').disabled) build(); } };
    $('w-build').onclick = build;
  }

  // ---------- the side panel: a rail of buttons, each opening one card (what to spend on, moments, today's numbers), and
  // Home's level in a box of its own. One card at a time, or none and the map clear.
  const railButton = (name) => $('w-rail')?.querySelector(`[data-card="${name}"]:not([hidden])`) ?? null;
  function openCard(name) {
    if (!$('w-rail')) return;
    card = name && railButton(name) ? name : null;
    for (const b of $('w-rail').querySelectorAll('[data-card]')) {
      b.classList.toggle('on', b.dataset.card === card);
      b.setAttribute('aria-pressed', String(b.dataset.card === card));
    }
    for (const s of $('w-side').querySelectorAll('.w-card[data-card]')) s.hidden = s.dataset.card !== card;
    if (card && opts.card?.key) try { localStorage.setItem(opts.card.key, card); } catch { /* not remembered, no harm */ }
    if (card === 'probe') checkProbe();
  }
  /** The card a World opens with: the one open last time, else the page's first. */
  function firstCard() {
    let last = null;
    if (opts.card?.key) try { last = localStorage.getItem(opts.card.key); } catch { /* none remembered */ }
    return last && railButton(last) ? last : opts.card?.first ?? null;
  }
  /** A dot on a rail button, `has` something waiting for you or `busy` while it runs, and the same in its name and tooltip. */
  function mark(name, cls, on, note) {
    const b = railButton(name);
    if (!b) return;
    b.dataset.label ??= b.getAttribute('aria-label');
    b.classList.toggle(cls, Boolean(on));
    const label = on ? `${b.dataset.label}: ${note}` : b.dataset.label;
    b.setAttribute('aria-label', label); b.title = label;
  }

  const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  /** Map space has y pointing down, so north is -π/2. */
  const compass = (ang) => COMPASS[Math.round(((ang + Math.PI / 2) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) / (Math.PI / 4)) % 8];
  const dayOf = (d) => { const [y, m, dd] = d.split('-').map(Number); return new Date(y, m - 1, dd); };
  const short = (d) => dayOf(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const momentTitle = (m) => (m.kind === 'week' ? `Week of ${short(m.from)}` : m.kind === 'cleanup' ? `Big cleanup, ${short(m.day)}` : `${m.name}, ${short(m.day)}`);
  function row(name, value) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = name; dd.textContent = value;
    return [dt, dd];
  }
  const can = (price) => (world?.balance ?? 0) >= price;
  /** Aim on the map: a push (`'push'`, on the map) or a probe (`'probe'`, on the Universe), or stop (false). */
  function setAim(on) {
    aiming = on;
    for (const [id, kind] of [['w-aim', 'push'], ['w-probe-aim', 'probe']]) {
      if (!$(id)) continue;
      $(id).classList.toggle('on', on === kind);
      $(id).textContent = on === kind ? 'Done aiming' : 'Aim on the map';
    }
    cv.style.cursor = on ? 'crosshair' : '';
    if (on === 'push') { if (aimAng == null) aimAng = -Math.PI / 4; showMap(); }
    if (on === 'probe') { if (probeAng == null) probeAng = -Math.PI / 4; showUniverse(); }
    showPush();
    showProbe();
  }
  /** Where a push would leave from: the place the map is on, when it is Home or a colony. */
  const pushFrom = () => (here === 'home' || colonyOf(placeOf(here) ?? {}) ? here : null);
  function showPush() {
    if (opts.readOnly) return;
    showPlaces($('w-push-from'));
    const from = pushFrom();
    $('w-push-box').hidden = !from;
    if ($('w-push-none')) $('w-push-none').hidden = Boolean(from);
    if (!from) return;
    $('w-push-text').textContent = `Pick a direction from ${placeName(from)}. The dark lights up that way as you keep working, and it can find a planet.`;
    const price = world.prices?.frontier ?? 0;
    $('w-push-price').textContent = `${fmt(price)} credit`;
    // No direction (none yet, or just pushed) shows the list's placeholder, so any direction can be picked again.
    $('w-dir').value = aimAng == null ? '' : String(COMPASS.indexOf(compass(aimAng)) * Math.PI / 4 - Math.PI / 2);
    const b = $('w-push');
    b.textContent = aimAng == null ? 'Pick a direction' : `Push ${compass(aimAng)}`;
    b.disabled = aimAng == null || !can(price);
    $('w-push-why').hidden = can(price);
    $('w-push-why').textContent = `You have ${fmt(Math.max(0, world.balance))}. Work earns more.`;
  }
  async function push() {
    const from = pushFrom();
    if (aimAng == null || !from) return;
    const b = $('w-push'), err = $('w-push-err');
    b.disabled = true; err.hidden = true;
    const r = await opts.api('/api/world/buy', { kind: 'frontier', ang: aimAng, from });
    if (!r.ok) { err.textContent = r.error || 'That did not go through.'; err.hidden = false; showPush(); return; }
    opts.toast?.(`The frontier is pushed ${compass(aimAng)} from ${placeName(from)}. It lights up that way as you work.`);
    const ang = aimAng, o = placeOf(from);
    aimAng = null;
    setAim(false);
    AgentWorld.update(r.world);
    showMap({ x: o.x + Math.cos(ang) * 90, y: o.y + Math.sin(ang) * 90 });
  }
  /** Send a probe: shown signed in. The hub aims it at the nearest galaxy that way you haven't found; it arrives as you work. */
  let probeAng = null, probing = false;
  function showProbe() {
    const on = universeOn();
    if ($('w-universe')) $('w-universe').hidden = !on;
    if ($('w-universe-hint')) $('w-universe-hint').hidden = on || !opts.universe;
    if (zTo > zMax()) zoomTo(zMax());
    loadFound();
    if (opts.readOnly || !$('w-probe')) return;
    const rail = $('w-rail')?.querySelector('[data-card="probe"]');
    if (rail) rail.hidden = !on;
    if (!on) { if (card === 'probe') openCard(null); return; }
    const mine = myProbes(), flying = mine.filter((q) => !q.to);
    mark('probe', 'has', flying.length, flying.length === 1 ? 'a probe is on its way' : `${flying.length} probes are on their way`);
    const price = world.prices?.probe ?? 0, b = $('w-probe'), nobody = probeReady === false;
    $('w-probe-price').textContent = `${fmt(price)} credit`;
    $('w-probe-dir').value = probeAng == null ? '' : String(COMPASS.indexOf(compass(probeAng)) * Math.PI / 4 - Math.PI / 2);
    b.textContent = probing ? 'Aiming…' : probeAng == null ? 'Pick a direction' : `Send a probe ${compass(probeAng)}`;
    b.disabled = probing || probeAng == null || !can(price) || nobody;
    $('w-probe-why').hidden = can(price);
    $('w-probe-why').textContent = `You have ${fmt(Math.max(0, world.balance))}. Work earns more.`;
    $('w-probe-none').hidden = !(nobody || !mine.length);
    $('w-probe-none').textContent = nobody ? "There's no one new to find yet." : 'Send a probe to find the galaxies around you.';
    const items = [...flying.map((q) => ({ text: `On its way ${compass(q.ang)}, ${Math.floor(q.progress * 100)}% there` })),
      ...found.map((g) => ({ text: `Found @${g.handle}`, visit: g.handle }))];
    $('w-probe-list').hidden = !items.length;
    $('w-probe-list').replaceChildren(...items.map((it) => {
      const li = document.createElement('li');
      if (!it.visit) { li.textContent = it.text; return li; }
      const a = document.createElement('button');
      a.type = 'button'; a.className = 'linkish'; a.textContent = it.text; a.onclick = () => opts.universe.visit(it.visit);
      li.append(a);
      return li;
    }));
  }
  /** Ask whether a probe would find anyone now; an unreachable hub says nothing, and the probe itself will say so. */
  async function checkProbe() {
    if (opts.readOnly || !universeOn()) return;
    const r = await opts.api('/api/world/probe-ready', {});
    probeReady = r?.ok && r.none ? false : true;
    showProbe();
  }
  async function sendProbe() {
    if (probeAng == null || probing) return;
    const err = $('w-probe-err'), ang = probeAng;
    probing = true; err.hidden = true; showProbe();
    const r = await opts.api('/api/world/probe', { ang });
    probing = false;
    if (!r.ok) { err.textContent = r.error || 'That did not go through.'; err.hidden = false; showProbe(); checkProbe(); return; }
    opts.toast?.(`A probe is on its way ${compass(ang)}. It arrives as you keep working.`);
    probeAng = null;
    if (aiming === 'probe') setAim(false);
    AgentWorld.update(r.world);
    showUniverse();
    checkProbe();
  }
  /** Build on the place you are looking at: Home or a colony. Claude takes a few seconds; one build at a time. */
  let buildingOn = null;
  /** The places you can build on or push from, Home first: a chip each in `box`, its dot the planet's colour. */
  function showPlaces(box = $('w-build-on')) {
    if (!box) return;
    const list = [{ id: 'home', name: 'Home', dot: '#4a86c0' },
      ...planets().filter(colonyOf).map((p) => ({ id: p.id, name: p.colony.name, dot: LOOK[p.look]?.[0] ?? '#cfe0ff' }))];
    const sig = list.map((q) => `${q.id}:${q.name}`).join();
    if (sig !== box.dataset.sig) { // rebuilt only when the places change, so focus survives updates
      box.dataset.sig = sig;
      box.replaceChildren(...list.map((q) => {
        const b = document.createElement('button'), dot = document.createElement('i');
        b.type = 'button'; b.className = 'w-place'; b.dataset.place = q.id;
        dot.style.background = q.dot;
        b.append(dot, q.name);
        b.onclick = () => flyTo(q.id);
        return b;
      }));
    }
    for (const b of box.children) { b.classList.toggle('on', b.dataset.place === here); b.setAttribute('aria-pressed', String(b.dataset.place === here)); }
  }
  function showBuild() {
    if (opts.readOnly) return;
    showPlaces();
    mark('build', 'busy', buildingOn, `building on ${placeName(buildingOn)}`);
    const box = $('w-build-box'), p = placeOf(here), yours = here === 'home' || (p && colonyOf(p));
    box.hidden = !yours;
    if ($('w-build-none')) $('w-build-none').hidden = Boolean(yours);
    if (!yours) return;
    $('w-build-title').textContent = 'Build';
    const price = world.prices?.build ?? 0, b = $('w-build'), text = $('w-build-text');
    $('w-build-price').textContent = `${fmt(price)} credit`;
    b.textContent = buildingOn ? `Building on ${placeName(buildingOn)}…` : `Build on ${placeName(here)}`;
    b.disabled = Boolean(buildingOn) || !text.value.trim() || !can(price);
    text.disabled = Boolean(buildingOn);
    $('w-build-why').hidden = can(price);
    $('w-build-why').textContent = `You have ${fmt(Math.max(0, world.balance))}. Work earns more.`;
    const done = (world.builds ?? []).filter((d) => d.on === here);
    $('w-built').hidden = !done.length;
    $('w-built').replaceChildren(...done.slice(-4).reverse().map((d) => { const li = document.createElement('li'); li.textContent = d.caption; return li; }));
  }
  async function build() {
    const on = here, err = $('w-build-err');
    buildingOn = on; err.hidden = true; showBuild();
    const r = await opts.api('/api/world/build', { on, description: $('w-build-text').value });
    buildingOn = null;
    if (!r.ok) { err.textContent = r.error || 'That did not go through.'; err.hidden = false; showBuild(); return; }
    $('w-build-text').value = '';
    opts.toast?.(`Built on ${placeName(on)}: ${r.caption}`);
    AgentWorld.update(r.world);
    if (here !== on || zTo > 0.3) flyTo(on);
  }
  /** Send a rocket: shown while the frontier has found a planet nobody lives on. */
  function showRocket() {
    if (opts.readOnly) return;
    const list = planets().filter((p) => !p.colony), box = $('w-rocket-box');
    box.hidden = !list.length;
    if ($('w-rocket-none')) $('w-rocket-none').hidden = list.length > 0;
    mark('rocket', 'has', list.length, list.length === 1 ? 'a bare planet is waiting' : `${list.length} bare planets are waiting`);
    if (!list.length) return;
    const sel = $('w-rocket-to'), sig = list.map((p) => p.id).join();
    if (sig !== rocketSig) { // rebuilt only when the planets change, so an open list stays open
      rocketSig = sig;
      const seenAs = {}, keep = sel.value;
      sel.replaceChildren(...list.map((p) => {
        const dir = compass(Math.atan2(p.y, p.x)), n = (seenAs[dir] = (seenAs[dir] ?? 0) + 1);
        return new Option(`Bare planet, ${dir}${n > 1 ? ` ${n}` : ''}`, p.id);
      }));
      sel.value = list.some((p) => p.id === keep) ? keep : list[0].id;
    }
    if (here !== rocketHere) { // flying to a bare planet picks it; otherwise the list keeps what you picked
      rocketHere = here;
      if (list.some((p) => p.id === here)) sel.value = here;
    }
    $('w-rocket-text').textContent = list.length === 1 ? 'The frontier found a bare planet. A rocket lands a colony there, and you name it.'
      : `The frontier found ${list.length} bare planets. A rocket lands a colony on one, and you name it.`;
    const price = world.prices?.rocket ?? 0;
    $('w-rocket-price').textContent = `${fmt(price)} credit`;
    $('w-rocket').disabled = sending || !$('w-rocket-name').value.trim() || !can(price);
    $('w-rocket-why').hidden = can(price);
    $('w-rocket-why').textContent = `You have ${fmt(Math.max(0, world.balance))}. Work earns more.`;
  }
  /** The set piece: the view pulls out, the rocket flies from where you are to the planet, and the view flies in to the
   *  new colony. With reduced motion it goes straight there. */
  async function sendRocket() {
    const id = $('w-rocket-to').value, err = $('w-rocket-err');
    sending = true; err.hidden = true; showRocket();
    const r = await opts.api('/api/world/buy', { kind: 'rocket', planet: id, name: $('w-rocket-name').value });
    sending = false;
    if (!r.ok) { err.textContent = r.error || 'That did not go through.'; err.hidden = false; showRocket(); return; }
    $('w-rocket-name').value = '';
    // It lifts off from where you are when people live there (Home or a colony), else from Home.
    const p = r.world.planets.find((q) => q.id === id), at = placeOf(here);
    const from = here !== id && (here === 'home' || (at && colonyOf(at))) ? at : { x: 0, y: 0 };
    if (calm.matches || !p) { AgentWorld.update(r.world); land({ id, name: p?.colony?.name ?? 'The colony' }); return; }
    flight = { id, name: p.colony.name, from: { x: from.x, y: from.y }, to: { x: p.x, y: p.y }, at: performance.now() + 1100 };
    AgentWorld.update(r.world);
    showMap({ x: (from.x + p.x) / 2, y: (from.y + p.y) / 2 });
  }
  function land(f) {
    flight = null;
    showColonies();
    opts.toast?.(`The rocket landed. ${f.name} is your colony now.`);
    if (calm.matches) flyTo(f.id); else setTimeout(() => { if (raf) flyTo(f.id); }, 500);
  }
  /** The zoom bar: Home, each colony, the map. */
  function showColonies() {
    const list = planets().filter(colonyOf), sig = list.map((p) => `${p.id}:${p.colony.name}:${read.stageName(p.colony)}`).join();
    if (sig === coloniesSig) return;
    coloniesSig = sig;
    $('w-colonies').replaceChildren(...list.map((p) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small'; b.dataset.place = p.id; b.textContent = p.colony.name; b.title = `${p.colony.name}, ${read.stageName(p.colony)}`;
      b.onclick = () => flyTo(p.id);
      return b;
    }));
    zoomTo(zTo);
  }
  function pick(id) {
    picked = id;
    const m = (world.moments ?? []).find((q) => q.id === id), box = $('w-moment');
    box.hidden = !m;
    if (!m) return;
    openCard('moments');
    if (z < 0.5) showMap({ x: m.x, y: m.y }); else focusTo = { x: m.x, y: m.y };
    $('w-m-name').textContent = momentTitle(m);
    const i = m.info;
    if (!i) { // a system's public projection keeps when a moment was, never its numbers
      $('w-m-when').textContent = m.kind === 'week' ? `${short(m.from)} to ${short(m.day)}.` : m.kind === 'cleanup' ? 'A day that removed more than it added.' : 'Home reached a new level.';
      $('w-m-info').replaceChildren();
      return;
    }
    $('w-m-when').textContent = m.kind === 'week' ? `${short(m.from)} to ${short(m.day)}, ${i.days} day${i.days === 1 ? '' : 's'} worked.`
      : m.kind === 'cleanup' ? 'A day that removed more than it added.' : `Home reached level ${i.level}.`;
    $('w-m-info').replaceChildren(...(m.kind === 'level' ? row('XP', fmt(i.xp)) : [
      ...(m.kind === 'week' ? row('Commits', fmt(i.commits)) : []),
      ...row('Lines written', '+' + fmt(i.added)),
      ...row('Lines removed', `−${fmt(i.removed)}`),
      ...row('Credit earned', fmt(i.credit))]));
  }
  function showMoments(list) {
    $('w-moments-box').hidden = !list.length;
    if ($('w-moments-none')) $('w-moments-none').hidden = list.length > 0;
    $('w-moments-n').textContent = list.length ? String(list.length) : '';
    const newest = list.slice(-6).reverse(), sig = newest.map((m) => m.id).join();
    if (sig === momentsSig) return; // rebuilt only when they change, so focus and clicks survive updates
    momentsSig = sig;
    $('w-moments').replaceChildren(...newest.map((m) => {
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button'; b.className = 'linkish'; b.dataset.kind = m.kind; b.textContent = momentTitle(m);
      b.onclick = () => pick(m.id);
      li.append(b);
      return li;
    }));
  }
  function show(w) {
    const h = w.home ?? { xp: 0, today: 0, level: 1, stage: 'Bare rock', at: 0, next: null }, pct = (v) => Math.round(Math.min(1, v) * 100);
    $('w-level').textContent = `Level ${h.level}`;
    $('w-stage').textContent = h.stage;
    // A system's public projection has a level and a stage but no XP: the XP, its bar and the next level hide.
    const xp = h.xp ?? h.at ?? 0;
    $('w-xp').hidden = $('w-bar').parentElement.hidden = $('w-next').hidden = h.xp == null;
    $('w-xp').textContent = h.next ? `${fmt(xp)} / ${fmt(h.next.at)} XP` : `${fmt(xp)} XP`;
    $('w-bar').style.width = pct(h.next ? (xp - (h.at ?? 0)) / (h.next.at - (h.at ?? 0)) : 1) + '%';
    $('w-next').textContent = h.next ? `${h.stage} → ${h.next.name}` : `${h.stage}, the top level`;
    $('w-xp-today').hidden = $('w-bar-today').parentElement.hidden = h.today == null;
    $('w-xp-today').textContent = `+${fmt(h.today ?? 0)} today`;
    $('w-xp-today').title = `+${fmt(h.today ?? 0)} XP today. A day's XP is a third of its credit: a typical full working day gives about 85.`;
    $('w-bar-today').style.width = pct((h.today ?? 0) / 100) + '%';
    $('w-credit').textContent = fmt(Math.max(0, w.balance ?? 0));
    if (!opts.readOnly) { // today's numbers, the totals and the notes are the owner's alone
      const t = w.today;
      $('w-today').replaceChildren(...read.todayRows(t).flatMap(([name, value]) => row(name, value)));
      const since = new Date(w.startedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
      $('w-total').textContent = w.earned > 0 ? `${fmt(w.earned)} credit earned since ${since}, ${fmt(w.spent ?? 0)} spent.`
        : `Your world started on ${since} as a bare rock. Each day you work gives Home XP, and it levels up.`;
      const names = (list) => (list ?? []).map((r) => r.split('/').filter(Boolean).at(-1)).join(', ');
      const notes = [];
      if (w.noEmail?.length) notes.push(`No commits counted in ${names(w.noEmail)}: git has no user.email there.`);
      if (w.gitFailed?.length) notes.push(`Commits in ${names(w.gitFailed)} couldn't be read this time: git didn't answer in time. What was counted stays.`);
      $('w-noemail').hidden = !notes.length;
      $('w-noemail').textContent = notes.join(' ');
      showDays(w);
    }
    showPush();
    showProbe();
    showBuild();
    showRocket();
    showColonies();
    showMoments(w.moments ?? []);
    if (picked && !(w.moments ?? []).some((m) => m.id === picked)) pick(null);
  }

  // ---------- Profile's days: the last 100 as the galaxy page's mosaic draws them (hub/public/hub.js daysMosaic, copied),
  // amber for a day with work, and the line of stats above. The Mac knows its own days, signed in or not.
  function hashOf(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return h >>> 0;
  }
  const pickOf = (s, list) => list[hashOf(s) % list.length];
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many}`;
  function daysMosaic(worked) {
    const had = new Set(worked), now = new Date(), grid = document.createElement('div');
    grid.className = 'mosaic'; grid.setAttribute('aria-hidden', 'true'); grid.style.setProperty('--cols', '20');
    let count = 0;
    for (let back = 99; back >= 0; back--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
      const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const lit = had.has(k), cell = document.createElement('span');
      if (lit) count++;
      cell.className = pickOf(k, lit ? ['a0', 'a0', 'a1', 'a2'] : ['q1', 'q1', 'q2', 'q2', 'q3', 'q4']);
      grid.append(cell);
    }
    const box = document.createElement('div'), cap = document.createElement('div'), a = document.createElement('span'), b = document.createElement('span');
    box.className = 'days'; cap.className = 'cap';
    a.textContent = 'Last 100 days'; b.textContent = `${plural(count, 'day', 'days')} with work`;
    cap.append(a, b); box.append(grid, cap);
    return box;
  }
  function showDays(w) {
    if (!$('w-pf-days')) return;
    const colonies = planets().filter(colonyOf).length, builds = (w.builds ?? []).length;
    const since = new Date(w.startedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    $('w-pf-stats').textContent = `Active ${plural(w.daysActive ?? 0, 'day', 'days')} · ${plural(colonies, 'colony', 'colonies')} · ${plural(builds, 'build', 'builds')} · World since ${since}`;
    const worked = w.worked ?? [], sig = `${new Date().toDateString()}|${worked.join()}`;
    if (sig === daysSig) return; // redrawn when a day is added, or the date turns
    daysSig = sig;
    $('w-pf-days').replaceChildren(daysMosaic(worked));
  }

  // ---------- Profile: the hub account, or the way to sign in to one. The page passes the hub's state with each summary;
  // the sign-in itself is the server's (it polls the hub), so this only starts it, shows the code, and follows the snapshots.
  let hubNow = null, orderBase = null, loginCancelled = false, personMark = [];
  const ago = (t) => {
    const s = Math.max(0, (Date.now() - t) / 1000);
    return s < 60 ? 'just now' : s < 3600 ? `${Math.floor(s / 60)} min ago` : s < 172_800 ? `${Math.floor(s / 3600)} h ago` : `${Math.floor(s / 86_400)} days ago`;
  };
  const AVATARS = 'https://avatars.githubusercontent.com/';
  const web = (u) => (/^https?:\/\//.test(String(u)) ? String(u) : null);
  function avatarOf(a) {
    const label = a.name || a.handle || '?', words = label.trim().split(/\s+/), cls = 'avatar';
    if (typeof a.avatar === 'string' && a.avatar.startsWith(AVATARS)) {
      const img = document.createElement('img');
      img.className = cls; img.src = a.avatar; img.alt = ''; img.referrerPolicy = 'no-referrer';
      return img;
    }
    const s = document.createElement('span');
    s.className = cls; s.setAttribute('aria-hidden', 'true');
    s.textContent = (words.length > 1 ? words[0][0] + words[1][0] : label.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 2) || '?').toUpperCase();
    return s;
  }
  /** What an order from the site is doing, in the words the panel's own buttons use. */
  function orderText(o) {
    if (o.kind === 'build') return `build on ${placeName(o.on)}`;
    if (o.kind === 'frontier') return 'push the frontier';
    const p = placeOf(o.planet);
    return p ? `rocket to the bare planet, ${compass(Math.atan2(p.y, p.x))}` : 'send a rocket';
  }
  /** Fill the Profile box from the hub's state (`before` is the summary it replaces, for telling whether an order did anything). */
  function showHub(h, before = world) {
    if (!$('w-profile') || opts.readOnly || !h) return;
    const was = hubNow, toast = (t, bad) => opts.toast?.(t, bad);
    hubNow = h;
    $('w-pf-in').hidden = !h.loggedIn;
    $('w-pf-out').hidden = h.loggedIn;
    const err = $('w-pf-err');
    if (h.loggedIn && h.account) {
      const a = h.account, base = String(h.url ?? '').replace(/\/+$/, ''), sig = `${a.avatar}|${a.name}|${a.handle}`;
      err.hidden = true;
      if ($('w-pf-avatar')._sig !== sig) { $('w-pf-avatar')._sig = sig; $('w-pf-avatar').replaceChildren(avatarOf(a)); }
      if ($('w-rail-avatar') && $('w-rail-avatar')._sig !== sig) { $('w-rail-avatar')._sig = sig; $('w-rail-avatar').replaceChildren(avatarOf(a)); }
      $('w-pf-handle').textContent = a.name || `@${a.handle}`;
      $('w-pf-xy').textContent = `${a.name ? `@${a.handle} · ` : ''}${a.x}, ${a.y}`.replaceAll('-', '−');
      const page = $('w-pf-page'), edit = $('w-pf-edit');
      page.hidden = edit.hidden = !web(base);
      page.href = `${base}/@${encodeURIComponent(a.handle)}`; edit.href = `${base}/me`;
      const s = h.sync ?? {};
      $('w-pf-sync').textContent = s.lastError ? s.lastError + (s.lastOk ? ` Last synced ${ago(s.lastOk)}.` : '')
        : s.lastOk ? `Synced ${ago(s.lastOk)}` : 'Not synced yet';
      const cur = h.orders?.current ?? null;
      $('w-pf-order').hidden = !cur;
      if (cur) $('w-pf-order').textContent = `Running an order from the site: ${orderText(cur)}…`;
    } else {
      const r = $('w-rail-avatar');
      if (r?._sig) { r._sig = null; r.replaceChildren(...personMark.map((n) => n.cloneNode(true))); } // signed out: the page's person mark
      const p = h.pending, live = Boolean(p);
      $('w-pf-start').hidden = live; $('w-pf-wait').hidden = !live;
      if (live) {
        err.hidden = true; loginCancelled = false;
        $('w-pf-code').textContent = p.userCode;
        const link = $('w-pf-link'), href = web(p.verificationUri);
        link.textContent = href ? href.replace(/^https?:\/\//, '').replace(/\?.*$/, '') : '';
        if (href) link.href = href; else link.removeAttribute('href');
      } else if (was?.pending && !was.loggedIn && !loginCancelled) {
        err.textContent = "The sign-in didn't complete. Try again."; err.hidden = false;
      }
    }
    mark('profile', 'busy', h.loggedIn && h.orders?.current, 'running an order from the site');
    if (!was) { orderBase = h.orders?.current ? { n: before?.builds?.length ?? 0, spent: before?.spent ?? 0 } : null; return; } // the first sight raises nothing
    if (h.loggedIn && !was.loggedIn) toast(`Signed in as @${h.account?.handle}`);
    const e = h.sync?.lastError ?? null, wasE = was.sync?.lastError ?? null;
    if (h.loggedIn && was.loggedIn && e && e !== wasE) toast(e, true);
    else if (h.loggedIn && was.loggedIn && !e && wasE) toast('Hub in sync again');
    // An order from the site lands when it stops being the current one; the summary says whether it did anything.
    const cur = h.loggedIn ? h.orders?.current : null;
    if (cur && !orderBase) orderBase = { n: before?.builds?.length ?? 0, spent: before?.spent ?? 0 };
    if (!cur && orderBase) {
      const b = orderBase;
      orderBase = null;
      if (was.orders?.current && h.loggedIn) {
        const builds = world?.builds ?? [];
        if (builds.length > b.n) toast(`Built from the site: ${builds.at(-1).caption}`);
        else if ((world?.spent ?? 0) !== b.spent) toast("The site's order landed");
      }
    }
  }
  function wireProfile() {
    const call = (id, path, then) => {
      const b = $(id);
      b.onclick = async () => {
        b.disabled = true;
        const r = await opts.api(path, {});
        b.disabled = false;
        then(r);
      };
    };
    const say = (r) => { $('w-pf-err').textContent = r.error || 'That did not go through.'; $('w-pf-err').hidden = false; };
    call('w-pf-login', '/api/hub/login/start', (r) => {
      $('w-pf-err').hidden = true;
      if (!r.ok) return say(r);
      loginCancelled = false;
      if (hubNow) showHub({ ...hubNow, loggedIn: false, pending: { userCode: r.userCode, verificationUri: r.verificationUri } });
    });
    $('w-pf-cancel').onclick = async () => {
      loginCancelled = true;
      const r = await opts.api('/api/hub/login/cancel', {});
      if (r.ok === false) return say(r);
      if (hubNow) showHub({ ...hubNow, pending: null });
    };
    call('w-pf-logout', '/api/hub/logout', (r) => {
      if (!r.ok) return opts.toast?.(r.error || 'Could not sign out.', true);
      opts.toast?.('Signed out');
      if (hubNow) showHub({ ...hubNow, loggedIn: false, account: null, pending: null });
    });
  }

  window.AgentWorld = {
    enter(summary, options = {}) {
      opts = options;
      hubNow = null; orderBase = null; loginCancelled = false;
      document.body.classList.toggle('w-readonly', Boolean(opts.readOnly)); // a system shown read-only: nothing to spend
      if (!cv) wire();
      world = summary;
      if (made?.seed !== (summary.seed ?? 1)) { made = make(summary.seed ?? 1); sky = null; }
      paint();
      here = 'home'; flight = null; focus = { x: 0, y: 0 }; focusTo = { x: 0, y: 0 };
      show(summary);
      showHub(opts.hub);
      found = []; foundSig = null; foundRetry = 0; flying = new Set(); landed = []; probeReady = null; probeAng = null;
      showProbe(); // the Universe and the Probe card follow the account the hub says is signed in
      if (opts.card) openCard(firstCard());
      fit();
      zoomTo(0); z = 0; pan = { x: 0, y: 0 };
      t0 = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    },
    update(summary, hub) {
      if (!raf || !summary || summary.started === false) return; // a system's public projection has no `started`
      const before = world;
      world = summary;
      paint();
      show(summary);
      showHub(hub, before);
      showProbe();
      opts.onPlace?.(here); // the place may have changed underneath: a bare planet the map is on can be a colony now
    },
    exit() { cancelAnimationFrame(raf); raf = 0; drag = null; flight = null; if (aiming) setAim(false); document.body.classList.remove('w-readonly'); },
    /** Fly to a place: 'home' or a planet's id (the galaxy page's build chips use it). */
    flyTo(id) { if (raf) flyTo(id); },
    /** Where a point on the map (map px, Home at 0,0) is on the canvas now. */
    at(mx, my) { return view ? [view.cx + mx * view.s, view.cy + my * view.s] : null; },
    /** The pure readers above (today's line, a colony's stage...), for the pages around it and the tests. */
    read,
  };
})();
