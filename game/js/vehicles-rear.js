// vehicles-rear.js — the 12 vehicles of vehicles.js seen FROM BEHIND (forward chase camera, 480×270 canvas).
// REAR[id] = { w, h, draw(ctx, x, y, env), flyAltPx? }
//   x = integer centre column, y = wheel-contact row; the sprite occupies rows y-h .. y-1
//   (flying vehicles: rows y-flyAltPx-h .. y-flyAltPx-1, plus a soft dithered shadow at y).
//   env = { night 0..1, timeOfDay, t (s), speed (m/s), steer -1..1, grade, view: 'rear' }.
// Static art is baked once (lazily, on the first draw) into offscreen canvases: a day body, a night "lit"
// layer (windows, lamps), a ground shadow and a headlight cone. Each frame composes body + animated parts
// (tyre tread, legs, propellers, blinkers) into a per-vehicle scratch canvas, then blits it with a lean
// (ground vehicles: horizontal shear) or a bank (planes: vertical shear). No per-frame allocation.
// No DOM/window access at module level — Node can import this file.

// ---------------------------------------------------------------- shared palette
const O = '#15131b';                                            // outline
const CH = ['#f4f6fa', '#b9bdc6', '#7a7e88', '#4a4d55'];        // chrome hi → dark
const GL = { d: '#18293a', m: '#24405a', s: '#3d6688', h: '#9fd0ec', r: '#5f8fb4' };
const TL = { d: '#6a1414', m: '#9c2420', h: '#cc4a3c' };        // tail light, unlit
const TLL = { m: '#ff3a2c', h: '#ffd6c8' };                     // tail light, lit
const AM = { d: '#7a5010', m: '#b87e1a', h: '#f0c060' }, AML = '#ffb030';
const PLT = { b: '#ecebe2', d: '#2a2a32', s: '#b0b0a8' };
const UND = '#0c0c10';
const TY = { d: '#151519', m: '#34343c', s: '#24242a', k: '#0a0a0c' };
const WARM = ['#fff3c0', '#f6d880', '#e4b458', '#b88a3c'];      // lit cabin, top → bottom
const NIGHT_TINT = '#0b1230';

// ---------------------------------------------------------------- bake-time helpers (draw into B, width W)
let B = null, W = 0;
function R(x, y, w, h, c) { B.fillStyle = c; B.fillRect(x, y, w, h); }
function P(x, y, c) { B.fillStyle = c; B.fillRect(x, y, 1, 1); }
function M(x, y, w, h, c) { B.fillStyle = c; B.fillRect(x, y, w, h); B.fillRect(W - x - w, y, w, h); } // mirrored pair
function MP(x, y, c) { M(x, y, 1, 1, c); }
function S(y, hw, c, h = 1) { B.fillStyle = c; B.fillRect((W >> 1) - hw, y, hw * 2, h); }               // centred span
function D(x, y, w, h, c, ph = 0) {                                                                    // checker dither
  B.fillStyle = c;
  for (let j = 0; j < h; j++) for (let i = (j + ph) & 1; i < w; i += 2) B.fillRect(x + i, y + j, 1, 1);
}
function MD(x, y, w, h, c, ph = 0) { D(x, y, w, h, c, ph); D(W - x - w, y, w, h, c, (ph + w + 1) & 1); }
function SD(y, hw, c, ph = 0, h = 1) { MD((W >> 1) - hw, y, hw, h, c, ph); }
// Symmetric body profile: half-widths per row from y0; outline o, fill f (outline follows stepped edges).
function prof(y0, hws, o, f) {
  for (let i = 0; i < hws.length; i++) S(y0 + i, hws[i], o);
  if (!f) return;
  for (let i = 1; i < hws.length - 1; i++) { const hw = Math.min(hws[i - 1], hws[i], hws[i + 1]) - 1; if (hw > 0) S(y0 + i, hw, f); }
}
function fillHw(hws, i) { return Math.min(hws[i - 1], hws[i], hws[i + 1]) - 1; }
// Light from upper-left: inner left edge lighter, inner right edge darker.
function edges(y0, hws, hi, sh, from = 1, to = hws.length - 1) {
  const cx = W >> 1;
  for (let i = Math.max(1, from); i < Math.min(hws.length - 1, to); i++) {
    const hw = fillHw(hws, i);
    if (hw > 1) { P(cx - hw, y0 + i, hi); P(cx + hw - 1, y0 + i, sh); }
  }
}
// Even-diameter disc centred between columns cx-1 | cx (top row = top).
function ed(cx, top, r, c) {
  B.fillStyle = c;
  for (let i = 0; i < 2 * r; i++) {
    const dy = i - r + 0.5, hw = Math.round(Math.sqrt(Math.max(0, r * r - dy * dy)));
    if (hw > 0) B.fillRect(cx - hw, top + i, hw * 2, 1);
  }
}
// Dark glass with a sky band and two parallel diagonal reflections.
function glass(x, y, w, h, alt = 0) {
  R(x, y, w, h, GL.m); R(x, y, w, 1, GL.s); R(x, y + h - 1, w, 1, GL.d);
  if (h > 4) D(x, y + h - 3, w, 2, GL.d, alt);
  B.fillStyle = GL.h;
  const a = x + (w * 0.22 | 0) + alt;
  for (let j = 1; j < h - 1; j++) {
    const xx = a + (h - 1 - j) - (h >> 1);
    if (xx >= x && xx < x + w) B.fillRect(xx, y + j, 1, 1);
    const x2 = xx + 3;
    if (x2 >= x && x2 < x + w && (j & 1)) B.fillRect(x2, y + j, 1, 1);
  }
}
// Warm lit cabin window (night layer) with seat backs and passengers' heads.
function litWin(x, y, w, h, seed = 1, heads = true) {
  const b1 = y + (h * 0.3 | 0), b2 = y + (h * 0.65 | 0);
  R(x, y, w, h, WARM[1]); R(x, y, w, b1 - y, WARM[0]); R(x, b2, w, y + h - b2, WARM[2]);
  D(x, b1, w, 1, WARM[0]); D(x, b2, w, 1, WARM[1]);
  R(x + 1, y + 1, w - 2, 1, '#fffbe8');                         // ceiling lamp strip
  if (!heads) return;
  let s = seed * 9301 + 49297;
  for (let px = x + 2; px < x + w - 3; ) {
    s = (s * 9301 + 49297) % 233280;
    const hy = y + h - 5 - (s % 3);
    if (s % 5 !== 0) {                                          // a passenger: head + shoulders silhouette
      R(px, hy, 3, 3, '#6a4426'); R(px - 1, hy + 3, 5, y + h - hy - 3, '#7a5430'); P(px + 1, hy, '#8a5e36');
    }
    px += 5 + (s % 4);
  }
  R(x, y + h - 1, w, 1, WARM[3]);
}
function tailDay(x, y, w, h) { R(x, y, w, h, TL.m); R(x, y, w, 1, TL.h); R(x, y + h - 1, w, 1, TL.d); }
function tailLit(x, y, w, h) { R(x, y, w, h, TLL.m); if (w > 2 && h > 2) R(x + 1, y + 1, w - 2, h - 2, TLL.h); else P(x, y, TLL.h); }
function plate(x, y, w, h, flag) {
  R(x - 1, y - 1, w + 2, h + 2, O); R(x, y, w, h, PLT.b); R(x, y + h - 1, w, 1, PLT.s);
  const my = y + (h >> 1);
  for (let i = flag ? 3 : 1; i < w - 1; i += 2) P(x + i, my, PLT.d);
  if (flag) { P(x + 1, y, '#2a5ab8'); P(x + 1, y + 1, '#ffd21a'); }
}
// 3×5 pixel font (bake-time only).
const FONT = {
  '0': '###|#.#|#.#|#.#|###', '1': '.#.|##.|.#.|.#.|###', '2': '###|..#|###|#..|###', '3': '###|..#|.##|..#|###',
  '4': '#.#|#.#|###|..#|..#', '5': '###|#..|###|..#|##.', '6': '###|#..|###|#.#|###', '7': '###|..#|.#.|.#.|.#.',
  '8': '###|#.#|###|#.#|###', '9': '###|#.#|###|..#|###', 'Е': '###|#..|##.|#..|###', '-': '...|...|###|...|...',
};
function text(str, x, y, sc, c) {
  for (const ch of str) {
    const g = FONT[ch];
    if (g) { const rows = g.split('|'); for (let j = 0; j < 5; j++) for (let i = 0; i < 3; i++) if (rows[j][i] === '#') R(x + i * sc, y + j * sc, sc, sc, c); }
    x += 4 * sc;
  }
}

// ---------------------------------------------------------------- runtime state + helpers (draw into G)
let G = null;
const F = { t: 0, sp: 0, n: 0, k: 0, bob: 0, steer: 0, ph: 0, blur: false };   // reused every frame
function g(x, y, w, h, c) { G.fillStyle = c; G.fillRect(x, y, w, h); }
// Tyre seen from behind: dark block, sidewalls, tread bars moving up as the wheel rolls; blur when fast.
function tyre(x, y, w, h, knob) {
  g(x, y, w, h, TY.d);
  if (w > 3) { g(x, y, 1, h, TY.s); g(x + w - 1, y, 1, h, TY.s); }
  const ix = w > 3 ? x + 1 : x, iw = w > 3 ? w - 2 : w;
  if (F.blur) {
    G.globalAlpha = 0.45; g(ix, y, iw, h, TY.m); G.globalAlpha = 1;
    for (let r = (2 - (F.ph & 1)); r < h - 1; r += 2) g(ix, y + r, iw, 1, TY.s);
  } else {
    const p = 2 - (F.ph % 3);
    for (let r = p, q = 0; r < h - 1; r += 3, q++) {
      if (knob && iw > 3) { const hw = iw >> 1; g(ix + ((q + (F.ph / 3 | 0)) & 1 ? hw : 0), y + r, iw - hw, 2, TY.m); }
      else g(ix, y + r, iw, 1, TY.m);
    }
  }
  g(x, y + h - 1, w, 1, TY.k);
}
function bobOf(t, sp, rate) {
  if (sp < 0.3) return 0;
  return ((t * (2 + Math.min(sp, 20) * 0.2) * rate) | 0) & 1;
}
function blink(t, period, on, offset = 0) { return ((t / period + offset) % 1) < on; }

// ---------------------------------------------------------------- canvases
function mkCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas'); c.width = w; c.height = h; return c;
}
function ctx2d(c) { const x = c.getContext('2d'); x.imageSmoothingEnabled = false; return x; }
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function bakeShadow(s) {
  const fly = s.flyAltPx > 0, sw = fly ? Math.round(s.w * 0.62) : s.w + 6, sh = fly ? (s.w > 120 ? 8 : 5) : 5;
  const c = mkCanvas(sw, sh), x = ctx2d(c);
  x.fillStyle = '#000';
  for (let j = 0; j < sh; j++) {
    const dy = (j + 0.5) / sh * 2 - 1;
    for (let i = 0; i < sw; i++) {
      const dx = (i + 0.5) / sw * 2 - 1, d = dx * dx + dy * dy;
      if (d > 1) continue;
      const lvl = fly ? (d < 0.45 ? 8 : 4) : (d < 0.55 ? 16 : d < 0.85 ? 8 : 4);
      if (BAYER[(j & 3) * 4 + (i & 3)] < lvl) x.fillRect(i, j, 1, 1);
    }
  }
  s.shadow = c; s.shW = sw; s.shH = sh;
}
// Headlight beam on the road ahead: wide near the vehicle, narrowing toward the horizon, fading dither.
function bakeCone(s) {
  const L = s.coneLen, cw = s.w + 12, c = mkCanvas(cw, L), x = ctx2d(c), cx = cw >> 1;
  for (let j = 0; j < L; j++) {
    const f = 1 - j / (L - 1);                                  // 0 near (bottom) → 1 far (top)
    const hw = Math.round(s.w * (0.56 - 0.36 * f)), lvl = Math.round(9 - 8 * f);
    for (let i = -hw; i < hw; i++) {
      const lobe = Math.abs(Math.abs(i + 0.5) - hw * 0.45) < hw * 0.3 ? 2 : 0;   // two beams
      if (BAYER[(j & 3) * 4 + ((i + cx) & 3)] < lvl + lobe) {
        x.fillStyle = lobe && f < 0.5 && BAYER[((j + 2) & 3) * 4 + ((i + cx + 1) & 3)] < 3 ? '#fffbe6' : '#ffe9a0';
        x.fillRect(cx + i, j, 1, 1);
      }
    }
  }
  s.cone = c; s.coneW = cw;
}
function bake(s) {
  W = s.w;
  s.body = mkCanvas(s.w, s.h); B = ctx2d(s.body); s.paint();
  if (s.paintLit) { s.lit = mkCanvas(s.w, s.h); B = ctx2d(s.lit); s.paintLit(); }
  B = null;
  s.K = ctx2d(mkCanvas(s.w, s.h));
  bakeShadow(s);
  if (s.coneLen) bakeCone(s);
  s.ready = true;
}

// ---------------------------------------------------------------- the generic draw
const PUFF_A = [0.6, 0.38, 0.18];
function puffs(ctx, x, y, side, up, col) {
  const sp = F.sp, rate = sp < 0.3 ? 0.7 : 1.4 + Math.min(sp, 30) * 0.04;
  ctx.fillStyle = col;
  for (let i = 0; i < 3; i++) {
    const ph = (F.t * rate + i / 3) % 1, st = ph < 0.34 ? 0 : ph < 0.67 ? 1 : 2;
    ctx.globalAlpha = PUFF_A[st];
    const sz = 1 + st + (sp > 8 ? 1 : 0);
    const dx = Math.round(side * ph * (3 + Math.min(sp, 20) * 0.25));
    const dy = up ? -Math.round(ph * 9) : Math.round(ph * (sp > 0.3 ? 3 : 0) - ph * ph * 7);
    ctx.fillRect(x + dx - (sz >> 1), y + dy - (sz >> 1), sz, sz);
  }
  ctx.globalAlpha = 1;
}
function leanAt(row, h, lean) { return lean ? Math.round(lean * (h - 1 - row) / (h - 1)) : 0; }

function drawRear(s, ctx, x, y, env) {
  if (!s.ready) bake(s);
  const e = env || F, w = s.w, h = s.h, fly = s.flyAltPx | 0;
  F.t = +e.t || 0; F.sp = Math.max(0, +e.speed || 0); F.n = Math.min(1, Math.max(0, +e.night || 0));
  F.steer = Math.min(1, Math.max(-1, +e.steer || 0));
  F.k = Math.min(1, Math.max(0, (F.n - 0.3) / 0.4));
  F.bob = fly ? (Math.sin(F.t * (fly > 60 ? 0.9 : 1.7)) > 0.3 ? 1 : 0) : bobOf(F.t, F.sp, s.bobRate || 1);
  const rev = F.sp / (6.2832 * (s.wheelR || 0.3));
  F.blur = rev > 6; F.ph = (F.t * rev * 9) | 0;
  const off = fly ? Math.round(F.steer * 3) : Math.round(F.steer * (s.shift || 1));
  const X0 = (x | 0) - (w >> 1) + off, Y0 = (y | 0) - h - fly;
  const lean = fly ? 0 : Math.round(F.steer * (s.lean || 0));
  const roll = fly ? Math.round(F.steer * (s.roll || 0)) : 0;
  // 1. ground shadow (and the headlight beam, which the body then hides near the vehicle)
  ctx.globalAlpha = fly ? 0.32 : 0.5;
  ctx.drawImage(s.shadow, (x | 0) - (s.shW >> 1) + (fly ? off * 2 : off), (y | 0) - (s.shH >> 1) - (fly ? 0 : 1));
  if (F.k > 0 && s.cone) {
    ctx.globalAlpha = 0.5 * F.k;
    ctx.drawImage(s.cone, (x | 0) - (s.coneW >> 1) + off + leanAt(0, h, lean), (y | 0) - Math.round(h * s.coneY) - s.coneLen);
  }
  ctx.globalAlpha = 1;
  // 2. compose into the scratch canvas
  const K = s.K; G = K;
  K.clearRect(0, 0, w, h);
  if (s.under) s.under();
  const ty = s.tyres;
  if (ty) for (let i = 0; i < ty.length; i++) tyre(ty[i][0], ty[i][1], ty[i][2], ty[i][3], s.knob);
  K.drawImage(s.body, 0, -F.bob);
  if (s.over) s.over();
  if (F.n > 0.02) {
    K.globalCompositeOperation = 'source-atop';
    K.globalAlpha = 0.4 * F.n; K.fillStyle = NIGHT_TINT; K.fillRect(0, 0, w, h);
    K.globalAlpha = 1; K.globalCompositeOperation = 'source-over';
  }
  if (s.lit && F.k > 0) { K.globalAlpha = F.k; K.drawImage(s.lit, 0, -F.bob); K.globalAlpha = 1; }
  if (s.post) s.post();
  // 3. blit with lean (rows sheared) or bank (columns sheared)
  if (s.pre) s.pre(ctx, X0, Y0);
  const cv = K.canvas;
  if (lean) {
    for (let r0 = 0; r0 < h; ) {
      const o = leanAt(r0, h, lean); let r1 = r0 + 1;
      while (r1 < h && leanAt(r1, h, lean) === o) r1++;
      ctx.drawImage(cv, 0, r0, w, r1 - r0, X0 + o, Y0 + r0, w, r1 - r0);
      r0 = r1;
    }
  } else if (roll) {
    const half = w >> 1;
    for (let c0 = 0; c0 < w; ) {
      const o = Math.round(roll * (c0 - half) / half); let c1 = c0 + 1;
      while (c1 < w && Math.round(roll * (c1 - half) / half) === o) c1++;
      ctx.drawImage(cv, c0, 0, c1 - c0, h, X0 + c0, Y0 + o, c1 - c0, h);
      c0 = c1;
    }
  } else ctx.drawImage(cv, X0, Y0);
  // 4. light halos + exhaust on the main canvas
  if (F.k > 0 && s.tails) {
    const tl = s.tails;
    ctx.fillStyle = '#ff2a20';
    for (let i = 0; i < tl.length; i++) {
      const L = tl[i], lx = X0 + L[0] + leanAt(L[1], h, lean), ly = Y0 + L[1] - F.bob;
      ctx.globalAlpha = 0.22 * F.k; ctx.fillRect(lx - 2, ly - 2, L[2] + 4, L[3] + 4);
      ctx.globalAlpha = 0.12 * F.k; ctx.fillRect(lx - 4, ly - 3, L[2] + 8, L[3] + 6);
    }
    ctx.globalAlpha = 0.16 * F.k;                                // red spill on the road behind
    ctx.fillRect((x | 0) - (w >> 1) + off + 2, (y | 0), w - 4, 2);
    ctx.globalAlpha = 1;
  }
  if (s.pipe) { const pp = s.pipe; puffs(ctx, X0 + pp[0] + leanAt(pp[1], h, lean), Y0 + pp[1], pp[2], pp[3], s.puffCol || '#a9a9b0'); }
  if (s.fx) s.fx(ctx, X0, Y0, lean, roll);
}

function veh(spec) {
  const s = Object.assign({ ready: false, flyAltPx: 0 }, spec);
  const out = { w: s.w, h: s.h, draw: (ctx, x, y, env) => drawRear(s, ctx, x, y, env) };
  if (s.flyAltPx) out.flyAltPx = s.flyAltPx;
  return out;
}

// ================================================================= 1. bike «Україна» 22×34
const BK = { fr: '#c0282c', frD: '#7e161a', frH: '#ff6a5a', sh: '#2f6fd0', shH: '#5a96ec', shD: '#1e4c96',
  pa: '#3a4a7a', paD: '#26304f', skin: '#e8b48a', hair: '#5a3418', cap: '#f2d23a', capD: '#c0a018',
  bp: '#b8642a', bpH: '#e08a48', bpD: '#7a3e18' };
const BIKE = veh({
  w: 22, h: 34, wheelR: 0.34, bobRate: 0.7, lean: 5, shift: 1, coneY: 0.35, coneLen: 46,
  tyres: [[10, 20, 2, 14]],
  tails: [[10, 21, 2, 2]],
  paint() {
    // seat stays → axle, mudguard + reflector, rack
    R(9, 18, 1, 10, BK.fr); R(12, 18, 1, 10, BK.frD); P(9, 27, CH[1]); P(12, 27, CH[2]);
    R(9, 18, 4, 2, BK.fr); R(9, 18, 4, 1, BK.frH); tailDay(10, 21, 2, 2);
    R(6, 16, 10, 1, CH[2]); R(6, 16, 10, 1, CH[1]); P(6, 17, CH[3]); P(15, 17, CH[3]);
    // arms reaching to the grips
    for (let y = 4; y < 12; y++) { const ax = 5 - ((y - 4) * 3 >> 3); M(ax - 1, y, 2, 1, y < 8 ? BK.sh : BK.shD); }
    M(0, 13, 3, 2, '#1a1a1e'); M(1, 12, 3, 2, BK.skin); M(3, 14, 3, 1, CH[2]);
    // seat of the pants on the saddle
    prof(10, [5, 5, 5, 5, 4, 3], O, BK.pa); R(8, 15, 6, 1, BK.paD); R(10, 11, 1, 4, BK.paD);
    // torso
    const T = [3, 5, 6, 6, 6, 6, 6, 6, 5, 5];
    prof(3, T, O, BK.sh); edges(3, T, BK.shH, BK.shD); R(6, 10, 10, 1, BK.shD);
    // backpack with flap, pocket, straps
    const BP = [3, 3, 3, 3, 3, 3, 3];
    prof(5, BP, O, BK.bp); R(9, 6, 4, 2, BK.bpD); R(9, 6, 4, 1, BK.bpH); edges(5, BP, BK.bpH, BK.bpD, 3);
    R(9, 9, 4, 2, BK.bpD); R(9, 9, 4, 1, BK.bpH); P(10, 8, CH[1]); P(11, 8, CH[1]);
    MP(8, 4, '#3a2a1a'); MP(8, 5, '#3a2a1a');
    // head: yellow cap, hair, ears
    prof(0, [2, 3, 3, 3, 2], O, null); S(0, 2, BK.cap); S(1, 3, BK.cap); P(9, 0, '#fff2a0'); P(13, 1, BK.capD); S(2, 3, BK.capD);
    S(3, 3, BK.hair); S(4, 1, BK.skin); MP(8, 3, BK.skin); P(10, 3, '#7a4a24');
  },
  paintLit() { tailLit(10, 21, 2, 2); },
  under() {   // pedalling legs either side of the wheel (behind it)
    const a = F.sp > 0.05 ? (F.t * F.sp) / (6.2832 * 0.34) / 2.4 * 6.2832 : 0.8;
    const d = Math.round(Math.sin(a) * 2.4);
    leg(6, 28 + d, -1); leg(13, 28 - d, 1);
  },
});
function leg(x, fy, side) {
  const hip = 14 - F.bob, knee = hip + ((fy - hip) >> 1), bend = fy < 28 ? side : 0;
  g(x + bend, hip, 3, knee - hip, BK.pa); g(x + (side < 0 ? 2 : 0) + bend, hip, 1, knee - hip, BK.paD);
  g(x, knee, 3, fy - knee, BK.pa); g(x + (side < 0 ? 2 : 0), knee, 1, fy - knee, BK.paD);
  g(x, fy - 1, 3, 1, '#e8e8e0'); g(x - (side < 0 ? 1 : 0), fy, 4, 2, '#1a1a1e'); g(x - 1, fy + 2, 5, 1, CH[2]);
}

// ================================================================= 2. moped «Карпати» 24×36
const MO = { b: '#d23a2a', bH: '#ff7a5c', bS: '#8e1f18', eng: '#5a5c64', engD: '#34353b', j: '#3f6a3a', jH: '#5e8e56',
  jD: '#2a4a28', stripe: '#b8c890', hm: '#f0f0f0', hmS: '#b0b4bc', pa: '#2c2c3a', paD: '#1c1c26', boot: '#1a1a1a' };
const MOPED = veh({
  w: 24, h: 36, wheelR: 0.28, bobRate: 1.2, lean: 4, shift: 1, coneY: 0.35, coneLen: 50,
  tyres: [[10, 25, 4, 11]],
  tails: [[10, 19, 4, 2]],
  pipe: [21, 29, 1, 0], puffCol: '#b4b4bc',
  paint() {
    // engine + exhaust muffler (right)
    M(7, 27, 3, 4, MO.eng); M(7, 27, 3, 1, '#8a8c94'); M(7, 30, 3, 1, MO.engD);
    R(15, 26, 2, 2, CH[2]); R(16, 27, 5, 3, CH[1]); R(16, 27, 5, 1, CH[0]); R(16, 29, 5, 1, CH[2]); R(20, 28, 1, 1, O);
    // legs on the footrests
    for (let y = 17; y < 24; y++) { const lx = 5 - ((y - 17) * 2 / 7 | 0); M(lx - 1, y, 3, 1, MO.pa); MP(lx + 1, y, MO.paD); }
    M(1, 24, 4, 3, MO.boot); M(1, 24, 4, 1, '#3a3a40'); M(0, 27, 6, 1, CH[2]);
    // rear fender, plate, tail lamp
    prof(18, [3, 3, 3, 3, 3, 3, 3, 3, 2], O, MO.b); R(10, 19, 4, 1, MO.bH); R(10, 25, 4, 1, MO.bS);
    R(9, 18, 6, 3, CH[2]); R(10, 18, 4, 1, CH[0]); tailDay(10, 19, 4, 2);
    plate(10, 22, 4, 3, false);
    // seat
    R(6, 16, 12, 3, O); R(7, 16, 10, 2, '#26262c'); R(7, 16, 10, 1, '#45454e');
    // arms to the grips
    for (let y = 7; y < 14; y++) { const ax = 5 - ((y - 7) * 3 / 7 | 0); M(ax - 1, y, 2, 1, y < 10 ? MO.j : MO.jD); }
    M(0, 13, 3, 2, '#1a1a1e'); M(1, 12, 2, 2, '#2a2a2a');
    // jacket: reflective stripe, belt
    const J = [4, 6, 7, 7, 7, 7, 7, 7, 7, 7, 7, 6, 5];
    prof(5, J, O, MO.j); edges(5, J, MO.jH, MO.jD); S(11, 6, MO.stripe); S(15, 5, MO.jD); R(11, 7, 2, 8, MO.jD);
    // helmet: white with a red stripe
    const HM = [3, 4, 5, 5, 5, 4, 3];
    prof(0, HM, O, MO.hm); edges(0, HM, '#ffffff', MO.hmS); R(11, 0, 2, 6, '#c8302a'); P(8, 2, '#ffffff');
    S(6, 3, '#2a2a30');
  },
  paintLit() { tailLit(10, 19, 4, 2); R(10, 21, 4, 1, '#fff4c0'); },
});

// ================================================================= 3. ЗАЗ-965 «Горбатий» 46×34
const Z5 = { h: '#c4e2f4', b: '#7ab2d6', s: '#4b7aa2', d: '#335a7e', lv: '#22384c' };
const ZAZ965 = veh({
  w: 46, h: 34, wheelR: 0.28, lean: -1.4, coneY: 0.3, coneLen: 60,
  tyres: [[3, 26, 6, 8], [37, 26, 6, 8]],
  tails: [[3, 17, 3, 4], [40, 17, 3, 4]],
  pipe: [32, 29, 1, 0],
  paint() {
    R(13, 27, 20, 3, UND);
    // greenhouse: rounded roof, small high rear window, side glass slivers
    const GH = [7, 10, 12, 13, 13, 14, 14, 14, 15, 15, 15, 15];
    prof(1, GH, O, Z5.b); S(2, 6, Z5.h); S(3, 8, Z5.h); D(14, 4, 18, 1, Z5.h);
    for (let i = 4; i < 11; i++) { const hw = fillHw(GH, i - 1); MP(23 - hw, i, GL.d); MP(24 - hw, i, GL.m); }
    const RW = [7, 8, 9, 9, 10, 10];
    for (let i = 0; i < 6; i++) S(4 + i, RW[i] + 1, O);
    glass(14, 5, 18, 4); R(13, 9, 20, 1, GL.d);
    // body: the round hump
    const BD = [17, 19, 20, 21, 22, 22, 22, 22, 22, 22, 22, 22, 22, 21, 21, 20, 19, 18];
    prof(11, BD, O, Z5.b); S(12, 18, Z5.h); S(13, 19, Z5.h); SD(14, 20, Z5.h);
    SD(22, 21, Z5.s, 1); S(23, 21, Z5.s); S(24, 20, Z5.s, 3); edges(11, BD, Z5.h, Z5.d);
    // engine lid with louvres
    R(12, 13, 22, 1, Z5.s); R(12, 13, 1, 10, Z5.s); R(33, 13, 1, 10, Z5.s); R(13, 22, 20, 1, Z5.s);
    for (let i = 0; i < 4; i++) { M(14, 15 + i * 2, 7, 1, Z5.lv); M(14, 16 + i * 2, 7, 1, Z5.h); }
    R(22, 14, 2, 8, Z5.s); P(22, 20, CH[0]); P(23, 20, CH[1]);
    // round tail lights, plate, bumper with overriders, exhaust
    R(3, 18, 3, 2, O); R(4, 17, 1, 4, O); R(40, 18, 3, 2, O); R(41, 17, 1, 4, O);
    P(4, 18, TL.h); P(41, 18, TL.h); P(4, 19, TL.m); P(41, 19, TL.m);
    plate(18, 23, 10, 3, false);
    S(26, 22, CH[2]); S(26, 21, CH[1]); S(27, 22, CH[3]); D(3, 26, 40, 1, CH[0], 1);
    M(11, 24, 2, 4, CH[2]); M(11, 24, 1, 3, CH[0]);
    R(31, 28, 3, 2, '#55555c'); P(32, 29, O);
  },
  paintLit() {
    M(3, 18, 3, 2, TLL.m); M(4, 17, 1, 4, TLL.m); MP(4, 18, TLL.h); MP(4, 19, TLL.h);
    R(18, 23, 10, 1, '#fffbe0');
  },
});

// ================================================================= 4. ЗАЗ-968М «Вухатий» 50×34
const Z8 = { h: '#f0d9a8', b: '#d0a868', s: '#977242', d: '#6e5230', g: '#3a3026' };
const ZAZ968 = veh({
  w: 50, h: 34, wheelR: 0.28, lean: -1.4, coneY: 0.3, coneLen: 60,
  tyres: [[4, 26, 6, 8], [40, 26, 6, 8]],
  tails: [[2, 20, 6, 3], [42, 20, 6, 3]],
  pipe: [15, 29, -1, 0],
  paint() {
    R(13, 27, 24, 3, UND);
    // boxy greenhouse, wide flat rear window
    const GH = [10, 12, 13, 13, 13, 14, 14, 14, 14, 15, 15, 15];
    prof(1, GH, O, Z8.b); S(2, 9, Z8.h); S(3, 11, Z8.h);
    for (let i = 4; i < 10; i++) { const hw = fillHw(GH, i - 1); MP(25 - hw, i, GL.d); }
    S(4, 11, O, 6); glass(15, 5, 20, 4, 1);
    // body
    const BD = [19, 20, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 20, 19];
    prof(11, BD, O, Z8.b); S(12, 20, Z8.h); SD(13, 20, Z8.h); S(23, 20, Z8.s); S(24, 20, Z8.s, 2);
    SD(22, 20, Z8.s, 1); edges(11, BD, Z8.h, Z8.d);
    // the «ears»: intakes sticking out of the shoulders
    for (let y = 10; y < 20; y++) {
      const x0 = y === 10 ? 2 : y === 11 ? 1 : 0;
      M(x0, y, 6 - x0, 1, O);
      if (y > 10 && y < 19) M(x0 + 1, y, 4 - x0, 1, y < 13 ? Z8.h : y > 16 ? Z8.s : Z8.b);
    }
    for (let y = 13; y < 18; y += 2) M(1, y, 3, 1, Z8.g);
    M(5, 12, 1, 7, Z8.d); M(1, 19, 5, 1, Z8.d);
    // engine lid with a ribbed grille
    R(12, 13, 26, 1, Z8.s); R(12, 13, 1, 10, Z8.s); R(37, 13, 1, 10, Z8.s); R(13, 22, 24, 1, Z8.s);
    for (let i = 0; i < 4; i++) { R(15, 14 + i * 2, 20, 1, Z8.g); R(15, 15 + i * 2, 20, 1, Z8.h); }
    // long rectangular tail lights (amber outer)
    M(1, 19, 8, 5, O); M(2, 20, 6, 3, TL.m); M(2, 20, 6, 1, TL.h); M(2, 20, 2, 3, AM.m);
    plate(19, 23, 12, 3, false); R(22, 22, 6, 1, CH[1]);
    S(26, 22, CH[1]); S(27, 22, CH[3]); S(26, 21, CH[0]); M(12, 25, 2, 3, CH[2]);
    R(14, 28, 3, 2, '#55555c'); P(15, 29, O);
  },
  paintLit() { M(4, 20, 4, 3, TLL.m); M(5, 21, 2, 1, TLL.h); M(2, 20, 2, 3, AML); R(19, 23, 12, 1, '#fffbe0'); },
});

// ================================================================= 5. ЗАЗ-1102 «Таврія» 52×32
const TV = { h: '#ff8a7a', b: '#d23a32', s: '#8c2220', d: '#661816', pl: '#2c2c32', plH: '#4a4a54' };
const TAVRIA = veh({
  w: 52, h: 32, wheelR: 0.28, lean: -1.4, coneY: 0.3, coneLen: 60,
  tyres: [[5, 24, 7, 8], [40, 24, 7, 8]],
  tails: [[3, 15, 10, 4], [39, 15, 10, 4]],
  pipe: [14, 28, -1, 0],
  paint() {
    R(12, 25, 28, 3, UND);
    // hatch: big sloping rear glass with a wiper
    const GH = [15, 17, 18, 19, 19, 20, 20, 20, 21, 21, 21, 22, 22];
    prof(1, GH, O, TV.b); S(2, 16, TV.h); S(3, 13, O, 9); glass(14, 4, 24, 7);
    R(12, 3, 28, 1, '#2a2a30');                                   // rubber seal
    for (let i = 0; i < 6; i++) P(26 - i * 2, 10 - i, '#101014'), P(25 - i * 2, 10 - i, '#101014');
    // body
    const BD = [24, 25, 26, 26, 26, 26, 26, 26, 26, 26, 26, 25, 25, 24];
    prof(13, BD, O, TV.b); S(14, 24, TV.h); edges(13, BD, TV.h, TV.d); S(20, 24, TV.s); S(21, 24, TV.s);
    // wide tail-light bar: red | amber | reverse white, each side
    M(2, 14, 21, 6, O);
    M(3, 15, 10, 4, TL.m); M(3, 15, 10, 1, TL.h); M(13, 15, 4, 4, AM.m); M(13, 15, 4, 1, AM.h);
    M(17, 15, 5, 4, '#d8d8d4'); M(17, 15, 5, 1, '#ffffff'); M(12, 15, 1, 4, O); M(16, 15, 1, 4, O);
    R(23, 15, 6, 4, TV.s); R(25, 16, 2, 2, CH[1]);                // badge between the lamps
    // plate recess
    R(18, 19, 16, 5, TV.d); plate(20, 20, 12, 3, true);
    // black plastic bumper, reflectors
    S(23, 26, TV.pl, 3); S(23, 25, TV.plH); S(25, 26, '#1c1c20'); M(2, 24, 3, 1, TL.m);
    R(13, 26, 3, 2, '#55555c'); P(14, 27, O);
  },
  paintLit() { M(3, 15, 10, 4, TLL.m); M(4, 16, 8, 2, TLL.h); M(13, 15, 4, 4, AML); R(20, 20, 12, 1, '#fffbe0'); },
});

// ================================================================= 6. ЛуАЗ-969 «Волинь» 50×36
const LZ = { h: '#a6ad7a', b: '#7d8456', s: '#565c3a', d: '#3e4228', U: '#4a5a8a', UH: '#6a7ab0', UD: '#323e62',
  hat: '#5a3a22', hatH: '#7a5434', skin: '#e0a880', tent: '#9a8a5a', tentH: '#bcab78', tentS: '#6a5e3a', rim: '#6f7550' };
const LUAZ = veh({
  w: 50, h: 36, wheelR: 0.33, bobRate: 1.3, lean: -1.6, coneY: 0.35, coneLen: 60, knob: true,
  tyres: [[3, 25, 8, 11], [39, 25, 8, 11]],
  tails: [[2, 16, 3, 3], [45, 16, 3, 3]],
  pipe: [37, 30, 1, 0],
  paint() {
    R(10, 28, 30, 3, UND); R(11, 29, 28, 1, '#26261e'); R(22, 28, 6, 3, '#2a2a22');   // axle + diff
    // windscreen frame far ahead (seen through the open tub)
    R(6, 2, 38, 2, LZ.d); R(6, 2, 38, 1, LZ.s); R(6, 4, 1, 10, LZ.d); R(43, 4, 1, 10, LZ.d);
    D(7, 4, 36, 9, '#9fc8dc', 0); D(7, 4, 36, 2, '#d8eef8', 1);
    R(22, 4, 1, 3, '#1a1a1e');                                    // mirror stalk
    // passenger seat back
    R(29, 8, 11, 7, O); R(30, 9, 9, 5, '#3a2a1a'); R(30, 9, 9, 1, '#5a4430');
    // driver (left-hand drive): shoulders, fur hat, neck, ears
    R(9, 10, 16, 6, O); R(10, 10, 14, 5, LZ.U); R(10, 10, 14, 1, LZ.UH); R(23, 11, 1, 4, LZ.UD); R(16, 11, 1, 4, LZ.UD);
    R(13, 3, 8, 8, O); R(14, 3, 6, 3, LZ.hat); R(14, 3, 6, 1, LZ.hatH); R(13, 5, 8, 1, LZ.hat);
    R(14, 6, 6, 3, '#4a2e1a'); R(15, 9, 4, 1, LZ.skin); P(13, 7, LZ.skin); P(20, 7, LZ.skin);
    // folded soft top rolled at the rear
    R(4, 13, 42, 3, O); R(5, 13, 40, 2, LZ.tent); R(5, 13, 40, 1, LZ.tentH);
    for (let x = 9; x < 44; x += 6) P(x, 14, LZ.tentS);
    // the tub
    const BD = [24, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 25, 24];
    prof(15, BD, O, LZ.b); S(16, 24, LZ.h); edges(15, BD, LZ.h, LZ.d);
    for (let i = 0; i < 3; i++) { S(19 + i * 3, 23, LZ.s); S(20 + i * 3, 23, LZ.h); }
    S(25, 24, LZ.s); S(26, 24, LZ.d);
    // spare wheel on the rear panel
    ed(25, 15, 6, O); ed(25, 16, 5, '#1d1d22'); ed(25, 18, 3, LZ.rim); ed(25, 19, 2, LZ.s);
    R(24, 20, 2, 2, CH[1]); P(21, 17, '#4a4a52'); P(22, 16, '#4a4a52'); R(31, 20, 1, 6, LZ.d);
    // round lamps high on the corners, plate, tube bumper
    MP(3, 16, O); M(2, 17, 3, 1, O); tailDay(2, 16, 3, 3); M(2, 19, 3, 2, AM.m);
    plate(21, 27, 8, 2, false);
    S(27, 24, LZ.d, 2); S(27, 23, LZ.s); M(1, 26, 3, 3, LZ.d);
    R(36, 29, 3, 2, '#55555c'); P(37, 30, O);
  },
  paintLit() { M(2, 16, 3, 3, TLL.m); MP(3, 17, TLL.h); M(2, 19, 3, 2, AML); R(21, 27, 8, 1, '#fffbe0'); },
});

// ================================================================= 7. ЛАЗ-695 76×64
const LA = { cr: '#efe3c0', crH: '#fff6dc', crS: '#c7b78e', crD: '#a8966a', red: '#c8402c', redH: '#e8664a',
  redS: '#8a2a1e', redD: '#64201a', gr: '#2c1410' };
const LAZWIN = [10, 14, 27, 16];
const LAZ = veh({
  w: 76, h: 64, wheelR: 0.45, bobRate: 0.8, lean: -2, coneY: 0.3, coneLen: 84,
  tyres: [[6, 53, 6, 11], [13, 53, 6, 11], [57, 53, 6, 11], [64, 53, 6, 11]],
  tails: [[4, 38, 4, 6], [68, 38, 4, 6]],
  pipe: [58, 58, 1, 0], puffCol: '#8e8e96',
  paint() {
    R(20, 56, 36, 4, UND);
    // the roof crest («гребінець»): raised intake with vertical slats
    const CR = [20, 22, 23, 23, 23, 23, 24, 24, 24, 24];
    prof(0, CR, O, LA.cr); S(1, 21, LA.crH); S(2, 22, LA.crH);
    for (let x = 17; x < 59; x += 3) { R(x, 3, 1, 5, LA.crD); P(x + 1, 3, LA.crH); }
    S(8, 23, LA.crS);
    // body
    const BD = [31, 34, 35, 36, 36];
    for (let i = 0; i < 44; i++) BD.push(36);
    BD.push(35);
    prof(8, BD, O, LA.cr); S(9, 33, LA.crH); S(10, 34, LA.crH); SD(11, 35, LA.crH); edges(8, BD, LA.crH, LA.crS);
    MP(4, 10, AM.m); MP(5, 10, AM.h);                              // clearance lamps
    // rear window: two panes, centre mullion
    M(9, 13, 29, 18, O); glass(10, 14, 27, 16); glass(39, 14, 27, 16, 1); R(37, 13, 2, 18, LA.cr); P(37, 13, LA.crH);
    D(10, 27, 27, 2, '#30485c'); D(39, 27, 27, 2, '#30485c');      // seat backs through the glass
    // badge, chrome belt
    R(33, 32, 10, 2, CH[2]); R(34, 32, 8, 1, CH[0]);
    S(35, 36, CH[0]); S(36, 36, CH[2]);
    // red lower body
    for (let y = 37; y < 55; y++) S(y, 35, y === 37 ? LA.redH : y > 51 ? LA.redS : LA.red);
    MP(1, 37, O); SD(50, 35, LA.redS, 1); M(2, 37, 1, 18, LA.redH);
    // engine grille
    R(19, 39, 38, 12, O); R(20, 40, 36, 10, LA.gr);
    for (let y = 40; y < 50; y += 2) { R(20, y, 36, 1, CH[2]); R(20, y, 36, 1, y === 40 ? CH[0] : CH[1]); }
    R(37, 40, 2, 10, LA.redS); M(19, 39, 2, 2, CH[2]);
    // vertical light clusters
    M(3, 37, 6, 12, CH[3]); M(4, 38, 4, 6, TL.m); M(4, 38, 4, 1, TL.h); M(4, 44, 4, 4, AM.m); M(4, 44, 4, 1, AM.h);
    plate(32, 51, 12, 3, false);
    // bumper, exhaust
    S(54, 37, '#2a2a2e', 3); S(54, 36, '#4a4a52'); M(1, 54, 4, 2, CH[1]);
    R(57, 57, 3, 2, '#55555c'); P(58, 58, O);
  },
  paintLit() {
    litWin(10, 14, 27, 16, 3); litWin(39, 14, 27, 16, 7);
    M(4, 38, 4, 6, TLL.m); M(5, 39, 2, 4, TLL.h); M(4, 44, 4, 4, AML); MP(4, 10, AML); MP(5, 10, '#fff0c0');
    R(32, 51, 12, 1, '#fffbe0');
  },
});

// ================================================================= 8. Богдан А092 64×58
const BG = { wh: '#f4f4ee', whH: '#ffffff', whS: '#c8cac4', whD: '#a0a29c', ye: '#f2c418', yeH: '#ffe46a', yeS: '#b48a0a',
  yeD: '#8a6a08', dg: '#3a3a40', dgH: '#5a5a62' };
const BOGDAN = veh({
  w: 64, h: 58, wheelR: 0.36, bobRate: 1.1, lean: -2, coneY: 0.3, coneLen: 80,
  tyres: [[6, 46, 5, 12], [12, 46, 5, 12], [47, 46, 5, 12], [53, 46, 5, 12]],
  tails: [[3, 28, 4, 6], [57, 28, 4, 6]],
  pipe: [18, 51, -1, 0],
  paint() {
    R(16, 49, 32, 3, UND);
    // roof vent + mirrors on stalks
    R(24, 0, 16, 3, O); R(25, 1, 14, 2, BG.whS); R(25, 1, 14, 1, BG.whH);
    M(0, 13, 3, 8, O); M(1, 14, 1, 6, '#6a8aa0'); M(3, 15, 1, 1, O);
    // body
    const BD = [27, 29, 30];
    for (let i = 0; i < 44; i++) BD.push(30);
    BD.push(29);
    prof(2, BD, O, BG.wh); S(3, 28, BG.whH); S(4, 29, BG.whH); edges(2, BD, BG.whH, BG.whS);
    // two rear-door windows
    M(5, 7, 26, 21, O); glass(6, 8, 24, 19); glass(34, 8, 24, 19, 1); R(30, 7, 4, 40, BG.wh); R(31, 7, 2, 40, BG.whS);
    // route board «15» in the right-hand window
    R(37, 9, 20, 14, O); R(38, 10, 18, 12, '#ffffff'); R(38, 21, 18, 1, '#d8d8d0'); text('15', 40, 11, 2, '#1a1a1e');
    // white → yellow livery
    S(28, 29, BG.whD);
    for (let y = 29; y < 47; y++) S(y, 29, y === 29 ? BG.yeH : y > 43 ? BG.yeS : BG.ye);
    SD(42, 29, BG.yeS, 1); R(30, 29, 4, 18, BG.ye); R(31, 29, 1, 18, BG.yeS); R(32, 29, 1, 18, BG.yeD);
    M(28, 33, 1, 3, CH[1]);                                       // door handles
    // vertical light stacks: red / amber / reverse
    M(2, 27, 6, 16, O); M(3, 28, 4, 6, TL.m); M(3, 28, 4, 1, TL.h); M(3, 34, 4, 4, AM.m); M(3, 38, 4, 3, '#dcdcd8');
    plate(26, 39, 12, 3, true); R(29, 37, 6, 1, CH[2]);
    // bumper
    S(46, 31, BG.dg, 3); S(46, 30, BG.dgH); S(48, 31, '#26262a');
    R(17, 50, 3, 2, '#55555c'); P(18, 51, O);
  },
  paintLit() {
    litWin(6, 8, 24, 19, 5); litWin(34, 8, 24, 19, 2);
    R(38, 10, 18, 12, '#fffde8'); text('15', 40, 11, 2, '#141418');
    M(3, 28, 4, 6, TLL.m); M(4, 29, 2, 4, TLL.h); M(3, 34, 4, 4, AML); R(26, 39, 12, 1, '#fffbe0');
  },
});

// ================================================================= 9. КрАЗ-6322 74×66
const KZ = { h: '#8a9a5a', b: '#5f6e3a', s: '#3f4a26', d: '#2c3418', t: '#6e6a44', tH: '#8c875c', tS: '#4c4930', tD: '#38361f',
  strap: '#4a3a20', chas: '#24261c', flap: '#1c1c1e' };
const KRAZ = veh({
  w: 74, h: 66, wheelR: 0.6, bobRate: 0.6, lean: -2, coneY: 0.3, coneLen: 84, knob: true,
  tyres: [[5, 48, 18, 18], [51, 48, 18, 18]],
  tails: [[5, 54, 3, 2], [66, 54, 3, 2]],
  pipe: [69, 1, 1, 1], puffCol: '#6a6a70',
  paint() {
    R(22, 55, 30, 6, UND);
    // exhaust stack beside the tent + big mirrors on arms
    R(67, 2, 3, 24, O); R(68, 1, 1, 24, '#2e2e2e'); for (let y = 6; y < 22; y += 3) P(68, y, '#5a5a56');
    M(0, 12, 4, 9, O); M(1, 13, 2, 7, '#7fa0b0'); M(1, 13, 1, 2, '#c8e0ea'); M(4, 16, 3, 1, O);
    // canvas tent
    const TN = [26, 29, 30];
    for (let i = 0; i < 40; i++) TN.push(31);
    prof(1, TN, O, KZ.t); S(2, 28, KZ.tH); S(3, 29, KZ.tH); SD(4, 30, KZ.tH); edges(1, TN, KZ.tH, KZ.tS);
    for (let x = 11; x < 64; x += 9) { R(x, 5, 1, 37, KZ.tS); D(x + 1, 6, 1, 35, KZ.tH); }   // folds
    // rear flap: laced edges, two straps with buckles, rope at the bottom
    M(10, 5, 1, 37, KZ.tD); for (let y = 7; y < 41; y += 3) MP(11, y, '#b8b088');
    M(21, 4, 3, 39, KZ.strap); M(21, 4, 1, 39, '#6a5430'); M(21, 30, 3, 2, CH[2]);
    for (let x = 7; x < 67; x += 2) P(x, 42, (x & 2) ? '#b8a878' : '#7a6e48');
    S(43, 31, KZ.tD);
    // tailgate: planks, ribs, hinges, plate
    R(4, 44, 66, 10, O);
    for (let y = 45; y < 53; y++) R(5, y, 64, 1, (y - 45) % 3 === 0 ? KZ.h : (y - 45) % 3 === 2 ? KZ.s : KZ.b);
    for (let x = 12; x < 64; x += 10) { R(x, 45, 1, 8, KZ.s); P(x + 1, 46, KZ.h); }
    M(5, 45, 2, 2, CH[2]); R(36, 45, 2, 2, CH[3]);
    plate(31, 49, 12, 3, false);
    // chassis beam, guarded lamps, pintle hook, mud flaps
    R(2, 53, 70, 3, KZ.chas); R(2, 53, 70, 1, '#3a3e2c');
    M(4, 52, 5, 4, O); M(5, 53, 3, 2, TL.m); P(5, 53, TL.h); P(68, 53, TL.h);
    R(35, 55, 4, 4, '#1a1a16'); R(36, 56, 2, 2, '#4a4a42');
    M(24, 55, 3, 5, KZ.chas);
    M(8, 55, 12, 6, O); M(9, 55, 10, 5, KZ.flap); M(9, 55, 10, 1, '#4a4a50'); M(11, 57, 6, 1, KZ.s); M(11, 58, 6, 1, KZ.h);
  },
  paintLit() { M(5, 53, 3, 2, TLL.m); P(6, 53, TLL.h); P(67, 53, TLL.h); R(31, 49, 12, 1, '#fffbe0'); },
});

// ================================================================= 10. Електробус «Електрон» 78×66
const EL = { wh: '#f2f4f6', whH: '#ffffff', whS: '#c6ccd4', whD: '#9aa2ac', bl: '#1f5fbf', blH: '#4a8ae8', blS: '#143e80', blD: '#0e2c5c',
  ye: '#ffd21a', yeS: '#c09a08', pk: '#b8bec8', pkH: '#dce0e6', pkS: '#7c828c', hv: '#e8782a' };
const ELECTRON = veh({
  w: 78, h: 66, wheelR: 0.45, bobRate: 0.5, lean: -2, coneY: 0.3, coneLen: 84,
  tyres: [[8, 54, 6, 12], [15, 54, 6, 12], [57, 54, 6, 12], [64, 54, 6, 12]],
  tails: [[2, 14, 3, 30], [73, 14, 3, 30]],
  paint() {
    R(22, 57, 34, 3, UND);
    // roof battery packs, fans, orange HV conduits, charge LEDs
    M(8, 0, 30, 8, O); M(9, 1, 28, 6, EL.pk); M(9, 1, 28, 2, EL.pkH); M(9, 6, 28, 1, EL.pkS);
    for (let i = 0; i < 2; i++) { M(13 + i * 12, 3, 5, 3, EL.pkS); M(14 + i * 12, 4, 3, 1, '#3a3e46'); }
    R(38, 2, 2, 6, EL.hv); R(38, 2, 1, 6, '#ffa060');
    for (let i = 0; i < 5; i++) MP(28 + i * 2, 5, '#4c6a52');
    // body
    const BD = [33, 36, 37, 38];
    for (let i = 0; i < 46; i++) BD.push(38);
    BD.push(37);
    prof(7, BD, O, EL.wh); S(8, 35, EL.whH); S(9, 36, EL.whH); edges(7, BD, EL.whH, EL.whS);
    // big rear glass + LED destination sign
    R(6, 12, 66, 26, O); glass(7, 13, 64, 24);
    R(19, 14, 40, 7, '#101016'); D(20, 15, 38, 5, '#22222a', 1); text('Е-24', 31, 15, 1, '#a86a10');
    // yellow stripe, blue skirt with a yellow wave
    S(38, 37, EL.whS); S(39, 37, EL.ye); S(40, 37, EL.yeS);
    for (let y = 41; y < 56; y++) S(y, 37, y === 41 ? EL.blH : y > 52 ? EL.blS : EL.bl);
    for (let x = 2; x < 34; x++) { const yy = 52 - ((x - 2) >> 2); R(x, yy, 1, 2, EL.ye); P(x, yy + 2, EL.yeS); }
    SD(52, 37, EL.blS, 1);
    // service hatch seams, badge, plate, vent grille
    R(22, 42, 34, 1, EL.blS); R(22, 42, 1, 11, EL.blS); R(55, 42, 1, 11, EL.blS);
    R(35, 44, 8, 3, CH[1]); R(36, 44, 6, 1, CH[0]); text('Е', 37, 44, 1, EL.blD);
    plate(33, 48, 12, 3, true);
    for (let y = 45; y < 52; y += 2) R(59, y, 9, 1, EL.blD);
    // tall LED tail strips + amber indicators
    M(1, 13, 5, 32, O); M(2, 14, 3, 30, TL.m); M(2, 14, 1, 30, TL.h); M(2, 45, 3, 4, AM.m); M(1, 44, 5, 6, O); M(2, 45, 3, 4, AM.m);
    // bumper
    S(55, 38, '#3a3e48', 2); S(55, 37, '#5a606c'); S(57, 38, '#22242a');
  },
  paintLit() {
    litWin(7, 13, 64, 24, 11);
    R(19, 14, 40, 7, '#101016'); text('Е-24', 31, 15, 1, '#ffb83a');
    for (let i = 0; i < 5; i++) MP(28 + i * 2, 5, '#48f070');
    M(2, 14, 3, 30, TLL.m); for (let y = 15; y < 43; y += 3) MP(3, y, TLL.h);
    M(2, 45, 3, 4, AML); R(33, 48, 12, 1, '#fffbe0');
  },
  post() {   // charge cells fill up in a loop
    const lvl = ((F.t * 1.5) | 0) % 6;
    for (let i = 0; i < 5; i++) { g(28 + i * 2, 5 - F.bob, 1, 1, i < lvl ? '#48f070' : '#2c4a32'); g(49 - i * 2, 5 - F.bob, 1, 1, i < lvl ? '#48f070' : '#2c4a32'); }
  },
  fx(ctx, X0, Y0, lean) {   // no exhaust — sparks crackle off the roof connectors instead
    const fr = (F.t * 14) | 0, hsh = (fr * 2654435761) >>> 0;
    if ((hsh & 7) > 2) return;
    const sx = X0 + 36 + ((hsh >> 4) % 7) + leanAt(0, 66, lean), sy = Y0 - F.bob;
    ctx.fillStyle = '#e8ffff'; ctx.fillRect(sx, sy, 1, 1);
    ctx.fillStyle = '#62e0ff'; ctx.fillRect(sx - 1, sy - 1 - ((hsh >> 8) & 1), 1, 1); ctx.fillRect(sx + 1, sy - 2, 1, 1);
    if (hsh & 1) { ctx.fillStyle = '#bff6ff'; ctx.fillRect(sx + 2, sy - 3, 1, 1); ctx.fillRect(sx - 2, sy - 3, 1, 1); }
    if (F.k > 0) { ctx.globalAlpha = 0.25 * F.k; ctx.fillStyle = '#62e0ff'; ctx.fillRect(sx - 3, sy - 4, 7, 6); ctx.globalAlpha = 1; }
  },
});

// ================================================================= 11. Ан-2 90×40, flies at 40 px
const A2 = { k: O, b: '#d6dade', h: '#f2f4f6', s: '#9aa0a8', d: '#6e747c', wing: '#c2c8cc', wingH: '#e8ecee', wingS: '#8a9096',
  bl: '#2a5ab8', ye: '#ffd21a', eng: '#3a3c42' };
function bakeProp() { const c = mkCanvas(34, 34); B = ctx2d(c); W = 34; ed(17, 0, 17, '#d8dce2'); B = null; return c; }
const AN2 = veh({
  w: 90, h: 40, flyAltPx: 40, roll: 5,
  paint() {
    // main gear (forward, under the lower wing)
    M(35, 27, 2, 6, A2.d); M(34, 32, 4, 7, O); M(35, 33, 2, 5, '#26262c'); M(35, 33, 1, 5, '#3c3c44');
    // upper wing (full span), top face seen from above
    R(1, 6, 88, 5, O); R(0, 7, 90, 3, O);
    R(2, 7, 86, 2, A2.wingH); R(1, 8, 88, 1, A2.wing); R(2, 9, 86, 1, A2.wingS); D(2, 8, 86, 1, A2.wing, 1);
    // lower wing
    R(8, 24, 74, 4, O); R(9, 25, 72, 1, A2.wingH); R(9, 26, 72, 1, A2.wingS);
    // I-struts + bracing wires
    M(14, 10, 2, 15, O); M(15, 11, 1, 13, A2.s);
    B.globalAlpha = 0.55;
    for (let i = 0; i < 14; i++) { MP(16 + i, 11 + i, A2.d); MP(16 + i, 24 - i, A2.d); }
    B.globalAlpha = 1;
    // fuselage: max section, then the tail cone (lighter rings toward the viewer)
    const FU = [3, 5, 7, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 7, 6, 4];
    prof(4, FU, O, A2.s); edges(4, FU, A2.b, A2.d);
    M(37, 12, 1, 10, A2.bl); M(38, 13, 1, 9, A2.bl);              // cheatline on the sides
    prof(7, [3, 5, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 6, 5, 3], A2.d, A2.b);
    prof(11, [2, 3, 4, 4, 4, 4, 4, 4, 4, 3, 2], A2.s, A2.h);
    ed(45, 15, 2, '#c8ccd2');
    // tailwheel + strut
    R(44, 25, 2, 3, A2.d); R(43, 27, 4, 4, O); R(44, 28, 2, 2, '#26262c');
    // stabilizer
    R(26, 16, 38, 3, O); R(27, 16, 36, 1, A2.wingH); R(27, 17, 36, 1, A2.wing); M(33, 17, 1, 1, A2.wingS);
    // fin with the flag: blue over yellow
    R(43, 0, 4, 18, O); R(44, 1, 2, 7, A2.bl); R(44, 8, 2, 8, A2.ye); P(44, 1, '#5a8ae8'); P(44, 8, '#fff08a');
  },
  paintLit() { R(44, 16, 2, 1, '#fff6d0'); },
  pre(ctx, X0, Y0) {   // propeller disc ahead of the nose, on the main canvas behind the plane (untinted)
    const P2 = this.prop || (this.prop = bakeProp());
    ctx.globalAlpha = 0.2 - 0.14 * F.n; ctx.drawImage(P2, X0 + 28, Y0 - F.bob);
    const cx = X0 + 45, cy = Y0 + 17 - F.bob, a = (F.t * 31) % 3.1416, c = Math.cos(a), sn = Math.sin(a);
    ctx.globalAlpha = 0.5; ctx.fillStyle = F.n > 0.5 ? '#8a8e96' : '#4a4c52';    // one rotating blade
    for (let r = 9; r < 17; r++) { ctx.fillRect(cx + Math.round(c * r), cy + Math.round(sn * r), 1, 1); ctx.fillRect(cx - 1 - Math.round(c * r), cy - Math.round(sn * r), 1, 1); }
    ctx.globalAlpha = 1;
  },
  post() {   // nav lights: red port (left) tip, green starboard tip, white tail, red belly beacon
    const o = -F.bob;
    g(0, 8 + o, 2, 1, blink(F.t, 1.2, 0.5) ? '#ff4040' : '#802020');
    g(88, 8 + o, 2, 1, blink(F.t, 1.2, 0.5) ? '#38f060' : '#1a6a2a');
    if (blink(F.t, 1.0, 0.12)) g(44, 16 + o, 2, 1, '#ffffff');
    if (blink(F.t, 1.6, 0.15, 0.5)) g(44, 29 + o, 2, 1, '#ff3030');
  },
  fx(ctx, X0, Y0) {
    if (F.k <= 0) return;
    const o = Y0 - F.bob;
    ctx.globalAlpha = 0.3 * F.k;
    ctx.fillStyle = '#ff3030'; ctx.fillRect(X0 - 2, o + 6, 5, 5);
    ctx.fillStyle = '#38f060'; ctx.fillRect(X0 + 87, o + 6, 5, 5);
    ctx.globalAlpha = 1;
  },
});

// ================================================================= 12. Ан-225 «Мрія» 160×60, flies at 90 px
const MR = { b: '#eef0f2', h: '#ffffff', s: '#b8bec6', ss: '#8a9098', d: '#666c76', wing: '#d0d4da', wingH: '#f0f2f4', wingS: '#9aa0a8',
  bl: '#1f5fbf', blH: '#4a86e0', ye: '#ffd21a', yeH: '#fff08a', eng: '#c4c8ce', engS: '#8a9098', noz: '#2a2c32' };
const ENG225 = [26, 44, 62];
function wingTop(dx) { return 19 + Math.round((Math.max(16, dx) - 16) * 9 / 63); }   // anhedral: tips droop
const AN225 = veh({
  w: 160, h: 60, flyAltPx: 90, roll: 6,
  paint() {
    // six engines under the drooping wing: cowling ring, nozzle, hot core
    for (const dx of ENG225) for (const sg of [-1, 1]) {
      const ex = 80 + sg * dx, ey = wingTop(dx) + 3;
      R(ex - 1, ey - 2, 2, 3, MR.ss);
      ed(ex, ey, 5, O); ed(ex, ey + 1, 4, MR.eng); ed(ex, ey + 2, 3, MR.engS); ed(ex, ey + 3, 2, MR.noz);
      R(ex - 3, ey + 2, 2, 1, '#f4f6f8'); P(ex - 4, ey + 3, '#f4f6f8');
    }
    // wing: top face seen from above, trailing edge, underside, flap-track fairings
    for (let dx = 0; dx < 80; dx++) {
      const y = wingTop(dx), th = dx < 40 ? 5 : dx < 64 ? 4 : 3;
      for (const xx of [79 - dx, 80 + dx]) {
        R(xx, y - 1, 1, th + 1, O);
        R(xx, y, 1, th - 2, dx & 1 ? MR.wingH : MR.wing); P(xx, y + th - 2, MR.wingS);
        if (dx % 12 === 6 && dx > 18) P(xx, y + th, MR.d);
      }
    }
    // fuselage: big section + sponsons, then lighter tail-cone rings
    const FU = [6, 9, 11, 12, 13, 13];
    for (let i = 0; i < 12; i++) FU.push(13);
    FU.push(12, 11, 9, 6);
    R(75, 11, 10, 7, O); R(76, 12, 8, 5, MR.s); R(77, 12, 3, 5, MR.b);                             // tail-cone neck
    prof(16, FU, O, MR.s); edges(16, FU, MR.b, MR.ss);
    M(64, 29, 4, 10, O); M(65, 30, 3, 8, MR.ss); M(65, 30, 3, 1, MR.s);                          // gear sponsons
    M(68, 25, 2, 2, MR.bl); M(68, 27, 2, 2, MR.ye);                                               // cheatline
    prof(18, [5, 8, 9, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 9, 8, 5], MR.ss, MR.b);
    prof(18, [3, 5, 6, 6, 6, 6, 6, 6, 6, 5, 3], MR.s, MR.h);
    // H-tail: stabilizer with dihedral, twin fins in the flag colours
    for (let dx = 0; dx < 36; dx++) {
      const y = 12 - (dx >> 4);
      for (const xx of [79 - dx, 80 + dx]) { R(xx, y - 1, 1, 4, O); P(xx, y, MR.wingH); P(xx, y + 1, MR.wing); }
    }
    M(46, 0, 5, 24, O); M(47, 1, 3, 10, MR.bl); M(47, 11, 3, 11, MR.ye); M(47, 1, 1, 10, MR.blH); M(47, 11, 1, 11, MR.yeH);
    M(48, 22, 1, 1, MR.ss);
    R(78, 11, 4, 4, MR.s); R(79, 12, 2, 2, MR.h);                                                  // tail cone tip
  },
  paintLit() {
    for (const dx of ENG225) for (const sg of [-1, 1]) { const ex = 80 + sg * dx, ey = wingTop(dx) + 3; ed(ex, ey + 3, 2, '#ff9a40'); R(ex - 1, ey + 4, 2, 2, '#ffd890'); }
    M(47, 1, 3, 10, '#5a96ff'); M(47, 11, 3, 11, '#ffe24a');   // fin logo lights
  },
  post() {
    const o = -F.bob;
    g(0, wingTop(79) + o, 2, 2, blink(F.t, 1.4, 0.5) ? '#ff4040' : '#802020');
    g(158, wingTop(79) + o, 2, 2, blink(F.t, 1.4, 0.5) ? '#38f060' : '#1a6a2a');
    if (blink(F.t, 1.1, 0.08)) { g(0, wingTop(79) - 1 + o, 1, 1, '#ffffff'); g(159, wingTop(79) - 1 + o, 1, 1, '#ffffff'); }
    if (blink(F.t, 1.7, 0.15, 0.3)) g(79, 14 + o, 2, 1, '#ff3030');
    if (blink(F.t, 1.7, 0.15, 0.8)) g(79, 38 + o, 2, 1, '#ff3030');
    if (blink(F.t, 0.9, 0.1)) g(79, 11 + o, 2, 1, '#ffffff');
  },
  fx(ctx, X0, Y0) {
    if (F.k <= 0) return;
    const o = Y0 - F.bob, wt = wingTop(79);
    ctx.globalAlpha = 0.3 * F.k;
    ctx.fillStyle = '#ff3030'; ctx.fillRect(X0 - 3, o + wt - 3, 7, 7);
    ctx.fillStyle = '#38f060'; ctx.fillRect(X0 + 156, o + wt - 3, 7, 7);
    ctx.fillStyle = '#ffb060';
    for (let i = 0; i < 3; i++) { const dx = ENG225[i], ey = o + wingTop(dx) + 5; ctx.fillRect(X0 + 80 - dx - 3, ey, 6, 5); ctx.fillRect(X0 + 80 + dx - 3, ey, 6, 5); }
    ctx.globalAlpha = 1;
  },
});

// ---------------------------------------------------------------- registry (same ids as VEHICLES)
export const REAR = {
  bike: BIKE, moped: MOPED, zaz965: ZAZ965, zaz968m: ZAZ968, tavria: TAVRIA, luaz: LUAZ,
  laz695: LAZ, bogdan: BOGDAN, kraz: KRAZ, electron: ELECTRON, an2: AN2, an225: AN225,
};
