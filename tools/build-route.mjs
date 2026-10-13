#!/usr/bin/env node
// Builds game/data/* for the road clicker from free, real-world data:
//   - geocoding:  Nominatim (OpenStreetMap)
//   - routing:    OSRM on routing.openstreetmap.de (OpenStreetMap roads)
//   - elevation:  AWS Terrain Tiles (Terrarium PNG, SRTM-based, ~30 m)
//   - places:     Overpass API (cities / towns / villages / rivers along the road)
//
// Usage:
//   node tools/build-route.mjs --from "Ужгород" --to "Харків" [--via "Львів;Київ"] [--quality ultra] [--yes]
// Without --yes it only prints the estimate.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tools', '.cache');
const OUT = path.join(ROOT, 'game', 'data');
const UA = 'ukraine-road-clicker/0.1 (hobby game; contact via github)';

const QUALITY = {
  // stepM: road sample spacing; stationM: horizon panorama spacing;
  // az: azimuth samples per panorama; roadZ / horizonZ: terrain tile zooms
  draft:    { stepM: 50, stationM: 25000, az: 180, roadZ: 11, horizonZ: 9 },
  standard: { stepM: 20, stationM: 10000, az: 360, roadZ: 12, horizonZ: 10 },
  ultra:    { stepM: 10, stationM: 10000, az: 720, roadZ: 12, horizonZ: 10 },
};
const HALF_MAP_M = 30500;          // panorama heightmap is 61 x 61 km around each station
const BANDS = [[150, 3000], [3000, 10000], [10000, HALF_MAP_M]]; // near / mid / far ridges
const EYE_M = 2.5;
const R_EARTH = 6371000;

// ---------- args ----------
const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true]);
  return acc;
}, []));
const from = args.from || 'Ужгород';
const to = args.to || 'Харків';
const via = args.via ? String(args.via).split(';').map(s => s.trim()).filter(Boolean) : [];
const qName = args.quality || 'ultra';
const Q = QUALITY[qName];
if (!Q) die(`unknown --quality ${qName} (draft | standard | ultra)`);

function die(msg) { console.error('✖', msg); process.exit(1); }
const log = (...a) => console.log(...a);
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

// ---------- http with polite retries ----------
async function http(url, opts = {}, kind = 'json', tries = 4) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { ...opts, headers: { 'User-Agent': UA, ...(opts.headers || {}) } });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      if (!r.ok) throw Object.assign(new Error('HTTP ' + r.status), { fatal: true });
      return kind === 'json' ? await r.json() : Buffer.from(await r.arrayBuffer());
    } catch (e) {
      if (e.fatal || i >= tries - 1) throw new Error(`${url.slice(0, 90)} → ${e.message}`);
      await new Promise(res => setTimeout(res, 1500 * (i + 1) ** 2));
    }
  }
}

// ---------- geo helpers ----------
const rad = d => d * Math.PI / 180;
function haversine(a, b) {
  const dLat = rad(b[0] - a[0]), dLon = rad(b[1] - a[1]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.sqrt(s));
}
function decodePolyline(str, precision = 6) {
  const f = 10 ** precision, pts = [];
  let i = 0, lat = 0, lon = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, result = 0, b;
      do { b = str.charCodeAt(i++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += d; else lon += d;
    }
    pts.push([lat / f, lon / f]);
  }
  return pts;
}
function resample(pts, step) {
  const out = [pts[0]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], seg = haversine(a, b);
    let t = step - carry;
    while (t <= seg) {
      const f = t / seg;
      out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
      t += step;
    }
    carry = seg - (t - step);
  }
  return out;
}
const lon2x = (lon, z) => (lon + 180) / 360 * 2 ** z;
const lat2y = (lat, z) => (1 - Math.log(Math.tan(rad(lat)) + 1 / Math.cos(rad(lat))) / Math.PI) / 2 * 2 ** z;
function destination(lat, lon, bearingDeg, d) {
  const br = rad(bearingDeg), dr = d / R_EARTH, la = rad(lat), lo = rad(lon);
  const la2 = Math.asin(Math.sin(la) * Math.cos(dr) + Math.cos(la) * Math.sin(dr) * Math.cos(br));
  const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(la), Math.cos(dr) - Math.sin(la) * Math.sin(la2));
  return [la2 * 180 / Math.PI, lo2 * 180 / Math.PI];
}

// ---------- terrain tiles ----------
class Terrain {
  constructor(z) { this.z = z; this.tiles = new Map(); this.missing = 0; }
  key(x, y) { return `${x}/${y}`; }
  async load(keys, label) {
    const todo = [...keys].filter(k => !this.tiles.has(k));
    let done = 0;
    const worker = async () => {
      while (todo.length) {
        const k = todo.pop();
        const file = path.join(CACHE, `t${this.z}_${k.replace('/', '_')}.png`);
        let buf;
        if (fs.existsSync(file)) buf = fs.readFileSync(file);
        else {
          buf = await http(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${this.z}/${k}.png`, {}, 'buf');
          fs.writeFileSync(file, buf);
        }
        const png = PNG.sync.read(buf);
        const h = new Float32Array(256 * 256);
        for (let i = 0; i < h.length; i++) {
          const o = i * 4;
          h[i] = png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
        }
        this.tiles.set(k, h);
        if (++done % 25 === 0 || !todo.length) process.stdout.write(`\r  ${label}: ${done}/${keys.size} tiles`);
      }
    };
    await Promise.all(Array.from({ length: 8 }, worker));
    if (keys.size) process.stdout.write('\n');
  }
  // bilinear sample, metres; tiles must be loaded
  at(lat, lon) {
    const fx = lon2x(lon, this.z) * 256 - 0.5, fy = lat2y(lat, this.z) * 256 - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const px = (x, y) => {
      const t = this.tiles.get(this.key(x >> 8, y >> 8));
      if (!t) { this.missing++; return 0; }
      return t[(y & 255) * 256 + (x & 255)];
    };
    const a = px(x0, y0), b = px(x0 + 1, y0), c = px(x0, y0 + 1), d = px(x0 + 1, y0 + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }
}
function tilesForPoints(points, z, padM = 0) {
  const keys = new Set();
  for (const [lat, lon] of points) {
    const pads = padM ? [[0, 0], ...[0, 90, 180, 270, 45, 135, 225, 315].map(b => destination(lat, lon, b, padM))]
      .map((p, i) => i === 0 ? [lat, lon] : p) : [[lat, lon]];
    if (!padM) { keys.add(`${Math.floor(lon2x(lon, z))}/${Math.floor(lat2y(lat, z))}`); continue; }
    const xs = pads.map(p => lon2x(p[1], z)), ys = pads.map(p => lat2y(p[0], z));
    for (let x = Math.floor(Math.min(...xs)); x <= Math.floor(Math.max(...xs)); x++)
      for (let y = Math.floor(Math.min(...ys)); y <= Math.floor(Math.max(...ys)); y++) keys.add(`${x}/${y}`);
  }
  return keys;
}

// ---------- 1. geocode ----------
async function geocode(q) {
  const j = await http(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=ua&accept-language=uk&q=${encodeURIComponent(q)}`);
  if (!j.length) die(`cannot find "${q}" in Ukraine`);
  await new Promise(r => setTimeout(r, 1100)); // Nominatim: max 1 req/s
  return { name: q, label: j[0].display_name.split(',')[0], lat: +j[0].lat, lon: +j[0].lon };
}

log(`\n🇺🇦  Route builder — quality "${qName}" (road every ${Q.stepM} m, panorama every ${Q.stationM / 1000} km, ${Q.az} azimuths)`);
const stops = [];
for (const q of [from, ...via, to]) stops.push(await geocode(q));
log('  stops:', stops.map(s => `${s.label} (${s.lat.toFixed(3)}, ${s.lon.toFixed(3)})`).join(' → '));

// ---------- 2. route ----------
const coords = stops.map(s => `${s.lon},${s.lat}`).join(';');
const rj = await http(`https://routing.openstreetmap.de/routed-car/route/v1/driving/${coords}?overview=full&geometries=polyline6`);
if (rj.code !== 'Ok') die('routing failed: ' + rj.code);
const raw = decodePolyline(rj.routes[0].geometry);
const lengthM = rj.routes[0].distance;
// A via point in a city centre often makes OSRM drive a short out-and-back spur to reach it.
// Cut such spurs: within ±3 km of each via waypoint, find the widest i < j where the road returns
// within 30 m of itself after ≥ 100 m, and drop the points in between.
{
  let spurs = 0;
  for (const wp of (rj.waypoints || []).slice(1, -1)) {
    const at = [wp.location[1], wp.location[0]];
    let k = 0, kd = Infinity;
    raw.forEach((p, i) => { const d = haversine(p, at); if (d < kd) { kd = d; k = i; } });
    const cum = [0];
    let lo = k, hi = k;
    for (let d = 0; lo > 0 && d < 3000; lo--) d += haversine(raw[lo - 1], raw[lo]);
    for (let d = 0; hi < raw.length - 1 && d < 3000; hi++) d += haversine(raw[hi], raw[hi + 1]);
    for (let i = lo + 1; i <= hi; i++) cum[i - lo] = cum[i - lo - 1] + haversine(raw[i - 1], raw[i]);
    let best = null;
    for (let i = lo; i <= hi; i++) for (let j = hi; j > i + 1; j--) {
      const span = cum[j - lo] - cum[i - lo];
      if (span < 100 || (best && span <= best.span)) continue;
      if (haversine(raw[i], raw[j]) < 30) { best = { i, j, span }; break; }
    }
    if (best) {
      raw.splice(best.i + 1, best.j - best.i);
      spurs++;
      log(`  ✂ removed a ${Math.round(best.span)} m out-and-back spur at via ${wp.name || at.map(v => v.toFixed(3)).join(',')}`);
    }
  }
  if (spurs) log(`  (${spurs} spur(s) removed)`);
}
const pts = resample(raw, Q.stepM);
const stations = resample(raw, Q.stationM);

// ---------- estimate ----------
// pad 400 m: road points lie up to 250 m from a 500 m sample, and bilinear sampling reads the next pixel
const roadTiles = tilesForPoints(resample(raw, 500), Q.roadZ, 400);
const horizonTiles = tilesForPoints(stations, Q.horizonZ, HALF_MAP_M);
const cached = [...roadTiles].filter(k => fs.existsSync(path.join(CACHE, `t${Q.roadZ}_${k.replace('/', '_')}.png`))).length
  + [...horizonTiles].filter(k => fs.existsSync(path.join(CACHE, `t${Q.horizonZ}_${k.replace('/', '_')}.png`))).length;
const fetchN = roadTiles.size + horizonTiles.size - cached;
log(`\n  ── estimate ─────────────────────────────`);
log(`  road length        ${(lengthM / 1000).toFixed(1)} km (${pts.length.toLocaleString()} samples)`);
log(`  panoramas          ${stations.length} × 61×61 km heightmaps`);
log(`  terrain tiles      ${roadTiles.size} road (z${Q.roadZ}) + ${horizonTiles.size} horizon (z${Q.horizonZ}), ${cached} cached`);
log(`  download           ~${(fetchN * 0.09).toFixed(0)} MB, ~${Math.ceil(fetchN / 8 * 0.4 / 60 + 1)} min`);
log(`  output size        ~${((pts.length * 12 + stations.length * Q.az * BANDS.length * 2) / 1e6).toFixed(1)} MB`);
log(`  cost               $0 — all sources are free public OSM / AWS Open Data services`);
log(`  ─────────────────────────────────────────`);
if (!args.yes) { log('\n  re-run with --yes to build.\n'); process.exit(0); }

// ---------- 3. road elevation ----------
log('\n⛰  elevation');
const road = new Terrain(Q.roadZ);
await road.load(roadTiles, 'road');
let ele = Float32Array.from(pts, p => road.at(p[0], p[1]));
if (road.missing) die(`${road.missing} road elevation lookups hit a terrain tile that was not loaded`);
// The DEM shows river level under bridges and spikes on cuttings: median then mean filter (~150 m).
{
  const w = Math.max(1, Math.round(75 / Q.stepM)), m = new Float32Array(ele.length);
  for (let i = 0; i < ele.length; i++) {
    const win = Array.from(ele.subarray(Math.max(0, i - w), Math.min(ele.length, i + w + 1))).sort((a, b) => a - b);
    m[i] = win[win.length >> 1];
  }
  const s = new Float32Array(ele.length);
  for (let i = 0; i < ele.length; i++) {
    let sum = 0, n = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(ele.length - 1, i + w); j++) { sum += m[j]; n++; }
    s[i] = sum / n;
  }
  ele = s;
}

// ---------- 4. horizon panoramas ----------
log('🌄 panoramas');
const hz = new Terrain(Q.horizonZ);
await hz.load(horizonTiles, 'horizon');
const horizon = new Int16Array(stations.length * BANDS.length * Q.az);
const stationEle = [];
const dStep = 120;
for (let s = 0; s < stations.length; s++) {
  const [lat, lon] = stations[s];
  const h0 = hz.at(lat, lon) + EYE_M;
  stationEle.push(Math.round(hz.at(lat, lon)));
  const cosLat = Math.cos(rad(lat));
  for (let a = 0; a < Q.az; a++) {
    const br = rad(a * 360 / Q.az), dn = Math.cos(br), de = Math.sin(br);
    for (let b = 0; b < BANDS.length; b++) {
      let best = -5;
      for (let d = BANDS[b][0]; d <= BANDS[b][1]; d += dStep * (b + 1)) {
        const la = lat + (dn * d / R_EARTH) * 180 / Math.PI;
        const lo = lon + (de * d / (R_EARTH * cosLat)) * 180 / Math.PI;
        const drop = d * d / (2 * R_EARTH) * 0.87;               // earth curvature with refraction
        const ang = Math.atan2(hz.at(la, lo) - h0 - drop, d) * 180 / Math.PI;
        if (ang > best) best = ang;
      }
      horizon[(s * BANDS.length + b) * Q.az + a] = Math.round(best * 100);
    }
  }
  if (s % 10 === 0 || s === stations.length - 1) process.stdout.write(`\r  panorama ${s + 1}/${stations.length}`);
}
process.stdout.write('\n');
if (hz.missing) die(`${hz.missing} horizon lookups hit a terrain tile that was not loaded`);

// ---------- 5. places & rivers along the road ----------
// Overpass "around a 1300 km polyline" times out, so query bbox chunks (~60 km of road each)
// and filter locally against the 100 m resampled route with a grid spatial index.
log('🏘  places & rivers');
const coarse = resample(raw, 100);                       // 100 m route segments; point i is at i*0.1 km
const CELL = 0.02, M_PER_DEG = R_EARTH * Math.PI / 180, grid = new Map();
const cellKey = (cy, cx) => cy + ':' + cx;
coarse.forEach((p, i) => {
  const k = cellKey(Math.floor(p[0] / CELL), Math.floor(p[1] / CELL));
  (grid.get(k) || grid.set(k, []).get(k)).push(i);
});
// Route point indices within radiusM of (lat, lon). Cells are 0.02° in both axes, which is ~2.2 km
// of latitude but only ~1.4 km of longitude at 50°N, so the cell radius is computed per axis.
function nearIdx(lat, lon, radiusM) {
  const ry = Math.ceil(radiusM / (CELL * M_PER_DEG)) + 1;
  const rx = Math.ceil(radiusM / (CELL * M_PER_DEG * Math.cos(rad(lat)))) + 1;
  const cy = Math.floor(lat / CELL), cx = Math.floor(lon / CELL), out = [];
  for (let y = cy - ry; y <= cy + ry; y++) for (let x = cx - rx; x <= cx + rx; x++) {
    const l = grid.get(cellKey(y, x)); if (l) for (const i of l) out.push(i);
  }
  return out;
}
// Nearest point on the route polyline (projected onto segments, local equirectangular metres).
function project(lat, lon, radiusM) {
  let best = { km: 0, off: Infinity };
  const k = Math.cos(rad(lat));
  const xy = p => [(p[1] - lon) * k * M_PER_DEG, (p[0] - lat) * M_PER_DEG];
  for (const i of nearIdx(lat, lon, radiusM + 100)) {
    for (const j of [i - 1, i]) {
      if (j < 0 || j + 1 >= coarse.length) continue;
      const [ax, ay] = xy(coarse[j]), [bx, by] = xy(coarse[j + 1]);
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      const off = Math.hypot(ax + dx * t, ay + dy * t);
      if (off < best.off) best = { km: (j + t) * 0.1, off };
    }
  }
  return best;
}
function cross(p1, p2, p3, p4) {                           // planar segment intersection, lon scaled; → u on p3-p4 or -1
  const k = Math.cos(rad(p1[0]));
  const d = (p2[1] - p1[1]) * k * (p4[0] - p3[0]) - (p2[0] - p1[0]) * (p4[1] - p3[1]) * k;
  if (!d) return -1;
  const t = ((p3[1] - p1[1]) * k * (p4[0] - p3[0]) - (p3[0] - p1[0]) * (p4[1] - p3[1]) * k) / d;
  const u = ((p3[1] - p1[1]) * k * (p2[0] - p1[0]) - (p3[0] - p1[0]) * (p2[1] - p1[1]) * k) / d;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? u : -1;
}
// Route segment indices whose cells touch the bbox of segment a-b (+1 cell margin).
function segCandidates(a, b) {
  const out = new Set();
  const y0 = Math.floor(Math.min(a[0], b[0]) / CELL) - 1, y1 = Math.floor(Math.max(a[0], b[0]) / CELL) + 1;
  const x0 = Math.floor(Math.min(a[1], b[1]) / CELL) - 1, x1 = Math.floor(Math.max(a[1], b[1]) / CELL) + 1;
  if ((y1 - y0) * (x1 - x0) > 400) return out;            // absurdly long segment: skip rather than scan the world
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const l = grid.get(cellKey(y, x));
    if (l) for (const i of l) { if (i > 0) out.add(i - 1); out.add(i); }
  }
  return out;
}
// "12 345" → 12345, "~5000" → 5000, "1,234,567" → 1234567, junk → 0
function parsePop(v) {
  const s = String(v || '').replace(/(\d)[\s  ,.'’](?=\d{3}(?:\D|$))/g, '$1');
  const m = s.match(/\d+/);
  const n = m ? Number(m[0]) : 0;
  return Number.isFinite(n) && n < 5e7 ? n : 0;
}
const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
// One query, with backoff and endpoint fallback. Only valid responses are cached. Returns null on persistent failure.
async function overpass(q) {
  const file = path.join(CACHE, 'op_' + crypto.createHash('sha1').update(q).digest('hex') + '.json');
  if (fs.existsSync(file)) {
    try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(j.elements)) return j; } catch {}
    fs.unlinkSync(file);
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = OVERPASS[attempt < 3 ? 0 : 1];
    let why;
    try {
      const r = await fetch(url, {
        method: 'POST', body: 'data=' + encodeURIComponent(q),
        headers: { 'User-Agent': UA, 'Content-Type': 'application/x-www-form-urlencoded' },
        signal: AbortSignal.timeout(180000),
      });
      if (r.ok) {
        const j = await r.json();
        if (!Array.isArray(j.elements)) why = 'no elements array';
        else if (j.remark && /error|timeout|runtime/i.test(j.remark)) why = 'remark: ' + j.remark.slice(0, 120);
        else {
          fs.writeFileSync(file, JSON.stringify(j));
          await sleep(1000);
          return j;
        }
      } else {
        why = 'HTTP ' + r.status;
        if (r.status < 500 && r.status !== 429) { log(`\n  ⚠ overpass ${why}`); return null; }
      }
    } catch (e) { why = e.message; }
    log(`\n  ⚠ overpass ${new URL(url).host}: ${why} — retry ${attempt + 1}/6`);
    await sleep(5000 * 2 ** (attempt % 3));
  }
  return null;
}
const placeHits = new Map(), riverHits = [], failed = [];
let splits = 0;
function bboxOf(part, pad = 0.06) {
  let s = 90, w = 180, n = -90, e = -180;
  for (const [la, lo] of part) { if (la < s) s = la; if (la > n) n = la; if (lo < w) w = lo; if (lo > e) e = lo; }
  return [s - pad, w - pad, n + pad, e + pad].map(v => v.toFixed(4)).join(',');
}
function ingest(j) {
  for (const e of j.elements) {
    const name = e.tags && (e.tags['name:uk'] || e.tags.name);
    if (!name) continue;
    if (e.type === 'node') {
      if (!Number.isFinite(e.lat) || !Number.isFinite(e.lon)) continue;
      const limit = e.tags.place === 'village' ? 800 : 4000;
      const p = project(e.lat, e.lon, limit);
      if (p.off > limit) continue;
      const prev = placeHits.get(name);
      if (!prev || p.off < prev.off) placeHits.set(name, { km: +p.km.toFixed(2), off: p.off, name, type: e.tags.place,
        pop: parsePop(e.tags.population) });
    } else {
      const g = e.geometry || [];
      for (let i = 1; i < g.length; i++) {
        if (!g[i - 1] || !g[i]) continue;                  // geom(bbox) leaves nulls outside the bbox
        const a1 = [g[i - 1].lat, g[i - 1].lon], a2 = [g[i].lat, g[i].lon];
        for (const r of segCandidates(a1, a2)) {
          if (r + 1 >= coarse.length) continue;
          const u = cross(a1, a2, coarse[r], coarse[r + 1]);
          if (u >= 0) riverHits.push({ km: +((r + u) * 0.1).toFixed(2), name });
        }
      }
    }
  }
}
// Query a run of route points; on failure split it in half (down to ~15 km) and retry.
async function queryPart(from, to, label) {
  const bb = bboxOf(coarse.slice(from, to + 1));
  process.stdout.write(`\r  chunk ${label} (km ${(from / 10).toFixed(0)}–${(to / 10).toFixed(0)})        `);
  const j = await overpass('[out:json][timeout:120][bbox:' + bb + '];(node[place~"^(city|town|village)$"];way[waterway=river];);out tags geom(' + bb + ');');
  if (j) return ingest(j);
  if (to - from >= 300) {                                  // ≥ 30 km → halves stay ≥ 15 km
    splits++;
    const mid = (from + to) >> 1;
    log(`\n  ↯ splitting km ${(from / 10).toFixed(0)}–${(to / 10).toFixed(0)}`);
    await queryPart(from, mid, label + 'a');
    await queryPart(mid, to, label + 'b');
    return;
  }
  failed.push(`km ${(from / 10).toFixed(0)}–${(to / 10).toFixed(0)}`);
}
const CHUNK = 600;                                          // 60 km of coarse points per query
const nChunks = Math.ceil((coarse.length - 1) / CHUNK);
for (let c = 0; c < nChunks; c++) {
  await queryPart(c * CHUNK, Math.min(coarse.length - 1, (c + 1) * CHUNK), `${c + 1}/${nChunks}`);
}
process.stdout.write('\n');
if (failed.length) {
  if (!args['allow-missing-places']) die(`Overpass failed for ${failed.join(', ')} — re-run later (good chunks are cached) or pass --allow-missing-places`);
  log(`  ⚠ missing places/rivers for ${failed.join(', ')} (--allow-missing-places)`);
}
if (splits) log(`  ${splits} chunk split(s)`);
const maxKm = (pts.length - 1) * Q.stepM / 1000;
const places = [...placeHits.values()].map(({ off, ...p }) => ({ ...p, km: Math.min(maxKm, p.km) }))
  .sort((a, b) => a.km - b.km || a.name.localeCompare(b.name, 'uk'));
riverHits.sort((a, b) => a.km - b.km);
const rivers = [];
for (const r of riverHits) {
  if (!rivers.some(o => o.name === r.name && Math.abs(o.km - r.km) < 2)) rivers.push({ km: Math.min(maxKm, r.km), name: r.name });
}
log('  ' + places.length + ' places, ' + rivers.length + ' river crossings');

// ---------- 6. write ----------
const buf = Buffer.alloc(pts.length * 12);
pts.forEach((p, i) => { buf.writeFloatLE(p[0], i * 12); buf.writeFloatLE(p[1], i * 12 + 4); buf.writeFloatLE(ele[i], i * 12 + 8); });
fs.writeFileSync(path.join(OUT, 'route.bin'), buf);
fs.writeFileSync(path.join(OUT, 'horizon.bin'), Buffer.from(horizon.buffer));
const meta = {
  version: 1, built: new Date().toISOString(), quality: qName,
  from: stops[0].label, to: stops.at(-1).label, via: stops.slice(1, -1).map(s => s.label),
  lengthM: (pts.length - 1) * Q.stepM, osrmLengthM: Math.round(lengthM), stepM: Q.stepM, count: pts.length,
  stationM: Q.stationM, stations: stations.length, az: Q.az, bands: BANDS, stationEle,
  eleMin: Math.round(ele.reduce((a, b) => Math.min(a, b))), eleMax: Math.round(ele.reduce((a, b) => Math.max(a, b))),
  places, rivers,
  attribution: 'Roads, places, rivers © OpenStreetMap contributors (ODbL). Terrain: AWS Terrain Tiles (SRTM/NASA, et al.).',
};
fs.writeFileSync(path.join(OUT, 'route.json'), JSON.stringify(meta));
log(`\n✔ wrote game/data — ${(lengthM / 1000).toFixed(0)} km, elevation ${meta.eleMin}–${meta.eleMax} m, ${places.length} places, ${rivers.length} rivers\n`);
