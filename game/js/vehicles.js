// vehicles.js — 12 Ukrainian vehicles drawn as pixel art with ctx.fillRect only.
// All sprites face RIGHT (direction of travel). draw(ctx, x, y, t, speed, env):
// (x, y) = bottom-centre anchor; the sprite occupies rows y-h .. y-1 (wheels sit on row y).
// No DOM/window access at module level (Node can import this file). No per-frame allocation.

// ---------- shared drawing state + helpers ----------
let C = null, OX = 0, OY = 0;
function begin(ctx, x, y, w, h) {
  C = ctx; ctx.imageSmoothingEnabled = false;
  OX = Math.round(x) - (w >> 1); OY = Math.round(y) - h;
}
function p(x, y, w, h, col) { C.fillStyle = col; C.fillRect(OX + (x | 0), OY + (y | 0), w | 0, h | 0); }
function px(x, y, col) { C.fillStyle = col; C.fillRect(OX + (x | 0), OY + (y | 0), 1, 1); }
function line(x0, y0, x1, y1, col) { // Bresenham, integer endpoints
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  C.fillStyle = col;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let e = dx + dy;
  for (;;) {
    C.fillRect(OX + x0, OY + y0, 1, 1);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * e;
    if (e2 >= dy) { e += dy; x0 += sx; }
    if (e2 <= dx) { e += dx; y0 += sy; }
  }
}
function alpha(a) { C.globalAlpha = a; }

// Disk half-widths, precomputed (round-looking pixel circles).
const DISK = [];
for (let r = 0; r <= 7; r++) {
  const row = [];
  for (let dy = -r; dy <= r; dy++) row.push(Math.floor(Math.sqrt(r * r + r - dy * dy)));
  DISK.push(row);
}
function disk(cx, cy, r, col, upperOnly) {
  C.fillStyle = col;
  const row = DISK[r], end = upperOnly ? r : 2 * r;
  for (let i = 0; i <= end; i++) { const hw = row[i]; C.fillRect(OX + cx - hw, OY + cy - r + i, 2 * hw + 1, 1); }
}
function ring(cx, cy, r, col) { // 1-px circle outline
  C.fillStyle = col;
  const row = DISK[r];
  for (let i = 0; i <= 2 * r; i++) {
    const hw = row[i], prev = i > 0 ? row[i - 1] : -1, next = i < 2 * r ? row[i + 1] : -1;
    const inner = Math.max(Math.min(prev, next), 0);
    if (i === 0 || i === 2 * r) { C.fillRect(OX + cx - hw, OY + cy - r + i, 2 * hw + 1, 1); continue; }
    const len = Math.max(1, hw - inner);
    C.fillRect(OX + cx - hw, OY + cy - r + i, len, 1);
    C.fillRect(OX + cx + hw - len + 1, OY + cy - r + i, len, 1);
  }
}

// Wheel spin phase: distance / circumference. Returns 0/1 frame, or 2 = motion blur.
function wheelFrame(t, speed, rM) {
  if (speed <= 0.05) return 0;
  const revPerSec = speed / (6.2832 * rM);
  if (revPerSec > 7) return 2;
  return (((t * speed) / (6.2832 * rM)) * 4 | 0) & 1;
}
const TYRE = '#1b1b20', RIM = '#9a9ca4', RIM_BLUR = '#6c6e76', HUB = '#2c2c33', ARCH = '#121216';
// Solid car/truck wheel with arch, rim and alternating hub dots.
function wheel(cx, cy, r, f, rim = RIM, arch = true) {
  if (arch) disk(cx, cy, r + 1, ARCH, true);
  disk(cx, cy, r, TYRE);
  const rr = r >= 4 ? 2 : 1;
  disk(cx, cy, rr, f === 2 ? RIM_BLUR : rim);
  if (f === 2) { px(cx, cy, HUB); return; }
  if (rr === 1) {
    if (f === 0) { px(cx, cy - 1, HUB); px(cx, cy + 1, HUB); } else { px(cx - 1, cy, HUB); px(cx + 1, cy, HUB); }
    px(cx, cy, '#d8dae0');
  } else {
    px(cx, cy, HUB);
    if (f === 0) { px(cx - 1, cy - 1, HUB); px(cx + 1, cy + 1, HUB); px(cx + 1, cy - 1, HUB); px(cx - 1, cy + 1, HUB); }
    else { px(cx, cy - 2, HUB); px(cx, cy + 2, HUB); px(cx - 2, cy, HUB); px(cx + 2, cy, HUB); }
    px(cx - 1, cy - 2, '#c8cad0');
  }
}
// Spoked wheel (bike / moped).
function spokeWheel(cx, cy, r, f, tyre = TYRE) {
  ring(cx, cy, r, tyre);
  const col = '#b8bac2';
  if (f === 2) { alpha(0.45); disk(cx, cy, r - 1, col); alpha(1); }
  else if (f === 0) { line(cx - r + 1, cy, cx + r - 1, cy, col); line(cx, cy - r + 1, cx, cy + r - 1, col); }
  else { const d = r - 2 > 0 ? r - 2 : 1; line(cx - d, cy - d, cx + d, cy + d, col); line(cx - d, cy + d, cx + d, cy - d, col); }
  px(cx, cy, '#e4e4ea');
}

// Body bob: 1 px, rate grows with speed, none when parked.
function bobOf(t, speed, rate = 1) {
  if (speed < 0.3) return 0;
  const f = (2 + Math.min(speed, 20) * 0.2) * rate;
  return ((t * f) | 0) & 1;
}

// Exhaust puffs: 3 fixed puffs from t, drift back (left) + up and fade in discrete steps.
const PUFF_A = [0.65, 0.45, 0.25];
function puffs(x, y, t, speed, col = '#a9a9b0', up = 0.5, rate = 1.6) {
  const drift = 4 + Math.min(speed, 30) * 0.5;
  for (let i = 0; i < 3; i++) {
    const ph = (t * rate + i / 3) % 1;
    const st = ph < 0.34 ? 0 : ph < 0.67 ? 1 : 2;
    alpha(PUFF_A[st]);
    const sx = Math.round(x - ph * drift), sy = Math.round(y - ph * (3 + 6 * up));
    const s = st === 0 ? 1 : 2;
    p(sx - (s >> 1), sy - (s >> 1), s, s, col);
  }
  alpha(1);
}

// Night lights. Headlight cone: 4 stepped bands to the right, slightly dropping toward the road.
const CONE_A = [0.55, 0.38, 0.22, 0.1];
function headlight(x, y, n, seg = 7) {
  px(x, y, n > 0.5 ? '#fffbe0' : '#e9e2b0');
  if (n <= 0.5) return;
  const k = Math.min(1, (n - 0.5) * 4);
  for (let i = 0; i < 4; i++) {
    alpha(CONE_A[i] * k);
    const hh = 1 + 2 * (i + 1);
    p(x + 1 + i * seg, y - (hh >> 1) + i, seg, hh, '#ffe27a');
  }
  alpha(1);
}
function taillight(x, y, n, h = 1) {
  p(x, y, 1, h, n > 0.5 ? '#ff3030' : '#a02020');
  if (n <= 0.5) return;
  alpha(0.35); p(x - 2, y - 1, 3, h + 2, '#ff2a2a'); alpha(1);
}
function blink(t, period, on, offset = 0) { return ((t / period + offset) % 1) < on; }

// ---------- sprite maps (row strings -> horizontal runs, parsed once) ----------
function sprite(rows) {
  const xs = [], ys = [], ls = [], cs = [];
  for (let y = 0; y < rows.length; y++) {
    const r = rows[y];
    let x = 0;
    while (x < r.length) {
      const c = r[x];
      if (c === '.') { x++; continue; }
      let e = x + 1;
      while (e < r.length && r[e] === c) e++;
      xs.push(x); ys.push(y); ls.push(e - x); cs.push(c);
      x = e;
    }
  }
  return { xs, ys, ls, cs, n: xs.length, rows };
}
function drawSprite(s, pal, dx = 0, dy = 0) {
  for (let i = 0; i < s.n; i++) {
    C.fillStyle = pal[s.cs[i]];
    C.fillRect(OX + dx + s.xs[i], OY + dy + s.ys[i], s.ls[i], 1);
  }
}
const BASEPAL = { k: '#1c1a24', w: '#2b4258', W: '#a8d8f0', g: '#cfd2d8', G: '#55575f', x: '#24242a', r: '#b02020', l: '#f4eec0', f: '#e8b48a' };
function pal(o) { return Object.assign({}, BASEPAL, o); }
function nightPal(o) { return Object.assign({}, o, { w: '#e9c96a', W: '#fff0b0' }); }

// ---------- 1. bike ----------
const BIKE = { frame: '#c0282c', frameHi: '#ff6a5a', shirt: '#2f6fd0', shirtD: '#1e4c96', pants: '#2a2a38', pantsD: '#18181f', skin: '#e8b48a', hair: '#5a3418', cap: '#f2d23a' };
function drawBike(ctx, x, y, t, speed, env = {}) {
  begin(ctx, x, y, 16, 17);
  const n = env.night || 0, f = wheelFrame(t, speed, 0.34), b = bobOf(t, speed, 0.7);
  // pedalling: crank turns once per ~2.4 wheel revolutions
  const crank = speed > 0.05 ? (t * speed) / (6.2832 * 0.34) / 2.4 * 6.2832 : 0.8;
  const bbx = 7, bby = 13;
  // far leg (darker, behind frame)
  leg(bbx, bby, crank + Math.PI, BIKE.pantsD, b);
  spokeWheel(3, 13, 3, f); spokeWheel(12, 13, 3, f);
  // frame: chain-stay, seat tube, top tube, down tube, fork, bars, seat
  line(3, 13, bbx, bby, BIKE.frame); line(bbx, bby, 5, 8, BIKE.frame); line(5, 8, 11, 8, BIKE.frameHi);
  line(bbx, bby, 11, 8, BIKE.frame); line(11, 8, 12, 13, '#8a8c94'); line(3, 13, 5, 8, BIKE.frame);
  p(10, 6, 1, 2, '#8a8c94'); p(10, 6, 2, 1, '#2a2a30');
  p(4, 7, 3, 1, '#2a2a30');
  // rider
  const yb = b;
  p(5, 3 + yb, 3, 4, BIKE.shirt); p(5, 6 + yb, 3, 1, BIKE.shirtD); p(6, 2 + yb, 2, 1, BIKE.shirt);
  line(7, 3 + yb, 10, 6, BIKE.shirtD); // arm to bars
  p(6, 0 + yb, 3, 2, BIKE.skin); p(6, 0 + yb, 3, 1, BIKE.cap); p(9, 0 + yb, 1, 1, BIKE.cap); px(5, 1 + yb, BIKE.hair);
  leg(bbx, bby, crank, BIKE.pants, b);
  p(bbx, bby, 1, 1, '#d8dae0');
  headlight(13, 7, n, 6); taillight(1, 9, n);
}
function leg(bbx, bby, a, col, b) {
  const fx = Math.round(bbx + Math.cos(a) * 2), fy = Math.round(bby + Math.sin(a) * 2);
  const hx = 5, hy = 6 + b;
  const kx = Math.round((hx + fx) / 2 + 2), ky = Math.round((hy + fy) / 2 - 1);
  line(hx, hy, kx, ky, col); line(kx, ky, fx, fy, col);
  px(fx, fy, '#1a1a1a'); px(fx + 1, fy, '#1a1a1a');
}

// ---------- 2. moped «Карпати» ----------
const MOP = { body: '#d23a2a', hi: '#ff7a5c', sh: '#8e1f18', eng: '#5a5c64', engD: '#34353b', jacket: '#3f6a3a', jacketD: '#2a4a28', helm: '#f0f0f0', helmS: '#b0b4bc', visor: '#2a3a50', pants: '#2c2c3a', boot: '#1a1a1a' };
function drawMoped(ctx, x, y, t, speed, env = {}) {
  begin(ctx, x, y, 20, 20); OY += 2;
  const n = env.night || 0, f = wheelFrame(t, speed, 0.28), b = bobOf(t, speed, 1.2);
  puffs(1, 14, t, speed, '#b4b4bc', 0.3, 2.2);
  spokeWheel(4, 14, 3, f); spokeWheel(16, 14, 3, f);
  const yb = b;
  // frame / bodywork (step-through)
  line(4, 14, 8, 11 + yb, MOP.sh);
  p(5, 9 + yb, 6, 2, MOP.body); p(5, 9 + yb, 6, 1, MOP.hi); // rear body under seat
  p(3, 8 + yb, 5, 1, '#202024'); p(3, 7 + yb, 4, 1, '#34343a'); // seat
  p(3, 9 + yb, 2, 1, MOP.sh); // rear mudguard
  line(10, 11 + yb, 14, 6 + yb, MOP.body); line(11, 11 + yb, 15, 6 + yb, MOP.sh); // down tube
  // engine + exhaust
  p(7, 11 + yb, 4, 3, MOP.eng); p(7, 13 + yb, 4, 1, MOP.engD); px(8, 12 + yb, '#8a8c94');
  p(2, 14, 6, 1, '#6a6c74'); px(1, 14, '#3a3a40');
  // fork, front mudguard, headlamp, bars
  line(15, 6 + yb, 16, 13, '#9a9ca4'); p(14, 10 + yb, 4, 1, MOP.body);
  p(15, 4 + yb, 2, 2, MOP.body); px(16, 4 + yb, MOP.hi); p(13, 3 + yb, 3, 1, '#2a2a30');
  // rider
  p(4, 5 + yb, 5, 2, MOP.pants); line(8, 6 + yb, 9, 10 + yb, MOP.pants); p(9, 10 + yb, 2, 1, MOP.boot);
  p(4, 1 + yb, 4, 5, MOP.jacket); p(4, 5 + yb, 4, 1, MOP.jacketD); px(8, 2 + yb, MOP.jacket);
  line(7, 2 + yb, 13, 3 + yb, MOP.jacketD);
  p(5, -2 + yb, 4, 3, MOP.helm); p(5, 0 + yb, 4, 1, MOP.helmS); p(8, -1 + yb, 1, 1, MOP.visor);
  headlight(17, 4 + yb, n, 6); taillight(2, 8 + yb, n);
}

// ---------- 3. ЗАЗ-965 «Горбатий» ----------
const S965 = sprite([
  '........kkkkkkk.........',
  '......kkhhhhhhhkk.......',
  '.....khwWwwkwWwwwhk.....',
  '....khwwwwwkwwwwwwwk....',
  '...khbbbbbbsbbbbbbbbk...',
  '..khhhhhhhhshhhhhhhhhkk.',
  '.kbbbbbbbbbsbbbbbbbbbbhk',
  'kbbbbbbbbbbsbbbbbbbbbbbl',
  'kbbbbbbbbbbsbbbbbbbbbbbk',
  'rssssssssssssssssssssssk',
  '.ggkkkkkkkkkkkkkkkkkkgg.',
  '........................',
]);
const P965 = pal({ h: '#c4e2f4', b: '#7ab2d6', s: '#4b7aa2' }), P965N = nightPal(P965);
function drawZaz965(ctx, x, y, t, speed, env = {}) {
  begin(ctx, x, y, 24, 12);
  const n = env.night || 0, f = wheelFrame(t, speed, 0.28), b = bobOf(t, speed);
  puffs(0, 9 + b, t, speed);
  drawSprite(S965, n > 0.5 ? P965N : P965, 0, b);
  px(9, 1 + b, '#e8f6ff'); px(10, 1 + b, '#e8f6ff'); // hump gleam
  wheel(5, 9, 2, f); wheel(18, 9, 2, f);
  headlight(23, 7 + b, n); taillight(0, 9 + b, n);
}

// ---------- 4. ЗАЗ-968М «Вухатий» ----------
const S968 = sprite([
  '........kkkkkkkkk.........',
  '.......khhhhhhhhhk........',
  '......khwWwwkwwWwwk.......',
  '.....khwwwwwkwwwwwwk......',
  '.kkkkbbbbbbbsbbbbbbbkkkkk.',
  'kGxGkbbbbbbbsbbbbbbbhhhhhk',
  'kGxGbbbbbbbbsbbbbbbbbbbbbk',
  'kbbbbbbbbbbbsbbbbbbbbbbbbl',
  'kbbbbbbbbbbbsbbbbbbbbbbbbk',
  'rssssssssssssssssssssssssk',
  'ggggkkkkkkkkkkkkkkkkkkgggg',
  '..........................',
]);
const P968 = pal({ h: '#f0d9a8', b: '#d0a868', s: '#977242', G: '#5c564c', x: '#211e1a' }), P968N = nightPal(P968);
function drawZaz968(ctx, x, y, t, speed, env = {}) {
  begin(ctx, x, y, 26, 12);
  const n = env.night || 0, f = wheelFrame(t, speed, 0.28), b = bobOf(t, speed);
  puffs(0, 9 + b, t, speed);
  drawSprite(S968, n > 0.5 ? P968N : P968, 0, b);
  p(13, 6 + b, 2, 1, '#cfd2d8'); // door handle
  wheel(5, 9, 2, f); wheel(20, 9, 2, f);
  headlight(25, 7 + b, n); taillight(0, 9 + b, n);
}

// ---------- 5. ЗАЗ-1102 «Таврія» ----------
const STAV = sprite([
  '..kkkkkkkkkkkk..............',
  '.khhhhhhhhhhhhkk............',
  '.kbwwwwwkwwwWwwhkk..........',
  '.kbwWwwwkwwwwwwwwhkk........',
  '.kbwwwwwkwwwwwwwwwwhkkk.....',
  '.khhhhhhshhhhhhhhhhhhhhkkk..',
  '.rbbbbbbsbbbbbbbbbbbbbbbbhkk',
  '.kbbbbbbsbbbbbbbbbbbbbbbbbbl',
  '.kssssssssssssssssssssssssk',
  '.GGGGGGGGGGGGGGGGGGGGGGGGGG.',
  '............................',
  '............................',
]);
const PTAV = pal({ h: '#ff8a7a', b: '#d23a32', s: '#8c2220', G: '#3a3a40', r: '#ff6020' }), PTAVN = nightPal(PTAV);
function drawTavria(ctx, x, y, t, speed, env = {}) {
  begin(ctx, x, y, 28, 12);
  const n = env.night || 0, f = wheelFrame(t, speed, 0.28), b = bobOf(t, speed);
  puffs(1, 9 + b, t, speed);
  drawSprite(STAV, n > 0.5 ? PTAVN : PTAV, 0, b);
  p(10, 6 + b, 2, 1, '#2a2a30'); // door handle
  wheel(6, 9, 2, f); wheel(22, 9, 2, f);
  headlight(27, 7 + b, n); taillight(1, 6 + b, n);
}

// ---------- 6. ЛуАЗ-969 «Волинь» ----------
const SLUAZ = sprite([
  '..............k...........',
  '..........xx..kw..........',
  '..........ff..kw..........',
  '.........UffU.kw..........',
  '.........UUUU.kw..........',
  '.kkkkkkkkkkkkkkkkkkkkkk...',
  '.khhhhhhhhhhhhhhhhhhhhhkk.',
  '.kbbbbbbbbsbbbbbbbbbbbbbhk',
  '.rssssssssssssssssssssssbl',
  '.kbbbbbbbbbbbbbbbbbbbbbbbk',
  '.kssssssssssssssssssssssbk',
  '..kkkkkkkkkkkkkkkkkkkkkk..',
  '..........................',
  '..........................',
]);
const PLUAZ = pal({ h: '#a6ad7a', b: '#7d8456', s: '#565c3a', x: '#3a2a1a', U: '#4a5a8a', w: '#9fc8dc' }), PLUAZN = PLUAZ; // open-top car: the windscreen has no cabin light behind it
function drawLuaz(ctx, x, y, t, speed, env = {}) {
  begin(ctx, x, y, 26, 14);
  const n = env.night || 0, f = wheelFrame(t, speed, 0.33), b = bobOf(t, speed, 1.3);
  puffs(0, 10 + b, t, speed);
  // spare wheel on the rear side
  disk(1, 8 + b, 2, '#1b1b20'); px(1, 8 + b, '#6c6e76');
  drawSprite(SLUAZ, PLUAZN, 0, b);
  // stamped ribs + hood louvres
  p(19, 7 + b, 4, 1, '#4b5032');
  wheel(6, 10, 3, f, '#6f7550', false); wheel(20, 10, 3, f, '#6f7550', false);
  headlight(25, 8 + b, n); taillight(1, 8 + b, n);
}

// ---------- 7. ЛАЗ-695 ----------
const LAZ = { k: '#1c1a24', cr: '#efe3c0', crH: '#fff6dc', crS: '#c7b78e', red: '#c8402c', redH: '#e8664a', redS: '#8a2a1e', g: '#d8dade', gl: '#2b4258', glH: '#a8d8f0', glN: '#f0cf72', glNH: '#fff1b6' };
function drawLaz(ctx, x, y, t, speed, env = {}) {
  begin(ctx, x, y, 44, 22);
  const n = env.night || 0, f = wheelFrame(t, speed, 0.45), b = bobOf(t, speed, 0.8), L = LAZ;
  const gl = n > 0.5 ? L.glN : L.gl, glH = n > 0.5 ? L.glNH : L.glH;
  puffs(0, 17 + b, t, speed, '#8e8e96');
  const o = b;
  // body silhouette (rounded corners)
  p(2, 3 + o, 39, 1, L.k); p(1, 4 + o, 42, 15, L.k); p(42, 6 + o, 1, 12, L.k); p(0, 6 + o, 1, 12, L.k);
  // rear roof crest (air intake) with louvres
  p(3, 0 + o, 10, 1, L.k); p(2, 1 + o, 12, 3, L.k); p(3, 1 + o, 10, 2, L.crH); p(3, 3 + o, 10, 1, L.cr);
  for (let i = 0; i < 5; i++) px(4 + i * 2, 2 + o, L.crS);
  // upper cream, lower red, chrome belt
  p(2, 4 + o, 40, 8, L.cr); p(2, 4 + o, 40, 1, L.crH); p(1, 6 + o, 1, 6, L.cr);
  // roof-edge skylight strip
  for (let i = 0; i < 9; i++) p(5 + i * 4, 5 + o, 3, 1, i % 2 ? gl : glH);
  // side windows with pillars
  for (let i = 0; i < 6; i++) { p(3 + i * 5, 7 + o, 4, 4, gl); px(3 + i * 5, 7 + o, glH); px(4 + i * 5, 7 + o, glH); }
  // door (front) + raked windscreen
  p(34, 6 + o, 4, 12, L.k); p(35, 7 + o, 2, 4, gl); p(35, 12 + o, 2, 4, gl); px(35, 7 + o, glH);
  p(39, 6 + o, 3, 6, gl); px(39, 6 + o, glH); px(40, 7 + o, glH); p(42, 7 + o, 1, 5, gl);
  p(2, 12 + o, 32, 1, L.g); p(38, 12 + o, 4, 1, L.g);
  p(2, 13 + o, 32, 5, L.red); p(38, 13 + o, 5, 5, L.red); p(2, 13 + o, 32, 1, L.redH); p(2, 17 + o, 32, 1, L.redS); p(38, 17 + o, 5, 1, L.redS);
  p(1, 13 + o, 1, 5, L.red);
  // bumpers
  p(0, 18 + o, 3, 1, L.g); p(41, 18 + o, 3, 1, L.g);
  wheel(9, 17, 4, f); wheel(34 - 4, 17, 4, f);
  headlight(43, 15 + o, n, 8); taillight(0, 14 + o, n, 2);
}

// ---------- 8. Маршрутка Богдан А092 ----------
const BOG = { k: '#1c1a24', wh: '#f4f4ee', whS: '#c8cac4', ye: '#f2c418', yeH: '#ffe46a', yeS: '#b48a0a', gl: '#2b4258', glH: '#a8d8f0', glN: '#f0cf72', glNH: '#fff1b6', g: '#8a8c94', dg: '#3a3a40' };
function drawBogdan(ctx, x, y, t, speed, env = {}) {
  begin(ctx, x, y, 36, 20);
  const n = env.night || 0, f = wheelFrame(t, speed, 0.36), b = bobOf(t, speed, 1.1), o = b, B = BOG;
  const gl = n > 0.5 ? B.glN : B.gl, glH = n > 0.5 ? B.glNH : B.glH;
  puffs(0, 15 + o, t, speed);
  // outline: tall box + sloped windscreen + short bonnet
  p(1, 1 + o, 28, 1, B.k); p(0, 2 + o, 30, 15, B.k);
  for (let i = 0; i < 6; i++) p(30 + i, 2 + i + o, 1, 15 - i, B.k); // windscreen slope
  p(30, 8 + o, 6, 9, B.k);
  // white upper body, yellow lower
  p(1, 2 + o, 29, 8, B.wh); p(1, 2 + o, 29, 1, '#ffffff');
  for (let i = 0; i < 5; i++) p(30 + i, 3 + i + o, 1, 7 - i, B.wh);
  p(1, 10 + o, 34, 6, B.ye); p(1, 10 + o, 34, 1, B.yeH); p(1, 15 + o, 34, 1, B.yeS);
  p(30, 8 + o, 5, 2, B.ye);
  // windows
  for (let i = 0; i < 4; i++) { p(2 + i * 6, 4 + o, 5, 4, gl); px(2 + i * 6, 4 + o, glH); }
  p(26, 4 + o, 3, 4, gl); // driver's side window
  for (let i = 0; i < 4; i++) p(30 + i, 4 + i + o, 1, 4 - i, i === 0 ? glH : gl); // windscreen glass
  // sliding door seam
  p(19, 3 + o, 1, 13, B.whS); p(19, 10 + o, 1, 6, B.yeS);
  // route-number sign on the windscreen top: white board, dark «15»
  p(22, 1 + o, 9, 7, B.k); p(23, 2 + o, 7, 5, '#ffffff');
  p(25, 2 + o, 1, 5, '#202024'); px(24, 3 + o, '#202024'); // 1
  p(27, 2 + o, 3, 1, '#202024'); px(27, 3 + o, '#202024'); p(27, 4 + o, 3, 1, '#202024'); px(29, 5 + o, '#202024'); p(27, 6 + o, 3, 1, '#202024'); // 5
  // grille + bumpers
  p(34, 11 + o, 1, 3, B.dg); p(0, 16 + o, 3, 1, B.dg); p(32, 16 + o, 4, 1, B.dg);
  wheel(7, 16, 3, f); wheel(29, 16, 3, f);
  headlight(35, 10 + o, n); taillight(0, 11 + o, n, 2);
}

// ---------- 9. КрАЗ-6322 ----------
const KRAZ = { k: '#16180f', h: '#8a9a5a', b: '#5f6e3a', s: '#3f4a26', tent: '#6e6a44', tentH: '#8c875c', tentS: '#4c4930', gl: '#2b4258', glH: '#a8d8f0', chr: '#2a2c22', g: '#9a9ca4' };
function drawKraz(ctx, x, y, t, speed, env = {}) {
  begin(ctx, x, y, 44, 24);
  const n = env.night || 0, f = wheelFrame(t, speed, 0.6), b = bobOf(t, speed, 0.6), o = b, K = KRAZ;
  // vertical exhaust stack behind the cab, puffs go up and back
  p(24, 1 + o, 1, 8, '#2a2a2a'); px(24, 0 + o, '#444');
  puffs(24, 1 + o, t, speed, '#7a7a80', 1.2, 1.4);
  // chassis frame
  p(1, 17, 41, 2, K.chr);
  // canvas tent over the cargo bed
  p(1, 4 + o, 22, 1, K.k); p(0, 5 + o, 24, 9, K.k);
  p(1, 5 + o, 22, 8, K.tent); p(1, 5 + o, 22, 1, K.tentH);
  for (let i = 0; i < 4; i++) p(4 + i * 5, 6 + o, 1, 7, K.tentS); // bows
  p(0, 14 + o, 24, 3, K.k); p(1, 14 + o, 22, 2, K.b); p(1, 14 + o, 22, 1, K.h); // bed side
  // cab
  p(24, 2 + o, 10, 1, K.k); p(23, 3 + o, 12, 14, K.k);
  p(24, 3 + o, 10, 13, K.b); p(24, 3 + o, 10, 1, K.h);
  p(27, 4 + o, 6, 5, K.gl); px(27, 4 + o, K.glH); px(28, 4 + o, K.glH); // door window
  p(26, 10 + o, 1, 6, K.s); p(31, 11 + o, 2, 1, K.g); // door seam + handle
  // long bonnet + big grille
  p(34, 7 + o, 9, 1, K.k); p(34, 8 + o, 10, 9, K.k);
  p(34, 8 + o, 9, 8, K.b); p(34, 8 + o, 9, 1, K.h); p(34, 15 + o, 9, 1, K.s);
  for (let i = 0; i < 3; i++) p(35 + i * 3, 10 + o, 2, 1, K.s); // bonnet louvres
  p(42, 9 + o, 2, 7, K.chr); px(43, 10 + o, '#5a5c4c'); px(43, 12 + o, '#5a5c4c'); px(43, 14 + o, '#5a5c4c');
  // big mudguard over front wheel
  p(33, 14 + o, 9, 1, K.s);
  // bumper
  p(40, 17, 4, 2, '#2a2c22');
  wheel(6, 19, 4, f, '#7c8458'); wheel(16, 19, 4, f, '#7c8458'); wheel(37, 19, 4, f, '#7c8458');
  headlight(43, 13 + o, n, 8); taillight(0, 14 + o, n, 2);
}

// ---------- 10. Електробус «Електрон» ----------
const ELE = { k: '#141824', wh: '#f2f4f6', whS: '#c6ccd4', bl: '#1f5fbf', blH: '#4a8ae8', blS: '#143e80', ye: '#ffd21a', gl: '#1d2a3a', glH: '#7fb6e0', glN: '#f4dc8a', glNH: '#fff3c0', pack: '#b8bec8', packS: '#7c828c' };
function drawElectron(ctx, x, y, t, speed, env = {}) {
  begin(ctx, x, y, 46, 22);
  const n = env.night || 0, f = wheelFrame(t, speed, 0.45), b = bobOf(t, speed, 0.5), o = b, E = ELE;
  const gl = n > 0.5 ? E.glN : E.gl, glH = n > 0.5 ? E.glNH : E.glH;
  // roof battery pack (no pantograph)
  p(9, 0 + o, 26, 1, E.k); p(8, 1 + o, 28, 2, E.k); p(9, 1 + o, 26, 1, E.pack); p(9, 2 + o, 26, 1, E.packS);
  // charge indicator: 5 cells fill up in a loop
  const lvl = ((t * 1.5) | 0) % 6;
  for (let i = 0; i < 5; i++) px(12 + i * 2, 1 + o, i < lvl ? '#48f070' : '#4c6a52');
  if (blink(t, 2.3, 0.06)) { px(36, 0 + o, '#bff6ff'); px(37, 1 + o, '#62e0ff'); px(36, 2 + o, '#bff6ff'); } // tiny spark
  // body (rounded)
  p(2, 3 + o, 41, 1, E.k); p(1, 4 + o, 44, 1, E.k); p(0, 5 + o, 46, 13, E.k);
  p(1, 5 + o, 44, 12, E.wh); p(2, 4 + o, 41, 1, '#ffffff');
  // continuous dark glazing band with thin pillars
  p(2, 6 + o, 40, 6, gl);
  for (let i = 0; i < 5; i++) { p(6 + i * 8, 6 + o, 1, 6, E.whS); p(2 + i * 8, 6 + o, 3, 1, glH); }
  // full-height front glass
  p(42, 5 + o, 3, 11, gl); px(43, 6 + o, glH); px(42, 7 + o, glH);
  // destination LED sign
  p(41, 5 + o, 4, 1, '#20202a'); px(42, 5 + o, '#ffb020'); px(44, 5 + o, '#ffb020');
  // livery: yellow stripe + blue skirt
  p(1, 12 + o, 44, 1, E.ye); p(1, 13 + o, 44, 4, E.bl); p(1, 13 + o, 44, 1, E.blH); p(1, 16 + o, 44, 1, E.blS);
  line(1, 11 + o, 5, 6 + o, E.ye); // rear swoosh
  // doors (full height glass)
  for (const dx0 of DOORS_E) { p(dx0, 6 + o, 4, 11, E.k); p(dx0 + 1, 7 + o, 1, 9, gl); p(dx0 + 2, 7 + o, 1, 9, gl); }
  // low skirt, small wheels half-hidden
  wheel(9, 18, 3, f, '#c0c4cc'); wheel(36, 18, 3, f, '#c0c4cc');
  p(0, 17 + o, 5, 1, E.blS); p(14, 17 + o, 18, 1, E.blS); p(41, 17 + o, 5, 1, E.blS);
  headlight(45, 14 + o, n, 8); taillight(0, 13 + o, n, 2);
}
const DOORS_E = [19, 37];

// ---------- 11. Ан-2 «Кукурузник» ----------
const AN2 = { k: '#1c1e22', b: '#d6dade', h: '#f2f4f6', s: '#9aa0a8', wing: '#c2c8cc', wingS: '#8a9096', bl: '#2a5ab8', ye: '#ffd21a', eng: '#3a3c42', gl: '#2b4258', glH: '#a8d8f0' };
function drawAn2(ctx, x, y, t, speed, env = {}) {
  begin(ctx, x, y, 36, 16);
  const n = env.night || 0, A = AN2;
  const o = Math.sin(t * 1.7) > 0.3 ? -1 : 0; // gentle float
  // tail fin (rounded top) with the flag + tailplane
  p(1, 0 + o, 3, 1, A.k); p(0, 1 + o, 5, 8, A.k); p(1, 1 + o, 3, 7, A.b); p(1, 1 + o, 1, 7, A.h);
  p(2, 2 + o, 2, 2, A.bl); p(2, 4 + o, 2, 2, A.ye);
  p(0, 8 + o, 10, 2, A.k); p(1, 8 + o, 8, 1, A.wing);
  // upper wing (long, above the fuselage)
  p(9, 1 + o, 23, 3, A.k); p(10, 1 + o, 21, 1, A.h); p(10, 2 + o, 21, 1, A.wingS);
  // deep fuselage tapering to the tail
  for (let r = 0; r < 9; r++) {
    const yy = 5 + r, x0 = r < 2 ? 12 - r * 4 : r < 6 ? 3 : 4 + (r - 6) * 4, x1 = 29;
    p(x0, yy + o, x1 - x0 + 1, 1, A.k);
    if (r > 0 && r < 8) p(x0 + 1, yy + o, x1 - x0 - 1, 1, r === 1 ? A.h : r === 5 ? A.bl : r >= 6 ? A.s : A.b);
  }
  // cockpit glazing (stepped) + cabin windows
  p(23, 4 + o, 6, 1, A.k); p(24, 5 + o, 4, 2, A.gl); px(27, 5 + o, A.glH); px(24, 6 + o, A.k);
  for (let i = 0; i < 4; i++) p(10 + i * 3, 7 + o, 2, 1, A.gl);
  // lower wing below the fuselage
  p(13, 13 + o, 17, 2, A.k); p(14, 13 + o, 15, 1, A.wingS);
  // interplane struts + cabane
  p(15, 4 + o, 1, 1, A.k); p(15, 12 + o, 1, 1, A.k);
  alpha(0.55); p(15, 5 + o, 1, 7, A.k); alpha(1);
  p(21, 4 + o, 1, 1, A.k);
  // radial engine cowling
  p(29, 5 + o, 4, 9, A.k); p(30, 6 + o, 3, 7, A.eng); p(30, 6 + o, 1, 7, '#5e6068'); px(32, 9 + o, '#8a8c92');
  // propeller: blur disc + rotating blade frames
  alpha(0.22); p(34, 2 + o, 1, 14, '#c8ccd2'); alpha(1);
  const fr = (t * 26 | 0) % 3;
  if (fr === 0) p(34, 3 + o, 1, 12, '#4a4c52');
  else if (fr === 1) { p(34, 2 + o, 1, 3, '#4a4c52'); p(34, 13 + o, 1, 3, '#4a4c52'); }
  else { alpha(0.6); p(34, 6 + o, 1, 7, '#6a6c72'); alpha(1); }
  px(33, 9 + o, '#8a8c92'); // spinner
  // fixed main gear + tailwheel
  p(25, 15 + o, 3, 1, A.k); px(26, 15 + o, '#6c6e76');
  px(4, 11 + o, A.k);
  // exhaust wisps
  puffs(28, 13 + o, t, 6, '#9a9aa2', 0.1, 2.4);
  // nav lights: red at upper wing tip, white tail, red beacon
  px(31, 1 + o, blink(t, 1.2, 0.5) ? '#ff4040' : '#802020');
  if (blink(t, 1.0, 0.12)) px(0, 8 + o, '#ffffff');
  if (blink(t, 1.6, 0.15, 0.5)) px(18, 4 + o, '#ff3030');
  if (n > 0.5) { alpha(0.35); p(30, 0 + o, 3, 3, '#ff3030'); alpha(1); }
}

// ---------- 12. Ан-225 «Мрія» ----------
const MR = { k: '#1a1c22', b: '#eef0f2', h: '#ffffff', s: '#b8bec6', ss: '#8a9098', bl: '#1f5fbf', ye: '#ffd21a', wing: '#d0d4da', wingS: '#9aa0a8', far: '#a6acb4', eng: '#c4c8ce', engS: '#7a8088', intake: '#2a2c32', gl: '#22344a' };
function drawAn225(ctx, x, y, t, speed, env = {}) {
  begin(ctx, x, y, 48, 18);
  const n = env.night || 0, M = MR;
  const o = Math.sin(t * 0.9) > 0.5 ? -1 : 0;
  // far fin (behind, darker) + far wing with 3 engines peeking above the fuselage
  for (let r = 0; r < 10; r++) p(5 + (r >> 2), 1 + r + o, 3, 1, r === 3 ? '#16408a' : r === 5 ? '#b8961a' : M.ss);
  for (let i = 0; i < 3; i++) { const ex = 22 + i * 7; p(ex, 5 + o, 5, 2, M.far); p(ex, 6 + o, 5, 1, M.engS); px(ex + 4, 5 + o, M.intake); }
  // fuselage: fat body, upswept tail cone
  for (let r = 0; r < 9; r++) {
    const yy = 7 + r, x0 = r <= 3 ? 3 + (r === 0 ? 3 : 0) : 3 + (r - 3) * 3, x1 = r === 0 ? 42 : r < 7 ? 46 : 45 - (r - 7);
    p(x0, yy + o, x1 - x0 + 1, 1, M.k);
    if (r > 0 && r < 8) p(x0 + 1, yy + o, x1 - x0 - 1, 1, r === 1 ? M.h : r >= 6 ? M.s : M.b);
  }
  px(47, 11 + o, M.k); px(47, 12 + o, M.k);
  // cockpit hump on top of the nose + windows
  p(34, 5 + o, 8, 1, M.k); p(33, 6 + o, 11, 1, M.k); p(34, 6 + o, 8, 1, M.b); p(42, 7 + o, 2, 1, M.k);
  p(39, 6 + o, 3, 1, M.gl); p(43, 8 + o, 2, 1, M.gl);
  // Ukrainian cheatline: blue over yellow
  p(5, 10 + o, 41, 1, M.bl); p(10, 11 + o, 36, 1, M.ye);
  // near wing root along the fuselage top + 3 near engines on pylons
  p(18, 8 + o, 22, 1, M.wingS);
  for (let i = 0; i < 3; i++) {
    const ex = 20 + i * 7;
    p(ex + 2, 9 + o, 1, 1, M.k);
    p(ex, 10 + o, 6, 3, M.k); p(ex + 1, 10 + o, 4, 2, M.eng); p(ex + 1, 11 + o, 4, 1, M.engS);
    px(ex + 5, 10 + o, M.intake); px(ex + 5, 11 + o, M.intake);
  }
  // landing-gear fairings (many wheels, retracted)
  p(20, 16 + o, 16, 1, M.k); p(21, 15 + o, 14, 1, M.ss);
  // H-tail: stabilizer + near swept fin with the flag
  p(0, 6 + o, 12, 2, M.k); p(1, 6 + o, 10, 1, M.wing);
  for (let r = 0; r < 11; r++) {
    const xe = 3 + (r >> 2);
    p(0, r + o, xe + 1, 1, M.k);
    if (r > 0 && r < 10) p(1, r + o, xe - 1, 1, r === 3 || r === 4 ? M.bl : r === 5 || r === 6 ? M.ye : M.b);
  }
  // lights: red/green wingtips, white tail strobe, red beacon; landing light at night
  px(40, 8 + o, blink(t, 1.4, 0.5) ? '#38f060' : '#1a6a2a');
  px(40, 5 + o, blink(t, 1.4, 0.5, 0.5) ? '#ff4040' : '#802020');
  if (blink(t, 1.1, 0.1)) px(0, 0 + o, '#ffffff');
  if (blink(t, 1.7, 0.15, 0.3)) px(28, 6 + o, '#ff3030');
  if (n > 0.5) {
    alpha(0.3); p(46, 13 + o, 2, 2, '#fff6c0');
    for (let i = 0; i < 3; i++) px(19 + i * 7, 11 + o, '#ffb060');
    alpha(1);
  }
}

// ---------- registry ----------
const V = (id, name, blurb, clickM, autoMps, incomeMult, cost, flies, flyAltPx, w, h, draw) =>
  ({ id, name, blurb, clickM, autoMps, incomeMult, cost, flies, flyAltPx, w, h, draw });

export const VEHICLES = [
  V('bike', 'Велосипед «Україна»', 'Харківський велосипед, на якому їздила вся країна.', 1, 0, 1, 0, false, 0, 16, 17, drawBike),
  V('moped', 'Мопед «Карпати»', 'Львівський мопед: тарахкотить, димить, але їде.', 2, 4, 1.15, 80, false, 0, 20, 20, drawMoped),
  V('zaz965', 'ЗАЗ-965 «Горбатий»', 'Перший «Запорожець» із круглим горбом і мотором ззаду.', 4, 15, 1.35, 600, false, 0, 24, 12, drawZaz965),
  V('zaz968m', 'ЗАЗ-968М «Вухатий»', '«Вуха» по боках — це повітрозабірники для мотора.', 7, 40, 1.6, 4500, false, 0, 26, 12, drawZaz968),
  V('tavria', 'ЗАЗ-1102 «Таврія»', 'Перший український передньопривідний хетчбек.', 12, 100, 1.9, 35000, false, 0, 28, 12, drawTavria),
  V('luaz', 'ЛуАЗ-969 «Волинь»', 'Луцька амфібія: проїде там, де доріг немає.', 20, 230, 2.3, 250000, false, 0, 26, 14, drawLuaz),
  V('laz695', 'Автобус ЛАЗ-695', 'Львівська легенда з «гребінцем» на даху.', 35, 500, 2.8, 1800000, false, 0, 44, 22, drawLaz),
  V('bogdan', 'Маршрутка Богдан А092', 'Передайте за проїзд! Зупинка на вимогу.', 55, 900, 3.4, 12000000, false, 0, 36, 20, drawBogdan),
  V('kraz', 'КрАЗ-6322', 'Кременчуцький тривісний велетень, якому бездоріжжя не страшне.', 90, 1500, 4.2, 80000000, false, 0, 44, 24, drawKraz),
  V('electron', 'Електробус «Електрон»', 'Львівський електробус: тихо, чисто, без вихлопу.', 150, 2400, 5.2, 550000000, false, 0, 46, 22, drawElectron),
  V('an2', 'Ан-2 «Кукурузник»', 'Київський біплан-трудяга, що сідає навіть на поле.', 250, 3600, 6.5, 4000000000, true, 24, 36, 16, drawAn2),
  V('an225', 'Ан-225 «Мрія»', 'Найбільший літак світу. Знищений у 2022-му — «Мрія» житиме.', 400, 5000, 8, 30000000000, true, 70, 48, 18, drawAn225),
];
