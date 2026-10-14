#!/usr/bin/env node
// pixelize.mjs — turn any PNG (render, photo, AI image) into clean game pixel art.
// Pure JS (pngjs only), no native deps. See tools/pixel/README.md for the full guide.
//
//   node tools/pixel/pixelize.mjs in.png out.png --w 64 --colors 16 --outline --dither bayer4 --palette ukraine
//   node tools/pixel/pixelize.mjs frames/ out/ --w 48 --palette ukraine --sheet out/car.png --cols 8
//
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HELP = `pixelize — image → game pixel art

usage: node pixelize.mjs <in.png|in-dir> <out.png|out-dir> [options]

size
  --w N              output width in px (default 64). Height follows aspect unless --h.
  --h N              output height in px
  --trim             crop to the opaque bounding box before scaling. In batch mode all
                     frames share one union box, so animations stay aligned
  --sample MODE      area | dominant (default) | center
                       area     = alpha-weighted average of each cell (soft)
                       dominant = 2-means per cell, keep the majority colour (crisp edges)
                       center   = nearest neighbour
  --alpha T          cell becomes opaque when coverage >= T (0..1, default 0.5)

colour
  --colors N         k-means palette size (default 16; 0 = keep palette as is)
  --palette P        auto (default) | ukraine | pico8 | path/to/file(.hex|.gpl|.txt)
                     with --colors N and a palette: k-means to N, then snap each
                     centre to the nearest palette colour (a subset of the palette)
  --sat X            saturation multiplier before quantising (default 1.15)
  --contrast X       contrast multiplier around mid-grey (default 1.08)
  --chroma-weight X  palette matching: weight of hue/chroma vs lightness (default 2; 1 = plain OKLab)
  --merge X          auto palette: fold colours closer than X (OKLab, default 0.04, 0 = off)
  --dither D         none (default) | bayer2 | bayer4 | bayer8
  --dither-amt X     dither strength 0..1 (default 0.5)

shape
  --outline [hex]    1-px outline around the opaque area (default colour = darkest
                     palette colour). Content is shrunk by 2 px so the size stays --w.
  --outline-style S  solid (default) | selective (darkened shade of the edge colour)
  --inner-shade      darken opaque pixels on the bottom/right silhouette edge one step
  --cleanup N        stray-pixel passes (default 1, 0 = off)
  --key K            background keying: auto (default) | none | #rrggbb
                     auto = keep existing alpha, else flood-fill from the border
  --key-tol N        keying tolerance in RGB distance (default 40)

output
  --scale N          upscale the main output ×N with nearest neighbour (default 1)
  --preview N        also write <name>@Nx.png (default off)
  --compare FILE     write a side-by-side before/after image (single-file mode)
  --sheet FILE       pack all outputs (batch mode, sorted by name) into a sprite
                     sheet + FILE.json frame map
  --cols N           sprite-sheet columns (default: all in one row, max 16)
  --shared-palette   batch: one palette for every frame (default on; --no-shared-palette)
  --seed N           k-means seed (default 1)
  --quiet
`;

// ---------- args ----------
function parseArgs(argv) {
  const o = {
    w: 64, h: 0, trim: false, sample: 'dominant', alpha: 0.5,
    colors: 16, palette: 'auto', sat: 1.15, contrast: 1.08, dither: 'none', ditherAmt: 0.5,
    outline: false, outlineColor: null, outlineStyle: 'solid', innerShade: false, cleanup: 1,
    key: 'auto', keyTol: 40, scale: 1, preview: 0, compare: null, sheet: null, cols: 0,
    sharedPalette: true, seed: 1, quiet: false, merge: 0.04, chroma: 2, _: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h': case '--help': o.help = true; break;
      case '--w': o.w = +next(); break;
      case '--h': o.h = +next(); break;
      case '--trim': o.trim = true; break;
      case '--sample': o.sample = next(); break;
      case '--alpha': o.alpha = +next(); break;
      case '--colors': case '--colours': o.colors = +next(); break;
      case '--palette': o.palette = next(); break;
      case '--sat': o.sat = +next(); break;
      case '--contrast': o.contrast = +next(); break;
      case '--dither': o.dither = next(); break;
      case '--dither-amt': o.ditherAmt = +next(); break;
      case '--outline':
        o.outline = true;
        if (argv[i + 1] && /^#?[0-9a-f]{6}$/i.test(argv[i + 1])) o.outlineColor = hexToRgb(next());
        break;
      case '--outline-style': o.outlineStyle = next(); o.outline = true; break;
      case '--inner-shade': o.innerShade = true; break;
      case '--cleanup': o.cleanup = +next(); break;
      case '--key': o.key = next(); break;
      case '--key-tol': o.keyTol = +next(); break;
      case '--scale': o.scale = +next(); break;
      case '--preview': o.preview = +next(); break;
      case '--compare': o.compare = next(); break;
      case '--sheet': o.sheet = next(); break;
      case '--cols': o.cols = +next(); break;
      case '--shared-palette': o.sharedPalette = true; break;
      case '--no-shared-palette': o.sharedPalette = false; break;
      case '--seed': o.seed = +next(); break;
      case '--merge': o.merge = +next(); break;
      case '--chroma-weight': o.chroma = +next(); break;
      case '--quiet': o.quiet = true; break;
      default:
        if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
        o._.push(a);
    }
  }
  return o;
}

// ---------- colour helpers ----------
function hexToRgb(h) {
  h = h.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
const toHex = (c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('');
const SRGB2LIN = new Float64Array(256).map((_, i) => {
  const c = i / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
});
function lin(v) { // v may be fractional 0..255
  const c = Math.min(255, Math.max(0, v)) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
// sRGB 0..255 → OKLab
function oklab(r, g, b) {
  const R = Number.isInteger(r) ? SRGB2LIN[r] : lin(r);
  const G = Number.isInteger(g) ? SRGB2LIN[g] : lin(g);
  const B = Number.isInteger(b) ? SRGB2LIN[b] : lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function oklabToRgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  const enc = (c) => {
    c = Math.min(1, Math.max(0, c));
    return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  };
  return [enc(R), enc(G), enc(B)];
}
const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
// palette matching distance: chroma (a,b) weighted up so a shadow keeps its hue and picks a
// darker same-hue swatch instead of a different hue with the right lightness (--chroma-weight)
let CW = 2;
const dm = (p, q) => (p[0] - q[0]) ** 2 + CW * ((p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2);

// ---------- palettes ----------
function loadPalette(spec) {
  if (!spec || spec === 'auto') return null;
  let file = spec;
  if (!fs.existsSync(file)) {
    for (const ext of ['.hex', '.gpl', '.txt']) {
      const f = path.join(HERE, 'palettes', spec + ext);
      if (fs.existsSync(f)) { file = f; break; }
    }
  }
  if (!fs.existsSync(file)) throw new Error(`palette not found: ${spec}`);
  const out = [];
  for (let line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith(';') || line.startsWith('#') && !/^#[0-9a-f]{6}\b/i.test(line)) continue;
    let m = line.match(/^#?([0-9a-f]{6})\b/i);               // .hex / .txt (Lospec)
    if (m) { out.push(hexToRgb(m[1])); continue; }
    m = line.match(/^(\d{1,3})\s+(\d{1,3})\s+(\d{1,3})/);    // .gpl (GIMP)
    if (m) out.push([+m[1], +m[2], +m[3]]);
  }
  if (!out.length) throw new Error(`palette ${spec} has no colours`);
  return out;
}

// ---------- image io ----------
function readPng(file) {
  const png = PNG.sync.read(fs.readFileSync(file));
  return { w: png.width, h: png.height, d: png.data }; // RGBA Uint8 (Buffer)
}
function writePng(file, img) {
  const png = new PNG({ width: img.w, height: img.h });
  png.data.set(img.d);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(png));
}
function upscale(img, k) {
  if (k <= 1) return img;
  const out = { w: img.w * k, h: img.h * k, d: new Uint8Array(img.w * k * img.h * k * 4) };
  for (let y = 0; y < out.h; y++) for (let x = 0; x < out.w; x++) {
    const s = (((y / k) | 0) * img.w + ((x / k) | 0)) * 4, t = (y * out.w + x) * 4;
    out.d[t] = img.d[s]; out.d[t + 1] = img.d[s + 1]; out.d[t + 2] = img.d[s + 2]; out.d[t + 3] = img.d[s + 3];
  }
  return out;
}

// ---------- 1. background keying ----------
function keyBackground(img, o) {
  if (o.key === 'none') return;
  const { w, h, d } = img;
  let hasAlpha = false;
  for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { hasAlpha = true; break; }
  if (o.key === 'auto' && hasAlpha) return;
  let bg;
  if (o.key !== 'auto') bg = hexToRgb(o.key);
  else { // most common colour on the border (quantised to 4 bits)
    const counts = new Map();
    const add = (x, y) => {
      const i = (y * w + x) * 4;
      const k = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | d[i + 2] >> 4;
      const c = counts.get(k) || { n: 0, r: 0, g: 0, b: 0 };
      c.n++; c.r += d[i]; c.g += d[i + 1]; c.b += d[i + 2]; counts.set(k, c);
    };
    for (let x = 0; x < w; x++) { add(x, 0); add(x, h - 1); }
    for (let y = 0; y < h; y++) { add(0, y); add(w - 1, y); }
    let best = null;
    for (const c of counts.values()) if (!best || c.n > best.n) best = c;
    bg = [best.r / best.n, best.g / best.n, best.b / best.n];
  }
  const tol2 = o.keyTol * o.keyTol;
  const near = (i) => d[i + 3] > 0 && (d[i] - bg[0]) ** 2 + (d[i + 1] - bg[1]) ** 2 + (d[i + 2] - bg[2]) ** 2 <= tol2;
  // flood fill from the border so same-coloured pixels inside the subject survive
  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => { const p = y * w + x; if (!seen[p] && near(p * 4)) { seen[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
  while (stack.length) {
    const p = stack.pop(), x = p % w, y = (p / w) | 0;
    d[p * 4 + 3] = 0;
    if (x > 0) push(x - 1, y); if (x < w - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1); if (y < h - 1) push(x, y + 1);
  }
}

function opaqueBBox(img, thr = 8) {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    if (img.d[(y * img.w + x) * 4 + 3] > thr) {
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}
function crop(img, r) {
  const out = { w: r.w, h: r.h, d: new Uint8Array(r.w * r.h * 4) };
  for (let y = 0; y < r.h; y++) {
    const s = ((r.y + y) * img.w + r.x) * 4;
    out.d.set(img.d.subarray(s, s + r.w * 4), y * r.w * 4);
  }
  return out;
}

// ---------- 2. downscale ----------
// Returns { w, h, lab: Float64Array(w*h*3) in OKLab, a: Uint8Array(w*h) 0|1 }
function downscale(img, W, H, o) {
  const { w, h, d } = img;
  const cells = Array.from({ length: W * H }, () => []);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(H - 1, Math.floor((y + 0.5) * H / h));
    for (let x = 0; x < w; x++) {
      const cx = Math.min(W - 1, Math.floor((x + 0.5) * W / w));
      cells[cy * W + cx].push((y * w + x) * 4);
    }
  }
  const lab = new Float64Array(W * H * 3), a = new Uint8Array(W * H);
  const cache = new Map();
  const labAt = (i) => {
    const k = d[i] << 16 | d[i + 1] << 8 | d[i + 2];
    let v = cache.get(k);
    if (!v) { v = oklab(d[i], d[i + 1], d[i + 2]); cache.set(k, v); }
    return v;
  };
  for (let c = 0; c < W * H; c++) {
    const px = cells[c];
    if (!px.length) continue;
    let cov = 0;
    for (const i of px) cov += d[i + 3] / 255;
    if (cov / px.length < o.alpha) continue;
    a[c] = 1;
    const opaque = px.filter((i) => d[i + 3] >= 128);
    const use = opaque.length ? opaque : px;
    let res;
    if (o.sample === 'center') {
      res = labAt(use[(use.length / 2) | 0]);
    } else {
      const pts = use.map(labAt);
      let m = [0, 0, 0];
      for (const p of pts) { m[0] += p[0]; m[1] += p[1]; m[2] += p[2]; }
      m = m.map((v) => v / pts.length);
      res = m;
      if (o.sample === 'dominant' && pts.length >= 4) {
        // 2-means: seed with the two most distant-ish points, keep majority cluster
        let A = pts[0], B = pts[0], far = -1;
        for (const p of pts) { const dd = d2(p, m); if (dd > far) { far = dd; A = p; } }
        far = -1;
        for (const p of pts) { const dd = d2(p, A); if (dd > far) { far = dd; B = p; } }
        if (far > 0.0016) { // only split cells that actually contain an edge
          let ca, cb, na = 0, nb = 0;
          for (let it = 0; it < 4; it++) {
            ca = [0, 0, 0]; cb = [0, 0, 0]; na = 0; nb = 0;
            for (const p of pts) {
              if (d2(p, A) <= d2(p, B)) { ca[0] += p[0]; ca[1] += p[1]; ca[2] += p[2]; na++; }
              else { cb[0] += p[0]; cb[1] += p[1]; cb[2] += p[2]; nb++; }
            }
            if (na) A = ca.map((v) => v / na);
            if (nb) B = cb.map((v) => v / nb);
          }
          res = na >= nb ? A : B;
        }
      }
    }
    lab[c * 3] = res[0]; lab[c * 3 + 1] = res[1]; lab[c * 3 + 2] = res[2];
  }
  return { w: W, h: H, lab, a };
}

// saturation / contrast tweak in OKLab (pixel art reads better a bit punchier)
function grade(s, o) {
  if (o.sat === 1 && o.contrast === 1) return;
  for (let c = 0; c < s.w * s.h; c++) {
    if (!s.a[c]) continue;
    s.lab[c * 3] = Math.min(1, Math.max(0, 0.5 + (s.lab[c * 3] - 0.5) * o.contrast));
    s.lab[c * 3 + 1] *= o.sat; s.lab[c * 3 + 2] *= o.sat;
  }
}

// ---------- 3. palette ----------
function mulberry(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6d2b79f5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function kmeans(points, k, seed, withCounts = false) { // points: array of [L,a,b]
  if (points.length <= k) {
    const C = dedupe(points);
    return withCounts ? { C, n: C.map(() => 1) } : C;
  }
  const rnd = mulberry(seed);
  // k-means++ init
  const C = [points[(rnd() * points.length) | 0]];
  const dist = new Float64Array(points.length).fill(Infinity);
  while (C.length < k) {
    let sum = 0;
    const last = C[C.length - 1];
    for (let i = 0; i < points.length; i++) { dist[i] = Math.min(dist[i], d2(points[i], last)); sum += dist[i]; }
    if (sum === 0) break;
    let r = rnd() * sum, i = 0;
    for (; i < points.length - 1; i++) { r -= dist[i]; if (r <= 0) break; }
    C.push(points[i]);
  }
  const asg = new Int32Array(points.length);
  for (let it = 0; it < 24; it++) {
    let moved = 0;
    for (let i = 0; i < points.length; i++) {
      let best = 0, bd = Infinity;
      for (let j = 0; j < C.length; j++) { const dd = d2(points[i], C[j]); if (dd < bd) { bd = dd; best = j; } }
      if (asg[i] !== best) { asg[i] = best; moved++; }
    }
    const acc = C.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < points.length; i++) {
      const a = acc[asg[i]], p = points[i];
      a[0] += p[0]; a[1] += p[1]; a[2] += p[2]; a[3]++;
    }
    for (let j = 0; j < C.length; j++) if (acc[j][3]) C[j] = [acc[j][0] / acc[j][3], acc[j][1] / acc[j][3], acc[j][2] / acc[j][3]];
    if (!moved && it) break;
  }
  if (!withCounts) return C;
  const n = C.map(() => 0);
  for (let i = 0; i < points.length; i++) n[asg[i]]++;
  return { C, n };
}
function dedupe(list) {
  const out = [];
  for (const c of list) if (!out.some((q) => d2(q, c) < 1e-9)) out.push(c);
  return out;
}
// Build final palette (array of {rgb, lab}) from the opaque pixels of one or more images
function buildPalette(images, o, fixed) {
  const pts = [];
  for (const s of images) for (let c = 0; c < s.w * s.h; c++) if (s.a[c]) pts.push([s.lab[c * 3], s.lab[c * 3 + 1], s.lab[c * 3 + 2]]);
  // subsample huge batches to keep k-means fast
  const MAX = 60000;
  const sample = pts.length > MAX ? pts.filter((_, i) => i % Math.ceil(pts.length / MAX) === 0) : pts;
  if (fixed) {
    const fx = fixed.map((rgb) => ({ rgb, lab: oklab(...rgb) }));
    if (!o.colors || o.colors >= fixed.length || !sample.length) return fx;
    // reduce: k-means to N, snap centres to palette. Big clusters pick first; a centre whose
    // nearest entry is taken moves to the next-nearest unused one if that is still close,
    // so e.g. tail-light red and body red don't collapse into one swatch.
    const { C, n } = kmeans(sample, o.colors, o.seed, true);
    const order = C.map((_, j) => j).sort((a, b) => n[b] - n[a]);
    const used = new Set();
    for (const j of order) {
      const ranked = fx.map((f, k) => [dm(f.lab, C[j]), k]).sort((a, b) => a[0] - b[0]);
      const free = ranked.find(([dd, k]) => !used.has(k) && Math.sqrt(dd) <= Math.sqrt(ranked[0][0]) * 1.35 + 0.005);
      used.add(free ? free[1] : ranked[0][1]);
    }
    return [...used].map((j) => fx[j]);
  }
  if (!sample.length) return [{ rgb: [0, 0, 0], lab: [0, 0, 0] }];
  return mergeClose(kmeans(sample, o.colors || 16, o.seed), o.merge).map((lab) => {
    const rgb = oklabToRgb(lab);
    return { rgb, lab: oklab(...rgb) };
  });
}
// fold palette entries closer than `thr` (OKLab distance) into one — fewer, more distinct swatches
function mergeClose(C, thr) {
  if (!thr) return C;
  const out = [];
  for (const c of [...C].sort((a, b) => a[0] - b[0])) {
    if (!out.some((q) => Math.sqrt(d2(q, c)) < thr)) out.push(c);
  }
  return out;
}

// ---------- 4. quantise + dither ----------
const BAYER = {
  bayer2: [[0, 2], [3, 1]],
  bayer4: [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]],
};
BAYER.bayer8 = (() => {
  const b4 = BAYER.bayer4, m = [];
  for (let y = 0; y < 8; y++) { m.push([]); for (let x = 0; x < 8; x++) m[y].push(4 * b4[y % 4][x % 4] + [[0, 2], [3, 1]][y >> 2][x >> 2]); }
  return m;
})();
function nearest(pal, p) {
  let best = 0, bd = Infinity;
  for (let j = 0; j < pal.length; j++) { const dd = dm(pal[j].lab, p); if (dd < bd) { bd = dd; best = j; } }
  return best;
}
// returns Int16Array index map (-1 = transparent)
function quantise(s, pal, o) {
  const idx = new Int16Array(s.w * s.h).fill(-1);
  const M = BAYER[o.dither];
  // typical gap between palette neighbours sets the dither spread
  let spread = 0;
  if (M) {
    const gaps = pal.map((p, i) => Math.min(...pal.map((q, j) => (i === j ? Infinity : Math.sqrt(d2(p.lab, q.lab))))));
    gaps.sort((a, b) => a - b);
    spread = (gaps[gaps.length >> 1] || 0.05) * o.ditherAmt * 1.5;
  }
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    const c = y * s.w + x;
    if (!s.a[c]) continue;
    let p = [s.lab[c * 3], s.lab[c * 3 + 1], s.lab[c * 3 + 2]];
    if (M) {
      const n = M.length, t = (M[y % n][x % n] + 0.5) / (n * n) - 0.5;
      p = [p[0] + t * spread, p[1], p[2]];   // dither on lightness only: cleaner, no colour noise
    }
    idx[c] = nearest(pal, p);
  }
  return idx;
}

// ---------- 5. cleanup ----------
function cleanup(idx, W, H, passes) {
  const N8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  for (let p = 0; p < passes; p++) {
    const src = idx.slice();
    const at = (x, y) => (x < 0 || y < 0 || x >= W || y >= H ? -1 : src[y * W + x]);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = src[y * W + x];
      const counts = new Map();
      let same4 = 0, opaqueN = 0;
      for (const [dx, dy] of N8) {
        const n = at(x + dx, y + dy);
        if (n >= 0) opaqueN++;
        if (n === v && (dx === 0 || dy === 0)) same4++;
        counts.set(n, (counts.get(n) || 0) + 1);
      }
      if (v >= 0) {
        if (opaqueN <= 1) { idx[y * W + x] = -1; continue; }      // floating speck
        let opaque4 = 0;
        for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) if (at(x + dx, y + dy) >= 0) opaque4++;
        if (opaque4 <= 1 && opaqueN <= 3) { idx[y * W + x] = -1; continue; } // 1-px spike on the silhouette
        if (same4 === 0) {                                          // orphan colour pixel
          let best = v, bn = 0;
          for (const [k, n] of counts) if (k >= 0 && n > bn) { bn = n; best = k; }
          if (bn >= 5) idx[y * W + x] = best;                       // only if clearly surrounded
        }
      } else if (opaqueN >= 7) {                                    // pin-hole
        let best = -1, bn = 0;
        for (const [k, n] of counts) if (k >= 0 && n > bn) { bn = n; best = k; }
        idx[y * W + x] = best;
      }
    }
  }
}

// ---------- 6. outline + render ----------
function render(idx, W, H, pal, o) {
  const out = { w: W, h: H, d: new Uint8Array(W * H * 4) };
  for (let c = 0; c < W * H; c++) {
    if (idx[c] < 0) continue;
    const [r, g, b] = pal[idx[c]].rgb;
    out.d.set([r, g, b, 255], c * 4);
  }
  // outline: darkest colour of the FULL palette (a reduced subset may lack a near-black)
  const darkest = o._darkest || pal.reduce((a, b) => (b.lab[0] < a.lab[0] ? b : a)).rgb;
  // darker shade of a palette colour: the palette entry closest to (L-0.22, same hue)
  const shade = (j) => {
    const L = pal[j].lab;
    const target = [Math.max(0, L[0] - 0.22), L[1] * 0.8, L[2] * 0.8];
    let best = j, bd = Infinity;
    pal.forEach((q, k) => { if (q.lab[0] < L[0] - 0.05) { const dd = d2(q.lab, target); if (dd < bd) { bd = dd; best = k; } } });
    return best === j ? darkest : pal[best].rgb;
  };
  if (o.innerShade) {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = y * W + x;
      if (idx[c] < 0) continue;
      const edge = (x === W - 1 || idx[c + 1] < 0) || (y === H - 1 || idx[c + W] < 0);
      if (edge) out.d.set(shade(idx[c]), c * 4);
    }
  }
  if (o.outline) {
    const col = o.outlineColor || darkest;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const c = y * W + x;
      if (idx[c] >= 0) continue;
      let src = -1;
      for (const [dx, dy] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
        const X = x + dx, Y = y + dy;
        if (X >= 0 && Y >= 0 && X < W && Y < H && idx[Y * W + X] >= 0) { src = idx[Y * W + X]; break; }
      }
      if (src < 0) continue;
      const rgb = o.outlineStyle === 'selective' ? shade(src) : col;
      out.d.set([rgb[0], rgb[1], rgb[2], 255], c * 4);
    }
  }
  return out;
}

// ---------- pipeline ----------
function load(file, o) {
  const img = readPng(file);
  img.d = new Uint8Array(img.d);
  keyBackground(img, o);
  return img;
}
function prepare(file, img, o, bb) {
  if (bb) img = crop(img, bb);
  const pad = o.outline ? 1 : 0;
  const W = Math.max(1, o.w - 2 * pad);
  const H = o.h ? Math.max(1, o.h - 2 * pad) : Math.max(1, Math.round(W * img.h / img.w));
  const s = downscale(img, W, H, o);
  grade(s, o);
  return { file, src: img, s, pad };
}
function finish(p, pal, o) {
  const { s, pad } = p;
  let idx = quantise(s, pal, o);
  if (o.cleanup) cleanup(idx, s.w, s.h, o.cleanup);
  if (pad) { // grow canvas by 1 px each side for the outline
    const W = s.w + 2, H = s.h + 2, g = new Int16Array(W * H).fill(-1);
    for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) g[(y + 1) * W + x + 1] = idx[y * s.w + x];
    return render(g, W, H, pal, o);
  }
  return render(idx, s.w, s.h, pal, o);
}
function compareImage(src, out, file) {
  // left: source scaled (nearest) to output-preview height; right: pixel art ×k
  const k = Math.max(1, Math.floor(512 / Math.max(out.w, out.h)));
  const big = upscale(out, k);
  const sh = big.h, sw = Math.round(src.w * sh / src.h);
  const gap = 16, W = sw + gap + big.w, H = sh;
  const img = { w: W, h: H, d: new Uint8Array(W * H * 4) };
  const checker = (x, y) => (((x >> 3) + (y >> 3)) & 1 ? 200 : 232);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = (y * W + x) * 4, c = checker(x, y);
    let r = c, g = c, b = c, a = 0, i = -1, dd = null;
    if (x < sw) { dd = src.d; i = (Math.min(src.h - 1, (y * src.h / sh) | 0) * src.w + Math.min(src.w - 1, (x * src.w / sw) | 0)) * 4; }
    else if (x >= sw + gap) { dd = big.d; i = (y * big.w + (x - sw - gap)) * 4; }
    else { r = g = b = 255; }
    if (dd) { a = dd[i + 3] / 255; r = dd[i] * a + r * (1 - a); g = dd[i + 1] * a + g * (1 - a); b = dd[i + 2] * a + b * (1 - a); }
    img.d[t] = r; img.d[t + 1] = g; img.d[t + 2] = b; img.d[t + 3] = 255;
  }
  writePng(file, img);
}
function emit(out, file, o) {
  writePng(file, upscale(out, o.scale));
  if (o.preview > 1) writePng(file.replace(/\.png$/i, `@${o.preview}x.png`), upscale(out, o.preview));
}
function packSheet(frames, file, o) {
  const cols = o.cols || Math.min(frames.length, 16);
  const rows = Math.ceil(frames.length / cols);
  const fw = Math.max(...frames.map((f) => f.img.w)), fh = Math.max(...frames.map((f) => f.img.h));
  const sheet = { w: cols * fw, h: rows * fh, d: new Uint8Array(cols * fw * rows * fh * 4) };
  const meta = { image: path.basename(file), frameWidth: fw, frameHeight: fh, cols, rows, frames: [] };
  frames.forEach((f, n) => {
    const ox = (n % cols) * fw, oy = ((n / cols) | 0) * fh;
    for (let y = 0; y < f.img.h; y++) sheet.d.set(f.img.d.subarray(y * f.img.w * 4, (y + 1) * f.img.w * 4), ((oy + y) * sheet.w + ox) * 4);
    meta.frames.push({ name: path.basename(f.name, '.png'), x: ox * o.scale, y: oy * o.scale, w: f.img.w * o.scale, h: f.img.h * o.scale });
  });
  meta.frameWidth *= o.scale; meta.frameHeight *= o.scale;
  emit(sheet, file, o);
  fs.writeFileSync(file.replace(/\.png$/i, '.json'), JSON.stringify(meta, null, 2));
}

export function pixelizeFiles(inputs, outputs, o) {
  CW = o.chroma;
  const fixed = loadPalette(o.palette);
  if (fixed) o._darkest = fixed.reduce((a, b) => (oklab(...b)[0] < oklab(...a)[0] ? b : a));
  const imgs = inputs.map((f) => load(f, o));
  // --trim: crop every frame to the UNION of their opaque boxes so animation stays aligned
  let bb = null;
  if (o.trim) {
    for (const b of imgs.map((im) => opaqueBBox(im)).filter(Boolean)) {
      if (!bb) { bb = { ...b }; continue; }
      const x1 = Math.max(bb.x + bb.w, b.x + b.w), y1 = Math.max(bb.y + bb.h, b.y + b.h);
      bb.x = Math.min(bb.x, b.x); bb.y = Math.min(bb.y, b.y); bb.w = x1 - bb.x; bb.h = y1 - bb.y;
    }
    if (bb && imgs.some((im) => im.w !== imgs[0].w || im.h !== imgs[0].h)) bb = null; // mixed sizes: per-frame
  }
  const preps = inputs.map((f, n) => prepare(f, imgs[n], o, o.trim ? bb || opaqueBBox(imgs[n]) : null));
  const shared = o.sharedPalette || inputs.length === 1 ? buildPalette(preps.map((p) => p.s), o, fixed) : null;
  const results = preps.map((p, n) => {
    const pal = shared || buildPalette([p.s], o, fixed);
    const img = finish(p, pal, o);
    if (outputs[n]) emit(img, outputs[n], o);
    return { name: path.basename(p.file), img, src: p.src, pal };
  });
  return results;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.help || o._.length < 2) { console.log(HELP); process.exit(o.help ? 0 : 1); }
  const [inp, outp] = o._;
  const log = (...a) => o.quiet || console.log(...a);
  const t0 = Date.now();
  if (fs.statSync(inp).isDirectory()) {
    const files = fs.readdirSync(inp).filter((f) => /\.png$/i.test(f)).sort();
    if (!files.length) throw new Error(`no .png files in ${inp}`);
    fs.mkdirSync(outp, { recursive: true });
    const res = pixelizeFiles(files.map((f) => path.join(inp, f)), files.map((f) => path.join(outp, f)), o);
    if (o.sheet) packSheet(res, o.sheet, o);
    log(`pixelize: ${files.length} frames → ${outp}${o.sheet ? ` + sheet ${o.sheet}` : ''}  palette ${res[0].pal.length} colours  ${Date.now() - t0} ms`);
  } else {
    const [r] = pixelizeFiles([inp], [outp], o);
    if (o.compare) compareImage(r.src, r.img, o.compare);
    log(`pixelize: ${inp} → ${outp} (${r.img.w}×${r.img.h}, ${r.pal.length} colours: ${r.pal.map((p) => toHex(p.rgb)).join(' ')})  ${Date.now() - t0} ms`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (e) { console.error('pixelize: ' + e.message); process.exit(1); }
}
