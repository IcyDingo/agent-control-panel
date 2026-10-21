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
  let flight = null, sending = false, rocketSig = '', coloniesSig = ''; // a rocket on its way: its colony shows once it lands
  const MAP = 900, ZMAX = 40, scaleOf = (v) => Math.pow(ZMAX, 1 - v); // the map spans MAP px zoomed out, ×40 close up
  const LOBE_START = 60, lobeRadius = (along, tip) => 34 + 26 * along / (tip + 40); // world.mjs's lobe shape
  const BODY = { home: 6, planet: 4.5 }; // radius on the map, map px
  const LOOK = { rust: ['#d9a27f', '#8a4f33', '#2a1712'], ice: ['#dbe8f2', '#7f9fb8', '#1d2a36'], sand: ['#e6d3a3', '#a68a55', '#2e2516'],
    violet: ['#c9b3e0', '#6e5590', '#1f1730'] };
  const MOMENT = { week: '#cfe0ff', cleanup: '#7ee0a8', level: '#ffcf7a' };

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
  const days = () => (world?.home?.xp ?? 0) / 100; // in full days' work: Home's stages below are drawn on that scale
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
    return clamp(best * 1.6);
  }
  /** How far the world reaches from Home (map px): the light, what the frontier bought, the planets it found. */
  const extent = () => Math.max(reach() * 1.15, ...lobes().map((l) => LOBE_START + l.bought + 60), ...planets().map((p) => Math.hypot(p.x, p.y) + 30));
  /** The light and the stars in it, drawn again only when the world changes, sampled small and drawn up smoothly so
   *  its edge is soft. */
  function paint() {
    const sig = JSON.stringify([world?.reach, lobes(), planets().map((p) => p.id)]);
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
  function label(text, lx, ly, color = '#8c96a4', size = 12) {
    x.font = `500 ${size}px Geist, system-ui, sans-serif`; x.textAlign = 'center';
    x.fillStyle = 'rgba(3,5,10,.8)'; x.fillText(text, lx + 1, ly + 1);
    x.fillStyle = color; x.fillText(text, lx, ly);
  }
  /** Home, level by level (world.mjs LEVELS): clouds over the rock, oceans, continents, green coasts, forests,
   *  settlements with lights at night, cities under an atmosphere, and a moon when it is terraformed; then an orbital
   *  ring, a star port on it, and a second moon. */
  function drawHome(cx, cy, R, t, detail) {
    const spin = calm.matches ? 0 : t / 60000, drift = calm.matches ? 0 : t / 40000;
    const clouds = ramp(0.03, 0.6), ocean = ramp(0.4, 1), land = ramp(1.5, 4.2), green = ramp(4, 6.2), forest = ramp(6.5, 9.5);
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
    x.fillStyle = mix('#6b6660', '#24507f', ocean); x.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    for (const c of made.craters) {
      x.fillStyle = `rgba(40,38,36,${0.5 * (1 - ocean)})`;
      x.beginPath(); x.arc(cx - R + ((c.u + spin) % 1) * 2 * R, cy - R + c.v * 2 * R, c.s * R / 240, 0, 7); x.fill();
    }
    const at = (l) => [cx - R + ((l.u + spin) % 1) * 2.2 * R - 0.1 * R, cy - R + l.v * 2 * R]; // a continent's centre now
    for (const l of made.land) {
      if (l.at > land * 1.05) continue; // continents rise one by one
      const [lx, ly] = at(l);
      x.fillStyle = mix('#7b7569', '#4f7a52', green);
      x.beginPath(); x.ellipse(lx, ly, l.s * 2 * R, l.s * 1.2 * R, 0.3, 0, 7); x.fill();
      if (forest > l.at * 0.9) { // forests spread inland
        x.fillStyle = `rgba(36,74,46,${0.85 * forest})`;
        x.beginPath(); x.ellipse(lx + l.s * 0.2 * R, ly, l.s * 1.1 * R, l.s * 0.62 * R, 0.3, 0, 7); x.fill();
      }
    }
    for (const c of made.clouds) {
      if (c.at > clouds * 1.05) continue;
      x.fillStyle = `rgba(235,240,250,${0.22 * clouds})`;
      x.beginPath(); x.ellipse(cx - R + ((c.u + drift) % 1) * 2.4 * R - 0.2 * R, cy - R + c.v * 2 * R, c.w * R, c.w * 0.32 * R, -0.15, 0, 7); x.fill();
    }
    const sh = x.createRadialGradient(cx - R * 0.45, cy - R * 0.4, R * 0.2, cx, cy, R * 1.05);
    sh.addColorStop(0, 'rgba(255,255,255,.12)'); sh.addColorStop(0.55, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(2,4,10,.82)');
    x.fillStyle = sh; x.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    if (R > 30 && detail > 0) for (const c of made.cities) {
      if (c.at > towns || c.on.at > land * 1.05) continue;
      const [ox, oy] = at(c.on), ex = Math.cos(c.a) * c.d * c.on.s * 2 * R, ey = Math.sin(c.a) * c.d * c.on.s * 1.2 * R;
      const lx = ox + ex * Math.cos(0.3) - ey * Math.sin(0.3), ly = oy + ex * Math.sin(0.3) + ey * Math.cos(0.3);
      if (Math.hypot(lx - cx, ly - cy) > R * 0.96) continue;
      const night = lx - cx > R * 0.05, d = Math.max(2, R / 110); // pale by day, lit at night
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
  const idSeed = (id) => [...id].reduce((h, ch) => h * 31 + ch.charCodeAt(0), made.seed) | 0;
  /** A planet the frontier found: a bare world in its own colours, with craters. A colony on it adds a warm air and
   *  domes lit from inside. */
  function drawPlanet(cx, cy, R, p, colony) {
    if (colony) {
      const a = x.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.2);
      a.addColorStop(0, 'rgba(240,180,120,.3)'); a.addColorStop(1, 'rgba(240,180,120,0)');
      x.fillStyle = a; x.beginPath(); x.arc(cx, cy, R * 1.2, 0, 7); x.fill();
    }
    const [c0, c1, c2] = LOOK[p.look] ?? LOOK.rust, gr = x.createRadialGradient(cx - R * 0.35, cy - R * 0.35, 0, cx, cy, R);
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
    const [hx, hy] = to(0, 0), hr = bodyR(BODY.home);
    if (seen(hx, hy, hr * 2.3)) drawHome(hx, hy, hr, t, here === 'home' ? detail : 0);
    if (z > 0.5) label('Home', hx, hy - hr - 10, '#e3e7ed', 13);
    for (const p of planets()) {
      const [px, py] = to(p.x, p.y), r = bodyR(BODY.planet), colony = colonyOf(p);
      if (!seen(px, py, r * 2.5)) continue;
      drawPlanet(px, py, r, p, colony);
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
  function wire() {
    cv = $('w-canvas'); x = cv.getContext('2d');
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
    $('w-rocket-name').onkeydown = (e) => { if (e.key === 'Enter' && !$('w-rocket').disabled) sendRocket(); };
    $('w-rocket-show').onclick = () => flyTo($('w-rocket-to').value);
    $('w-rocket').onclick = sendRocket;
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
    const price = world.prices?.frontier ?? 0;
    $('w-push-price').textContent = `${fmt(price)} credit`;
    if (aimAng != null) $('w-dir').value = String(COMPASS.indexOf(compass(aimAng)) * Math.PI / 4 - Math.PI / 2);
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
  /** Send a rocket: shown while the frontier has found a planet nobody lives on. */
  function showRocket() {
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
    if (list.some((p) => p.id === here)) sel.value = here;
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
    const p = r.world.planets.find((q) => q.id === id), from = placeOf(here) ?? { x: 0, y: 0 };
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
    $('w-moments').replaceChildren(...list.slice(-6).reverse().map((m) => {
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
    $('w-xp').textContent = h.next ? `${fmt(h.xp)} / ${fmt(h.next.at)} XP` : `${fmt(h.xp)} XP`;
    $('w-bar').style.width = pct(h.next ? (h.xp - h.at) / (h.next.at - h.at) : 1) + '%';
    $('w-next').textContent = h.next ? `Next: level ${h.next.level}, ${h.next.name}.` : 'The top level. The frontier keeps growing the map.';
    $('w-xp-today').textContent = `+${fmt(h.today)} XP today. ` + (h.today >= 100 ? 'More work gives more.' : 'A full day gives 100.');
    $('w-bar-today').style.width = pct(h.today / 100) + '%';
    $('w-credit').textContent = fmt(Math.max(0, w.balance));
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
    showPush();
    showRocket();
    showColonies();
    showMoments(w.moments ?? []);
    if (picked && !(w.moments ?? []).some((m) => m.id === picked)) pick(null);
  }

  window.AgentWorld = {
    enter(summary, options = {}) {
      opts = options;
      if (!cv) wire();
      world = summary;
      if (made?.seed !== (summary.seed ?? 1)) { made = make(summary.seed ?? 1); sky = null; }
      paint();
      here = 'home'; flight = null; focus = { x: 0, y: 0 }; focusTo = { x: 0, y: 0 };
      show(summary);
      fit();
      zoomTo(0); z = 0; pan = { x: 0, y: 0 };
      t0 = performance.now();
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(frame);
    },
    update(summary) {
      if (!raf || !summary?.started) return;
      world = summary;
      paint();
      show(summary);
    },
    exit() { cancelAnimationFrame(raf); raf = 0; drag = null; flight = null; if (aiming) setAim(false); },
    /** Where a point on the map (map px, Home at 0,0) is on the canvas now. */
    at(mx, my) { return view ? [view.cx + mx * view.s, view.cy + my * view.s] : null; },
  };
})();
