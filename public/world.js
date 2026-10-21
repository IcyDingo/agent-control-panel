// World: a universe your agents' work pays for. The page opens it (window.AgentWorld.enter) with the server's summary
// and passes each later one to update(). Close up you see Home, the planet the work terraforms; zoomed out, the map, where
// the work lights the dark around Home. It draws from the summary alone: `home.xp` (Home's XP; a full day's work is 100,
// 2,000 terraforms it) and the world's `seed`.
(() => {
  const $ = (id) => document.getElementById(id);
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)');
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  function rng(seed) {
    return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  }

  let cv = null, x = null, W = 0, H = 0, dpr = 1, raf = 0, t0 = 0;
  let world = null, made = null; // the summary, and what its seed makes (stars, land, cities)
  let z = 0, zTo = 0, pan = { x: 0, y: 0 }, drag = null;
  const MAP = 900, ZMAX = 40, scaleOf = (v) => Math.pow(ZMAX, 1 - v); // the map spans MAP px zoomed out, ×40 close up

  function make(seed) {
    const r = rng(seed), stars = [], land = [], cities = [], craters = [], clouds = [];
    for (let i = 0; i < 900; i++) stars.push({ x: (r() - 0.5) * MAP * 1.6, y: (r() - 0.5) * MAP, b: r() });
    for (let i = 0; i < 26; i++) land.push({ u: r(), v: 0.15 + r() * 0.7, s: 0.04 + r() * 0.09, at: r() });
    for (let i = 0; i < 90; i++) cities.push({ on: land[Math.floor(r() * land.length)], a: r() * 7, d: Math.sqrt(r()) * 0.8, at: r() }); // each on a continent
    for (let i = 0; i < 26; i++) craters.push({ u: r(), v: r(), s: 3 + r() * 9 });
    for (let i = 0; i < 14; i++) clouds.push({ u: r(), v: 0.1 + r() * 0.8, w: 0.12 + r() * 0.2, at: r() });
    return { seed, stars, land, cities, craters, clouds };
  }

  // ---------- the view's size; the side panel takes the right edge when there is room
  const side = () => { const s = $('w-side'); return s && getComputedStyle(s).position === 'absolute' && s.offsetLeft > W / 2 ? W - s.offsetLeft : 0; };
  function fit() {
    dpr = window.devicePixelRatio || 1;
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }

  // ---------- drawing
  const days = () => (world?.home?.xp ?? 0) / 100; // in full days' work: the stages below are drawn on that scale
  /** 0 before day `a`, 1 from day `b`, linear between: each stage eases in over the days before it is named. */
  const ramp = (a, b) => Math.min(1, Math.max(0, (days() - a) / (b - a)));
  const g = () => Math.sqrt(Math.min(1, days() / 40)); // how far the lit map reaches: quick at first, all of it at the ladder's top
  const litRadius = () => 46 + 120 * g();
  const lit = (mx, my) => Math.max(0, Math.min(1, (1 - Math.hypot(mx, my) / litRadius()) * 1.6));
  function mix(a, b, k) {
    const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
    return `rgb(${[16, 8, 0].map((s) => Math.round((pa >> s & 255) * (1 - k) + (pb >> s & 255) * k)).join(',')})`;
  }
  function label(text, lx, ly, color = '#8c96a4', size = 12) {
    x.font = `500 ${size}px Geist, system-ui, sans-serif`; x.textAlign = 'center';
    x.fillStyle = 'rgba(3,5,10,.8)'; x.fillText(text, lx + 1, ly + 1);
    x.fillStyle = color; x.fillText(text, lx, ly);
  }
  const glowCanvas = document.createElement('canvas');
  glowCanvas.width = 96; glowCanvas.height = 60;
  function drawGlow(cx, cy, s) { // sampled small, then drawn up smoothly so its edge is soft
    const gx = glowCanvas.getContext('2d'), gw = glowCanvas.width, gh = glowCanvas.height, sw = MAP * 1.6, sh = MAP;
    gx.clearRect(0, 0, gw, gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const l = lit(((i + 0.5) / gw - 0.5) * sw, ((j + 0.5) / gh - 0.5) * sh);
      if (l > 0) { gx.fillStyle = `rgba(36,62,110,${0.45 * l})`; gx.fillRect(i, j, 1, 1); }
    }
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(glowCanvas, cx - sw / 2 * s, cy - sh / 2 * s, sw * s, sh * s);
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

  function frame(now) {
    const t = now - t0;
    z = calm.matches ? zTo : z + (zTo - z) * 0.08;
    if (Math.abs(zTo - z) < 0.001) z = zTo;
    const s = scaleOf(z), cx = (W - side()) / 2 + pan.x, cy = H / 2 + pan.y;
    x.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bg = x.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.max(W, H) * 0.7);
    bg.addColorStop(0, '#0b1526'); bg.addColorStop(1, '#03050a');
    x.fillStyle = bg; x.fillRect(0, 0, W, H);
    const far = rng(made.seed + 1), n = Math.round(30 + 150 * g()); // more of the sky shows as the world grows
    for (let i = 0; i < 180; i++) {
      const a = 0.08 + far() * 0.18, px = far() * W, py = far() * H;
      if (i < n) { x.fillStyle = `rgba(220,230,255,${a})`; x.fillRect(px, py, 1, 1); }
    }
    const mapA = Math.min(1, Math.max(0, (z - 0.15) / 0.5));
    if (mapA > 0) {
      x.globalAlpha = mapA;
      drawGlow(cx, cy, s);
      for (const st of made.stars) {
        const l = lit(st.x, st.y);
        if (l <= 0.02) continue;
        const sx = cx + st.x * s, sy = cy + st.y * s;
        if (sx < -4 || sy < -4 || sx > W + 4 || sy > H + 4) continue;
        x.fillStyle = `rgba(225,235,255,${(0.25 + 0.6 * st.b) * l})`;
        const sz = st.b > 0.93 ? 2.2 : st.b > 0.75 ? 1.5 : 1;
        x.fillRect(sx, sy, sz, sz);
      }
      x.globalAlpha = 1;
    }
    const R = Math.min(Math.min(W - side(), H) * 0.3, 6 * s), detail = Math.min(1, Math.max(0, (0.5 - z) / 0.35));
    drawHome(cx, cy, R, t, detail);
    if (z > 0.5) label('Home', cx, cy - R - 10, '#e3e7ed', 13);
    $('w-where').textContent = z < 0.3 ? 'Home' : z > 0.7 ? 'Map' : 'Leaving Home';
    raf = requestAnimationFrame(frame);
  }

  // ---------- zoom and look around
  function zoomTo(v) {
    zTo = Math.max(0, Math.min(1, v));
    if (zTo < 0.2) pan = { x: 0, y: 0 };
    $('w-home').classList.toggle('on', zTo < 0.5);
    $('w-map').classList.toggle('on', zTo >= 0.5);
  }
  function wire() {
    cv = $('w-canvas'); x = cv.getContext('2d');
    cv.addEventListener('wheel', (e) => { e.preventDefault(); zoomTo(zTo + e.deltaY * 0.0015); }, { passive: false });
    cv.addEventListener('pointerdown', (e) => { drag = { x: e.clientX - pan.x, y: e.clientY - pan.y }; cv.setPointerCapture(e.pointerId); });
    cv.addEventListener('pointermove', (e) => { if (drag && z > 0.3) pan = { x: e.clientX - drag.x, y: e.clientY - drag.y }; });
    cv.addEventListener('pointerup', () => { drag = null; });
    $('w-home').onclick = () => zoomTo(0);
    $('w-map').onclick = () => zoomTo(1);
    new ResizeObserver(() => { if (raf) fit(); }).observe(cv);
  }

  // ---------- the side panel: Home's level, today's numbers, and what the world has earned
  function row(name, value) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = name; dd.textContent = value;
    return [dt, dd];
  }
  function show(w) {
    const h = w.home ?? { xp: 0, today: 0, level: 1, stage: 'Bare rock', at: 0, next: null }, pct = (v) => Math.round(Math.min(1, v) * 100);
    $('w-level').textContent = `Level ${h.level}`;
    $('w-stage').textContent = h.stage;
    $('w-xp').textContent = h.next ? `${fmt(h.xp)} / ${fmt(h.next.at)} XP` : `${fmt(h.xp)} XP`;
    $('w-bar').style.width = pct(h.next ? (h.xp - h.at) / (h.next.at - h.at) : 1) + '%';
    $('w-next').textContent = h.next ? `Next: level ${h.next.level}, ${h.next.name}.` : 'The top level. The frontier opens next.';
    $('w-xp-today').textContent = `+${fmt(h.today)} XP today. ` + (h.today >= 300 ? 'That is the most one day gives; more work still earns credit.'
      : h.today >= 100 ? 'More work gives more, up to 300.' : 'A full day gives 100.');
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
    $('w-total').textContent = w.earned > 0 ? `${fmt(w.earned)} credit earned since ${since}.`
      : `Your world started on ${since} as a bare rock. Each day you work gives Home XP, and it levels up.`;
    const names = (list) => (list ?? []).map((r) => r.split('/').filter(Boolean).at(-1)).join(', ');
    const notes = [];
    if (w.noEmail?.length) notes.push(`No commits counted in ${names(w.noEmail)}: git has no user.email there.`);
    if (w.gitFailed?.length) notes.push(`Commits in ${names(w.gitFailed)} couldn't be read this time: git didn't answer in time. What was counted stays.`);
    $('w-noemail').hidden = !notes.length;
    $('w-noemail').textContent = notes.join(' ');
  }

  window.AgentWorld = {
    enter(summary) {
      if (!cv) wire();
      world = summary;
      if (made?.seed !== (summary.seed ?? 1)) made = make(summary.seed ?? 1);
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
      show(summary);
    },
    exit() { cancelAnimationFrame(raf); raf = 0; drag = null; },
  };
})();
