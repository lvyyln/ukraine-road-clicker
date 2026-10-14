// Forward chase-camera road view for «Дорога України» — classic OutRun / Pole Position pseudo-3D, in pixel art.
//
//   createRoadScene(canvas, data) → { render(distanceM, dt, vehicleDrawFn, opts) → { night, timeOfDay, vehicleX, groundY } }
//   opts = { flies, flyAltPx, speedMps, timeOfDay (0..1 override, 0 = midnight, 0.5 = noon), showNote = true }  (as scene.js)
//   vehicleDrawFn(ctx, x, y, env) is called once per frame: x = vehicle centre column, y = wheel-contact row (ROAD_H − 14),
//     env = { night (0..1), timeOfDay, t (s), speed (m/s), steer (−1..1, upcoming curve), grade, view: 'rear' }.
//     Flyers get the ground row too and draw their own altitude + shadow.
//   The returned object is reused every frame (copy fields if you need to keep them).
//
// CAMERA: 4.5 m above the road and Z_V ≈ 10.7 m behind the vehicle, which rides in the right lane (1.75 m right of
//   the centre line). Horizontal FOV 70°: column x ↦ bearing = heading + (x − 240)·70/480; focal length F = 240/tan 35°.
// ROAD: 120 segments from 6 m to ~2.2 km ahead (lengths grow ×1.04), rebuilt from the real route every frame:
//   curvature = the ±50 m smoothed route heading relative to the camera (clamped to ±75° so hairpins stay on screen),
//   hills = smoothed elevation ×2 (bridges levelled bank to bank). The camera pitches with ~55 % of the grade, so on a
//   climb the terrain horizon sinks while the road's own vanishing point rises above it; crests hide what lies beyond.
// GROUND: drawn per pixel into one ImageData — perspective-correct textures in world metres, filtered by pixel footprint,
//   ordered-dither haze with distance and a dithered headlight pool at night. Surfaces: highway / mountain / city asphalt,
//   Lviv cobbles with tram rails, bridge deck; shoulders, kerb stripes, verge bands, ditches, sidewalks, fields, water.
// HORIZON: horizonAt far/mid/near ×2.5 with scene.js's saturation caps, facet-shaded and hazed, shifted by the pitch.
// SPRITES: procedural painters rendered lazily into offscreen canvases at 17 sizes (day + night versions, lit windows),
//   sorted back-to-front and clipped behind crests; building side walls and railings are textured per column in perspective.
import { drawText, measureText } from './pixelfont.js';

export const ROAD_W = 480, ROAD_H = 270;
const W = ROAD_W, H = ROAD_H, CX = W >> 1;
const FOV = 70, PXDEG = W / FOV;
const F = CX / Math.tan(FOV * Math.PI / 360);   // ≈ 342.8 px
const HZ0 = 112;                                  // horizon row on a level road
const VEH_Y = H - 14;                             // wheel-contact row
const CAM_H = 4.5;                                // camera height, m
const Z_V = CAM_H * F / (VEH_Y - HZ0);            // camera → vehicle, m
const VEH_LAT = 1.75;                             // vehicle (and camera) right of the centre line, m
const EXAG = 2.0;                                 // road relief exaggeration
const H_SCALE = 2.5 * PXDEG;                      // px per degree of horizon angle (×2.5)
const MID_SAT = 7, NEAR_SAT = 4.5;                // scene.js caps: a' = K·(1 − e^(−a/K))
const DAY_S = 720;                                // 1 game day = 12 real minutes
const NSEG = 120, S0 = 6, D0 = 0.8, GR = 1.04, LNGR = Math.log(GR);
const CURVE_MAX = 75;
const SKY_BANDS = 24;
const SIZES = [3, 4, 5, 7, 9, 12, 16, 21, 28, 37, 49, 65, 86, 114, 150, 200, 260];
const DENS = [1.5, 3, 6, 12];                     // wall texture densities, px per metre
const CAP = 1100;                                 // draw-list capacity
const BAY = Float32Array.from([0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5], v => (v + 0.5) / 16);
const DEG = Math.PI / 180;

// ---------- helpers ----------
function hash(i) {
  i = Math.imul(i ^ 0x9e3779b9, 0x85ebca6b); i ^= i >>> 13;
  i = Math.imul(i, 0xc2b2ae35); i ^= i >>> 16;
  return (i >>> 0) / 4294967296;
}
const hash2 = (a, b) => hash(Math.imul(a | 0, 73856093) ^ Math.imul(b | 0, 19349663));
function hh(a, b) { // fast per-pixel hash of two ints → [0,1)
  let h = Math.imul((a | 0) ^ Math.imul(b | 0, 0x9e3779b1), 0x85ebca6b);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12;
  return (h >>> 0) * 2.3283064365386963e-10;
}
// table noise for the per-pixel ground: random column offsets + a 4096-entry value table (cheaper than hashing)
const NZ = new Float32Array(4096), NZP = new Int32Array(1024);
for (let i = 0; i < 4096; i++) NZ[i] = hh(i, 911);
for (let i = 0; i < 1024; i++) NZP[i] = (hh(i, 313) * 4096) | 0;
const nz = (i, j) => NZ[(NZP[i & 1023] + j) & 4095];
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;
const smooth = (a, b, v) => { const t = clamp01((v - a) / (b - a)); return t * t * (3 - 2 * t); };
const RGB = c => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const css = c => 'rgb(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ')';
const pack3 = (r, g, b) => ((255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
const pack = c => pack3(Math.round(c[0]), Math.round(c[1]), Math.round(c[2]));
const U = c => pack(RGB(c));
const UA = (...c) => c.map(U);
const wrap180 = d => ((d % 360) + 540) % 360 - 180;
function makeCanvas(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(w, h) : Object.assign(document.createElement('canvas'), { width: w, height: h });
  c.getContext('2d').imageSmoothingEnabled = false;
  return c;
}
const WARM = pack3(255, 200, 110);
const NIGHT_RGB = [6, 10, 34], DUSK_RGB = [255, 110, 40];
function nightOf(c) {
  const r = c & 255, g = (c >>> 8) & 255, b = (c >>> 16) & 255;
  return pack3(Math.round(r + (6 - r) * 0.74), Math.round(g + (10 - g) * 0.74), Math.round(b + (34 - b) * 0.74));
}

// ---------- ground material palette (ids into BASE; each group is consecutive dark → light) ----------
const BASE = [];
function grp(...hx) { const i = BASE.length; for (const c of hx) BASE.push(RGB(c)); return i; }
const AS = grp('#303135', '#3a3b3f', '#434449', '#4f5055', '#5d5e63');      // highway asphalt
const AM = grp('#2d2f34', '#373a40', '#41444a', '#4d5057', '#5a5d64');      // mountain asphalt (bluish)
const AC = grp('#3a3a3d', '#444447', '#4e4e51', '#5a5a5d', '#68686a');      // city asphalt
const AB = grp('#464749', '#515256', '#5c5d61', '#68696d', '#76777a');      // bridge deck
const PATCH = grp('#27282b', '#2d2e31');
const JOINT = grp('#1f2022', '#8a8c8e');
const CB = grp('#29231f', '#584f45', '#685e53', '#786e61', '#8b8172');      // cobbles: seam, 3 tones, highlight
const RL = grp('#5e6064', '#c0c4ca');                                       // tram rail groove, shiny rail
const MK = grp('#e2e2d8', '#b4b4aa');                                       // road paint, worn paint
const SHD = grp('#4a4b4f', '#55565a', '#606165');                           // asphalt shoulder
const GV = grp('#54504a', '#666058', '#787264', '#8b8474');                 // gravel
const KR = grp('#b3332b', '#e4e4dc', '#262628', '#8c8c86');                 // kerb: red, white, black, granite
const GRW = grp('#335c28', '#3c6a2e', '#457634', '#52843c', '#649649');     // west grass
const GRM = grp('#264622', '#2f5428', '#38622e', '#436e36', '#517c42');     // mountain grass
const GRS = grp('#5e6a2e', '#6e7a34', '#7d883c', '#8d9846', '#a1aa56');     // steppe dry grass
const FLW = grp('#ece8dc', '#e8cc3a', '#9a72bc', '#d23a2a');                // flowers
const DIT = grp('#26421f', '#2e4c27', '#3a5866');                           // ditch: deep, side, puddle
const SW = grp('#706c64', '#928e85', '#a09c92', '#aeaaa0');                 // sidewalk tiles
const PP = grp('#7a7a74', '#9a9a94', '#b8b8b0');                            // parapet / walkway concrete
const WA = grp('#1d4070', '#275188', '#33629e', '#4f85bc', '#b0d6f0');      // water
const BK = grp('#58602f', '#6c743b', '#b0a074', '#9a8a5e');                 // bank: reeds, reeds light, sand, wet sand
const WH = grp('#ad8838', '#c09b48', '#d1af58', '#dfc16a', '#ecd486');      // wheat
const SF = grp('#2a3614', '#425426', '#5a6e2e', '#d4900a', '#f0c01c', '#46300f'); // sunflower: leaf ×3, petal ×2, seeds
const CZ = grp('#221912', '#2c2017', '#382a1e', '#463628');                 // chernozem
const PB = grp('#483424', '#58422d', '#685036');                            // ploughed brown soil
const YC = grp('#44652a', '#567a32', '#68903c', '#7ca44a');                 // young crops
const RS = grp('#a4961a', '#c4b428', '#dece38', '#f0e25a');                 // rapeseed
const FF = grp('#162e18', '#1e371c', '#264222', '#304e2a');                 // forest floor
const DT = grp('#62503a', '#746046', '#867254');                            // dirt track
const NB = BASE.length;

// shoulder / kerb / verge / ditch widths per surface style: 0 highway, 1 mountain, 2 city, 3 Lviv cobbles, 4 bridge
const SHW = [1.2, 0.5, 0.3, 0.3, 0.5], KBW = [0.3, 0.3, 0.25, 0.3, 0.35], VGW = [3.0, 1.8, 3.5, 3.2, 1.6], DTW = [1.6, 1.2, 0, 0, 0.5];

// ---------- sky palettes (scene.js approach, precomputed per time-of-day step) ----------
const PAL_N = 256;
const C = {
  dayTop: RGB('#3f78d6'), dayHor: RGB('#b4dcf7'), duskTop: RGB('#3b3f8e'), duskHor: RGB('#f5a05a'),
  nightTop: RGB('#050818'), nightHor: RGB('#1c2648'),
  far: RGB('#9aa2d6'), mid: RGB('#6f7fb0'), near: RGB('#3e6a3c'),
  nightFar: RGB('#1e2444'), nightMid: RGB('#161b36'), nightNear: RGB('#0e1424'), duskTint: RGB('#c46a5a'),
};
function buildPalette(tod) {
  const a = (tod - 0.25) * Math.PI * 2, sunEl = Math.sin(a);
  const night = 1 - smooth(-0.14, 0.1, sunEl);
  const dusk = clamp01(1 - Math.abs(sunEl - 0.02) / 0.22);
  const top = mix(mix(C.dayTop, C.nightTop, night), C.duskTop, dusk * 0.55 * (1 - night * 0.5));
  const hor = mix(mix(C.dayHor, C.nightHor, night), C.duskHor, dusk * 0.8 * (1 - night * 0.6));
  const sky = [];
  for (let i = 0; i < SKY_BANDS; i++) { const t = i / (SKY_BANDS - 1); sky.push(css(mix(top, hor, t * t * 0.6 + t * 0.4))); }
  function band(day, nt, haze) {
    let c = mix(day, nt, night);
    c = mix(c, C.duskTint, dusk * 0.25);
    return mix(c, hor, clamp01(haze + 0.2 * dusk + 0.15 * night));
  }
  const far = band(C.far, C.nightFar, 0.42), mid = band(C.mid, C.nightMid, 0.22), near = band(C.near, C.nightNear, 0.08);
  const wt = [255, 255, 255], bk = [0, 0, 0], lift = 1 - night;
  const R = new Uint32Array(15);
  const tones = (c, rim, lt, sh, low) => [pack(mix(c, wt, rim * lift)), pack(mix(c, wt, lt * lift)), pack(c), pack(mix(c, bk, sh)), pack(mix(c, hor, low))];
  R.set(tones(far, 0.2, 0.08, 0.1, 0.45), 0);
  R.set(tones(mid, 0.14, 0.07, 0.16, 0.35), 5);
  R.set(tones(near, 0.12, 0.1, 0.3, 0.25), 10);
  return {
    sunEl, night, dusk, sky, horizon: sky[SKY_BANDS - 1], hor, R,
    wire: css(mix(mix([40, 40, 46], NIGHT_RGB, 0.6 * night), hor, 0.1)),
  };
}

// ---------- pixel sprites ----------
class Pix {
  constructor(w, h) { this.w = w; this.h = h; this.c = new Uint32Array(w * h); this.n = new Uint32Array(w * h); }
  p(x, y, c, n) { x = Math.floor(x); y = Math.floor(y); if (x < 0 || y < 0 || x >= this.w || y >= this.h) return; const i = y * this.w + x; this.c[i] = c; this.n[i] = n || 0; }
  r(x, y, w, h, c, n) {
    const x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + w), y1 = Math.round(y + h);
    for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) this.p(i, j, c, n);
  }
}
function toEntry(P, post) {
  const d = makeCanvas(P.w, P.h), n = makeCanvas(P.w, P.h);
  const gd = d.getContext('2d'), gn = n.getContext('2d');
  const id = gd.createImageData(P.w, P.h), inn = gn.createImageData(P.w, P.h);
  const ud = new Uint32Array(id.data.buffer), un = new Uint32Array(inn.data.buffer);
  for (let i = 0; i < P.c.length; i++) { const c = P.c[i]; if (!c) continue; ud[i] = c; un[i] = P.n[i] || nightOf(c); }
  gd.putImageData(id, 0, 0); gn.putImageData(inn, 0, 0);
  if (post) { post(gd, false); post(gn, true); }
  return { d, n, w: P.w, h: P.h };
}
// a family of one painted sprite at many pixel sizes, built on first use
class SpriteSet {
  constructor(paint, aspect, v) { this.paint = paint; this.aspect = aspect; this.v = v; this.cache = new Array(SIZES.length).fill(null); }
  pick(hPx) {
    let i = 0; while (i < SIZES.length - 1 && SIZES[i] < hPx * 0.88) i++;
    let e = this.cache[i];
    if (!e) { const h = SIZES[i], w = Math.max(1, Math.round(h * this.aspect)); e = this.cache[i] = toEntry(this.paint(w, h, this.v)); }
    return e;
  }
}
// a wall texture (facade, railing, fence) at a few densities; pick by px-per-metre
class WallTex {
  constructor(paint, lenM, hM, v, post) { this.paint = paint; this.len = lenM; this.hm = hM; this.v = v; this.post = post; this.cache = [null, null, null, null]; }
  pick(pxPerM) {
    let i = 0; while (i < DENS.length - 1 && DENS[i] < pxPerM * 0.8) i++;
    let e = this.cache[i];
    if (!e) {
      const dens = DENS[i], P = this.paint(Math.max(1, Math.round(this.len * dens)), Math.max(1, Math.round(this.hm * dens)), dens, this.v, this.len, this.hm);
      e = this.cache[i] = toEntry(P, this.post ? (g, night) => this.post(g, night, dens, P.w, P.h) : null);
      e.dens = dens;
    }
    return e;
  }
}

// --- trees & plants ---
const BARK = UA('#2e2016', '#45311f', '#5e452c');
const SPR_T = UA('#0f2718', '#163421', '#1e432a', '#285433', '#386a3e');
const BIRCH_L = UA('#2c5222', '#3a6a2c', '#4c8236', '#609e44', '#7eba58');
const BIRCH_B = UA('#262320', '#c8c5ba', '#eceae2');
const OAK_L = UA('#1d381a', '#284b21', '#345e29', '#447335', '#5a8a44');
const POP_L = UA('#18361c', '#214528', '#2c5630', '#3a6838', '#508048');
const WIL_L = UA('#38582a', '#486a32', '#5a7c3e', '#6e8e4c', '#88a25c');
const ORCH_L = UA('#28501e', '#346226', '#427630', '#548a3c', '#6aa04a');
const tone5 = (T, s) => T[s < 0.6 ? 0 : s < 1.5 ? 1 : s < 2.4 ? 2 : s < 3.2 ? 3 : 4];

function crown(P, x0, y0, cw, ch, v, T, holes, droop) {
  const nb = 9, bx = new Float32Array(nb), by = new Float32Array(nb), br = new Float32Array(nb);
  const R = Math.min(cw, ch);
  bx[0] = x0 + cw * 0.5; by[0] = y0 + ch * 0.55; br[0] = R * 0.42;
  for (let i = 1; i < nb; i++) {
    const a = hash2(v * 31 + i, 1) * Math.PI * 2, d = 0.16 + 0.17 * hash2(v * 31 + i, 2);
    bx[i] = x0 + cw * (0.5 + Math.cos(a) * d * 1.15); by[i] = y0 + ch * (0.5 + Math.sin(a) * d * 0.95); br[i] = R * (0.19 + 0.11 * hash2(v * 31 + i, 3));
  }
  for (let y = Math.floor(y0); y < y0 + ch; y++) for (let x = Math.floor(x0); x < x0 + cw; x++) {
    let best = -1, bi = 0;
    for (let i = 0; i < nb; i++) {
      const dx = (x + 0.5 - bx[i]) / br[i], dy = (y + 0.5 - by[i]) / (br[i] * (droop ? 1.18 : 1));
      const q = 1 - (dx * dx + dy * dy);
      if (q > best) { best = q; bi = i; }
    }
    if (best <= 0) continue;
    if (best < 0.25 && hash2(x * 7 + v, y * 13 + 5) < holes) continue;
    const nx = (x + 0.5 - bx[bi]) / br[bi], ny = (y + 0.5 - by[bi]) / br[bi];
    const cl = R > 9 ? (hash2((x >> 1) + v * 17, (y >> 1) + 3) - 0.5) * 1.5 : 0;
    let s = 2.2 - nx * 0.9 - ny * 1.25 + cl + (hash2(x + v * 5, y * 3 + 1) - 0.5) * 0.7;
    s -= ((y - y0) / ch - 0.5) * 0.9 + ((x - x0) / cw - 0.5) * 0.5;
    P.p(x, y, tone5(T, s));
  }
}
function trunk(P, cx, y0, y1, tw, T) {
  const x0 = Math.round(cx - tw / 2);
  for (let y = Math.round(y0); y < y1; y++) for (let i = 0; i < tw; i++) P.p(x0 + i, y, T[tw === 1 ? 1 : i === 0 ? 2 : i === tw - 1 ? 0 : 1]);
}
function pSpruce(w, h, v) {
  const P = new Pix(w, h), cx = w / 2;
  const th = Math.max(1, Math.round(h * 0.09));
  trunk(P, cx, h - th - 1, h, Math.max(1, Math.round(w * 0.1)), BARK);
  const bot = h - th, nT = Math.max(2, Math.min(9, Math.round(h / 9)));
  for (let y = 0; y < bot; y++) {
    const t = (y + 0.5) / bot, tf = t * nT, ti = Math.floor(tf), tt = tf - ti;
    let hw = h < 10 ? cx * (0.15 + 0.85 * t) : cx * (0.08 + 0.92 * t) * (0.58 + 0.42 * tt) + (hash2(y + v * 131, 7) - 0.5) * w * 0.08;
    hw = Math.max(0.5, hw);
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - cx) / hw;
      if (dx < -1 || dx > 1) continue;
      if (h >= 12 && Math.abs(dx) > 0.8 && hash2(x + v * 3, y) < 0.35) continue;
      let s = 2.1 - dx * 1.1 + (tt - 0.5) * 0.9;
      if (tt < 0.22 && ti > 0) s -= 1.1;
      s += (hash2(x * 31 + v, y * 17 + 3) - 0.5) * 1.3;
      P.p(x, y, tone5(SPR_T, s));
    }
  }
  return P;
}
function pBirch(w, h, v) {
  const P = new Pix(w, h), tw = Math.max(1, Math.round(w * 0.08)), tx = Math.round(w / 2 - tw / 2 + (hash2(v, 9) - 0.5) * w * 0.12);
  const seg = Math.max(1, Math.round(h / 36));
  for (let y = Math.round(h * 0.28); y < h; y++) for (let i = 0; i < tw; i++) {
    const mark = hash2(Math.floor(y / seg) + v * 7, i > 0 ? 4 : 3) < 0.22;
    P.p(tx + i, y, mark ? BIRCH_B[0] : (tw > 1 && i === tw - 1 ? BIRCH_B[1] : BIRCH_B[2]));
  }
  crown(P, 0, 0, w, h * 0.74, v, BIRCH_L, 0.32, true);
  return P;
}
function pOak(w, h, v) {
  const P = new Pix(w, h);
  trunk(P, w / 2, h * 0.55, h, Math.max(1, Math.round(w * 0.1)), BARK);
  crown(P, 0, 0, w, h * 0.8, v, OAK_L, 0.08, false);
  return P;
}
function pPoplar(w, h, v) {
  const P = new Pix(w, h), ch = Math.round(h * 0.94);
  trunk(P, w / 2, ch - 2, h, Math.max(1, Math.round(w * 0.12)), BARK);
  for (let y = 0; y < ch; y++) {
    const t = y / ch;
    let f = t < 0.12 ? 0.25 + t / 0.12 * 0.45 : t < 0.8 ? 0.7 + 0.3 * Math.sin((t - 0.12) / 0.68 * Math.PI * 0.5) : 1 - (t - 0.8) / 0.2 * 0.4;
    const hw = Math.max(0.5, (w / 2) * f + (hash2(y + v * 11, 2) - 0.5) * w * 0.12);
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - w / 2) / hw;
      if (dx < -1 || dx > 1) continue;
      const streak = hash2(x + v * 13, Math.floor(y / 3 + hash2(x, v) * 3));
      P.p(x, y, tone5(POP_L, 2.2 - dx * 1.2 + (streak - 0.5) * 1.7 - (t > 0.86 ? 0.7 : 0)));
    }
  }
  return P;
}
function pBush(w, h, v) { const P = new Pix(w, h); crown(P, 0, 0, w, h + 1, v, OAK_L, 0.1, false); return P; }
function pFruit(w, h, v) {
  const P = new Pix(w, h);
  trunk(P, w / 2, h * 0.5, h, Math.max(1, Math.round(w * 0.09)), BARK);
  crown(P, 0, 0, w, h * 0.72, v, ORCH_L, 0.12, false);
  const dot = v & 1 ? U('#c8281e') : U('#f2eee8');
  for (let i = 0; i < w * h / 40; i++) { const x = hash2(v * 5 + i, 1) * w, y = hash2(v * 5 + i, 2) * h * 0.65; if (P.c[(y | 0) * w + (x | 0)]) P.p(x, y, dot); }
  return P;
}
function pWillow(w, h, v) {
  const P = new Pix(w, h);
  trunk(P, w / 2, h * 0.45, h, Math.max(1, Math.round(w * 0.1)), BARK);
  crown(P, 0, 0, w, h * 0.62, v, WIL_L, 0.15, true);
  for (let x = 0; x < w; x++) { // hanging strands
    if (hash2(x + v, 9) < 0.45) continue;
    let top = -1; for (let y = 0; y < h; y++) if (P.c[y * w + x]) { top = y; }
    if (top < 0) continue;
    const len = h * (0.1 + 0.2 * hash2(x, v + 3));
    for (let y = top; y < Math.min(h - 1, top + len); y++) P.p(x, y, WIL_L[(x + y) & 1 ? 2 : 3]);
  }
  return P;
}
const HAY = UA('#6e5420', '#8c6c2a', '#a88838', '#c4a44c', '#d8bc66');
function pHay(w, h, v) {
  const P = new Pix(w, h);
  for (let y = Math.round(h * 0.12); y < h; y++) {
    const t = (y - h * 0.12) / (h * 0.88), hw = (w / 2) * (t < 0.6 ? Math.sqrt(t / 0.6) : 1 - (t - 0.6) * 0.15);
    for (let x = 0; x < w; x++) {
      const dx = (x + 0.5 - w / 2) / Math.max(0.5, hw);
      if (dx < -1 || dx > 1) continue;
      P.p(x, y, tone5(HAY, 2.4 - dx * 1.1 - t * 0.8 + (hash2(x * 3 + v, y) - 0.5) * 1.2 + ((y + (x >> 1)) % 3 === 0 ? -0.6 : 0)));
    }
  }
  P.r(w / 2, 0, 1, h * 0.2, BARK[1]);
  return P;
}
function pReeds(w, h, v) {
  const P = new Pix(w, h), G = UA('#3a4a1e', '#4e6026', '#667a30', '#82923c'), head = U('#4a2e16');
  for (let x = 0; x < w; x++) {
    if (hash2(x + v * 7, 1) < 0.25) continue;
    const top = Math.round(h * (0.05 + 0.4 * hash2(x, v + 2)));
    for (let y = top; y < h; y++) P.p(x, y, G[Math.min(3, ((y - top) / (h - top) * 2 + hash2(x, y) * 2) | 0)]);
    if (hash2(x, v + 5) < 0.3 && h > 8) P.r(x, top, 1, Math.max(1, h * 0.12), head);
  }
  return P;
}
function pSunfl(w, h, v) {
  const P = new Pix(w, h), L = [SF, SF + 1, SF + 2].map(i => pack(BASE[i]));
  const pet = [pack(BASE[SF + 3]), pack(BASE[SF + 4])], seed = pack(BASE[SF + 5]);
  for (let y = Math.round(h * 0.32); y < h; y++) for (let x = 0; x < w; x++) { // leafy mass
    const edge = h * 0.32 + (hash2(x + v, 3) * 0.12 + Math.sin(x * 0.9 + v) * 0.04) * h;
    if (y < edge) continue;
    const s = 1.4 + (hash2((x >> 1) + v, y >> 1) - 0.5) * 2 - (y / h) * 0.9;
    P.p(x, y, L[s < 0.6 ? 0 : s < 1.4 ? 1 : 2]);
  }
  const n = Math.max(2, Math.round(w / Math.max(3, h * 0.28)));
  const r = Math.max(1, h * 0.11);
  for (let i = 0; i < n; i++) {
    const hx = (i + 0.5 + (hash2(v, i) - 0.5) * 0.6) * w / n, hy = h * (0.13 + 0.12 * hash2(i, v + 1));
    P.r(hx, hy, 1, h - hy, L[1]);
    for (let y = Math.floor(hy - r); y <= hy + r; y++) for (let x = Math.floor(hx - r); x <= hx + r; x++) {
      const d = Math.hypot(x + 0.5 - hx, (y + 0.5 - hy) * 1.15);
      if (d > r + 0.3) continue;
      P.p(x, y, d < r * 0.5 ? seed : (y > hy ? pet[0] : pet[1]));
    }
  }
  return P;
}
function pWheat(w, h, v) {
  const P = new Pix(w, h), T = [WH, WH + 1, WH + 2, WH + 3, WH + 4].map(i => pack(BASE[i])), poppy = U('#d0201a');
  for (let x = 0; x < w; x++) {
    const top = Math.round(h * (0.08 + 0.3 * hash2(x + v * 9, 1)));
    for (let y = top; y < h; y++) {
      const ear = y < top + Math.max(1, h * 0.22);
      P.p(x, y, T[ear ? ((x + y) & 1 ? 4 : 3) : Math.max(0, 2 - Math.floor((y - top) / (h - top) * 3) + (hash2(x, y) < 0.2 ? 1 : 0))]);
    }
    if (h > 6 && hash2(x, v + 4) < 0.05) P.r(x, h * 0.4, 1, 1, poppy);
  }
  return P;
}
const POLE_C = UA('#585854', '#77776f', '#96968e', '#b8b8b0'), INS = UA('#7aa898', '#c4e0d6');
function pPole(w, h, v) {
  const P = new Pix(w, h), cx = Math.floor(w / 2), pw = Math.max(1, Math.round(h * 0.03));
  for (let y = Math.round(h * 0.03); y < h; y++) for (let i = 0; i < pw; i++) P.p(cx - (pw >> 1) + i, y, POLE_C[pw === 1 ? 2 : i === 0 ? 3 : i === pw - 1 ? 0 : 2]);
  const ay = Math.round(h * 0.09), ah = Math.max(1, Math.round(h * 0.022));
  P.r(0, ay, w, ah, POLE_C[1]); if (ah > 1) P.r(0, ay, w, 1, POLE_C[2]);
  const ih = Math.max(1, Math.round(h * 0.035));
  for (const ix of [1, w - 2, cx]) { P.r(ix, (ix === cx ? 0 : ay - ih), 1, ih, INS[1]); if (ih > 2) P.r(ix, (ix === cx ? 0 : ay - ih) + ih - 1, 1, 1, INS[0]); }
  return P;
}
const LAMP_C = UA('#3e4a44', '#56645c', '#728078'), LENS = U('#e8e4cc'), LENS_N = U('#fff2b0');
function pLamp(w, h, dir) { // dir = +1: arm points right, −1: left
  const P = new Pix(w, h), pw = Math.max(1, Math.round(h * 0.025)), px0 = dir > 0 ? 1 : w - 1 - pw;
  for (let y = Math.round(h * 0.06); y < h; y++) for (let i = 0; i < pw; i++) P.p(px0 + i, y, LAMP_C[i === 0 ? 2 : 1]);
  const ay = Math.round(h * 0.06), hx0 = dir > 0 ? px0 : Math.round(w * 0.12);
  P.r(Math.min(px0, hx0), ay, Math.abs(px0 - (dir > 0 ? w - 1 : hx0)) + 1, Math.max(1, h * 0.015), LAMP_C[0]);
  const lw = Math.max(2, Math.round(w * 0.35)), lx = dir > 0 ? w - lw : 0;
  P.r(lx, ay, lw, Math.max(1, h * 0.03), LAMP_C[0]);
  P.r(lx, ay + Math.max(1, Math.round(h * 0.03)), lw, Math.max(1, Math.round(h * 0.012)), LENS, LENS_N);
  return P;
}
const CH_W = UA('#c8c2b4', '#ddd8cc', '#f2eee4'), GOLD = UA('#6e4a06', '#a07410', '#d4a020', '#f0c840', '#fff0a8');
const BLUE_D = UA('#162a54', '#1f3c74', '#2c5498', '#4674bc', '#94bcee'), WOOD_C = UA('#2a1c12', '#3a281a', '#4c3624', '#62482e');
function onion(P, cx, cy, rx, ry, T, stars) { // onion dome with spike, centre (cx, cy) = widest point
  const top = cy - ry * 1.9;
  for (let y = Math.floor(top); y <= cy + ry * 0.75; y++) {
    const t = (y + 0.5 - top) / (cy - top);
    const hw = t <= 1 ? rx * Math.pow(Math.sin(Math.min(1, t) * Math.PI / 2), 1.8) : rx * Math.sqrt(Math.max(0, 1 - Math.pow((y + 0.5 - cy) / (ry * 0.75), 2)));
    for (let x = Math.floor(cx - hw); x < cx + hw; x++) {
      const dx = (x + 0.5 - cx) / Math.max(0.5, hw);
      let s = 2.6 - dx * 1.4 - (t > 1 ? 0.6 : 0);
      if (Math.abs(dx + 0.45) < 0.12 && t > 0.5 && t < 1.15) s = 4;
      if (stars && hash2(x, y) < 0.06) { P.p(x, y, GOLD[4]); continue; }
      P.p(x, y, tone5(T, s));
    }
  }
  P.r(cx, top - ry * 0.9, 1, ry * 0.95, GOLD[3]); P.r(cx - Math.max(1, rx * 0.25), top - ry * 0.65, Math.max(1, rx * 0.5) * 2 + 1, 1, GOLD[3]);
}
function pChurch(w, h, v) {
  const P = new Pix(w, h);
  if (v === 2) { // Carpathian wooden tserkva: log walls + three stacked shingle roofs
    const base = h * 0.72;
    for (let y = Math.round(base); y < h; y++) for (let x = Math.round(w * 0.1); x < w * 0.9; x++) P.p(x, y, WOOD_C[(y % 3 === 0 ? 0 : x > w * 0.7 ? 1 : 2)]);
    const tiers = [[0.5, 0.86, 0.5, 0.72], [0.62, 0.62, 0.36, 0.5], [0.4, 0.4, 0.22, 0.34]];
    for (const [cy0, hw0, cy1] of tiers) {
      const y0 = h * cy1, y1 = h * (cy0 + 0.22);
      for (let y = Math.round(y0); y < Math.min(base, y1); y++) {
        const t = (y - y0) / (y1 - y0), hw = w * hw0 * 0.5 * (0.35 + 0.65 * t);
        for (let x = Math.floor(w / 2 - hw); x < w / 2 + hw; x++) P.p(x, y, WOOD_C[((x + (y >> 1)) & 1) ? 1 : (x > w / 2 ? 0 : 3)]);
      }
    }
    onion(P, w / 2, h * 0.17, Math.max(1, w * 0.09), Math.max(1, h * 0.05), UA('#3a3c40', '#585a5e', '#7c7e82', '#a2a4a8', '#d0d2d6'));
    P.r(w * 0.42, h * 0.84, w * 0.16, h * 0.16, WOOD_C[0]);
    return P;
  }
  const T = v === 1 ? BLUE_D : GOLD;
  const b0 = h * 0.56;
  for (let y = Math.round(b0); y < h; y++) for (let x = Math.round(w * 0.14); x < w * 0.86; x++) P.p(x, y, x > w * 0.66 ? CH_W[1] : CH_W[2]);
  for (let x = Math.round(w * 0.12); x < w * 0.88; x++) P.p(x, b0 - 1, U('#3e6a4a'));
  P.r(w * 0.12, b0 - 1, w * 0.76, Math.max(1, h * 0.02), U('#3e6a4a'));
  for (let i = 0; i < 3; i++) { const wx = w * (0.26 + i * 0.2); P.r(wx, h * 0.66, Math.max(1, w * 0.06), h * 0.12, U('#283446'), U('#ffcf6a')); }
  P.r(w * 0.44, h * 0.82, w * 0.12, h * 0.18, U('#5a3a24'));
  for (let y = Math.round(h * 0.3); y < b0; y++) for (let x = Math.round(w * 0.36); x < w * 0.64; x++) P.p(x, y, x > w * 0.56 ? CH_W[1] : CH_W[2]);
  P.r(w * 0.47, h * 0.38, Math.max(1, w * 0.05), h * 0.1, U('#283446'), U('#ffcf6a'));
  onion(P, w / 2, h * 0.24, Math.max(1, w * 0.16), Math.max(1, h * 0.065), T, v === 1);
  for (const sx of [0.22, 0.78]) {
    for (let y = Math.round(h * 0.47); y < b0; y++) for (let x = Math.round(w * (sx - 0.06)); x < w * (sx + 0.06); x++) P.p(x, y, CH_W[2]);
    onion(P, w * sx, h * 0.43, Math.max(1, w * 0.08), Math.max(1, h * 0.035), T, v === 1);
  }
  return P;
}
function pKmPost(w, h) {
  const P = new Pix(w, h);
  P.r(0, 0, w, h, U('#ecece6')); P.r(w - Math.max(1, w * 0.25), 0, Math.max(1, w * 0.25), h, U('#c4c4bc'));
  P.r(0, 0, w, Math.max(1, h * 0.22), U('#1e1e20'));
  return P;
}

// --- walls: guard rail, bridge railing, picket fence (repeating, transparent) ---
function pGuard(w, h, dens) { // 8 m × 0.9 m W-beam on posts every 2 m
  const P = new Pix(w, h), post = UA('#3a3c40', '#585a5e'), beam = UA('#6e7276', '#9a9ea2', '#c4c8cc', '#dfe3e6');
  for (let x = 0; x < w; x++) {
    const um = (x + 0.5) / dens;
    for (let y = 0; y < h; y++) {
      const vm = (h - y - 0.5) / dens;
      if (vm > 0.45 && vm < 0.8) { const b = (vm - 0.45) / 0.35; P.p(x, y, beam[b > 0.8 ? 1 : b > 0.55 ? 3 : b > 0.3 ? 2 : 0]); }
      else if ((um % 2) < Math.max(0.12, 1 / dens) && vm < 0.8) P.p(x, y, post[(um % 2) < 0.06 ? 1 : 0]);
    }
    if ((um % 8) < Math.max(0.1, 1 / dens)) P.p(x, Math.round(h - 0.62 * dens), U('#e04030'), U('#ff7050'));
  }
  return P;
}
function pRail(w, h, dens, v) { // 6 m × 1.1 m bridge railing
  const cols = [UA('#6a7884', '#94a4b0', '#c0ccd4'), UA('#3e5a48', '#5c7c66', '#86a690'), UA('#7a7e84', '#a4a8ae', '#d0d4d8')][v % 3];
  const P = new Pix(w, h);
  for (let x = 0; x < w; x++) {
    const um = (x + 0.5) / dens;
    for (let y = 0; y < h; y++) {
      const vm = (h - y - 0.5) / dens;
      if (vm > 0.98) P.p(x, y, cols[2]);
      else if (vm > 0.9) P.p(x, y, cols[1]);
      else if ((um % 3) < Math.max(0.16, 1 / dens)) P.p(x, y, cols[(um % 3) < 0.08 ? 2 : 0]);
      else if (vm > 0.42 && vm < 0.5) P.p(x, y, cols[1]);
      else if (vm < 0.12) P.p(x, y, cols[0]);
      else if (dens >= 6 && (um % 0.25) < 1 / dens) P.p(x, y, cols[0]);
    }
  }
  return P;
}
function pFence(w, h, dens, v) { // 6 m × 1.3 m picket fence, painted
  const paint = [UA('#2e5a3a', '#3e7a4c', '#5a9a66'), UA('#2e4a7a', '#3e62a0', '#5a82c0'), UA('#5a3e26', '#765234', '#946c46'), UA('#8a8478', '#aaa498', '#c8c2b4')][v % 4];
  const P = new Pix(w, h);
  for (let x = 0; x < w; x++) {
    const um = (x + 0.5) / dens, pk = um % 0.16, post = (um % 3) < 0.12;
    for (let y = 0; y < h; y++) {
      const vm = (h - y - 0.5) / dens;
      if (post) P.p(x, y, paint[0]);
      else if (vm > 0.25 && vm < 0.33 || vm > 1.0 && vm < 1.08) P.p(x, y, paint[0]);
      else if (pk < 0.1 && vm < 1.25 - (pk > 0.07 ? 0.04 : 0)) P.p(x, y, paint[pk < 0.03 ? 2 : 1]);
    }
  }
  return P;
}

// --- buildings: facades painted in metres, so every density shows the same house ---
// kinds: 0 village hata, 1 cottage, 2 khrushchovka (5 fl), 3 panel tower (9/16 fl), 4 Lviv tenement, 5 shop
const BK_FRONT = [8, 9, 12, 13, 12, 8];
const BK_SIDEH = [4.6, 7.6, 15.0, 0, 20.0, 4.6];
const BK_FRONTH = [6.0, 9.0, 15.0, 0, 20.0, 4.6];
const towerFloors = v => v >= 3 ? 16 : 9;
const HATA_WALL = ['#ece6d6', '#a9c6dc', '#e6d79e', '#d8e4cc', '#f0ece4', '#c4d8e8'].map(RGB);
const ROOFS = [UA('#6a2a20', '#8a3a2a', '#a44a34'), UA('#2a4c38', '#3a6a4a', '#4c8460'), UA('#3a4a5e', '#4a5a6e', '#5e7084'), UA('#6e6e68', '#8a8a84', '#a2a29c'), UA('#4a2e22', '#5e3c2c', '#764c36')];
const PANEL = ['#c9c2b0', '#b9b5aa', '#d6cfbd', '#b8bfc2', '#cfc6a8', '#c4c8c8'].map(RGB);
const LVIV = ['#d8b46a', '#d89a86', '#a8c4a0', '#e6d6ae', '#a8bcd0', '#c8a8c0', '#e0c890'].map(RGB);
const GLASS = UA('#1e2a3a', '#2a3a4e', '#5a7a98');
const LIT = UA('#ffd36a', '#ffc45a', '#ffe6a0', '#f4b04a', '#bcd4ff');
const WOODF = U('#7a5636'), WHITEF = U('#eeeeea'), DOOR = UA('#3e2a1c', '#5a3e28');
const shadeRGB = (c, f) => pack(mix(c, f > 0 ? [255, 255, 255] : [0, 0, 0], Math.abs(f)));

function facadePaint(kind, face) {
  return function paint(w, h, dens, v, lenM, hM) {
    const P = new Pix(w, h), px = 1 / dens;
    const winLit = (i, j, p) => hash2(i * 131 + v * 7 + face * 977, j * 17 + kind) < p;
    const litCol = (i, j) => LIT[(hash2(i + v, j * 3 + 1) * LIT.length) | 0];
    const glass = (um, vm, x0, y0, ww, wh, i, j, p, frame) => { // returns true if pixel drawn
      if (um < x0 || um >= x0 + ww || vm < y0 || vm >= y0 + wh) return false;
      const fx = Math.min(um - x0, x0 + ww - um), fy = Math.min(vm - y0, y0 + wh - vm);
      const fw = Math.max(0.1, px * 0.9);
      if (fx < fw || fy < fw || (dens >= 6 && Math.abs(um - (x0 + ww / 2)) < px * 0.5 && ww > 0.9)) { P.p(xg, yg, frame); return true; }
      const lit = winLit(i, j, p), refl = (vm - y0) > wh * 0.6 && (um - x0) < ww * 0.4;
      P.p(xg, yg, refl ? GLASS[2] : GLASS[(i + j) & 1], lit ? litCol(i, j) : pack3(14, 18, 30));
      return true;
    };
    let xg = 0, yg = 0;
    for (yg = 0; yg < h; yg++) for (xg = 0; xg < w; xg++) {
      const um = (xg + 0.5) * px, vm = hM - (yg + 0.5) * px, grain = hash2(xg * 7 + v, yg * 5 + kind) - 0.5;
      if (kind === 0 || kind === 1 || kind === 5) {
        const wallC = kind === 1 ? (v & 1 ? RGB('#9a4a32') : RGB(['#e8d8b8', '#d8c098', '#f0e8d8'][v % 3])) : kind === 5 ? RGB(['#e8e4dc', '#d8dce0', '#ece0c8'][v % 3]) : HATA_WALL[v % HATA_WALL.length];
        const wallH = kind === 1 ? 6.2 : kind === 5 ? 4.0 : 3.0, roof = ROOFS[(v >> 1) % ROOFS.length];
        if (vm < wallH) {
          if (vm < 0.45) { P.p(xg, yg, shadeRGB(kind === 0 ? RGB(['#5a6a7a', '#7a5a42', '#4e5e4e'][v % 3]) : RGB('#6a645a'), vm > 0.4 ? 0.15 : grain * 0.1)); continue; }
          if (vm > wallH - 0.22) { P.p(xg, yg, shadeRGB(wallC, -0.32)); continue; }
          if (kind === 5 && face === 0) { // storefront + sign band
            if (vm > 2.9 && vm < 3.8) { P.p(xg, yg, U(['#b8282a', '#1f5aa8', '#2a7a3a'][v % 3])); continue; }
            if (vm > 0.5 && vm < 2.6) {
              const bay = Math.floor(um / 1.6), fu = um - bay * 1.6;
              if (bay === 1) { P.p(xg, yg, fu < 0.1 || fu > 1.5 ? U('#9aa0a6') : DOOR[0]); continue; }
              if (fu < 0.08 || vm < 0.6 || vm > 2.5) { P.p(xg, yg, U('#9aa0a6')); continue; }
              P.p(xg, yg, (vm > 1.9 && fu < 0.6) ? GLASS[2] : GLASS[1], LIT[2]); continue;
            }
          }
          let drawn = false;
          if (face === 0) {
            const doorAt = Math.round(lenM * 0.62 / 2.6) * 2.6 - 1.3;
            if (kind !== 5 && um > doorAt && um < doorAt + 0.95 && vm < 2.1) { P.p(xg, yg, (um - doorAt) < 0.12 ? DOOR[0] : DOOR[1]); continue; }
            const bay = Math.floor((um - 0.6) / 2.6), bx = 0.6 + bay * 2.6 + 0.8;
            if (bay >= 0 && Math.abs(bx + 0.5 - doorAt - 0.45) > 1.2) {
              for (let fl = 0; fl < (kind === 1 ? 2 : 1) && !drawn; fl++) {
                const y0 = 0.95 + fl * 3.0;
                if (kind === 0 && um > bx - 0.15 && um < bx + 1.15 && vm > y0 - 0.15 && vm < y0 + 1.35 && !(um > bx && um < bx + 1.0 && vm > y0 && vm < y0 + 1.2)) { P.p(xg, yg, v & 1 ? U('#3a5aa0') : WHITEF); drawn = true; break; }
                drawn = glass(um, vm, bx, y0, 1.0, 1.2, bay, fl, 0.5, kind === 0 ? WOODF : WHITEF);
              }
            }
          } else {
            const nW = kind === 1 ? 2 : 2;
            for (let i = 0; i < nW && !drawn; i++) for (let fl = 0; fl < (kind === 1 ? 2 : 1) && !drawn; fl++) {
              const bx = lenM * (i === 0 ? 0.22 : 0.78) - 0.5, y0 = 0.95 + fl * 3.0;
              if (kind === 0 && um > bx - 0.15 && um < bx + 1.15 && vm > y0 - 0.15 && vm < y0 + 1.35 && !(um > bx && um < bx + 1.0 && vm > y0 && vm < y0 + 1.2)) { P.p(xg, yg, v & 1 ? U('#3a5aa0') : WHITEF); drawn = true; break; }
              drawn = glass(um, vm, bx, y0, 1.0, 1.2, i + 7, fl, 0.5, kind === 0 ? WOODF : WHITEF);
            }
          }
          if (drawn) continue;
          if (kind === 1 && v & 1 && dens >= 6) { // brick courses
            const row = Math.floor(vm / 0.26), off = (row & 1) * 0.13;
            if ((vm % 0.26) < px * 0.9 || ((um + off) % 0.52) < px * 0.9) { P.p(xg, yg, shadeRGB(wallC, 0.25)); continue; }
          }
          P.p(xg, yg, shadeRGB(wallC, grain * 0.08 - (vm < 0.9 ? 0.06 : 0)));
          continue;
        }
        // roof: gable on the front face, slope band on the side face
        if (face === 1 && kind !== 5) {
          const rh = hM - wallH, half = (1 - (vm - wallH) / rh) * (lenM / 2 + 0.35), d = Math.abs(um - lenM / 2);
          if (d > half) continue;
          if (d > half - 0.35) { P.p(xg, yg, roof[(vm - wallH) < 0.1 ? 0 : 2]); continue; }
          if (vm > wallH + rh * 0.3 && vm < wallH + rh * 0.3 + 0.55 && d < 0.3) { P.p(xg, yg, GLASS[0], LIT[1]); continue; }
          P.p(xg, yg, v & 2 ? shadeRGB(wallC, -0.05 + grain * 0.06) : pack(RGB(((um * 5) | 0) & 1 ? '#7a5a3a' : '#6a4c30')));
          continue;
        }
        if (kind === 5) { P.p(xg, yg, vm > hM - 0.15 ? U('#5a5a5a') : U('#7a7a76')); continue; }
        const rv = vm - wallH;
        if (rv < 0.12) { P.p(xg, yg, roof[0]); continue; }
        const chim = (um % (lenM * 0.7)) > lenM * 0.3 && (um % (lenM * 0.7)) < lenM * 0.3 + 0.55 && um < lenM - 0.6;
        if (chim) { P.p(xg, yg, U(rv > hM - wallH - 0.12 ? '#5a5a58' : '#8a4a36')); continue; }
        if (rv > hM - wallH - 0.85 && !chim) { if (rv > hM - wallH - 0.2) { P.p(xg, yg, roof[2]); continue; } }
        if (rv > hM - wallH - 0.2) continue;
        const corr = (v >> 1) % ROOFS.length === 3 ? ((Math.floor(rv * 4) + Math.floor(um * 1.2)) & 1) : (Math.floor(um * 4) & 1);
        P.p(xg, yg, roof[corr ? 1 : (dens >= 6 ? 2 : 1)]);
        continue;
      }
      if (kind === 2 || kind === 3) { // panel blocks
        const floors = kind === 2 ? 5 : towerFloors(v), fh = 2.8, base = kind === 2 ? 0.6 : 1.2, top = base + floors * fh;
        const col = PANEL[v % PANEL.length];
        if (vm > top) { P.p(xg, yg, shadeRGB(col, -0.4 + grain * 0.05)); continue; }
        if (vm < base) { P.p(xg, yg, shadeRGB(col, -0.25 + grain * 0.06)); continue; }
        const fl = Math.floor((vm - base) / fh), fv = vm - base - fl * fh;
        if (face === 1) { // end wall: mostly blank panels, two narrow window columns
          if (fv < px * 0.9 && dens >= 3 || (um % 3.0) < px * 0.6 && dens >= 6) { P.p(xg, yg, shadeRGB(col, -0.18)); continue; }
          if (glass(um, vm, 2.2, base + fl * fh + 0.9, 0.8, 1.3, 0, fl, 0.35, WHITEF) || glass(um, vm, lenM - 3.0, base + fl * fh + 0.9, 0.8, 1.3, 1, fl, 0.35, WHITEF)) continue;
          P.p(xg, yg, shadeRGB(col, -0.08 + grain * 0.06));
          continue;
        }
        const pan = Math.floor(um / 3.2), fu = um - pan * 3.2, sec = Math.floor(um / 12.8), su = um - sec * 12.8;
        const stripe = kind === 3 && Math.abs(su - 6.4) < 1.2;
        if (fl === 0 && Math.abs(su - 6.4) < 0.6 && fv < 2.2) { P.p(xg, yg, Math.abs(su - 6.4) > 0.5 ? U('#3a3a3a') : DOOR[0]); continue; }
        if (fl === 0 && Math.abs(su - 6.4) < 1.0 && fv > 2.2 && fv < 2.5) { P.p(xg, yg, shadeRGB(col, -0.45)); continue; }
        if (stripe) {
          if (glass(um, vm, sec * 12.8 + 6.0, base + fl * fh + 1.2, 0.8, 0.8, sec, fl + 50, 0.6, WHITEF)) continue;
          P.p(xg, yg, U(['#4a6c9a', '#a8583a', '#4a8a6a'][v % 3])); continue;
        }
        if ((fv < px * 0.9 && dens >= 3) || (fu < px * 0.7 && dens >= 6)) { P.p(xg, yg, shadeRGB(col, -0.18)); continue; }
        const balc = fl > 0 && ((pan % 4) === 1 || (pan % 4) === 2) && hash2(pan + v, 3) < 0.85;
        if (balc && fu > 0.25 && fu < 2.95 && fv < 1.1) { // balcony front
          const bt = (hash2(pan * 13 + v, fl) * 4) | 0;
          if (fv > 1.0) { P.p(xg, yg, shadeRGB(col, 0.2)); continue; }
          if (bt === 0) { P.p(xg, yg, (um % 0.3) < px ? U('#3a3a3c') : U('#1c2028'), (um % 0.3) < px ? 0 : (winLit(pan, fl, 0.4) ? LIT[3] : 0)); continue; }
          if (bt === 1) { if (fv > 0.45 && (Math.abs(fu - 1.6) > 1.25 || (fu % 0.7) < px || fv < 0.5 || fv > 0.95)) { P.p(xg, yg, WHITEF); continue; } if (fv > 0.45) { P.p(xg, yg, GLASS[1], winLit(pan, fl, 0.45) ? litCol(pan, fl) : 0); continue; } P.p(xg, yg, shadeRGB(col, -0.05)); continue; }
          P.p(xg, yg, pack(mix(RGB(['#c89a6a', '#9ab0c8', '#c8c0a0', '#a8b890'][bt & 3]), col, 0.2 + grain * 0.2))); continue;
        }
        if (balc && fu > 0.6 && fu < 2.6 && fv > 1.1 && fv < 2.5) { P.p(xg, yg, fu > 1.9 ? GLASS[0] : GLASS[1], winLit(pan, fl, 0.45) ? litCol(pan, fl) : 0); continue; }
        if (!balc && glass(um, vm, pan * 3.2 + 0.85, base + fl * fh + 0.85, 1.5, 1.4, pan, fl, 0.45, hash2(pan, fl + v) < 0.35 ? WOODF : WHITEF)) continue;
        P.p(xg, yg, shadeRGB(col, grain * 0.07 - (fv > fh - 0.25 ? 0.07 : 0)));
        continue;
      }
      if (kind === 4) { // Lviv tenement: shop floor, 3 floors with cornices, tiled mansard
        const col = LVIV[v % LVIV.length], roof = ROOFS[v & 1 ? 0 : 4];
        if (vm > 17.2) { // mansard
          const rv = vm - 17.2;
          if (rv > 2.6) continue;
          const dorm = (um % 4.2) > 1.6 && (um % 4.2) < 2.6 && rv > 0.5 && rv < 1.7;
          if (dorm) { P.p(xg, yg, (um % 4.2) < 1.75 || (um % 4.2) > 2.45 || rv > 1.55 ? WHITEF : GLASS[1], winLit(Math.floor(um / 4.2), 9, 0.3) ? LIT[0] : 0); continue; }
          P.p(xg, yg, roof[((Math.floor(rv * 5) + Math.floor(um * 3)) & 1) ? 1 : (dens >= 6 ? 2 : 1)]);
          continue;
        }
        if (vm > 16.0) { P.p(xg, yg, shadeRGB(col, vm > 16.9 ? 0.32 : vm < 16.25 ? -0.35 : 0.18)); continue; }
        if (vm < 4.5) { // ground floor: rusticated, arched doorway, shop windows
          const bay = Math.floor(um / 3.0), fu = um - bay * 3.0;
          if (vm > 4.2) { P.p(xg, yg, shadeRGB(col, 0.25)); continue; }
          if (fu > 0.6 && fu < 2.4 && vm > 0.4 && vm < 3.4 - (Math.abs(fu - 1.5) > 0.6 ? Math.pow((Math.abs(fu - 1.5) - 0.6) / 0.3, 2) * 0.3 : 0)) {
            if (fu < 0.7 || fu > 2.3 || vm < 0.5) { P.p(xg, yg, WHITEF); continue; }
            P.p(xg, yg, bay % 3 === 1 ? DOOR[(fu < 1.5) ? 0 : 1] : (vm > 2.6 ? GLASS[2] : GLASS[1]), bay % 3 === 1 ? 0 : LIT[2]); continue;
          }
          P.p(xg, yg, shadeRGB(col, ((vm % 0.5) < px ? -0.22 : -0.06) + grain * 0.05));
          continue;
        }
        const fl = Math.floor((vm - 4.5) / 3.83), fv = vm - 4.5 - fl * 3.83, bay = Math.floor(um / 2.6), fu = um - bay * 2.6;
        if (fv < 0.18) { P.p(xg, yg, shadeRGB(col, fv < 0.06 ? -0.3 : 0.28)); continue; }   // cornice band
        const wx0 = 0.75, wx1 = 1.85, wy0 = 0.9, wy1 = 3.0;
        if (fu > wx0 - 0.15 && fu < wx1 + 0.15 && fv > wy0 - 0.2 && fv < wy1 + (fl === 0 ? 0.55 : 0.2)) {
          if (fu > wx0 && fu < wx1 && fv > wy0 && fv < wy1) {
            if (Math.abs(fu - 1.3) < px * 0.6 && dens >= 6 || (fv > 2.3 && fv < 2.3 + px && dens >= 6)) { P.p(xg, yg, WHITEF); continue; }
            P.p(xg, yg, (fv > 2.4 && fu < 1.2) ? GLASS[2] : GLASS[(bay + fl) & 1], winLit(bay, fl, 0.5) ? litCol(bay, fl) : 0); continue;
          }
          if (fl === 0 && fv > wy1 + 0.2) { const pd = (fv - wy1 - 0.2) / 0.35; if (Math.abs(fu - 1.3) < 0.7 * (1 - pd)) { P.p(xg, yg, shadeRGB(col, 0.35)); continue; } else { P.p(xg, yg, shadeRGB(col, grain * 0.06)); continue; } }
          P.p(xg, yg, shadeRGB(col, fv < wy0 ? -0.25 : 0.4)); continue;
        }
        if (fl === 0 && bay % 3 === 1 && fv > 0.25 && fv < 1.0 && fu > 0.4 && fu < 2.2) { // wrought-iron balcony
          if (fv > 0.9 || (fu % 0.15) < px) { P.p(xg, yg, U('#1e1e22')); continue; }
        }
        P.p(xg, yg, shadeRGB(col, grain * 0.07 - (vm < 5.5 ? 0.04 : 0)));
        continue;
      }
    }
    return P;
  };
}
function shopSign(v) {
  const label = ['ПРОДУКТИ', 'АПТЕКА', 'КАВА', 'МАГАЗИН', 'ХЛІБ', 'КВІТИ'][v % 6];
  return (g, night, dens, w) => {
    const bandH = 0.9 * dens; if (bandH < 6) return;
    const s = Math.max(1, Math.floor(bandH / 7)), tw = measureText(label, { scale: s });
    const y = Math.round((4.6 - 3.8) * dens + (bandH - 5 * s) / 2);
    drawText(g, label, Math.round(w / 2 - tw / 2), y, night ? '#fff6c0' : '#ffffff', { scale: s });
  };
}

// --- sky sprites ---
function cloudEntry(seed) {
  const w = 34 + ((seed * 7) % 5) * 10, h = 12 + (seed % 4) * 3;
  const nb = 7 + (seed % 3), bx = [], by = [], br = [];
  for (let i = 0; i < nb; i++) { const t = (i + 0.5) / nb; bx.push(w * (0.12 + 0.76 * t)); br.push(h * (0.25 + 0.3 * Math.sin(t * Math.PI) * (0.7 + 0.6 * hash2(seed, i)))); by.push(h * 0.78 - br[i] * 0.55); }
  const D = UA('#a8b6cc', '#c8d4e4', '#e6eef6', '#ffffff'), N = UA('#1e2440', '#2a3150', '#363e62', '#58628a');
  const P = new Pix(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (y > h * 0.86) continue;
    let best = -1, bi = 0;
    for (let i = 0; i < nb; i++) { const dx = (x + 0.5 - bx[i]) / br[i], dy = (y + 0.5 - by[i]) / br[i]; const q = 1 - dx * dx - dy * dy; if (q > best) { best = q; bi = i; } }
    if (best <= 0) continue;
    const ny = (y + 0.5 - by[bi]) / br[bi], nx = (x + 0.5 - bx[bi]) / br[bi];
    let s = 2.2 - ny * 1.4 - nx * 0.4 - (y / h) * 1.2 + (BAY[(y & 3) * 4 + (x & 3)] - 0.5) * 0.9;
    const k = s < 0.7 ? 0 : s < 1.5 ? 1 : s < 2.3 ? 2 : 3;
    P.p(x, y, D[k], N[k]);
  }
  return Object.assign(toEntry(P), { w, h });
}
function discEntry(r, col, rim, glowR, glowCol) {
  const d = (glowR || r) * 2 + 1, c0 = (d - 1) / 2;
  const P = new Pix(d, d), cc = U(col), rc = U(rim), gc = glowR ? U(glowCol) : 0;
  for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) {
    const q = Math.hypot(x - c0, y - c0);
    if (q <= r + 0.3) P.p(x, y, q > r - 1 ? rc : cc, q > r - 1 ? rc : cc);
    else if (glowR && q <= glowR && BAY[(y & 3) * 4 + (x & 3)] < 0.55 * (1 - (q - r) / (glowR - r))) P.p(x, y, gc, gc);
  }
  return toEntry(P);
}
function moonEntry() {
  const r = 5, d = 11, P = new Pix(d, d), a = U('#e8e8f0'), b = U('#b8bccc'), c = U('#9ea2b4');
  for (let y = 0; y < d; y++) for (let x = 0; x < d; x++) {
    const q = Math.hypot(x - r, y - r); if (q > r + 0.3) continue;
    const crater = Math.hypot(x - 3, y - 4) < 1.3 || Math.hypot(x - 6.5, y - 6.5) < 1.6 || Math.hypot(x - 6, y - 2.5) < 0.8;
    P.p(x, y, q > r - 1 ? b : crater ? c : a, q > r - 1 ? b : crater ? c : a);
  }
  return toEntry(P);
}

// ---------- the scene ----------
export function createRoadScene(canvas, data) {
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const layer = makeCanvas(W, H), L = layer.getContext('2d');   // CPU-backed: putImageData is a plain copy
  const img = L.createImageData(W, H), buf = new Uint32Array(img.data.buffer);
  const lut = new Uint32Array(NB * 5);
  const PAL = []; for (let k = 0; k < PAL_N; k++) PAL.push(buildPalette(k / PAL_N));
  let lutFor = -1;
  function buildLut(P) {
    const nt = 0.74 * P.night, dk = 0.16 * P.dusk * (1 - P.night), hor = P.hor;
    for (let id = 0; id < NB; id++) {
      const c = BASE[id];
      let r = c[0] + (DUSK_RGB[0] - c[0]) * dk, g = c[1] + (DUSK_RGB[1] - c[1]) * dk, b = c[2] + (DUSK_RGB[2] - c[2]) * dk;
      r += (NIGHT_RGB[0] - r) * nt; g += (NIGHT_RGB[1] - g) * nt; b += (NIGHT_RGB[2] - b) * nt;
      for (let l = 0; l < 4; l++) { const t = l * 0.21; lut[l * NB + id] = pack3(Math.round(r + (hor[0] - r) * t), Math.round(g + (hor[1] - g) * t), Math.round(b + (hor[2] - b) * t)); }
      const q = 0.85 * P.night; // headlight-lit: back towards the warm day colour
      lut[4 * NB + id] = pack3(Math.round(Math.min(255, r + (c[0] * 1.04 + 6 - r) * q)), Math.round(Math.min(255, g + (c[1] + 2 - g) * q)), Math.round(b + (c[2] * 0.86 - b) * q));
    }
  }

  // sprite families
  const sets = (paint, aspect, n) => { const a = []; for (let v = 0; v < n; v++) a.push(new SpriteSet(paint, aspect, v)); return a; };
  const S_SPRUCE = sets(pSpruce, 0.42, 4), S_BIRCH = sets(pBirch, 0.55, 3), S_OAK = sets(pOak, 0.85, 3), S_POPLAR = sets(pPoplar, 0.24, 3);
  const S_BUSH = sets(pBush, 1.6, 3), S_FRUIT = sets(pFruit, 0.95, 2), S_WILLOW = sets(pWillow, 1.0, 2), S_HAY = sets(pHay, 1.15, 2);
  const S_REEDS = sets(pReeds, 1.3, 2), S_SUNFL = sets(pSunfl, 1.5, 3), S_WHEAT = sets(pWheat, 2.4, 2);
  const S_POLE = sets(pPole, 0.2, 1)[0], S_LAMP_R = new SpriteSet(pLamp, 0.3, 1), S_LAMP_L = new SpriteSet(pLamp, 0.3, -1);
  const S_CHURCH = [new SpriteSet(pChurch, 0.9, 0), new SpriteSet(pChurch, 0.9, 1), new SpriteSet(pChurch, 0.7, 2)];
  const S_KM = new SpriteSet(pKmPost, 0.42, 0);
  const T_GUARD = new WallTex(pGuard, 8, 0.9, 0), T_RAIL = [0, 1, 2].map(v => new WallTex(pRail, 6, 1.1, v)), T_FENCE = [0, 1, 2, 3].map(v => new WallTex(pFence, 6, 1.3, v));
  const BLD = new Map();
  function building(kind, v, len) { // { side: WallTex, front: WallTex, len, bw, hs, hf }
    const key = (kind * 16 + v) * 128 + Math.round(len);
    let b = BLD.get(key);
    if (b) return b;
    const hs = kind === 3 ? 1.6 + towerFloors(v) * 2.8 : BK_SIDEH[kind], hf = kind === 3 ? hs : BK_FRONTH[kind];
    b = { len, bw: BK_FRONT[kind], hs, hf, kind,
      side: new WallTex(facadePaint(kind, 0), len, hs, v, kind === 5 ? shopSign(v) : null),
      front: new WallTex(facadePaint(kind, 1), BK_FRONT[kind], hf, v) };
    BLD.set(key, b);
    return b;
  }
  const CLOUDS = []; for (let i = 0; i < 9; i++) CLOUDS.push(cloudEntry(i + 3));
  const CLOUD_AZ = new Float32Array(16), CLOUD_Y = new Int16Array(16), CLOUD_V = new Uint8Array(16);
  for (let i = 0; i < 16; i++) { CLOUD_AZ[i] = hash(i * 13 + 1) * 360; CLOUD_Y[i] = 6 + ((hash(i * 17 + 2) * 62) | 0); CLOUD_V[i] = i % CLOUDS.length; }
  const SUN = discEntry(6, '#fff6c8', '#ffd860', 13, '#fff0b0'), SUN_LOW = discEntry(8, '#ffb060', '#ff8040', 16, '#ff9a50'), MOON = moonEntry();
  const NSTAR = 220, STAR_AZ = new Float32Array(NSTAR), STAR_Y = new Int16Array(NSTAR);
  for (let i = 0; i < NSTAR; i++) { STAR_AZ[i] = hash(i * 3 + 1) * 360; STAR_Y[i] = (Math.pow(hash(i * 3 + 2), 1.3) * (HZ0 - 14)) | 0; }

  // data access
  const places = data.places || data.meta.places || [];
  const placeM = data.placeM || Float64Array.from(places, p => p.km * 1000);
  const rivers = data.rivers || data.meta.rivers || [];
  const riverM = data.riverM || Float64Array.from(rivers, r => r.km * 1000);
  const eleAt = data.eleAt || (m => data.pointAt(m).ele);
  const headingAt = data.headingAt || (m => data.pointAt(m).heading);
  const gradeAt = data.gradeAt || (m => data.pointAt(m).grade);
  const lengthM = data.lengthM;
  let lvivM = -1e9;
  for (let i = 0; i < places.length; i++) if (places[i].name === 'Львів') lvivM = placeM[i];

  // per-frame state (preallocated)
  const segS = new Float32Array(NSEG + 1), segX = new Float32Array(NSEG + 1), segZ = new Float32Array(NSEG + 1), segE = new Float32Array(NSEG + 1);
  const segPX = new Float32Array(NSEG + 1), segPY = new Float32Array(NSEG + 1), segCos = new Float32Array(NSEG + 1), segSin = new Float32Array(NSEG + 1);
  const segRel = new Float32Array(NSEG + 1), segClip = new Int16Array(NSEG + 1);
  const segStyle = new Uint8Array(NSEG + 1), segLanes = new Uint8Array(NSEG + 1), segBiome = new Uint8Array(NSEG + 1), segTK = new Int8Array(NSEG + 1);
  const segTD = new Float32Array(NSEG + 1), segForest = new Float32Array(NSEG + 1), segE2 = new Float32Array(NSEG + 1), segE3 = new Float32Array(NSEG + 1), segE4 = new Float32Array(NSEG + 1);
  for (let k = 0, s = S0; k <= NSEG; k++) { segS[k] = s; s += D0 * Math.pow(GR, k); }
  const S_END = segS[NSEG];
  const nearP = new Int32Array(64); let nNear = 0;
  const rivLo = new Float64Array(16), rivHi = new Float64Array(16), rivPad = new Float32Array(16), rivIdx = new Int32Array(16); let nRiv = 0;
  const yFar = new Int16Array(W), yMid = new Int16Array(W), yNear = new Int16Array(W), ySky = new Int16Array(W);
  const itK = new Uint8Array(CAP), itSeg = new Int16Array(CAP), itFore = new Uint8Array(CAP), itOrder = new Int16Array(CAP), bucket = new Int32Array(NSEG + 2);
  const itA = new Float32Array(CAP), itB = new Float32Array(CAP), itC = new Float32Array(CAP), itD = new Float32Array(CAP), itE = new Float32Array(CAP), itF = new Float32Array(CAP);
  const itR = new Array(CAP).fill(null);
  let nIt = 0;
  const prof = new Float64Array(8);   // dev timing: segments, ground, ridges+put, sky+layer, collect, items, frames
  const signCache = new Map(), kmCache = new Map();

  let clock = 0, tod = 0.36, camHead = NaN, lastM = NaN, pitch = 0, steerS = 0;
  let HZ = HZ0, camE = 0, camW = 0, eV = 0, nightA = 0, hlOn = false, vehX = CX;
  // projection output
  let PX = 0, PY = 0, PS = 0, PZ = 0, PK = 0;
  const env = { night: 0, timeOfDay: 0, t: 0, speed: 0, steer: 0, grade: 0, view: 'rear' };
  const result = { night: 0, timeOfDay: 0, vehicleX: CX, groundY: VEH_Y };

  // ---- world helpers (scene.js rules) ----
  function placeR(p) {
    const pop = p.pop || 0;
    if (p.type === 'city') return Math.min(11000, Math.max(2500, Math.sqrt(pop) * 5));
    if (p.type === 'town') return Math.min(2600, Math.max(1100, Math.sqrt(pop) * 9));
    return Math.min(900, Math.max(450, Math.sqrt(pop) * 9));
  }
  const placeWt = p => p.type === 'city' ? 1.25 : p.type === 'town' ? 1.0 : 0.8;
  function riverHalf(r) {
    const n = r.name || '';
    if (/Дніпр/.test(n)) return 450;
    if (/Дністер|Десна|Буг|Донець|Прип|Сула|Псел|Ворскл|Тиса|Сян|Горинь|Случ|Рось|Тетерів|Сейм|Оріль|Самар/.test(n)) return 80;
    return 22;
  }
  const RHALF = Float32Array.from(rivers, riverHalf);
  function townDensity(w) {
    let d = 0;
    for (let i = 0; i < nNear; i++) { const p = places[nearP[i]], q = 1 - Math.abs(w - placeM[nearP[i]]) / placeR(p); if (q > 0) d += q * placeWt(p); }
    return d;
  }
  function townKind(w) {
    let k = -1;
    for (let i = 0; i < nNear; i++) { const p = places[nearP[i]]; if (Math.abs(w - placeM[nearP[i]]) < placeR(p)) { const t = p.type === 'city' ? 2 : p.type === 'town' ? 1 : 0; if (t > k) k = t; } }
    return k;
  }
  function forestAt(w) {
    let f = (eleAt(w) - 330) / 150;
    if (hash2(Math.floor(w / 2300), 71) < 0.13) f = Math.max(f, 0.85);
    return f < 0 ? 0 : f > 1 ? 1 : f;
  }
  function riverAt(w, pad) { // index into rivLo/rivHi or −1
    for (let i = 0; i < nRiv; i++) if (w > rivLo[i] - pad && w < rivHi[i] + pad) return i;
    return -1;
  }
  function riverBridge(w) { for (let i = 0; i < nRiv; i++) if (w > rivLo[i] - rivPad[i] && w < rivHi[i] + rivPad[i]) return i; return -1; }
  function eleSm(w) { return (eleAt(w - 40) + 2 * eleAt(w - 20) + 3 * eleAt(w) + 2 * eleAt(w + 20) + eleAt(w + 40)) / 9; }
  function eS(w) { // smoothed elevation, bridges levelled bank to bank
    for (let i = 0; i < nRiv; i++) {
      const a = rivLo[i] - rivPad[i] - 10, b = rivHi[i] + rivPad[i] + 10;
      if (w > a && w < b) { const ea = eleSm(a), eb = eleSm(b); return ea + (eb - ea) * (w - a) / (b - a); }
    }
    return eleSm(w);
  }
  function lowerBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; }
  function segOf(s) {
    if (s <= S0) return 0;
    const k = Math.floor(Math.log(1 + (s - S0) * (GR - 1) / D0) / LNGR);
    return k < 0 ? 0 : k >= NSEG ? NSEG - 1 : k;
  }
  // project road point s metres ahead of the camera, L metres right of the centre line → PX, PY (ground), PS (px/m), PZ, PK
  function proj(s, Lat) {
    const k = segOf(s);
    const t = (s - segS[k]) / (segS[k + 1] - segS[k]);
    const X = segX[k] + (segX[k + 1] - segX[k]) * t + Lat * segCos[k];
    const Z = segZ[k] + (segZ[k + 1] - segZ[k]) * t - Lat * segSin[k];
    if (Z < 0.9) return false;
    const E = segE[k] + (segE[k + 1] - segE[k]) * t;
    PS = F / Z; PX = CX + X * PS; PY = HZ + (camE - E) * PS; PZ = Z; PK = k;
    return true;
  }

  // ---- segments ----
  function buildSegments(m) {
    segX[0] = -VEH_LAT; segZ[0] = S0;
    for (let k = 0; k < NSEG; k++) {
      const ds = segS[k + 1] - segS[k];
      let rel = wrap180(headingAt(camW + segS[k] + ds * 0.5) - camHead);
      rel = rel > CURVE_MAX ? CURVE_MAX : rel < -CURVE_MAX ? -CURVE_MAX : rel;
      segRel[k] = rel;
      const c = Math.cos(rel * DEG), sn = Math.sin(rel * DEG);
      segCos[k] = c; segSin[k] = sn;
      segX[k + 1] = segX[k] + sn * ds; segZ[k + 1] = segZ[k] + c * ds;
    }
    segCos[NSEG] = segCos[NSEG - 1]; segSin[NSEG] = segSin[NSEG - 1]; segRel[NSEG] = segRel[NSEG - 1];
    for (let k = 0; k <= NSEG; k++) {
      const w = camW + segS[k];
      segE[k] = (eS(w) - eV) * EXAG;
      const sc = F / segZ[k];
      segPX[k] = CX + segX[k] * sc; segPY[k] = HZ + (camE - segE[k]) * sc;
      // surface & surroundings
      const ri = nRiv ? riverBridge(w) : -1;
      const td = nNear ? townDensity(w) : 0, tk = nNear ? townKind(w) : -1;
      const ele = eleAt(w), fo = forestAt(w);
      let st = 0;
      if (ri >= 0) st = 4;
      else if (Math.abs(w - lvivM) < 1500) st = 3;
      else if ((tk === 2 && td > 0.3) || (tk === 1 && td > 0.75)) st = 2;
      else if (w < 215000 && ele > 230) st = 1;
      segStyle[k] = st;
      segLanes[k] = (w < 232000 || st === 3) ? 1 : 2;
      segBiome[k] = w < 215000 && fo > 0.4 ? 0 : w < 560000 ? 1 : 2;
      segTD[k] = td; segTK[k] = tk; segForest[k] = fo;
      const hw = segLanes[k] * 3.5;
      segE2[k] = hw + SHW[st] + KBW[st]; segE3[k] = segE2[k] + VGW[st]; segE4[k] = segE3[k] + DTW[st];
    }
  }

  // ---- ground: one row of pixels ----
  function cropAt(cs, cl, side, bi) {
    const h = hh(cs * 7 + side, cl * 13 + 5);
    if (bi === 0) return h < 0.55 ? 6 : 0;
    if (bi === 1) return h < 0.25 ? 0 : h < 0.45 ? 1 : h < 0.65 ? 2 : h < 0.75 ? 3 : h < 0.85 ? 4 : h < 0.92 ? 5 : 6;
    return h < 0.3 ? 2 : h < 0.6 ? 5 : h < 0.76 ? 7 : h < 0.86 ? 1 : h < 0.91 ? 4 : h < 0.96 ? 0 : 6;
  }
  // crop of the first field strip beside the road at w (for field-edge sprites)
  function edgeCrop(w, side, bi) {
    const stg = hh(side, 17) * 240, cs = Math.floor((w + stg) / 240);
    return cropAt(cs, 0, side, bi);
  }
  function drawRow(y, w, Z, xc, sc, k) {
    const fp = 1 / sc, row = y * W, by = (y & 3) << 2;
    const st = segStyle[k], lanes = segLanes[k], bi = segBiome[k], td = segTD[k], tk = segTK[k];
    const e0 = lanes * 3.5, e1 = e0 + SHW[st], e2 = e1 + KBW[st], e3 = e2 + VGW[st], e4 = e3 + DTW[st];
    const G = bi === 0 ? GRM : bi === 2 ? GRS : GRW;
    const band = Math.floor(w / 7) & 1, kerbOn = Math.floor(w / 2) & 1;
    const dashC = ((w % 12) + 12) % 12 < 4, dashL = ((w % 15) + 15) % 15 < 5;
    const zebra = st === 2 && ((w % 420) + 420) % 420 < 4;
    const lw = fp * 0.5;
    const hz = Z < 140 ? 0 : Math.min(2.999, (Z - 140) / 900);
    const l0 = hz | 0, lf = hz - l0;
    // rivers across this row
    let water = 0;
    for (let i = 0; i < nRiv; i++) {
      if (w > rivLo[i] && w < rivHi[i]) { water = 1; break; }
      if (w > rivLo[i] - 14 && w < rivHi[i] + 14) water = 2;
    }
    const town = td > 0.22, garden = town && tk === 0;
    // headlight pool
    let hlA = 0, hlHalf = 1;
    if (hlOn) { const zr = Z - Z_V; if (zr > 0.3 && zr < 40) { hlA = Math.pow(1 - zr / 40, 1.2) * 0.85; hlHalf = (0.9 + zr * 0.15) * sc; } }
    const fine = fp < 0.07 ? 0.07 : fp < 0.15 ? 0.15 : fp < 0.33 ? 0.33 : 0;
    const tw = (clock * 2.5) | 0;
    let cKey = -999999, cCrop = 0, stgKey = -999999, stgVal = 0, pjKey = -999999, phVal = 1;
    const pi = Math.floor(w / 6.5), pfu = w / 6.5 - pi, patchRate = st === 1 ? 0.13 : 0.05;
    for (let x = 0; x < W; x++) {
      const lat = (x - xc) * fp, a = lat < 0 ? -lat : lat;
      const bv = BAY[by + (x & 3)];
      let id;
      if (a < e0) { // ---- carriageway ----
        let mk = false;
        if (st !== 3) {
          if (Math.abs(a - (e0 - 0.25)) < (lw > 0.1 ? lw : 0.1)) mk = true;
          else if (lanes === 1) { if (a < (lw > 0.07 ? lw : 0.07) && dashC) mk = true; }
          else if (Math.abs(a - 0.13) < (lw > 0.06 ? lw : 0.06) && (a > 0.07 || lw > 0.12)) mk = true;
          else if (Math.abs(a - 3.5) < (lw > 0.07 ? lw : 0.07) && dashL) mk = true;
          if (zebra && a < e0 - 0.6 && (Math.floor(lat / 0.5) & 1)) mk = true;
        }
        if (mk) id = MK + (nz(Math.floor(w / 1.5), Math.floor(lat * 3)) < 0.18 ? 1 : 0);
        else if (st === 3) { // Lviv cobbles + tram rails
          const ra = Math.abs(a - 1.75);
          if (Math.abs(ra - 0.72) < (lw > 0.05 ? lw : 0.05)) id = RL + 1;
          else if (Math.abs(ra - 0.64) < (lw > 0.03 ? lw : 0.03)) id = RL;
          else if (fp > 0.15) id = CB + 1 + ((nz(Math.floor(lat / 0.9), Math.floor(w / 0.9)) * 2 + bv) | 0);
          else {
            const ri = Math.floor(w / 0.16), off = (ri & 1) * 0.11, cu = (lat + 30 + off) / 0.22, ci = Math.floor(cu);
            const fu = cu - ci, fv = w / 0.16 - ri;
            if (fu < 0.14 || fv < 0.18) id = CB;
            else if (fv > 0.68 && fu < 0.5 && fp < 0.08) id = CB + 4;
            else id = CB + 1 + ((nz(ci, ri) * 3) | 0);
          }
        } else {
          const B = st === 1 ? AM : st === 2 ? AC : st === 4 ? AB : AS;
          let t = 2;
          const d = Math.abs((a % 3.5) - 1.75);
          if (d > 0.5 && d < 1.1) t = 1;
          if (fine) {
            const hv = nz(Math.floor(lat / fine), Math.floor(w / fine));
            if (hv < 0.1) t = 0; else if (hv > 0.93) t = hv > 0.985 ? 4 : 3;
          } else if (bv < 0.12) t = 3;
          id = B + t;
          if (st !== 4) {
            const pj = Math.floor((lat + 40) / 1.9);
            if (pj !== pjKey) { pjKey = pj; phVal = hh(pi + 7919, pj); }
            const ph = phVal;
            if (ph < patchRate) { const fu = pfu, fv = (lat + 40) / 1.9 - pj; if (fu > 0.1 && fu < 0.2 + ph * 6 && fv > 0.12 && fv < 0.88) id = PATCH + (fu < 0.14 ? 0 : 1); }
          } else if (((w % 24) + 24) % 24 < (lw * 2 > 0.3 ? lw * 2 : 0.3)) id = JOINT + (((w % 24) + 24) % 24 < 0.1 ? 1 : 0);
        }
      } else if (a < e1) { // ---- shoulder / gutter ----
        if (st === 0) { const r = a - e0 < 0.35 && ((w % 0.5) + 0.5) % 0.5 < 0.2; id = r ? SHD : SHD + 1 + (fine && nz(Math.floor(lat / fine), Math.floor(w / fine)) < 0.2 ? 1 : 0); }
        else if (st === 1) id = GV + (fine ? ((nz(Math.floor(lat / fine), Math.floor(w / fine)) * 4) | 0) : 1 + (bv < 0.5 ? 1 : 0));
        else if (st === 4) id = AB + 3;
        else id = SW + 1;
      } else if (a < e2) { // ---- kerb ----
        if (st === 1) id = kerbOn ? KR : KR + 1;
        else if (st === 3) id = KR + 3;
        else id = kerbOn ? KR + 2 : KR + 1;
      } else if (a < e3) { // ---- verge / sidewalk / walkway ----
        if (st === 2 || st === 3) {
          const tu = (lat + 40) / 0.5, tv = w / 0.5, ti = Math.floor(tu), tj = Math.floor(tv);
          id = fp < 0.12 && (tu - ti < 0.1 || tv - tj < 0.1) ? SW : SW + 1 + ((nz(ti, tj) * 3) | 0);
        } else if (st === 4) id = ((w % 2) + 2) % 2 < (lw > 0.06 ? lw : 0.06) ? PP : PP + 1;
        else {
          id = G + 2 + band;
          if (fine) { const hv = nz(Math.floor(lat / 0.1), Math.floor(w / 0.1)); if (hv < 0.14) id = G + band; else if (hv > 0.9) id = hv > 0.994 && bi !== 2 ? FLW + ((hv * 1000) & 3) : G + 4; }
        }
      } else if (a < e4) { // ---- ditch / parapet ----
        if (st === 4) id = a > e4 - 0.15 ? PP : PP + 2;
        else { const dm = (a - e3) / (e4 - e3); id = dm > 0.3 && dm < 0.7 ? (nz(Math.floor(w / 3), 7) < 0.25 ? DIT + 2 : DIT) : DIT + 1; }
      } else if (water === 1) { // ---- river ----
        if (fp > 0.5) id = WA + 1 + (bv < 0.5 ? 1 : 0);
        else {
          const hv = nz(Math.floor((lat + clock * 0.7) / 1.3), Math.floor(w / 0.45));
          id = hv < 0.3 ? WA + 1 : hv < 0.85 ? WA + 2 : WA + 3;
          if (nz(Math.floor(lat / 0.4), Math.floor(w / 0.3) + tw * 7919) > 0.993) id = WA + 4;
          if (hv < 0.06) id = WA;
        }
      } else if (water === 2 || st === 4) { // ---- bank ----
        id = BK + ((nz(Math.floor(lat / 0.3), Math.floor(w / 0.3)) * 2 + (bi === 2 ? 2 : 0)) | 0);
      } else if (town) { // ---- yards, lawns, village gardens ----
        const cu = Math.floor((a - e4) / 24), cv = Math.floor(w / 30), hv = nz(cu * 3 + (lat < 0 ? 1 : 0), cv);
        const fu = (a - e4) - cu * 24, fv = w - cv * 30;
        if (fu < 2.2 && hv > 0.5) id = tk === 2 ? AC + 1 + (bv < 0.25 ? 1 : 0) : DT + 1;                // yard paths
        else if (garden && hv > 0.4) id = (((fu / 0.7) | 0) & 1) ? (fp < 0.3 ? YC + 1 : YC + 2) : PB + 1;
        else if (fine) { const hq = nz(Math.floor(lat / 0.12), Math.floor(w / 0.12)); id = G + 2 + band + (hq < 0.12 ? -2 : hq > 0.94 ? 1 : 0); }
        else id = G + 2 + (bv < 0.5 ? band : 0);
      } else { // ---- fields ----
        const d = a - e4, side = lat < 0 ? 1 : 0;
        const cl = Math.floor(d / 110), sk = cl * 2 + side;
        if (sk !== stgKey) { stgKey = sk; stgVal = hh(sk, 17) * 240; }
        const stg = stgVal;
        const ww = w + stg, cs = Math.floor(ww / 240);
        const du = d - cl * 110, dv = ww - cs * 240;
        const key = (cs * 64 + cl) * 2 + side;
        if (key !== cKey) { cKey = key; cCrop = cropAt(cs, cl, side, bi); }
        const edge = lw > 1.2 ? lw : 1.2;
        if (du < edge || dv < edge) id = cCrop === 6 ? FF + 1 : DT + (du < edge * 0.5 || dv < edge * 0.5 ? 1 : 0);
        else switch (cCrop) {
          case 2: { // wheat
            if (fp > 0.35) id = WH + 1 + (bv < 0.55 ? 1 : 0);
            else { id = (Math.floor(lat / 0.35) & 1) ? WH + 1 : WH + 2; const hv = nz(Math.floor(lat / 0.08), Math.floor(w / 0.08)); if (hv > 0.85) id = hv > 0.97 ? WH + 4 : WH + 3; else if (hv < 0.08) id = WH; }
            if ((du % 18) < (lw > 0.4 ? lw : 0.4)) id = WH;
            break;
          }
          case 5: { // sunflowers
            if (fp < 0.2) {
              const cu = lat / 0.7, cv = w / 0.7, fu = cu - Math.floor(cu) - 0.5, fv = cv - Math.floor(cv) - 0.5, r2 = fu * fu + fv * fv * 1.6;
              id = r2 < 0.025 ? SF + 5 : r2 < 0.11 ? (fv < 0 ? SF + 3 : SF + 4) : SF + ((nz(Math.floor(lat / 0.15), Math.floor(w / 0.15)) * 3) | 0);
            } else id = bv < 0.42 ? SF + 4 : bv < 0.6 ? SF + 3 : SF + 1 + (bv < 0.85 ? 1 : 0);
            break;
          }
          case 7: case 3: { // chernozem / ploughed
            const B = cCrop === 7 ? CZ : PB;
            if (fp > 0.4) id = B + 1 + (bv < 0.4 ? 1 : 0);
            else { id = (Math.floor(lat / 0.45) & 1) ? B + 1 : B + 2; const hv = nz(Math.floor(lat / 0.12), Math.floor(w / 0.12)); if (hv > 0.9) id = cCrop === 7 ? CZ + 3 : PB + 2; else if (hv < 0.1) id = B; }
            break;
          }
          case 1: { // young crops in rows
            if (fp > 0.3) id = YC + 1 + (bv < 0.5 ? 1 : 0);
            else id = ((lat / 0.5) - Math.floor(lat / 0.5)) < 0.55 ? YC + 1 + (nz(Math.floor(lat / 0.1), Math.floor(w / 0.1)) < 0.4 ? 1 : 0) : (bi === 2 ? CZ + 2 : PB + 1);
            break;
          }
          case 4: id = RS + 1 + (fine ? ((nz(Math.floor(lat / 0.12), Math.floor(w / 0.12)) * 3) | 0) : (bv < 0.5 ? 1 : 0)); break;
          case 6: id = FF + 1 + (fine ? ((nz(Math.floor(lat / 0.2), Math.floor(w / 0.2)) * 3) | 0) : (bv < 0.4 ? 1 : 0)); if (id > FF + 3) id = FF + 3; break;
          default: { // meadow
            id = G + 1 + band;
            if (fine) { const hv = nz(Math.floor(lat / 0.12), Math.floor(w / 0.12)); if (hv > 0.88) id = hv > 0.985 ? FLW + ((hv * 997) & 3) : G + 3; else if (hv < 0.12) id = G; }
            else if (bv < 0.2) id = G + 3;
          }
        }
      }
      let l = l0 + (bv < lf ? 1 : 0);
      if (hlA > 0) { const dx = x - vehX, q = 1 - (dx < 0 ? -dx : dx) / hlHalf; if (q > 0 && bv < q * hlA) l = 4; }
      buf[row + x] = lut[l * NB + id];
    }
  }

  function drawGround() {
    let clip = H, zRef = 0, sRef = 0, xRef = 0, kRef = 0;
    for (let k = 0; k < NSEG; k++) {
      segClip[k] = clip;
      const y0 = segPY[k], y1 = segPY[k + 1];
      if (y1 >= clip || y1 >= y0) continue;
      const top = Math.max(0, Math.ceil(y1));
      const iz0 = 1 / segZ[k], iz1 = 1 / segZ[k + 1];
      for (let r = Math.min(clip - 1, Math.floor(y0)); r >= top; r--) {
        const t = (y0 - r) / (y0 - y1), iz = iz0 + (iz1 - iz0) * t, Z = 1 / iz;
        const u = (Z - segZ[k]) / (segZ[k + 1] - segZ[k]);
        const s = segS[k] + (segS[k + 1] - segS[k]) * u, X = segX[k] + (segX[k + 1] - segX[k]) * u;
        drawRow(r, camW + s, Z, CX + X * F * iz, F * iz, k);
        zRef = Z; sRef = s; xRef = X; kRef = k;
      }
      if (top < clip) clip = top;
    }
    segClip[NSEG] = clip;
    // beyond the last segment: flat ground to the horizon
    if (clip > HZ + 1 && zRef > 0) {
      const yr = clip, sn = segSin[NSEG - 1], cs = segCos[NSEG - 1];
      for (let r = clip - 1; r > HZ; r--) {
        const Z = Math.min(60000, zRef * (yr - HZ) / (r - HZ)), dz = Z - zRef;
        const X = xRef + dz * sn / Math.max(0.2, cs);
        drawRow(r, camW + sRef + dz / Math.max(0.2, cs), Z, CX + X * F / Z, F / Z, kRef);
      }
      clip = HZ + 1;
    }
    return clip;
  }

  // ---- horizon ridges (front to back, only above the ground) ----
  function drawRidges(P, m, bottom) {
    const R = P.R;
    const fo = forestAt(m + 2500);
    // a city 1.5–12 km ahead shows as a skyline of distant blocks on the horizon
    let city = 0;
    for (let i = 0; i < nNear; i++) {
      const p = places[nearP[i]]; if (p.type !== 'city') continue;
      const d = placeM[nearP[i]] - m, R2 = placeR(p);
      if (d > -R2 && d < R2 + 9000) city = Math.max(city, Math.min(1, (p.pop || 0) / 600000) * (d > R2 ? 1 - (d - R2) / 9000 : 1));
    }
    const litP = P.night > 0.3 ? 0.35 : 0;
    for (let x = 0; x < W; x++) {
      const b = camHead + (x - CX) / PXDEG;
      yFar[x] = Math.round(HZ - 1 - data.horizonAt(m, b, 2) * H_SCALE);
      let a = data.horizonAt(m, b, 1);
      if (a > 0) a = MID_SAT * (1 - Math.exp(-a / MID_SAT));
      yMid[x] = Math.round(HZ - 1 - a * H_SCALE);
      a = data.horizonAt(m, b, 0);
      if (a > 0) a = NEAR_SAT * (1 - Math.exp(-a / NEAR_SAT));
      const u = Math.floor(b * PXDEG * 1.6);
      let bump;
      if (fo > 0.4) { const ph = ((u % 5) + 5) % 5; bump = (ph === 2 ? 3 : ph === 1 || ph === 3 ? 2 : 1) + ((hash(Math.floor(u / 5)) * 2) | 0); }
      else { const cl = Math.floor(u / 9); bump = hash(cl) < 0.5 ? 1 + ((hash(cl + 7) * 3) | 0) - (((u % 9) + 9) % 9 === 0 ? 1 : 0) : 0; }
      yNear[x] = Math.round(HZ - 1 - a * H_SCALE) - bump;
      if (city > 0.05) { const cb = Math.floor(u / 9), hv = hash(cb * 3 + 1); ySky[x] = hv < 0.75 ? Math.round(HZ - 2 - (3 + hash(cb * 3 + 2) * 15) * city) : 9999; }
      else ySky[x] = 9999;
    }
    for (let x = 0; x < W; x++) {
      const u = Math.floor((camHead + (x - CX) / PXDEG) * PXDEG * 1.6);
      const yn = Math.max(0, yNear[x]), ym = Math.max(0, yMid[x]), yf = Math.max(0, yFar[x]);
      let lim = bottom;
      // near band: dense forest texture
      for (let y = yn; y < lim; y++) {
        const q = hh(u >> 1, (y - yNear[x]) >> 1);
        buf[y * W + x] = y === yNear[x] ? R[10] : R[q < 0.3 ? 13 : q > 0.85 ? 11 : 12];
      }
      if (yn < lim) lim = yn;
      // distant city blocks (hazy), windows lit at night
      if (ySky[x] < lim) {
        const ys = Math.max(0, ySky[x]), cb = Math.floor(u / 9);
        for (let y = ys; y < lim; y++) {
          const win = litP && ((u % 3 + 3) % 3) === 1 && (y - ys) % 3 === 1 && hh(u, y) < litP;
          buf[y * W + x] = win ? WARM : R[y === ys ? 5 : (((u % 9) + 9) % 9) < 2 ? 8 : 7];
        }
        if (ys < lim) lim = ys;
      }
      // mid band: faceted mountains with forest speckle
      const slm = (x > 1 && x < W - 2) ? yMid[x + 2] - yMid[x - 2] : 0, hm = Math.max(1, lim - ym);
      for (let y = ym; y < lim; y++) {
        const bv = BAY[((y & 3) << 2) + (x & 3)], dep = (y - ym) / hm;
        let c = y === yMid[x] ? 5 : slm < -1 ? (bv < 0.7 ? 6 : 7) : slm > 1 ? (bv < 0.7 ? 8 : 7) : 7;
        if (dep > 0.55 && bv < (dep - 0.55) * 1.6) c = 9;
        else if (y > ym + 1 && hh(u, y) < 0.12) c = 8;
        buf[y * W + x] = R[c];
      }
      if (ym < lim) lim = ym;
      const slf = (x > 1 && x < W - 2) ? yFar[x + 2] - yFar[x - 2] : 0, hf = Math.max(1, lim - yf);
      for (let y = yf; y < lim; y++) {
        const bv = BAY[((y & 3) << 2) + (x & 3)], dep = (y - yf) / hf;
        let c = y === yFar[x] ? 0 : slf < -1 ? (bv < 0.65 ? 1 : 2) : slf > 1 ? (bv < 0.65 ? 3 : 2) : 2;
        if (dep > 0.4 && bv < (dep - 0.4) * 1.4) c = 4;
        buf[y * W + x] = R[c];
      }
    }
  }

  // ---- sky ----
  function drawSky(P) {
    const bh = Math.ceil((HZ + 3) / SKY_BANDS);
    for (let i = 0; i < SKY_BANDS; i++) { ctx.fillStyle = P.sky[i]; ctx.fillRect(0, i * bh, W, bh); }
    ctx.fillStyle = P.horizon; ctx.fillRect(0, SKY_BANDS * bh, W, H - SKY_BANDS * bh);
    if (P.night > 0.05) {
      ctx.fillStyle = '#fff';
      for (let i = 0; i < NSTAR; i++) {
        const x = Math.round(CX + wrap180(STAR_AZ[i] - camHead) * PXDEG);
        if (x < 0 || x >= W) continue;
        const tw = hash2(i, (clock * 2) | 0) < 0.08 ? 0.35 : 1;
        ctx.globalAlpha = P.night * tw * (i % 3 === 0 ? 1 : 0.55);
        ctx.fillRect(x, STAR_Y[i] + Math.round(HZ - HZ0), 1, 1);
      }
      ctx.globalAlpha = 1;
    }
    const a = (tod - 0.25) * Math.PI * 2;
    const sunAz = 90 + (tod - 0.25) * 360;
    const sx = Math.round(CX + wrap180(sunAz - camHead) * PXDEG * 0.6), sy = Math.round(HZ - 4 - Math.sin(a) * (HZ - 16));
    if (sy < HZ + 10) { const s = P.sunEl < 0.25 ? SUN_LOW : SUN; if (sx > -s.w && sx < W + s.w) ctx.drawImage(s.d, sx - (s.w >> 1), sy - (s.h >> 1)); }
    const mx = Math.round(CX + wrap180(sunAz + 180 - camHead) * PXDEG * 0.6), my = Math.round(HZ - 4 + Math.sin(a) * (HZ - 24));
    if (my < HZ + 6 && mx > -8 && mx < W + 8) { ctx.globalAlpha = 0.35 + 0.65 * P.night; ctx.drawImage(MOON.d, mx - 5, my - 5); ctx.globalAlpha = 1; }
    for (let i = 0; i < 16; i++) {
      const c = CLOUDS[CLOUD_V[i]];
      const x = Math.round(CX + wrap180(CLOUD_AZ[i] + clock * (0.06 + (i & 3) * 0.02) - camHead) * PXDEG * 0.9 - c.w / 2);
      if (x < -c.w || x > W) continue;
      const y = CLOUD_Y[i] + Math.round((HZ - HZ0) * 0.5);
      if (P.night < 0.98) { ctx.globalAlpha = 1; ctx.drawImage(c.d, x, y); }
      if (P.night > 0.02) { ctx.globalAlpha = P.night; ctx.drawImage(c.n, x, y); }
    }
    ctx.globalAlpha = 1;
  }

  // ---- draw list ----
  function push(kind, k, s) {
    if (nIt >= CAP) return -1;
    const i = nIt++;
    itK[i] = kind; itSeg[i] = k; itFore[i] = s < Z_V - 1.5 ? 1 : 0;
    return i;
  }
  function addSpr(set, s, Lat, hm, aspect) {
    if (s < 0.5 || s > S_END || !proj(s, Lat)) return;
    const h = hm * PS; if (h < 1.5) return;
    const w = h * (aspect || set.aspect);
    if (PX + w * 0.5 < 0 || PX - w * 0.5 > W || PY - h > H || PY < 0) return;
    const i = push(0, PK, s); if (i < 0) return;
    itA[i] = PX; itB[i] = PY; itC[i] = w; itD[i] = h; itR[i] = set;
  }
  function addWall(tex, sa, sb, Lat, hm, u0) {
    if (sb < 1.2 || sa > S_END) return;
    if (sa < 1.2) { u0 += 1.2 - sa; sa = 1.2; }
    if (sb > S_END) sb = S_END;
    while (sa < sb - 0.01) {
      const cl = Math.max(3, sa * 0.14), e = Math.min(sb, sa + cl);
      const i = push(1, segOf(e), sa); if (i < 0) return;
      itA[i] = sa; itB[i] = e; itC[i] = Lat; itD[i] = hm; itE[i] = u0; itF[i] = segOf(sa); itR[i] = tex;
      u0 += e - sa; sa = e;
    }
  }
  function addBuilding(b, s1, Lat, sd) { // Lat = road-facing wall, sd = side
    if (s1 + b.len < 1.2 || s1 > S_END) return;
    addWall(b.side, s1, s1 + b.len, Lat, b.hs, 0);
    if (s1 > 1.2) { const i = push(2, segOf(s1), s1); if (i >= 0) { itA[i] = s1; itC[i] = Lat; itE[i] = Lat + sd * b.bw; itD[i] = b.hf; itR[i] = b.front; } }
  }
  function addText(cache, key, text, kind, s, Lat, hm) {
    let e = cache.get(key);
    if (!e) { if (cache.size > 160) cache.clear(); e = { text, kind, sc: [null, null, null, null] }; cache.set(key, e); }
    if (s < 0.5 || s > S_END || !proj(s, Lat)) return;
    const h = hm * PS; if (h < 2) return;
    const i = push(3, PK, s); if (i < 0) return;
    itA[i] = PX; itB[i] = PY; itD[i] = h; itR[i] = e;
  }
  function signEntry(e, scale) { // kind 0 entry (blue), 1 exit (blue + red bar), 2 river (blue «р.»), 3 km plate
    let c = e.sc[scale - 1];
    if (c) return c;
    const s = scale, tw = measureText(e.text, { scale: s });
    const km = e.kind === 3, pw = tw + (km ? 4 : 8) * s, ph = (km ? 9 : 11) * s, post = (km ? 8 : 20) * s;
    const w = pw, h = ph + post;
    const paint = (night) => {
      const cv = makeCanvas(w, h), g = cv.getContext('2d');
      g.fillStyle = '#6c6e70';
      if (km) g.fillRect((w >> 1) - s, ph, 2 * s, post); else { g.fillRect(2 * s, ph, s, post); g.fillRect(w - 3 * s, ph, s, post); }
      g.fillStyle = km ? '#1e1e20' : '#ffffff'; g.fillRect(0, 0, pw, ph);
      g.fillStyle = km ? '#f2f2ec' : '#1d5bb8'; g.fillRect(s, s, pw - 2 * s, ph - 2 * s);
      drawText(g, e.text, (pw - tw) >> 1, km ? 2 * s : 3 * s, km ? '#111111' : '#ffffff', { scale: s });
      if (e.kind === 1) { g.fillStyle = '#d42a2a'; for (let x = s; x < pw - s; x++) { const y = ph - 2 * s - Math.round((x - s) * (ph - 3 * s) / (pw - 3 * s)); g.fillRect(x, y - s, 1, 2 * s); } }
      if (night) { g.globalCompositeOperation = 'source-atop'; g.fillStyle = 'rgba(6,10,34,0.5)'; g.fillRect(0, 0, w, h); }
      return cv;
    };
    c = e.sc[scale - 1] = { d: paint(false), n: paint(true), w, h };
    return c;
  }

  // ---- roadside objects ----
  function collect() {
    nIt = 0;
    const w0 = camW + 0.5, w1 = camW + Math.min(S_END, 950);
    // trees, bushes, field edges
    for (let sd = -1; sd <= 1; sd += 2) {
      const seed = sd > 0 ? 101 : 202;
      for (let i = Math.floor(w0 / 7); i * 7 < w1; i++) {
        const w = (i + hh(i, seed + 1) * 0.8) * 7, s = w - camW;
        if (s > 320 && (i & 1)) continue;
        const k = segOf(s), st = segStyle[k];
        if (st >= 2) continue;
        if (nRiv && riverAt(w, 25) >= 0) continue;
        const h1 = hh(i, seed), h2 = hh(i, seed + 3), h3 = hh(i, seed + 5), e4 = segE4[k], bi = segBiome[k], td = segTD[k];
        if (td > 0.22) {
          if (h1 < 0.3) addSpr(S_FRUIT[(h2 * 2) | 0], s, sd * (e4 + 3 + h3 * 22), 3.5 + h2 * 2);
          continue;
        }
        if (bi === 0) {
          const f = segForest[k];
          if (h1 < 0.4 + f * 0.5) {
            const spr = h2 < 0.75 ? S_SPRUCE[(h3 * 4) | 0] : S_OAK[(h3 * 3) | 0];
            addSpr(spr, s, sd * (e4 + 2 + h3 * 7), (h2 < 0.75 ? 13 : 10) + h2 * 9);
          }
          if (s < 520 && hh(i, seed + 7) < 0.85 * f + 0.1) addSpr(S_SPRUCE[(h1 * 4) | 0], s + 3, sd * (e4 + 11 + h2 * 14), 15 + h3 * 9);
          if (s < 380 && hh(i, seed + 8) < f) addSpr(S_SPRUCE[(h2 * 4) | 0], s + 5, sd * (e4 + 27 + h1 * 22), 17 + h3 * 8);
          continue;
        }
        const belt = hh(Math.floor(w / 420), seed + 9) < (bi === 2 ? 0.38 : 0.45);
        if (belt && h1 < 0.8) {
          const r = hh(i, seed + 11);
          const spr = bi === 2 ? (r < 0.6 ? S_POPLAR[(h3 * 3) | 0] : S_OAK[(h3 * 3) | 0]) : (r < 0.35 ? S_POPLAR[(h3 * 3) | 0] : r < 0.7 ? S_BIRCH[(h3 * 3) | 0] : S_OAK[(h3 * 3) | 0]);
          const tall = spr === S_POPLAR[0] || spr === S_POPLAR[1] || spr === S_POPLAR[2];
          addSpr(spr, s, sd * (e4 + 8 + h2 * 3.5), tall ? 17 + h2 * 7 : 8 + h2 * 6);
        } else if (h1 < 0.035) addSpr(S_OAK[(h3 * 3) | 0], s, sd * (e4 + 6 + h2 * 40), 9 + h3 * 6);
        else if (h1 > 0.95 && s < 400) addSpr(S_BUSH[(h3 * 3) | 0], s, sd * (segE2[k] + 1.2 + h2 * 1.5), 1.1 + h3 * 0.8);
        // field edge plants (sunflowers / wheat) right at the field border, close range only
        if (s < 150) {
          const cr = edgeCrop(w, sd > 0 ? 0 : 1, bi);
          if (cr === 5) { addSpr(S_SUNFL[i % 3], s, sd * (e4 + 1.6), 2.0, 1.5); addSpr(S_SUNFL[(i + 1) % 3], s + 3.5, sd * (e4 + 1.4), 1.9, 1.5); }
          else if (cr === 2) addSpr(S_WHEAT[i & 1], s, sd * (e4 + 1.4), 1.0, 2.4);
        }
        if (h2 < 0.03 && s < 700) { const cr = edgeCrop(w, sd > 0 ? 0 : 1, bi); if (cr === 2 || cr === 0) addSpr(S_HAY[i & 1], s, sd * (e4 + 14 + h3 * 70), 3.2); }
      }
    }
    // rivers: reeds and willows on the banks, bridge railings, lamps, signs
    for (let r = 0; r < nRiv; r++) {
      const lo = rivLo[r], hi = rivHi[r], bLo = lo - rivPad[r], bHi = hi + rivPad[r];
      for (let sd = -1; sd <= 1; sd += 2) {
        const k = segOf(Math.max(0, lo - camW)), e4 = segE4[k];
        for (let j = 0; j < 9; j++) {
          const L = sd * (e4 + 1 + j * 4 + hh(j, r) * 2);
          addSpr(S_REEDS[j & 1], lo - camW - 1 - hh(j, sd) * 4, L, 2.0, 1.3);
          addSpr(S_REEDS[(j + 1) & 1], hi - camW + 1 + hh(j, sd + 5) * 4, L, 2.0, 1.3);
        }
        addSpr(S_WILLOW[0], lo - camW - 16, sd * (e4 + 9 + hh(r, sd) * 12), 9);
        addSpr(S_WILLOW[1], hi - camW + 18, sd * (e4 + 14 + hh(r, sd + 3) * 12), 10);
        const kb = segOf(Math.max(0, bLo - camW));
        const Lr = sd * (segE3[kb] - 0.05);
        addWall(T_RAIL[(riverIdxOf(r) >> 1) % 3], bLo - camW, bHi - camW, Lr, 1.1, 0);
        if (hi - lo > 100) for (let q = Math.ceil(bLo / 45); q * 45 < bHi; q++) addSpr(sd > 0 ? S_LAMP_L : S_LAMP_R, q * 45 - camW + (sd > 0 ? 22 : 0), sd * (segE3[kb] - 0.2), 9.5);
      }
      const kr = segOf(Math.max(0, bLo - 60 - camW));
      addText(signCache, -(riverIdxOf(r) + 1), 'р. ' + (rivers[riverIdxOf(r)].name || ''), 2, bLo - 60 - camW, segE2[kr] + 2.4, 3.0);
    }
    // guard rails on mountain stretches
    for (let q = Math.floor(w0 / 64); q * 64 < Math.min(w1, camW + 700); q++) {
      const s = q * 64 - camW, k = segOf(Math.max(0, s + 32));
      if (segStyle[k] !== 1) continue;
      const g = hh(q, 404);
      if (g < 0.4) addWall(T_GUARD, s, s + 64, segE2[k] - 0.15, 0.9, 0);
      if (g > 0.3 && g < 0.75) addWall(T_GUARD, s, s + 64, -(segE2[k] - 0.15), 0.9, 0);
    }
    // power poles (left) and street lamps (cities)
    let pPrevX = 0, pPrevY = 0, pPrevOk = false;
    for (let q = Math.floor(w0 / 50); q * 50 < w1; q++) {
      const s = q * 50 - camW, k = segOf(Math.max(0, s));
      if (segStyle[k] >= 2 || (nRiv && riverAt(q * 50, 40) >= 0)) { pPrevOk = false; continue; }
      const L = -(segE4[k] + 3.5);
      if (!proj(s, L)) { pPrevOk = false; continue; }
      const top = PY - 9.6 * PS, x = PX, kk = PK;
      addSpr(S_POLE, s, L, 10);
      if (pPrevOk && s < 700) {
        const i = push(4, kk, s);
        if (i >= 0) { itA[i] = pPrevX; itB[i] = pPrevY; itC[i] = x; itD[i] = top; itE[i] = Math.min(14, 0.35 * PS * 3); }
      }
      pPrevX = x; pPrevY = top; pPrevOk = true;
    }
    for (let q = Math.floor(w0 / 32); q * 32 < Math.min(w1, camW + 800); q++) {
      const s = q * 32 - camW, k = segOf(Math.max(0, s));
      if (segStyle[k] !== 2 && segStyle[k] !== 3) continue;
      const sd = q & 1 ? 1 : -1;
      addSpr(sd > 0 ? S_LAMP_L : S_LAMP_R, s, sd * (segE2[k] + 0.4), 9);
    }
    // km posts (right)
    for (let q = Math.max(0, Math.ceil(w0 / 1000)); q * 1000 < w1 && q * 1000 <= lengthM; q++) {
      const s = q * 1000 - camW, k = segOf(Math.max(0, s));
      if (segStyle[k] === 4) continue;
      addText(kmCache, q, String(q), 3, s, segE2[k] + 1.0, 1.05);
    }
    // places: entry/exit signs, churches
    for (let n = 0; n < nNear; n++) {
      const pi = nearP[n], p = places[pi], R = placeR(p) * 0.9 + 150, pm = placeM[pi];
      for (let e = 0; e < 2; e++) {
        let w = pm + (e ? R : -R);
        const dk = w - Math.round(w / 1000) * 1000; if (Math.abs(dk) < 40) w += dk >= 0 ? 40 - dk : -40 - dk;
        const s = w - camW; if (s < 0.5 || s > 900) continue;
        const k = segOf(s);
        addText(signCache, pi * 2 + e, p.name || '', e, s, segE2[k] + 2.2, 3.0);
      }
      if (hh(pi, 5) < (p.type === 'village' ? 0.55 : 1)) {
        const w = pm + (hh(pi, 6) - 0.5) * Math.min(1500, placeR(p)) * 0.5, s = w - camW;
        if (s > 2 && s < 950 && !(nRiv && riverAt(w, 60) >= 0)) {
          const k = segOf(s), sd = hh(pi, 7) < 0.5 ? -1 : 1;
          const v = w < 200000 && p.type === 'village' ? 2 : hh(pi, 8) < 0.3 ? 1 : 0;
          addSpr(S_CHURCH[v], s, sd * (segE4[k] + 22 + hh(pi, 9) * 10), v === 2 ? 17 : p.type === 'city' ? 30 : 22);
        }
      }
    }
    // buildings, by 48 m lots
    if (nNear) for (let li = Math.floor((camW - 48) / 48); li * 48 < camW + 950; li++) {
      const lw = li * 48, wc = lw + 24;
      const td = townDensity(wc); if (td < 0.06) continue;
      if (nRiv && riverAt(wc, 70) >= 0) continue;
      const tk = townKind(wc), lv = Math.abs(wc - lvivM) < 2600, big = tk === 2 && (Math.abs(wc - lvivM) > 2600);
      const s0 = lw - camW, k = segOf(Math.max(0, s0 + 24)), e3 = segE3[k], e4 = segE4[k];
      for (let sd = -1; sd <= 1; sd += 2) {
        const hL = hh(li, sd + 50), hv = hh(li, sd + 60);
        if (hL > Math.min(0.97, td * 1.3 + (lv ? 0.6 : 0))) continue;
        if (lv) {
          for (let j = 0; j < 3; j++) { if (hh(li * 3 + j, sd + 70) < 0.06) continue; addBuilding(building(4, (hh(li * 3 + j, sd + 71) * 7) | 0, 15.6), s0 + j * 16, sd * (e3 + 0.3), sd); }
        } else if (big || (tk === 1 && hL < td * 0.35)) {
          const tower = big && hv < 0.55;
          const b = tower ? building(3, (hh(li, sd + 72) * 6) | 0, 36) : building(2, (hh(li, sd + 72) * 6) | 0, tk === 1 ? 38.4 : 44.8);
          if (big && hv > 0.9) { addBuilding(building(5, (hh(li, sd + 73) * 6) | 0, 12), s0 + 4, sd * (e4 + 3), sd); addBuilding(building(1, (hh(li, sd + 74) * 6) | 0, 10), s0 + 26, sd * (e4 + 6), sd); }
          else addBuilding(b, s0 + 2, sd * (e4 + 8 + hv * 9), sd);
        } else {
          for (let j = 0; j < 2; j++) {
            const hj = hh(li * 2 + j, sd + 80); if (hj > 0.92) continue;
            const kind = tk === 1 ? (hj < 0.5 ? 1 : hj < 0.8 ? 0 : 5) : (hj < 0.12 ? 1 : hj < 0.18 ? 5 : 0);
            const len = kind === 0 ? 11 : kind === 1 ? 10 : 12;
            const v = (hh(li * 2 + j, sd + 81) * 6) | 0, ss = s0 + j * 24 + 2 + hh(li * 2 + j, sd + 82) * 6;
            const Lh = e4 + 6 + hh(li * 2 + j, sd + 83) * 4;
            addBuilding(building(kind, v, len), ss, sd * Lh, sd);
            if (kind !== 5) addWall(T_FENCE[v & 3], ss - 4, ss + len + 5, sd * (Lh - 3), 1.3, 0);
          }
        }
      }
    }
  }
  const riverIdxOf = r => rivIdx[r];

  // ---- drawing items ----
  function blit(e, sx, sy, sw, sh, dx, dy, dw, dh) {
    if (nightA < 0.98) ctx.drawImage(e.d, sx, sy, sw, sh, dx, dy, dw, dh);
    if (nightA > 0.02) {
      if (nightA < 0.98) ctx.globalAlpha = nightA;
      ctx.drawImage(e.n, sx, sy, sw, sh, dx, dy, dw, dh);
      ctx.globalAlpha = 1;
    }
  }
  function drawRect(e, x0, yTop, w, h, clip) { // sprite entry into a dest rect, bottom cropped at clip
    const vis = Math.min(h, clip - yTop);
    if (vis <= 0 || w <= 0) return;
    const sh = Math.max(1, Math.round(e.h * vis / h));
    blit(e, 0, 0, e.w, sh, x0, yTop, w, vis);
  }
  function pline(xa, ya, xb, yb) {
    xa = Math.round(xa); ya = Math.round(ya); xb = Math.round(xb); yb = Math.round(yb);
    const dx = xb - xa, dy = yb - ya;
    if (Math.abs(dx) >= Math.abs(dy)) {
      if (dx === 0) { ctx.fillRect(xa, ya, 1, 1); return; }
      const x0 = Math.max(-1, Math.min(xa, xb)), x1 = Math.min(W, Math.max(xa, xb));
      let runX = x0, runY = Math.round(ya + dy * (x0 - xa) / dx);
      for (let x = x0 + 1; x <= x1; x++) {
        const y = Math.round(ya + dy * (x - xa) / dx);
        if (y !== runY || x === x1) { ctx.fillRect(runX, runY, x - runX + (x === x1 && y === runY ? 1 : 0), 1); runX = x; runY = y; }
      }
    } else {
      const y0 = Math.max(-1, Math.min(ya, yb)), y1 = Math.min(H, Math.max(ya, yb));
      let runY = y0, runX = Math.round(xa + dx * (y0 - ya) / dy);
      for (let y = y0 + 1; y <= y1; y++) {
        const x = Math.round(xa + dx * (y - ya) / dy);
        if (x !== runX || y === y1) { ctx.fillRect(runX, runY, 1, y - runY + (y === y1 && x === runX ? 1 : 0)); runX = x; runY = y; }
      }
    }
  }
  function drawItem(i) {
    const kind = itK[i], clip = segClip[kind === 1 ? itF[i] : itSeg[i]];
    if (kind === 0) { // sprite
      const h = itD[i], w = Math.max(1, Math.round(itC[i])), hh_ = Math.max(1, Math.round(h));
      const e = itR[i].pick(h);
      drawRect(e, Math.round(itA[i] - w / 2), Math.round(itB[i]) - hh_, w, hh_, clip);
    } else if (kind === 1) { // textured wall, per column
      const sa = itA[i], sb = itB[i], Lat = itC[i], hm = itD[i], u0 = itE[i], tex = itR[i];
      if (!proj(sa, Lat)) return;
      const xa = PX, ya = PY, za = PZ, sca = PS;
      if (!proj(sb, Lat)) return;
      const xb = PX, yb = PY, zb = PZ, scb = PS;
      const e = tex.pick(Math.max(sca, scb)), dens = e.dens, tw = e.w, th = e.h, texLen = tex.len;
      const tA = ya - hm * sca, tB = yb - hm * scb, iza = 1 / za, izb = 1 / zb, uA = u0 * iza, uB = (u0 + sb - sa) * izb;
      const dx = xb - xa;
      let x0 = Math.floor(Math.min(xa, xb)), x1 = Math.ceil(Math.max(xa, xb));
      if (x1 === x0) x1 = x0 + 1;
      if (x0 < 0) x0 = 0; if (x1 > W) x1 = W;
      // strips as wide as the edges allow without stepping more than ~1 px (1 column when steep)
      const adx = Math.abs(dx) < 0.5 ? 0.5 : Math.abs(dx);
      const slope = Math.max(Math.abs(tB - tA), Math.abs(yb - ya)) / adx;
      const kw = Math.max(1, Math.min(24, Math.floor(0.9 / Math.max(1e-3, slope))));
      for (let x = x0; x < x1; x += kw) {
        const xe = Math.min(x1, x + kw);
        const f = Math.abs(dx) < 0.5 ? 0.5 : clamp01(((x + xe) * 0.5 - xa) / dx);
        const yt = Math.round(tA + (tB - tA) * f), ybR = Math.round(ya + (yb - ya) * f), bot = Math.min(ybR, clip);
        if (bot <= yt) continue;
        const sh = Math.max(1, Math.round(th * (bot - yt) / (ybR - yt)));
        let fl = Math.abs(dx) < 0.5 ? 0.5 : clamp01((x - xa) / dx), fr = Math.abs(dx) < 0.5 ? 0.5 : clamp01((xe - xa) / dx);
        let ul = (uA + (uB - uA) * fl) / (iza + (izb - iza) * fl), ur = (uA + (uB - uA) * fr) / (iza + (izb - iza) * fr);
        if (ul > ur) { const q = ul; ul = ur; ur = q; }
        const base = Math.floor(ul / texLen) * texLen;
        let c0 = (ul - base) * dens, c1 = (ur - base) * dens;
        if (kw === 1 || c1 > tw || c1 - c0 < 1) { // single column (or a strip crossing the texture seam)
          if (kw > 1 && c1 > tw) { for (let xx = x; xx < xe; xx++) { const ff = clamp01((xx + 0.5 - xa) / adx * Math.sign(dx || 1)); const um = (uA + (uB - uA) * ff) / (iza + (izb - iza) * ff); let col = Math.floor((um % texLen) * dens); if (col < 0) col += tw; if (col >= tw) col = tw - 1; blit(e, col, 0, 1, sh, xx, yt, 1, bot - yt); } continue; }
          let col = Math.floor(((c0 + c1) * 0.5) % tw); if (col < 0) col += tw;
          blit(e, col, 0, 1, sh, x, yt, xe - x, bot - yt);
        } else blit(e, c0, 0, c1 - c0, sh, x, yt, xe - x, bot - yt);
      }
    } else if (kind === 2) { // building front face
      if (!proj(itA[i], itC[i])) return;
      const xa = PX, ya = PY, sa = PS;
      if (!proj(itA[i], itE[i])) return;
      const xb = PX, yb = PY, sb = PS, hm = itD[i];
      const x0 = Math.round(Math.min(xa, xb)), x1 = Math.round(Math.max(xa, xb));
      const yBot = Math.round((ya + yb) / 2), yTop = Math.round(yBot - hm * (sa + sb) / 2);
      if (x1 <= x0 || x1 < 0 || x0 > W) return;
      drawRect(itR[i].pick((sa + sb) / 2), x0, yTop, x1 - x0, yBot - yTop, clip);
    } else if (kind === 3) { // text sign / km plate
      const e = itR[i], h = itD[i];
      const s0 = e.kind === 3 ? 17 : 31; // native height at scale 1
      const sc = Math.max(1, Math.min(4, Math.round(h / s0)));
      const c = signEntry(e, sc), k = h / c.h, w = Math.max(1, Math.round(c.w * k)), hh_ = Math.max(1, Math.round(h));
      drawRect(c, Math.round(itA[i] - w / 2), Math.round(itB[i]) - hh_, w, hh_, clip);
    } else if (kind === 4) { // sagging wire pair
      const xa = itA[i], ya = itB[i], xb = itC[i], yb = itD[i], sag = itE[i];
      if ((xa < 0 && xb < 0) || (xa > W && xb > W)) return;
      ctx.fillStyle = curWire;
      for (let wv = 0; wv < 2; wv++) {
        const o = wv ? 2 : 0;
        let px0 = xa, py0 = ya + o;
        for (let q = 1; q <= 6; q++) { const t = q / 6, px1 = xa + (xb - xa) * t, py1 = ya + (yb - ya) * t + o + sag * 4 * t * (1 - t); pline(px0, py0, px1, py1); px0 = px1; py0 = py1; }
      }
    }
  }
  let curWire = '#333';
  function drawItems(fore) {
    // bucket sort by segment, far → near (stable inside a bucket)
    bucket.fill(0);
    let n = 0;
    for (let i = 0; i < nIt; i++) if (itFore[i] === fore) { bucket[NSEG - itSeg[i]]++; n++; }
    for (let b = 1; b <= NSEG + 1; b++) bucket[b] += bucket[b - 1];
    for (let i = nIt - 1; i >= 0; i--) if (itFore[i] === fore) itOrder[--bucket[NSEG - itSeg[i]]] = i;
    for (let j = 0; j < n; j++) drawItem(itOrder[j]);
  }

  function render(distanceM, dt, vehicleDrawFn, opts = {}) {
    dt = dt > 0 ? Math.min(dt, 0.25) : 0;
    clock += dt;
    if (typeof opts.timeOfDay === 'number') tod = ((opts.timeOfDay % 1) + 1) % 1;
    else tod = (tod + dt / DAY_S) % 1;
    const pIdx = Math.min(PAL_N - 1, (tod * PAL_N) | 0), P = PAL[pIdx];
    if (pIdx !== lutFor) { buildLut(P); lutFor = pIdx; }
    const m = Math.max(0, Math.min(lengthM, +distanceM || 0));
    camW = m - Z_V;

    // nearby places & rivers (no allocation)
    nNear = 0;
    for (let i = lowerBound(placeM, camW - 13000); i < placeM.length && placeM[i] < camW + 14000 && nNear < 64; i++) {
      if (Math.abs(placeM[i] - (camW + 600)) < placeR(places[i]) + 1600) nearP[nNear++] = i;
    }
    nRiv = 0;
    for (let i = lowerBound(riverM, camW - 600); i < riverM.length && riverM[i] < camW + S_END + 600 && nRiv < 16; i++) {
      const hw = RHALF[i];
      if (hw <= 22 && nNear && townDensity(riverM[i]) > 0.5) continue;   // city streams run in culverts (Полтва under Lviv)
      rivLo[nRiv] = riverM[i] - hw; rivHi[nRiv] = riverM[i] + hw; rivPad[nRiv] = Math.min(30, hw + 8); rivIdx[nRiv] = i; nRiv++;
    }

    // camera heading & pitch (smoothed, snap on seeks)
    const tgtH = headingAt(Math.max(0, camW + 12));
    const g = (eS(m + 45) - eS(m - 45)) / 90 * EXAG;
    const tgtP = Math.max(-34, Math.min(34, Math.atan(g) * F * 0.55));
    if (!(camHead === camHead) || Math.abs(m - lastM) > 2500) { camHead = tgtH; pitch = tgtP; steerS = 0; }
    else {
      camHead = (camHead + wrap180(tgtH - camHead) * Math.min(1, dt * 2.5) + 360) % 360;
      pitch += (tgtP - pitch) * Math.min(1, dt * 3);
    }
    lastM = m;
    HZ = Math.round(HZ0 + pitch);
    camE = (VEH_Y - HZ) * Z_V / F;
    eV = eS(m);
    nightA = P.night; hlOn = false;   // headlight beams are drawn by the vehicle sprites themselves (vehicles-rear.js)
    curWire = P.wire;

    const T0 = performance.now();
    buildSegments(m);
    // steering from the curve ~45 m ahead of the vehicle
    const ks = segOf(Z_V + 45);
    const tgtS = Math.max(-1, Math.min(1, segRel[ks] / 22));
    steerS += (tgtS - steerS) * Math.min(1, dt * 4);
    vehX = CX + Math.round(steerS * 5);

    // ground + ridges into the pixel layer
    buf.fill(0);
    const T1 = performance.now();
    const groundTop = drawGround();
    const T2 = performance.now();
    drawRidges(P, m, Math.min(groundTop, HZ + 3));
    const T2b = performance.now();
    L.putImageData(img, 0, 0);
    const T3 = performance.now();

    ctx.imageSmoothingEnabled = false;
    ctx.globalAlpha = 1;
    drawSky(P);
    ctx.drawImage(layer, 0, 0);

    const T4 = performance.now();
    collect();
    const T5 = performance.now();
    drawItems(0);

    env.t = clock; env.speed = opts.speedMps || 0; env.night = P.night; env.timeOfDay = tod;
    env.steer = steerS; env.grade = gradeAt(m);
    if (vehicleDrawFn) vehicleDrawFn(ctx, vehX, VEH_Y, env);
    ctx.globalAlpha = 1;
    drawItems(1);

    if (opts.showNote !== false) drawText(ctx, 'висота ×2.5', 3, 3, 'rgba(255,255,255,0.7)', { shadow: 'rgba(0,0,0,0.45)' });

    const T6 = performance.now();
    prof[0] += T1 - T0; prof[1] += T2 - T1; prof[2] += T2b - T2; prof[7] += T3 - T2b; prof[3] += T4 - T3; prof[4] += T5 - T4; prof[5] += T6 - T5; prof[6]++;
    result.night = P.night; result.timeOfDay = tod; result.vehicleX = vehX; result.groundY = VEH_Y;
    return result;
  }

  return { render, prof };
}
