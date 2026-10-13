// Side-view pixel scene for «Дорога України».
//
//   createScene(canvas, data) → { render(distanceM, dt, vehicleDrawFn, opts) → { night, timeOfDay, vehicleX, groundY } }
//   opts = { flies, flyAltPx, speedMps, timeOfDay (0..1 override, 0 = midnight, 0.5 = noon), showNote = true }
//
// Camera: the vehicle drives left → right, so we look to the LEFT of travel: bearing = heading − 90°.
// Horizontal FOV 60°: column x ↦ bearing = heading − 90 + (x/384 − 0.5)·60.
// Horizon ridges: y = HORIZON_Y − angle·2.5·(384/60) (heights exaggerated ×2.5, see the «висота ×2.5» note).
// Mid/near bands saturate (≈linear for small angles, max 7° / 4.5° before ×2.5) so a valley wall can't fill the whole sky.
//
// WORLD SCALE (foreground): 1 px = 1 m along the road at the road centre line (y = 180).
// The ground is a true flat plane seen from the side: a row at screen y moves at
// rate r(y) = (y − HORIZON_Y) / (180 − HORIZON_Y) px per metre, so far fields crawl, the verge races,
// and anything that runs away from the road (field edges, rivers) converges on the vanishing point.
// Lane dashes are 3 m / 9 m gap, power poles every 60 m, km posts every 1000 m.
//
// The canvas keeps a fixed 384×216 backing store; scale it with CSS (image-rendering: pixelated).
// The returned object is reused every frame (copy fields if you need to keep them).
import { drawText, measureText } from './pixelfont.js';

export const SCENE_W = 384, SCENE_H = 216;
const W = SCENE_W, H = SCENE_H, CX = W >> 1;
const HORIZON_Y = 128;
const ROAD_REF_Y = 180;            // rate = 1 px / m here
const ROAD_TOP = 170, ROAD_BOT = 190;
const GROUND_Y = 184;              // wheel contact (near lane)
const VEH_X = 120;
const H_SCALE = 2.5 * W / 60;      // px per degree of horizon angle (×2.5 exaggeration)
const FOV = 60;
const MID_SAT = 7, NEAR_SAT = 4.5; // saturate mid/near angles: a' = K·(1 − e^(−a/K)) so a valley wall can't swallow the sky
const DAY_S = 720;                 // 1 game day = 12 real minutes
const rateAt = y => (y - HORIZON_Y) / (ROAD_REF_Y - HORIZON_Y);

// ---------- helpers ----------
function hash(i) {
  i = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); i ^= i >>> 13;
  i = Math.imul(i, 0xc2b2ae35); i ^= i >>> 16;
  return (i >>> 0) / 4294967296;
}
const hash2 = (a, b) => hash(Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663));
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
function mix(a, b, t) { return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
function css(c) { return 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')'; }
function makeCanvas(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
  return c;
}
function sprite(w, h, paint) { const c = makeCanvas(w, h); paint(c.getContext('2d'), w, h); return c; }
function px(g, col, x, y, w = 1, h = 1) { g.fillStyle = col; g.fillRect(x, y, w, h); }

// ---------- palettes (precomputed per time-of-day step, no per-frame strings) ----------
const PAL_N = 256;
const SKY_BANDS = 16;
const C = {
  dayTop: hex('#3f78d6'), dayHor: hex('#b4dcf7'), duskTop: hex('#3b3f8e'), duskHor: hex('#f5a05a'),
  nightTop: hex('#050818'), nightHor: hex('#1c2648'),
  far: hex('#9aa2d6'), mid: hex('#6f7fb0'), near: hex('#3e6a3c'),
  nightFar: hex('#1e2444'), nightMid: hex('#161b36'), nightNear: hex('#0e1424'), duskTint: hex('#c46a5a'),
};
function buildPalette(tod) {
  const a = (tod - 0.25) * Math.PI * 2, sunEl = Math.sin(a);
  const night = 1 - smooth(-0.14, 0.1, sunEl);
  const dusk = clamp01(1 - Math.abs(sunEl - 0.02) / 0.22);
  let top = mix(mix(C.dayTop, C.nightTop, night), C.duskTop, dusk * 0.55 * (1 - night * 0.5));
  let hor = mix(mix(C.dayHor, C.nightHor, night), C.duskHor, dusk * 0.8 * (1 - night * 0.6));
  const sky = [];
  for (let i = 0; i < SKY_BANDS; i++) { const t = i / (SKY_BANDS - 1); sky.push(css(mix(top, hor, t * t * 0.6 + t * 0.4))); }
  function band(day, nt, haze) {
    let c = mix(day, nt, night);
    c = mix(c, C.duskTint, dusk * 0.25);
    c = mix(c, hor, clamp01(haze + 0.2 * dusk + 0.15 * night));
    return c;
  }
  const far = band(C.far, C.nightFar, 0.42), mid = band(C.mid, C.nightMid, 0.22), near = band(C.near, C.nightNear, 0.08);
  return {
    sunEl, night, dusk, sky, horizon: sky[SKY_BANDS - 1],
    far: css(far), farRim: css(mix(far, [255, 255, 255], 0.18 * (1 - night))),
    mid: css(mid), midRim: css(mix(mid, [255, 255, 255], 0.12 * (1 - night))),
    near: css(near), nearDark: css(mix(near, [0, 0, 0], 0.25)),
    nightTint: 'rgba(6,10,34,' + (0.74 * night).toFixed(3) + ')',
    duskTint: 'rgba(255,110,40,' + (0.16 * dusk * (1 - night)).toFixed(3) + ')',
    hasTint: night > 0.01 || dusk > 0.02,
  };
}

// ---------- sprites ----------
function spruce(w, h) {
  return sprite(w, h, (g) => {
    const dk = '#1d4428', lt = '#2c5f35';
    px(g, '#4a3420', (w >> 1), h - 2, 1, 2);
    const tiers = Math.max(2, Math.round(h / 5));
    for (let y = 0; y < h - 2; y++) {
      const ty = y % Math.ceil((h - 2) / tiers);
      const half = Math.min(w >> 1, Math.round((y / (h - 2)) * (w >> 1) + ty * 0.4));
      px(g, dk, (w >> 1) - half, y, half * 2 + 1, 1);
      if (half > 0) px(g, lt, (w >> 1) - half, y, 1, 1);
    }
  });
}
function roundTree(w, h, col, lt) {
  return sprite(w, h, (g) => {
    px(g, '#4a3420', (w >> 1), h - 3, 1, 3);
    const cx = (w - 1) / 2, cy = (h - 3) / 2, rx = w / 2, ry = (h - 2) / 2;
    for (let y = 0; y < h - 2; y++) for (let x = 0; x < w; x++) {
      const dx = (x - cx) / rx, dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) px(g, (dx + dy < -0.5) ? lt : col, x, y);
    }
  });
}
function poplar(h) {
  return sprite(5, h, (g) => {
    px(g, '#4a3420', 2, h - 3, 1, 3);
    for (let y = 0; y < h - 3; y++) {
      const t = y / (h - 3), half = t < 0.15 ? 0 : t < 0.35 ? 1 : 2;
      px(g, '#2b5a2c', 2 - half, y, half * 2 + 1, 1);
      if (half) px(g, '#4a7f3a', 2 - half, y, 1, 1);
    }
  });
}
function house(kind, v) { // returns [sprite, lightsSprite]
  const roofs = ['#8a3a2a', '#3b5c8c', '#5a5a5a', '#7a4a2a', '#477a45', '#9a6a3a'];
  const walls = ['#ece6d2', '#e2d6b0', '#d8dce0', '#f0e0c8', '#cfe0d0'];
  const roof = roofs[v % roofs.length], wall = walls[(v >> 1) % walls.length];
  let w, h;
  const ops = [], lights = [];
  if (kind === 0) { // village hata
    w = 14 + (v % 3) * 2; h = 12;
    ops.push(['r', wall, 1, 5, w - 2, 7], ['roof', roof, 0, 0, w, 6], ['r', '#6a4a30', 3, 8, 2, 4]);
    ops.push(['r', '#2a3a55', w - 6, 7, 3, 2]); lights.push([w - 6, 7, 3, 2]);
    if (v % 2) ops.push(['r', '#8a8a8a', w - 4, 1, 2, 3]); // chimney
  } else if (kind === 1) { // town house, 2 storeys
    w = 16 + (v % 2) * 4; h = 18;
    ops.push(['r', wall, 1, 5, w - 2, 13], ['roof', roof, 0, 0, w, 6]);
    for (let fy = 0; fy < 2; fy++) for (let fx = 3; fx < w - 3; fx += 5) { ops.push(['r', '#2a3a55', fx, 8 + fy * 5, 2, 3]); lights.push([fx, 8 + fy * 5, 2, 3]); }
  } else if (kind === 2) { // panel block (khrushchovka / 9-storey)
    const floors = v % 2 ? 9 : 5; w = 26 + (v % 3) * 6; h = floors * 4 + 3;
    const col = ['#b9b5aa', '#c9c2b0', '#a9b0b4'][v % 3];
    ops.push(['r', col, 0, 1, w, h - 1], ['r', '#7f7c76', 0, 0, w, 1]);
    for (let f = 0; f < floors; f++) for (let x = 2; x < w - 2; x += 4) { ops.push(['r', '#3a4252', x, 3 + f * 4, 2, 2]); if (hash2(v * 31 + f, x) < 0.55) lights.push([x, 3 + f * 4, 2, 2]); }
  } else { // church with golden domes
    w = 20; h = 26;
    ops.push(['r', '#f2eee4', 3, 12, 14, 14], ['r', '#f2eee4', 7, 6, 6, 8], ['r', '#d9a520', 7, 2, 6, 4], ['r', '#ffd84a', 8, 2, 2, 2], ['r', '#d9a520', 9, 0, 2, 2],
      ['r', '#d9a520', 3, 9, 4, 3], ['r', '#d9a520', 13, 9, 4, 3], ['r', '#5a4030', 9, 20, 2, 6], ['r', '#2a3a55', 5, 15, 2, 3], ['r', '#2a3a55', 13, 15, 2, 3]);
    lights.push([5, 15, 2, 3], [13, 15, 2, 3]);
  }
  const draw = (g, onlyLights) => {
    if (onlyLights) { for (const l of lights) px(g, '#ffd36a', l[0], l[1], l[2], l[3]); return; }
    for (const o of ops) {
      if (o[0] === 'roof') { for (let y = 0; y < o[5]; y++) { const ins = Math.round((o[5] - 1 - y) * (o[4] / 2 - 2) / (o[5] - 1)); px(g, o[1], o[2] + ins, o[3] + y, o[4] - ins * 2, 1); } }
      else px(g, o[1], o[2], o[3], o[4], o[5]);
    }
  };
  return { img: sprite(w, h, g => draw(g, false)), lit: sprite(w, h, g => draw(g, true)), w, h };
}
function cloud(seed) {
  const w = 30 + ((seed * 7) % 4) * 8, h = 12 + (seed % 3) * 2;
  const blobs = [];
  for (let i = 0; i < 6; i++) blobs.push([4 + hash2(seed, i) * (w - 8), h * 0.55 + hash2(seed, i + 9) * h * 0.2, 3 + hash2(seed, i + 20) * (h * 0.45)]);
  const paint = (top, bot) => (g) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let inside = false;
      for (const b of blobs) { const dx = x - b[0], dy = (y - b[1]) * 1.4; if (dx * dx + dy * dy < b[2] * b[2]) { inside = true; break; } }
      if (inside && y < h - 1) px(g, y > h * 0.62 ? bot : top, x, y);
    }
  };
  return { day: sprite(w, h, paint('#ffffff', '#d6e2f0')), night: sprite(w, h, paint('#3a4466', '#262d48')), w, h };
}
function disc(r, col, rim) {
  const d = r * 2 + 1;
  return sprite(d, d, (g) => {
    for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) {
      const q = (x - r) * (x - r) + (y - r) * (y - r);
      if (q <= r * r + r * 0.6) px(g, q > (r - 1) * (r - 1) ? rim : col, x, y);
    }
  });
}

// crop palettes: [even row, odd row]
const CROPS = [
  ['#d9b75e', '#c9a34c'],  // 0 wheat
  ['#e8ba1e', '#6e7f2c'],  // 1 sunflower
  ['#80ae45', '#71a03b'],  // 2 young crops
  ['#78563b', '#674932'],  // 3 ploughed
  ['#e8d63a', '#d4c22e'],  // 4 rapeseed
  ['#6ca649', '#609a41'],  // 5 meadow
  ['#2f5b31', '#29522c'],  // 6 forest floor
];
function cropOf(cell, zone) {
  const h = hash2(cell, zone * 977 + 13);
  return h < 0.33 ? 0 : h < 0.66 ? 1 : h < 0.8 ? 2 : h < 0.9 ? 3 : h < 0.95 ? 4 : 5;
}

export function createScene(canvas, data) {
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const layer = makeCanvas(W, H), L = layer.getContext('2d');
  const vcan = makeCanvas(256, 160), V = vcan.getContext('2d');
  const VAX = 128, VAY = 128;

  const PAT_SPRUCE = L.createPattern(sprite(48, 64, (g) => {
    px(g, '#3c6638', 0, 0, 48, 64);
    for (let k = 0; k < 70; k++) {
      const cx = (hash2(k, 1) * 48) | 0, cy = (hash2(k, 2) * 64) | 0, hh = 4 + ((hash2(k, 3) * 4) | 0);
      for (let y = 0; y < hh; y++) { const hw = (y * 0.45) | 0; for (let dx = -hw; dx <= hw; dx++) px(g, dx < 0 ? '#4c7a46' : '#2c5230', (cx + dx + 48) % 48, (cy + y) % 64); }
    }
  }), 'repeat');
  const PAT_LEAF = L.createPattern(sprite(40, 40, (g) => {
    px(g, '#4a7440', 0, 0, 40, 40);
    for (let k = 0; k < 60; k++) {
      const cx = (hash2(k, 4) * 40) | 0, cy = (hash2(k, 5) * 40) | 0;
      px(g, '#3b6236', cx, cy, 3, 2); px(g, '#5a8a4c', cx, cy, 2, 1); px(g, '#33572f', (cx + 1) % 40, (cy + 2) % 40, 2, 1);
    }
  }), 'repeat');
  const PAL = []; for (let k = 0; k < PAL_N; k++) PAL.push(buildPalette(k / PAL_N));

  // sprites
  const SPRUCE = [spruce(3, 7), spruce(5, 11), spruce(7, 15), spruce(9, 20)];
  const TREE = [roundTree(5, 7, '#3b6a32', '#4f8040'), roundTree(7, 9, '#3b6a32', '#4f8040'), roundTree(9, 12, '#355f2e', '#4c7d3c'), roundTree(11, 14, '#355f2e', '#4c7d3c')];
  const POPLAR = [poplar(22), poplar(26), poplar(30)];
  const HOUSES = [[], [], [], []];
  for (let v = 0; v < 6; v++) { HOUSES[0].push(house(0, v)); HOUSES[1].push(house(1, v)); HOUSES[2].push(house(2, v)); }
  HOUSES[3].push(house(3, 0));
  const CLOUDS = []; for (let i = 0; i < 7; i++) CLOUDS.push(cloud(i + 3));
  const SUN = disc(6, '#fff6c8', '#ffd860'), SUN_LOW = disc(7, '#ffb060', '#ff8040'), MOON = disc(4, '#e8e8f0', '#b8bccc');
  const TUFT = [sprite(5, 4, g => { px(g, '#3f7a2e', 0, 2, 5, 2); px(g, '#4f8f38', 1, 0, 1, 2); px(g, '#4f8f38', 3, 1, 1, 1); }),
    sprite(9, 6, g => { px(g, '#3a7030', 1, 2, 7, 4); px(g, '#4c8a3a', 2, 0, 5, 3); px(g, '#2c5a26', 0, 4, 9, 2); })];

  const STARS = new Int16Array(160);
  for (let i = 0; i < 80; i++) { STARS[i * 2] = (hash(i * 3 + 1) * W) | 0; STARS[i * 2 + 1] = (hash(i * 3 + 2) * (HORIZON_Y - 20)) | 0; }

  const colOff = new Float32Array(W);
  for (let x = 0; x < W; x++) colOff[x] = (x / W - 0.5) * FOV;
  const yFar = new Int16Array(W), yMid = new Int16Array(W), yNear = new Int16Array(W), yTmp = new Int16Array(W);
  // fill columns x from ys[x] down to bottom (rimOnly: 1-px top edge), merging equal neighbours into one rect
  function fillCols(g, ys, bottom, rimOnly, ox) {
    let x0 = 0;
    for (let x = 1; x <= W; x++) {
      if (x < W && ys[x] === ys[x0]) continue;
      const y = ys[x0];
      if (y < bottom) g.fillRect(x0 + ox, y, x - x0, rimOnly ? 1 : bottom - y);
      x0 = x;
    }
  }
  const ROW_RATE = new Float32Array(H);
  for (let y = 0; y < H; y++) ROW_RATE[y] = rateAt(y);

  // per-frame scratch (preallocated)
  const nearP = new Int32Array(64); let nNear = 0;
  const rivLo = new Float64Array(8), rivHi = new Float64Array(8), rivIdx = new Int32Array(8); let nRiv = 0;
  // night lights layer: lit windows, erased under anything drawn in front of them
  const lcan = makeCanvas(W, H), LG = lcan.getContext('2d');
  let lightsOn = false, litAny = false;
  function occlude(img, x, y) {
    if (!litAny) return;
    LG.globalCompositeOperation = 'destination-out'; LG.drawImage(img, x, y); LG.globalCompositeOperation = 'source-over';
  }
  const signCache = new Map(), riverSignCache = new Map(), kmStr = [];

  const places = data.places || data.meta.places || [];
  const placeM = data.placeM || Float64Array.from(places, p => p.km * 1000);
  const rivers = data.rivers || data.meta.rivers || [];
  const riverM = data.riverM || Float64Array.from(rivers, r => r.km * 1000);
  const eleAt = data.eleAt || (m => data.pointAt(m).ele);
  const gradeAt = data.gradeAt || (m => data.pointAt(m).grade);
  const bearingBetween = data.bearingBetween || ((a, b) => data.pointAt((a + b) / 2).heading);

  let clock = 0, tod = 0.36, camHeading = NaN, lastM = NaN, tiltDeg = 0;
  const env = { t: 0, speed: 0, night: 0, grade: 0 };
  const result = { night: 0, timeOfDay: 0, vehicleX: VEH_X, groundY: GROUND_Y };

  // ---- world helpers ----
  function placeR(p) { // radius of the built-up area, metres
    const pop = p.pop || 0;
    if (p.type === 'city') return Math.min(7000, Math.max(2500, Math.sqrt(pop) * 5));
    if (p.type === 'town') return Math.min(2600, Math.max(1100, Math.sqrt(pop) * 9));
    return Math.min(900, Math.max(450, Math.sqrt(pop) * 9));
  }
  function placeW(p) { return p.type === 'city' ? 1.25 : p.type === 'town' ? 1.0 : 0.8; }
  function riverHalf(r) {
    const n = r.name || '';
    if (/Дніпр/.test(n)) return 450;
    if (/Дністер|Десна|Буг|Донець|Прип|Сула|Псел|Ворскл|Тиса|Сян|Горинь|Случ|Рось|Тетерів|Сейм|Оріль|Самар/.test(n)) return 80;
    return 22;
  }
  function inRiver(xw, pad) {
    for (let i = 0; i < nRiv; i++) if (xw > rivLo[i] - pad && xw < rivHi[i] + pad) return true;
    return false;
  }
  function townDensity(xw) {
    let d = 0;
    for (let i = 0; i < nNear; i++) {
      const p = places[nearP[i]], R = placeR(p), q = 1 - Math.abs(xw - placeM[nearP[i]]) / R;
      if (q > 0) d += q * placeW(p);
    }
    return d;
  }
  function townKind(xw) { // biggest settlement type covering xw: 0 village, 1 town, 2 city
    let k = -1;
    for (let i = 0; i < nNear; i++) {
      const p = places[nearP[i]];
      if (Math.abs(xw - placeM[nearP[i]]) < placeR(p)) { const t = p.type === 'city' ? 2 : p.type === 'town' ? 1 : 0; if (t > k) k = t; }
    }
    return k;
  }
  function forestAt(xw) {
    const e = eleAt(xw);
    let f = (e - 330) / 150;
    const cell = Math.floor(xw / 2300);
    if (hash2(cell, 71) < 0.13) f = Math.max(f, 0.85); // patches of woodland on the plains
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }
  function lowerBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; }

  // ---- layers ----
  function drawSky(P, mCam) {
    const bh = Math.ceil(HORIZON_Y / SKY_BANDS);
    for (let i = 0; i < SKY_BANDS; i++) { ctx.fillStyle = P.sky[i]; ctx.fillRect(0, i * bh, W, bh); }
    ctx.fillStyle = P.horizon; ctx.fillRect(0, HORIZON_Y, W, H - HORIZON_Y);
    if (P.night > 0.05) {
      ctx.fillStyle = '#fff';
      for (let i = 0; i < 80; i++) {
        const tw = hash2(i, (clock * 2) | 0) < 0.08 ? 0.35 : 1;
        ctx.globalAlpha = P.night * tw * (i % 3 === 0 ? 1 : 0.6);
        ctx.fillRect(STARS[i * 2], STARS[i * 2 + 1], 1, 1);
      }
      ctx.globalAlpha = 1;
    }
    // sun & moon on arcs (rise left, set right)
    const a = (tod - 0.25) * Math.PI * 2;
    const sx = Math.round(CX - Math.cos(a) * 172), sy = Math.round(HORIZON_Y - 4 - Math.sin(a) * 112);
    if (sy < HORIZON_Y + 8) { const s = P.sunEl < 0.25 ? SUN_LOW : SUN; ctx.drawImage(s, sx - (s.width >> 1), sy - (s.height >> 1)); }
    const mx = Math.round(CX + Math.cos(a) * 172), my = Math.round(HORIZON_Y - 4 + Math.sin(a) * 100);
    if (my < HORIZON_Y + 6) { ctx.globalAlpha = 0.35 + 0.65 * P.night; ctx.drawImage(MOON, mx - 4, my - 4); ctx.globalAlpha = 1; }
    // clouds
    const span = W + 120;
    for (let i = 0; i < CLOUDS.length; i++) {
      const c = CLOUDS[i];
      let x = (hash(i * 13) * span - clock * (1.5 + i * 0.4) - mCam * (0.004 + i * 0.001)) % span;
      if (x < 0) x += span;
      x = Math.round(x - 60); const y = 8 + ((hash(i * 17) * 54) | 0);
      if (P.night < 0.98) { ctx.globalAlpha = 1 - P.night; ctx.drawImage(c.day, x, y); }
      if (P.night > 0.02) { ctx.globalAlpha = P.night * 0.9; ctx.drawImage(c.night, x, y); }
    }
    ctx.globalAlpha = 1;
  }

  function drawRidges(P, m, mCam) {
    const base = camHeading - 90;
    for (let x = 0; x < W; x++) {
      const b = base + colOff[x];
      yFar[x] = Math.max(0, Math.round(HORIZON_Y - 1 - data.horizonAt(m, b, 2) * H_SCALE));
      let a = data.horizonAt(m, b, 1);
      if (a > 0) a = MID_SAT * (1 - Math.exp(-a / MID_SAT));
      yMid[x] = Math.max(0, Math.round(HORIZON_Y - 1 - a * H_SCALE));
      a = data.horizonAt(m, b, 0);
      if (a > 0) a = NEAR_SAT * (1 - Math.exp(-a / NEAR_SAT));
      yNear[x] = Math.max(0, Math.round(HORIZON_Y - 1 - a * H_SCALE));
    }
    const bottom = HORIZON_Y + 2;
    ctx.fillStyle = P.far; fillCols(ctx, yFar, bottom, 0, 0);
    ctx.fillStyle = P.farRim; fillCols(ctx, yFar, bottom, 1, 0);
    ctx.fillStyle = P.mid; fillCols(ctx, yMid, bottom, 0, 0);
    ctx.fillStyle = P.midRim; fillCols(ctx, yMid, bottom, 1, 0);
  }
  // near band (drawn into the tinted ground layer) + procedural tree line that scrolls with distance (parallax 0.06 px/m)
  function drawNear(m, mCam) {
    const bottom = HORIZON_Y + 2;
    const forest = forestAt(m);
    const off = Math.floor(mCam * 0.06);
    const tex = forest > 0.4 ? PAT_SPRUCE : PAT_LEAF;
    const tw = forest > 0.4 ? 48 : 40, o = ((off % tw) + tw) % tw;
    L.setTransform(1, 0, 0, 1, -o, 0);
    L.fillStyle = tex;
    for (let x = 0; x < W; x++) {
      const u = x + off;
      let bump;
      if (forest > 0.4) { const ph = ((u % 5) + 5) % 5; bump = (ph === 2 ? 4 : ph === 1 || ph === 3 ? 2 : 1) + (hash(Math.floor(u / 5)) * 3 | 0); }
      else { const cl = Math.floor(u / 9); bump = hash(cl) < 0.55 ? 1 + ((hash(cl + 7) * 3) | 0) - (((u % 9) + 9) % 9 === 0 ? 1 : 0) : 0; }
      yTmp[x] = yNear[x] - bump;
    }
    fillCols(L, yTmp, bottom, 0, o);
    L.setTransform(1, 0, 0, 1, 0, 0);
  }

  function screenX(xw, mCam, r) { return Math.round(CX + (xw - mCam) * r); }

  function drawFields(m, mCam, t) {
    const FIELD = 1700;
    for (let y = HORIZON_Y + 1; y < ROAD_TOP; y++) {
      const r = ROW_RATE[y];
      const zone = y < 138 ? 2 : y < 152 ? 1 : 0;
      const par = y & 1;
      const w0 = mCam - (CX + 2) / r, w1 = mCam + (CX + 2) / r;
      const c0 = Math.floor(w0 / FIELD), c1 = Math.floor(w1 / FIELD);
      for (let c = c0; c <= c1; c++) {
        const xa = Math.max(0, screenX(c * FIELD, mCam, r)), xb = Math.min(W, screenX((c + 1) * FIELD, mCam, r));
        if (xb <= xa) continue;
        const f = forestAt((c + 0.5) * FIELD);
        let crop;
        if (f > 0.55) crop = zone === 0 && hash2(c, 5) < 0.6 ? 5 : 6;
        else crop = cropOf(c + zone * 3, zone);
        L.fillStyle = CROPS[crop][par];
        L.fillRect(xa, y, xb - xa, 1);
        if (zone === 0 && crop === 1 && y > 156 && !par) { // sunflower heads near the road
          L.fillStyle = '#4a3216';
          const step = 3, sx0 = xa + (((screenX(0, mCam, r) - xa) % step) + step) % step;
          for (let x = sx0; x < xb; x += step * 2) L.fillRect(x, y, 1, 1);
        }
      }
    }
    // rivers flowing away from the road converge on the vanishing point
    for (let i = 0; i < nRiv; i++) {
      for (let y = HORIZON_Y + 1; y < H; y++) {
        if (y >= ROAD_TOP && y < ROAD_BOT + 4) continue;
        const r = ROW_RATE[y];
        const xa = Math.max(0, screenX(rivLo[i], mCam, r)), xb = Math.min(W, screenX(rivHi[i], mCam, r));
        if (xb <= xa) continue;
        L.fillStyle = ((y + ((t * 2) | 0)) & 3) === 0 ? '#5d93cf' : (y & 1) ? '#3a6fb0' : '#4277b8';
        L.fillRect(xa, y, xb - xa, 1);
      }
    }
  }

  // generic object row; kind: 0 spruce/trees, 1 tree belt, 2 houses, 3 poplars
  function objectRow(kind, baseY, spacing, seed, sizeIdx, mCam) {
    const r = ROW_RATE[baseY];
    const w0 = mCam - (CX + 40) / r, w1 = mCam + (CX + 40) / r;
    const i0 = Math.floor(w0 / spacing), i1 = Math.ceil(w1 / spacing);
    for (let i = i0; i <= i1; i++) {
      const h1 = hash2(i, seed);
      const xw = (i + hash2(i, seed + 1) * 0.6) * spacing;
      if (nRiv && inRiver(xw, 15)) continue;
      const x = screenX(xw, mCam, r);
      if (kind === 0) {
        const f = forestAt(xw);
        const dens = nNear ? townDensity(xw) : 0;
        if (dens > 0.15) continue;
        if (h1 < f * 0.92) {
          const big = h1 < f * 0.3 ? 1 : 0;
          const s = eleAt(xw) < 360 && hash2(i, seed + 5) < 0.6 ? TREE[Math.min(3, sizeIdx + big)] : SPRUCE[Math.min(3, sizeIdx + big)];
          L.drawImage(s, x - (s.width >> 1), baseY - s.height); occlude(s, x - (s.width >> 1), baseY - s.height);
        }
        else if (h1 > 0.93 && f < 0.5) { const s = TREE[sizeIdx]; L.drawImage(s, x - (s.width >> 1), baseY - s.height); occlude(s, x - (s.width >> 1), baseY - s.height); }
      } else if (kind === 1) {
        const cell = Math.floor(xw / 1700);
        if (forestAt(xw) > 0.5 || hash2(cell, seed + 9) > 0.35) continue;
        if (nNear && townDensity(xw) > 0.2) continue;
        const s = TREE[sizeIdx + (h1 < 0.3 ? 1 : 0)];
        L.drawImage(s, x - (s.width >> 1), baseY - s.height + ((h1 * 2) | 0)); occlude(s, x - (s.width >> 1), baseY - s.height + ((h1 * 2) | 0));
      } else if (kind === 2) {
        if (!nNear) return;
        const d = townDensity(xw);
        if (d <= 0 || h1 > Math.min(0.95, Math.pow(d, 0.7) * 1.1)) continue;
        const tk = townKind(xw);
        let k = 0;
        if (tk === 2) k = sizeIdx === 0 && d > 0.45 ? 2 : (h1 < 0.4 ? 1 : 0);
        else if (tk === 1) k = sizeIdx === 0 && d > 0.7 && h1 < 0.3 ? 2 : (d > 0.5 && h1 < 0.5 ? 1 : 0);
        const v = (hash2(i, seed + 3) * 6) | 0;
        if (tk >= 1 && sizeIdx === 0 && hash2(i, seed + 4) < 0.025) k = 3;
        const hs = HOUSES[k][k === 3 ? 0 : v];
        const hx = x - (hs.w >> 1), hy = baseY - hs.h;
        L.drawImage(hs.img, hx, hy);
        occlude(hs.img, hx, hy);
        if (lightsOn && hash2(i, seed + 6) > 0.25) { LG.drawImage(hs.lit, hx, hy); litAny = true; }
      } else if (kind === 3) {
        const seg = Math.floor(xw / 650);
        if (hash2(seg, seed + 2) > 0.32 || forestAt(xw) > 0.5) continue;
        if (nNear && townDensity(xw) > 0.3) continue;
        const s = POPLAR[(h1 * 3) | 0];
        L.drawImage(s, x - 2, baseY - s.height); occlude(s, x - 2, baseY - s.height);
      }
    }
  }

  function drawPoles(mCam) {
    const baseY = 167, r = ROW_RATE[baseY], SP = 60, PH = 24;
    const w0 = mCam - (CX + 80) / r, w1 = mCam + (CX + 80) / r;
    const i0 = Math.floor(w0 / SP), i1 = Math.ceil(w1 / SP);
    let px0 = -9999;
    for (let i = i0; i <= i1; i++) {
      const xw = i * SP;
      if (nRiv && inRiver(xw, 5)) { px0 = -9999; continue; }
      const x = screenX(xw, mCam, r);
      L.fillStyle = '#5a4630'; L.fillRect(x, baseY - PH, 1, PH);
      L.fillStyle = '#4a3a28'; L.fillRect(x - 3, baseY - PH + 2, 7, 1);
      L.fillStyle = '#c8c8c0'; L.fillRect(x - 3, baseY - PH + 1, 1, 1); L.fillRect(x + 3, baseY - PH + 1, 1, 1);
      if (px0 > -9999) { // sagging wires, drawn as horizontal runs
        L.fillStyle = '#34343a';
        for (let w = 0; w < 2; w++) {
          const xa = px0 + (w ? 3 : -3), xb = x + (w ? 3 : -3), y0 = baseY - PH + 1, span = xb - xa;
          if (span <= 1 || xb < 0 || xa >= W) continue;
          let runX = xa, runY = y0;
          for (let xx = xa + 1; xx <= xb; xx++) {
            const tt = (xx - xa) / span, yy = y0 + Math.round(4 * tt * (1 - tt) * 3);
            if (yy !== runY || xx === xb) { L.fillRect(runX, runY, xx - runX, 1); runX = xx; runY = yy; }
          }
        }
      }
      px0 = x;
    }
  }

  function drawKmPosts(mCam) {
    const baseY = 171, r = ROW_RATE[baseY];
    const w0 = mCam - (CX + 20) / r, w1 = mCam + (CX + 20) / r;
    for (let k = Math.max(0, Math.ceil(w0 / 1000)); k <= Math.floor(w1 / 1000); k++) {
      if (k * 1000 > data.lengthM) break;
      const x = screenX(k * 1000, mCam, r);
      let s = kmStr[k]; if (s === undefined) s = kmStr[k] = String(k);
      const tw = measureText(s), pw = tw + 4;
      L.fillStyle = '#e8e8e8'; L.fillRect(x, baseY - 7, 2, 7);
      L.fillStyle = '#202020'; L.fillRect(x - (pw >> 1) - 1, baseY - 16, pw + 2, 9);
      L.fillStyle = '#f4f4f4'; L.fillRect(x - (pw >> 1), baseY - 15, pw, 7);
      drawText(L, s, x - (tw >> 1), baseY - 14, '#111');
    }
  }

  function placeSign(idx, exit) {
    const key = idx * 2 + (exit ? 1 : 0);
    let s = signCache.get(key);
    if (s) return s;
    const name = places[idx].name || '';
    const tw = measureText(name), w = tw + 8, h = 11;
    s = sprite(w, h + 8, (g) => {
      px(g, '#6c6c6c', 2, h, 1, 8); px(g, '#6c6c6c', w - 3, h, 1, 8);
      px(g, '#ffffff', 0, 0, w, h); px(g, '#1d5bb8', 1, 1, w - 2, h - 2);
      drawText(g, name, 4, 3, '#ffffff');
      if (exit) { g.fillStyle = '#d42a2a'; for (let x = 1; x < w - 1; x++) { const y = h - 2 - Math.round((x - 1) * (h - 3) / (w - 3)); g.fillRect(x, y, 1, 1); g.fillRect(x, y - 1, 1, 1); } }
    });
    signCache.set(key, s);
    return s;
  }
  function riverSign(idx) {
    let s = riverSignCache.get(idx);
    if (s) return s;
    const name = 'р. ' + (rivers[idx].name || '');
    const tw = measureText(name), w = tw + 6;
    s = sprite(w, 17, (g) => { px(g, '#6c6c6c', w >> 1, 9, 1, 8); px(g, '#ffffff', 0, 0, w, 9); px(g, '#2a63c4', 1, 1, w - 2, 7); drawText(g, name, 3, 2, '#ffffff'); });
    riverSignCache.set(idx, s);
    return s;
  }
  function clearOfKmPost(xw) { // keep signs ≥ 60 m from a km post so they never overlap
    const d = xw - Math.round(xw / 1000) * 1000;
    return d >= 0 ? (d < 60 ? xw + 60 - d : xw) : (d > -60 ? xw - 60 - d : xw);
  }
  function drawSigns(mCam) {
    const baseY = 173, r = ROW_RATE[baseY];
    for (let i = 0; i < nNear; i++) {
      const p = places[nearP[i]], R = placeR(p) * 0.9 + 150;
      for (let e = 0; e < 2; e++) {
        const xw = clearOfKmPost(placeM[nearP[i]] + (e ? R : -R));
        const x = screenX(xw, mCam, r);
        if (x < -150 || x > W + 150) continue;
        const s = placeSign(nearP[i], e === 1);
        L.drawImage(s, x - (s.width >> 1), baseY - s.height);
      }
    }
    for (let i = 0; i < nRiv; i++) {
      const x = screenX(clearOfKmPost(rivLo[i] - 25), mCam, r);
      if (x < -120 || x > W + 120) continue;
      const s = riverSign(rivIdx[i]);
      L.drawImage(s, x - (s.width >> 1), baseY - s.height);
    }
  }

  function drawRoad(mCam, t) {
    L.fillStyle = '#7a7466'; L.fillRect(0, ROAD_TOP - 1, W, 1);              // far shoulder
    L.fillStyle = '#4a4a4e'; L.fillRect(0, ROAD_TOP, W, ROAD_BOT - ROAD_TOP);  // asphalt
    L.fillStyle = '#55555a'; L.fillRect(0, ROAD_TOP + 4, W, 1); L.fillRect(0, ROAD_BOT - 5, W, 1);
    L.fillStyle = '#dcdcd4'; L.fillRect(0, ROAD_TOP + 1, W, 1); L.fillRect(0, ROAD_BOT - 2, W, 1);
    // centre dashes: 3 m dash, 9 m gap, at 1 px/m (true distance rate)
    L.fillStyle = '#ecece4';
    for (let k = Math.floor((mCam - CX) / 12) - 1; k * 12 < mCam + CX + 12; k++) L.fillRect(screenX(k * 12, mCam, 1), ROAD_REF_Y - 1, 3, 1);
    // asphalt specks for speed feel
    L.fillStyle = '#3e3e42';
    const s0 = Math.floor((mCam - CX) / 7) - 1;
    for (let i = s0; i < s0 + W / 7 + 2; i++) {
      const h1 = hash(i * 5 + 3);
      if (h1 < 0.5) continue;
      L.fillRect(screenX(i * 7 + h1 * 7, mCam, 1), ROAD_TOP + 3 + ((h1 * 1000) | 0) % 14, 2, 1);
    }
    // verge below the road (rates > 1: it races past)
    for (let y = ROAD_BOT; y < H; y++) {
      const r = ROW_RATE[y];
      const off2 = ((Math.floor(mCam * r) % 16) + 16) % 16;
      L.fillStyle = y === ROAD_BOT ? '#6c6a5c' : (y & 1) ? '#4f8a35' : '#558f3a';
      L.fillRect(0, y, W, 1);
      if (y > ROAD_BOT + 1 && (y % 3) === 0) {
        L.fillStyle = '#467d2f';
        for (let x = -off2; x < W; x += 16) L.fillRect(x + ((y * 7) & 7), y, 3, 1);
      }
    }
  }

  function drawBridges(mCam, t) {
    for (let i = 0; i < nRiv; i++) {
      const xa = screenX(rivLo[i], mCam, 1), xb = screenX(rivHi[i], mCam, 1);
      if (xb < -10 || xa > W + 10) continue;
      const a = Math.max(-2, xa - 6), b = Math.min(W + 2, xb + 6);
      // water under and in front of the deck
      for (let y = ROAD_BOT; y < H; y++) {
        const r = ROW_RATE[y], wa = Math.max(0, screenX(rivLo[i], mCam, r)), wb = Math.min(W, screenX(rivHi[i], mCam, r));
        if (wb <= wa) continue;
        L.fillStyle = ((y + ((t * 2) | 0)) & 3) === 0 ? '#5d93cf' : (y & 1) ? '#3a6fb0' : '#4277b8';
        L.fillRect(wa, y, wb - wa, 1);
      }
      // deck girder
      L.fillStyle = '#8c8a84'; L.fillRect(a, ROAD_BOT, b - a, 3);
      L.fillStyle = '#6c6a64'; L.fillRect(a, ROAD_BOT + 3, b - a, 1);
      // piers every 40 m
      L.fillStyle = '#7c7a74';
      for (let k = Math.ceil(rivLo[i] / 40); k * 40 <= rivHi[i]; k++) { const x = screenX(k * 40, mCam, 1.1); L.fillRect(x - 1, ROAD_BOT + 4, 3, H - ROAD_BOT - 4); }
      // far railing
      L.fillStyle = '#b0b4b8'; L.fillRect(a, ROAD_TOP - 5, b - a, 1); L.fillRect(a, ROAD_TOP - 2, b - a, 1);
      const o = ((Math.floor(mCam) % 4) + 4) % 4;
      for (let x = a - o; x < b; x += 4) L.fillRect(x, ROAD_TOP - 5, 1, 5);
    }
  }
  function drawNearRailings(mCam, P) {
    for (let i = 0; i < nRiv; i++) {
      const r = 1.18;
      const a = Math.max(-2, screenX(rivLo[i], mCam, r) - 6), b = Math.min(W + 2, screenX(rivHi[i], mCam, r) + 6);
      if (b < 0 || a > W) continue;
      ctx.fillStyle = '#c8ccd0'; ctx.fillRect(a, ROAD_BOT - 4, b - a, 1); ctx.fillRect(a, ROAD_BOT, b - a, 1);
      ctx.fillStyle = '#9a9ea4';
      const o = ((Math.floor(mCam * r) % 5) + 5) % 5;
      for (let x = a - o; x < b; x += 5) ctx.fillRect(x, ROAD_BOT - 4, 1, 5);
      if (P.night > 0.01) { ctx.fillStyle = P.nightTint; ctx.fillRect(a, ROAD_BOT - 4, b - a, 5); }
    }
  }

  function drawTufts(mCam) {
    const baseY = 212, r = ROW_RATE[baseY], SP = 9;
    const w0 = mCam - (CX + 20) / r, w1 = mCam + (CX + 20) / r;
    for (let i = Math.floor(w0 / SP); i <= Math.ceil(w1 / SP); i++) {
      const h1 = hash2(i, 404);
      if (h1 > 0.35) continue;
      const xw = (i + hash2(i, 405)) * SP;
      if (nRiv && inRiver(xw, 3)) continue;
      const s = TUFT[h1 < 0.08 ? 1 : 0];
      L.drawImage(s, screenX(xw, mCam, r) - (s.width >> 1), baseY - s.height + ((h1 * 40) | 0) % 4);
    }
  }

  function render(distanceM, dt, vehicleDrawFn, opts = {}) {
    dt = dt > 0 ? Math.min(dt, 0.25) : 0;
    clock += dt;
    if (typeof opts.timeOfDay === 'number') tod = ((opts.timeOfDay % 1) + 1) % 1;
    else tod = (tod + dt / DAY_S) % 1;
    const P = PAL[Math.min(PAL_N - 1, (tod * PAL_N) | 0)];
    const m = Math.max(0, Math.min(data.lengthM, +distanceM || 0));

    // smoothed camera heading (circular), snaps on seeks
    const target = bearingBetween(m - 300, m + 300);
    const g = gradeAt(m);
    const tgtTilt = Math.max(-12, Math.min(12, Math.atan(g) * 180 / Math.PI));
    if (!(camHeading === camHeading) || Math.abs(m - lastM) > 2500) { camHeading = target; tiltDeg = tgtTilt; }
    else {
      const d = ((target - camHeading + 540) % 360) - 180;
      camHeading = (camHeading + d * Math.min(1, dt * 2.5) + 360) % 360;
      tiltDeg += (tgtTilt - tiltDeg) * Math.min(1, dt * 4);
    }
    lastM = m;
    const mCam = m + (CX - VEH_X);

    // nearby places & rivers (no allocation)
    nNear = 0;
    for (let i = lowerBound(placeM, mCam - 9000); i < placeM.length && placeM[i] < mCam + 9000 && nNear < 64; i++) {
      if (Math.abs(placeM[i] - mCam) < placeR(places[i]) + 1200) nearP[nNear++] = i;
    }
    nRiv = 0;
    for (let i = lowerBound(riverM, mCam - 1200); i < riverM.length && riverM[i] < mCam + 1200 && nRiv < 8; i++) {
      const hw = riverHalf(rivers[i]);
      rivLo[nRiv] = riverM[i] - hw; rivHi[nRiv] = riverM[i] + hw; rivIdx[nRiv] = i; nRiv++;
    }
    lightsOn = P.night > 0.25; litAny = false;
    if (lightsOn) LG.clearRect(0, 0, W, H);

    ctx.imageSmoothingEnabled = false;
    drawSky(P, mCam);
    drawRidges(P, m, mCam);

    // ground layer (tinted for dusk/night as a whole)
    L.clearRect(0, 0, W, H);
    drawNear(m, mCam);
    drawFields(m, mCam, clock);
    objectRow(0, 136, 14, 11, 0, mCam);
    objectRow(1, 139, 10, 21, 0, mCam);
    objectRow(0, 146, 11, 31, 1, mCam);
    objectRow(2, 149, 22, 41, 0, mCam);
    objectRow(1, 153, 8, 51, 1, mCam);
    objectRow(0, 159, 9, 61, 2, mCam);
    objectRow(2, 162, 18, 71, 1, mCam);
    objectRow(3, 166, 16, 81, 0, mCam);
    drawPoles(mCam);
    drawSigns(mCam);
    drawKmPosts(mCam);
    drawRoad(mCam, clock);
    drawBridges(mCam, clock);
    drawTufts(mCam);
    if (P.hasTint) {
      L.globalCompositeOperation = 'source-atop';
      if (P.dusk > 0.02) { L.fillStyle = P.duskTint; L.fillRect(0, 0, W, H); }
      if (P.night > 0.01) { L.fillStyle = P.nightTint; L.fillRect(0, 0, W, H); }
      L.globalCompositeOperation = 'source-over';
    }
    ctx.drawImage(layer, 0, 0);

    // lit windows at night
    if (litAny) {
      ctx.globalAlpha = Math.min(1, (P.night - 0.25) * 2);
      ctx.drawImage(lcan, 0, 0);
      ctx.globalAlpha = 1;
    }

    // vehicle
    env.t = clock; env.speed = opts.speedMps || 0; env.night = P.night; env.grade = g;
    const flies = !!opts.flies;
    const vy = flies ? GROUND_Y - Math.round(opts.flyAltPx || 0) : GROUND_Y;
    if (flies) {
      const alt = opts.flyAltPx || 0, sw = Math.max(8, Math.round(36 - alt * 0.2));
      ctx.globalAlpha = 0.35 * (1 - Math.min(0.7, alt / 300));
      ctx.fillStyle = '#000';
      ctx.fillRect(VEH_X - (sw >> 1), GROUND_Y - 1, sw, 3);
      ctx.fillRect(VEH_X - (sw >> 1) + 2, GROUND_Y - 2, sw - 4, 5);
      ctx.globalAlpha = 1;
    }
    if (vehicleDrawFn) {
      if (flies || Math.abs(tiltDeg) < 0.6) vehicleDrawFn(ctx, VEH_X, vy, env);
      else {
        V.setTransform(1, 0, 0, 1, 0, 0);
        V.clearRect(0, 0, 256, 160);
        V.imageSmoothingEnabled = false;
        vehicleDrawFn(V, VAX, VAY, env);
        ctx.save();
        ctx.translate(VEH_X, vy);
        ctx.rotate(-tiltDeg * Math.PI / 180);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(vcan, -VAX, -VAY);
        ctx.restore();
      }
    }
    drawNearRailings(mCam, P);

    if (opts.showNote !== false) drawText(ctx, 'висота ×2.5', W - 3, 3, 'rgba(255,255,255,0.75)', { align: 'right', shadow: 'rgba(0,0,0,0.45)' });

    result.night = P.night; result.timeOfDay = tod; result.vehicleX = VEH_X; result.groundY = GROUND_Y;
    return result;
  }

  return { render };
}
