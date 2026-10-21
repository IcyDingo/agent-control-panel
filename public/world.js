// World: a universe your agents' work pays for. The page opens it (window.AgentWorld.enter) with the server's summary
// and passes each later one to update(). Close up you see Home, the planet the work builds up; zoomed out, the map, where
// the work lights the dark around Home. It draws from the summary alone: `grown` (0..1) and the world's `seed`.
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
    const r = rng(seed), stars = [], land = [], cities = [], craters = [];
    for (let i = 0; i < 900; i++) stars.push({ x: (r() - 0.5) * MAP * 1.6, y: (r() - 0.5) * MAP, b: r() });
    for (let i = 0; i < 26; i++) land.push({ u: r(), v: 0.15 + r() * 0.7, s: 0.04 + r() * 0.09, at: r() });
    for (let i = 0; i < 90; i++) cities.push({ u: r(), v: 0.2 + r() * 0.6, at: r() });
    for (let i = 0; i < 26; i++) craters.push({ u: r(), v: r(), s: 3 + r() * 9 });
    return { seed, stars, land, cities, craters };
  }

  // ---------- the view's size; the side panel takes the right edge when there is room
  const side = () => { const s = $('w-side'); return s && getComputedStyle(s).position === 'absolute' && s.offsetLeft > W / 2 ? W - s.offsetLeft : 0; };
  function fit() {
    dpr = window.devicePixelRatio || 1;
    W = cv.clientWidth; H = cv.clientHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  }

  // ---------- drawing
  const g = () => world?.grown ?? 0;
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
  /** Home: a bare rock that the work turns into a world (oceans, land, city lights, an atmosphere). */
  function drawHome(cx, cy, R, t, detail) {
    const p = g(), ocean = Math.min(1, Math.max(0, (p - 0.03) / 0.3)), spin = calm.matches ? 0 : t / 60000;
    if (p > 0.08) {
      const a = x.createRadialGradient(cx, cy, R * 0.95, cx, cy, R * 1.25);
      a.addColorStop(0, `rgba(110,160,240,${0.35 * p})`); a.addColorStop(1, 'rgba(110,160,240,0)');
      x.fillStyle = a; x.beginPath(); x.arc(cx, cy, R * 1.25, 0, 7); x.fill();
    }
    x.save(); x.beginPath(); x.arc(cx, cy, R, 0, 7); x.clip();
    x.fillStyle = mix('#6b6660', '#24507f', ocean); x.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    for (const c of made.craters) {
      x.fillStyle = `rgba(40,38,36,${0.5 * (1 - ocean)})`;
      x.beginPath(); x.arc(cx - R + ((c.u + spin) % 1) * 2 * R, cy - R + c.v * 2 * R, c.s * R / 240, 0, 7); x.fill();
    }
    for (const l of made.land) {
      if (l.at > p * 1.15) continue;
      x.fillStyle = mix('#7b7569', '#4f7a52', ocean);
      x.beginPath(); x.ellipse(cx - R + ((l.u + spin) % 1) * 2.2 * R - 0.1 * R, cy - R + l.v * 2 * R, l.s * 2 * R, l.s * 1.2 * R, 0.3, 0, 7); x.fill();
    }
    const sh = x.createRadialGradient(cx - R * 0.45, cy - R * 0.4, R * 0.2, cx, cy, R * 1.05);
    sh.addColorStop(0, 'rgba(255,255,255,.12)'); sh.addColorStop(0.55, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(2,4,10,.82)');
    x.fillStyle = sh; x.fillRect(cx - R, cy - R, 2 * R, 2 * R);
    if (R > 30 && detail > 0) for (const c of made.cities) {
      if (c.at > p) continue;
      const lx = cx - R + ((c.u + spin) % 1) * 2.2 * R - 0.1 * R, ly = cy - R + c.v * 2 * R;
      if (Math.hypot(lx - cx, ly - cy) > R * 0.96 || lx - cx < R * 0.05) continue; // lights show on the night side
      x.fillStyle = 'rgba(255,205,120,.85)'; x.fillRect(lx, ly, 2, 2);
    }
    x.restore();
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

  // ---------- the side panel: today's numbers, and what the world has earned
  function row(name, value) {
    const dt = document.createElement('dt'), dd = document.createElement('dd');
    dt.textContent = name; dd.textContent = value;
    return [dt, dd];
  }
  function show(w) {
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
      : `Your world started on ${since} as a bare rock. Commits and tokens earn credit, and it grows as they come in.`;
    const repos = (w.noEmail ?? []).map((r) => r.split('/').filter(Boolean).at(-1));
    $('w-noemail').hidden = !repos.length;
    $('w-noemail').textContent = repos.length ? `No commits counted in ${repos.join(', ')}: git has no user.email there.` : '';
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
