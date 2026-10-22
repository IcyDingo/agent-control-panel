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
  const MAP = 900, ZMAX = 40, scaleOf = (v) => Math.pow(ZMAX, 1 - v); // the map spans MAP px zoomed out, ×40 close up
  const LOBE_START = 60, lobeRadius = (along, tip) => 34 + 26 * along / (tip + 40); // world.mjs's lobe shape
  const BODY = { home: 6, planet: 4.5 }; // radius on the map, map px
  const LOOK = { rust: ['#d9a27f', '#8a4f33', '#2a1712'], ice: ['#dbe8f2', '#7f9fb8', '#1d2a36'], sand: ['#e6d3a3', '#a68a55', '#2e2516'],
    violet: ['#c9b3e0', '#6e5590', '#1f1730'] };
  const MOMENT = { week: '#cfe0ff', cleanup: '#7ee0a8', level: '#ffcf7a' };
  const SUN = { gold: '#ffd27a', white: '#eef2ff', orange: '#ffa65c', blue: '#bcd3ff' };
  /** world.mjs LEVELS' XP: a public projection of a system has a level but no XP, so Home is drawn at its level's start. */
  const LEVEL_XP = [0, 15, 100, 300, 500, 800, 1200, 1600, 2000, 2600, 3300, 4000];
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
  const days = () => (world?.home?.xp ?? LEVEL_XP[(world?.home?.level ?? 1) - 1] ?? 0) / 100; // in full days' work: Home's stages below are drawn on that scale
  /** 0 before day `a`, 1 from day `b`, linear between: each stage eases in over the days before it is named. */
  const ramp = (a, b) => clamp((days() - a) / (b - a));
  const g = () => Math.sqrt(Math.min(1, days() / 40)); // how far the lit map reaches: quick at first, all of it at the ladder's top
  const reach = () => world?.reach ?? 46;
  const lobes = () => world?.frontier ?? [];
  const planets = () => world?.planets ?? [];
  function lit(mx, my) {
    let best = 1 - Math.hypot(mx, my) / reach();
    for (const l of lobes()) {
      const ux = Math.cos(l.ang), uy = Math.sin(l.ang), along = clamp(mx * ux + my * uy, 0, l.tip);
      best = Math.max(best, 1 - Math.hypot(mx - ux * along, my - uy * along) / lobeRadius(along, l.tip));
    }
    if (sun()) best = Math.max(best, 1 - Math.hypot(mx - sun().x, my - sun().y) / 70); // the sun's own glow
    return clamp(best * 1.6);
  }
  /** How far the world reaches from Home (map px): the light, the sun, what the frontier bought, the planets it found. */
  const extent = () => Math.max(reach() * 1.15, ...(sun() ? [Math.hypot(sun().x, sun().y) + 70] : []),
    ...lobes().map((l) => LOBE_START + l.bought + 60), ...planets().map((p) => Math.hypot(p.x, p.y) + 30));
  /** The light and the stars in it, drawn again only when the world changes, sampled small and drawn up smoothly so
   *  its edge is soft. */
  function paint() {
    const sig = JSON.stringify([world?.reach, world?.sun, lobes(), planets().map((p) => p.id)]);
    if (sky && sig === skySig) return;
    skySig = sig;
    const E = extent(), n = 128, c = document.createElement('canvas');
    c.width = c.height = n;
    const gx = c.getContext('2d');
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const l = lit(((i + 0.5) / n - 0.5) * 2 * E, ((j + 0.5) / n - 0.5) * 2 * E);
      if (l > 0) { gx.fillStyle = `rgba(36,62,110,${0.45 * l})`; gx.fillRect(i, j, 1, 1); }
    }
    sky = { E, glow: c, stars: made.stars.map((s) => ({ ...s, l: lit(s.x, s.y) })).filter((s) => s.l > 0.02) };
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
      const a = (calm.matches ? 0 : t / 30000) - 0.6, mx = cx + Math.cos(a) * R * 1.75, my = cy + Math.sin(a) * R * 0.55;
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
  /** The mascot: a small astronaut standing on Home's north pole and waving, the same figure the hub's landing shows
   *  (hub/public/hub.js MASCOT, 40 by 48 units). About half of Home's radius tall, and not drawn when Home is small. */
  function drawMascot(cx, cy, R) {
    if (R < 28) return;
    const u = clamp(R * 0.012, 0.45, 1.4), FG = '#e3e7ed', DIM = '#8c96a4', AMBER = '#e3ab3e';
    const rr = (px, py, w, h, r, fill) => {
      x.fillStyle = fill; x.beginPath();
      if (x.roundRect) x.roundRect(px, py, w, h, r); else x.rect(px, py, w, h);
      x.fill();
    };
    x.save(); x.translate(cx - 20 * u, cy - R - 46.5 * u); x.scale(u, u);
    rr(7, 24, 7, 13, 2.5, DIM); // backpack
    x.save(); x.translate(29, 28); x.rotate(-35 * Math.PI / 180); x.translate(-29, -28); rr(27, 17, 4.5, 11, 2.25, FG); x.restore(); // the waving arm
    rr(13.5, 36, 5.5, 10, 2.5, FG); rr(21, 36, 5.5, 10, 2.5, FG); // legs
    rr(13, 43, 6.5, 3.5, 1.5, DIM); rr(20.5, 43, 6.5, 3.5, 1.5, DIM); // boots
    rr(12, 23, 16, 15, 5, FG); // body
    rr(9, 25, 4.5, 11, 2.25, FG); // the other arm
    x.fillStyle = FG; x.beginPath(); x.arc(20, 13, 11, 0, 7); x.fill(); // helmet
    x.fillStyle = '#0d0f12'; x.beginPath(); x.arc(21, 13.5, 7, 0, 7); x.fill(); // visor
    x.fillStyle = AMBER; x.globalAlpha = 0.95; x.beginPath(); x.ellipse(18.5, 10.5, 2.6, 1.6, 0, 0, 7); x.fill(); x.globalAlpha = 1; // its glint
    rr(19.4, 0.5, 1.2, 3, 0, DIM); x.fillStyle = AMBER; x.beginPath(); x.arc(20, 1.2, 1.4, 0, 7); x.fill(); // antenna
    x.restore();
  }
  const idSeed = (id) => [...id].reduce((h, ch) => h * 31 + ch.charCodeAt(0), made.seed) | 0;
  /** A planet the frontier found: a bare world in its own colours, with craters. A colony on it adds a warm air and
   *  domes lit from inside. */
  function drawPlanet(cx, cy, R, p, colony, look = {}) {
    if (colony) {
      const a = x.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.2);
      a.addColorStop(0, 'rgba(240,180,120,.3)'); a.addColorStop(1, 'rgba(240,180,120,0)');
      x.fillStyle = a; x.beginPath(); x.arc(cx, cy, R * 1.2, 0, 7); x.fill();
    }
    const [c0, c1, c2] = look.land ? [mix(look.land, '#ffffff', 0.35), look.land, mix(look.land, '#000000', 0.8)] : LOOK[p.look] ?? LOOK.rust;
    const gr = x.createRadialGradient(cx + light.lx * R * 0.35, cy + light.ly * R * 0.35, 0, cx, cy, R);
    gr.addColorStop(0, c0); gr.addColorStop(0.6, c1); gr.addColorStop(1, c2);
    x.fillStyle = gr; x.beginPath(); x.arc(cx, cy, R, 0, 7); x.fill();
    if (R > 12) {
      const r = rng(idSeed(p.id));
      x.save(); x.beginPath(); x.arc(cx, cy, R, 0, 7); x.clip();
      for (let i = 0; i < 14; i++) { x.fillStyle = 'rgba(20,14,10,.28)'; x.beginPath(); x.arc(cx + (r() - 0.5) * 1.8 * R, cy + (r() - 0.5) * 1.8 * R, R * (0.03 + r() * 0.07), 0, 7); x.fill(); }
      if (colony) {
        const d = rng(idSeed(p.id) + 5), u = Math.max(1.5, R / 110);
        for (let i = 0; i < 7; i++) {
          const dx = cx + (d() - 0.6) * R * 0.9, dy = cy + (d() - 0.3) * R * 0.8, dr = R * (0.05 + d() * 0.06);
          x.fillStyle = 'rgba(190,225,255,.38)'; x.beginPath(); x.ellipse(dx, dy, dr * 1.4, dr, 0, Math.PI, 2 * Math.PI); x.fill();
          x.fillStyle = 'rgba(255,205,120,.9)'; x.fillRect(dx - u / 2, dy - u * 1.4, u, u);
        }
      }
      x.restore();
    } else if (colony) { x.fillStyle = 'rgba(255,205,120,.95)'; x.fillRect(cx + R * 0.15, cy - R * 0.2, 1.5, 1.5); }
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
  /** The sun Home orbits: a corona, its disc, and six faint rays turning slowly. */
  function drawSun(px, py, r, t) {
    const c = SUN[sun().look] ?? SUN.gold, g = x.createRadialGradient(px, py, r, px, py, 3 * r), spin = calm.matches ? 0 : t / 20000;
    g.addColorStop(0, rgba(c, 0.35)); g.addColorStop(1, rgba(c, 0));
    x.fillStyle = g; x.beginPath(); x.arc(px, py, 3 * r, 0, 7); x.fill();
    x.strokeStyle = rgba(c, 0.18); x.lineWidth = 1; x.beginPath();
    for (let i = 0; i < 6; i++) { const a = spin + i * Math.PI / 3; x.moveTo(px + Math.cos(a) * r, py + Math.sin(a) * r); x.lineTo(px + Math.cos(a) * 2.2 * r, py + Math.sin(a) * 2.2 * r); }
    x.stroke();
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
  /** The direction a push would take, from Home: dashed, with an arrowhead. */
  function drawArrow(hx, hy, ang, len, a) {
    const ex = hx + Math.cos(ang) * len, ey = hy + Math.sin(ang) * len;
    x.strokeStyle = `rgba(227,171,62,${a})`; x.fillStyle = `rgba(227,171,62,${a})`; x.lineWidth = 2; x.setLineDash([6, 6]);
    x.beginPath(); x.moveTo(hx + Math.cos(ang) * 14, hy + Math.sin(ang) * 14); x.lineTo(ex, ey); x.stroke(); x.setLineDash([]);
    x.beginPath(); x.moveTo(ex + Math.cos(ang) * 10, ey + Math.sin(ang) * 10);
    x.lineTo(ex + Math.cos(ang + 2.5) * 9, ey + Math.sin(ang + 2.5) * 9); x.lineTo(ex + Math.cos(ang - 2.5) * 9, ey + Math.sin(ang - 2.5) * 9); x.fill();
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
      if (sun()) { const [ux, uy] = to(sun().x, sun().y), ur = Math.max(2.5, sun().r * s); if (seen(ux, uy, ur * 3)) drawSun(ux, uy, ur, t); }
      for (const l of lobes()) if (l.lit < l.bought) { // what the frontier bought and hasn't lit yet: a faint trail ahead
        const [ax, ay] = to(Math.cos(l.ang) * l.tip, Math.sin(l.ang) * l.tip), [bx, by] = to(Math.cos(l.ang) * (LOBE_START + l.bought), Math.sin(l.ang) * (LOBE_START + l.bought));
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
      drawBuilt(hx, hy, hr, hp, t, 'back', spin, true);
      drawHome(hx, hy, hr, t, here === 'home' ? detail : 0, lookOf(hp));
      drawBuilt(hx, hy, hr, hp, t, 'ground', spin, true);
      drawBuilt(hx, hy, hr, hp, t, 'front', spin, true);
      drawMascot(hx, hy, hr);
    }
    if (z > 0.5) label('Home', hx, hy - hr - 10, '#e3e7ed', 13);
    for (const p of planets()) {
      const [px, py] = to(p.x, p.y), r = bodyR(BODY.planet), colony = colonyOf(p), pp = colony ? piecesOn(p.id) : [];
      if (!seen(px, py, r * 3.2)) continue;
      drawBuilt(px, py, r, pp, t, 'back', 0, false);
      drawPlanet(px, py, r, p, colony, lookOf(pp));
      drawBuilt(px, py, r, pp, t, 'ground', 0, false);
      drawBuilt(px, py, r, pp, t, 'front', 0, false);
      if (z > 0.5 && colony) label(colony.name, px, py + r + 20, '#e3e7ed', 12.5);
      else if (z > 0.5) {
        x.strokeStyle = 'rgba(227,171,62,.6)'; x.setLineDash([3, 4]); x.lineWidth = 1;
        x.beginPath(); x.arc(px, py, r + 7, 0, 7); x.stroke(); x.setLineDash([]);
        label('Bare planet', px, py + r + 20, '#8c96a4', 11.5);
      }
    }
    if (flight && drawRocket(flight, now, to)) land(flight);
    if (aimAng != null && z > 0.4) drawArrow(hx, hy, aimAng, Math.max(90, Math.min(220, (LOBE_START + PUSH_PX) * s)), aiming ? 0.95 : 0.6);
    const name = placeName(here);
    $('w-where').textContent = z < 0.3 ? name : z > 0.7 ? 'Map' : `Leaving ${name}`;
    raf = requestAnimationFrame(frame);
  }
  const PUSH_PX = 150; // world.mjs PUSH_LEN: how far a push reaches, for the aiming arrow

  // ---------- zoom, flying, aiming and clicks
  /** The zoom that shows the whole world: 1 is the first map, more is further out. */
  const zFit = () => {
    const vw = (W || 1200) - side(), need = Math.max(MAP * 0.5, extent()) / (Math.min(vw, H || 800) * 0.48);
    return clamp(1 + Math.log(need) / Math.log(ZMAX), 1, 1.8);
  };
  function zoomTo(v) {
    zTo = clamp(v, 0, zFit());
    if (zTo < 0.2) pan = { x: 0, y: 0 };
    for (const b of document.querySelectorAll('.w-zoom [data-place]')) b.classList.toggle('on', zTo < 0.5 && b.dataset.place === here);
    $('w-map').classList.toggle('on', zTo >= 0.5);
  }
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
    if (world) { showBuild(); showRocket(); }
  }
  function showMap(at = { x: 0, y: 0 }) { focusTo = { ...at }; pan = { x: 0, y: 0 }; zoomTo(zFit()); }
  /** What is under a point on the canvas: a planet, Home, or a moment. */
  function hit(px, py) {
    if (!view || z < 0.35) return null;
    const { s, cx, cy, bodyR } = view, d = (mx, my) => Math.hypot(cx + mx * s - px, cy + my * s - py);
    for (const p of planets()) if (d(p.x, p.y) < Math.max(12, bodyR(BODY.planet))) return { planet: p.id };
    if (d(0, 0) < Math.max(12, bodyR(BODY.home))) return { planet: 'home' };
    const m = (world.moments ?? []).find((q) => d(q.x, q.y) < 9);
    return m ? { moment: m } : null;
  }
  function aimAt(px, py) {
    const { s, cx, cy } = view;
    aimAng = Math.atan2(py - cy, px - cx);
    if (Math.hypot(px - cx, py - cy) < 6 * s) return;
    showPush();
  }
  /** An Enter that only finishes an accent or an input method's word (WebKit says so with keyCode 229). */
  const composing = (e) => e.isComposing || e.keyCode === 229;
  function wire() {
    cv = $('w-canvas'); x = cv.getContext('2d');
    if ($('w-profile')) wireProfile(); // the panel's; the hub's page has no such box
    cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomTo(zTo + e.deltaY * 0.0015); }, { passive: false });
    cv.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX - pan.x, y: e.clientY - pan.y, at: [e.clientX, e.clientY], moved: false };
      cv.setPointerCapture(e.pointerId);
      if (aiming) aimAt(e.offsetX, e.offsetY);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) { const h = hit(e.offsetX, e.offsetY); hover = h?.moment?.id ?? null; cv.style.cursor = aiming ? 'crosshair' : h ? 'pointer' : ''; return; }
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
    });
    $('w-home').onclick = () => flyTo('home');
    $('w-map').onclick = () => showMap();
    new ResizeObserver(() => { if (raf) fit(); }).observe(cv);
    $('w-dir').replaceChildren(new Option('Direction', '', true, true), ...COMPASS.map((c, i) => new Option(c[0].toUpperCase() + c.slice(1), String(i * Math.PI / 4 - Math.PI / 2))));
    $('w-dir').options[0].disabled = true;
    $('w-aim').onclick = () => setAim(!aiming);
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

  // ---------- the side panel: Home's level, what to spend on, moments, and today's numbers
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
  function setAim(on) {
    aiming = on;
    $('w-aim').classList.toggle('on', on);
    $('w-aim').textContent = on ? 'Done aiming' : 'Aim on the map';
    cv.style.cursor = on ? 'crosshair' : '';
    if (on) { if (aimAng == null) aimAng = -Math.PI / 4; showMap(); }
    showPush();
  }
  function showPush() {
    if (opts.readOnly) return;
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
    if (aimAng == null) return;
    const b = $('w-push'), err = $('w-push-err');
    b.disabled = true; err.hidden = true;
    const r = await opts.api('/api/world/buy', { kind: 'frontier', ang: aimAng });
    if (!r.ok) { err.textContent = r.error || 'That did not go through.'; err.hidden = false; showPush(); return; }
    opts.toast?.(`The frontier is pushed ${compass(aimAng)}. It lights up that way as you work.`);
    const ang = aimAng;
    aimAng = null;
    setAim(false);
    AgentWorld.update(r.world);
    showMap({ x: Math.cos(ang) * 90, y: Math.sin(ang) * 90 });
  }
  /** Build on the place you are looking at: Home or a colony. Claude takes a few seconds; one build at a time. */
  let buildingOn = null;
  function showBuild() {
    if (opts.readOnly) return;
    const box = $('w-build-box'), p = placeOf(here), yours = here === 'home' || (p && colonyOf(p));
    box.hidden = !yours;
    if (!yours) return;
    $('w-build-title').textContent = `Build on ${placeName(here)}`;
    const price = world.prices?.build ?? 0, b = $('w-build'), text = $('w-build-text');
    $('w-build-price').textContent = `${fmt(price)} credit`;
    b.textContent = buildingOn ? `Building on ${placeName(buildingOn)}…` : 'Build it';
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
    if (opts.readOnly) return;
    const list = planets().filter(colonyOf), sig = list.map((p) => `${p.id}:${p.colony.name}`).join();
    if (sig === coloniesSig) return;
    coloniesSig = sig;
    $('w-colonies').replaceChildren(...list.map((p) => {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'btn small'; b.dataset.place = p.id; b.textContent = p.colony.name;
      b.onclick = () => flyTo(p.id);
      return b;
    }));
    zoomTo(zTo);
  }
  function pick(id) {
    picked = id;
    const m = (world.moments ?? []).find((q) => q.id === id), card = $('w-moment');
    card.hidden = !m;
    if (!m) return;
    if (z < 0.5) showMap({ x: m.x, y: m.y }); else focusTo = { x: m.x, y: m.y };
    $('w-m-name').textContent = momentTitle(m);
    const i = m.info;
    if (!i) { // a system's public projection keeps when a moment was, never its numbers
      $('w-m-when').textContent = m.kind === 'week' ? `${short(m.from)} to ${short(m.day)}.` : m.kind === 'cleanup' ? 'A day that removed more than it added.' : 'Home reached a new level.';
      $('w-m-info').replaceChildren();
      return;
    }
    $('w-m-when').textContent = m.kind === 'week' ? `${short(m.from)} to ${short(m.day)}, ${i.days} day${i.days === 1 ? '' : 's'} worked.`
      : m.kind === 'cleanup' ? 'A day that removed more than it added. Removing pays most.' : `Home reached level ${i.level}.`;
    $('w-m-info').replaceChildren(...(m.kind === 'level' ? row('XP', fmt(i.xp)) : [
      ...(m.kind === 'week' ? row('Commits', fmt(i.commits)) : []),
      ...row('Lines written', '+' + fmt(i.added)),
      ...row('Lines removed', `−${fmt(i.removed)}` + (m.kind === 'cleanup' ? `, so ×${i.multiplier.toFixed(1)}` : '')),
      ...row('Credit earned', fmt(i.credit))]));
  }
  function showMoments(list) {
    $('w-moments-box').hidden = !list.length;
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
    $('w-next').textContent = h.next ? `Next: level ${h.next.level}, ${h.next.name}.` : 'The top level. The frontier keeps growing the map.';
    $('w-xp-today').hidden = $('w-bar-today').parentElement.hidden = h.today == null;
    $('w-xp-today').textContent = `+${fmt(h.today ?? 0)} XP today. ` + ((h.today ?? 0) >= 100 ? 'More work gives more.' : 'A full day gives 100.');
    $('w-bar-today').style.width = pct((h.today ?? 0) / 100) + '%';
    $('w-credit').textContent = fmt(Math.max(0, w.balance ?? 0));
    if (!opts.readOnly) { // today's numbers, the totals and the notes are the owner's alone
      const t = w.today;
      $('w-today').replaceChildren(
        ...row('Commits', fmt(t.commits)),
        ...row('Lines written', '+' + fmt(t.added)),
        ...row('Lines removed', `−${fmt(t.removed)}, so ×${t.multiplier.toFixed(1)}`),
        ...row('Tokens', fmt(t.tokens)),
        ...row('Credit earned', fmt(t.credit)));
      const since = new Date(w.startedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
      $('w-total').textContent = w.earned > 0 ? `${fmt(w.earned)} credit earned since ${since}, ${fmt(w.spent ?? 0)} spent.`
        : `Your world started on ${since} as a bare rock. Each day you work gives Home XP, and it levels up.`;
      const names = (list) => (list ?? []).map((r) => r.split('/').filter(Boolean).at(-1)).join(', ');
      const notes = [];
      if (w.noEmail?.length) notes.push(`No commits counted in ${names(w.noEmail)}: git has no user.email there.`);
      if (w.gitFailed?.length) notes.push(`Commits in ${names(w.gitFailed)} couldn't be read this time: git didn't answer in time. What was counted stays.`);
      $('w-noemail').hidden = !notes.length;
      $('w-noemail').textContent = notes.join(' ');
    }
    showPush();
    showBuild();
    showRocket();
    showColonies();
    showMoments(w.moments ?? []);
    if (picked && !(w.moments ?? []).some((m) => m.id === picked)) pick(null);
  }

  // ---------- Profile: the hub account, or the way to sign in to one. The page passes the hub's state with each summary;
  // the sign-in itself is the server's (it polls the hub), so this only starts it, shows the code, and follows the snapshots.
  let hubNow = null, orderBase = null, loginCancelled = false;
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
      $('w-pf-handle').textContent = `@${a.handle}`;
      $('w-pf-xy').textContent = `${a.x}, ${a.y}`.replaceAll('-', '−');
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
    },
    exit() { cancelAnimationFrame(raf); raf = 0; drag = null; flight = null; if (aiming) setAim(false); document.body.classList.remove('w-readonly'); },
    /** Where a point on the map (map px, Home at 0,0) is on the canvas now. */
    at(mx, my) { return view ? [view.cx + mx * view.s, view.cy + my * view.s] : null; },
  };
})();
