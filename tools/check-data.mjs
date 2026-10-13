#!/usr/bin/env node
// Sanity checks for game/data via game/js/data.js (the same module the browser uses).
// usage: node tools/check-data.mjs [--base http://localhost:8081/data/]
// Needs a running server: node tools/serve.mjs --port 8081
import { loadData } from '../game/js/data.js';

const i = process.argv.indexOf('--base');
const base = i > 0 ? process.argv[i + 1] : 'http://localhost:8081/data/';
let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✔ ' : '  ✘ ') + msg); if (!cond) fails++; };

const t0 = Date.now();
const d = await loadData(base);
const M = d.meta;
console.log(`loaded ${base} in ${Date.now() - t0} ms: ${M.from} → ${M.to}${M.via && M.via.length ? ' via ' + M.via.join(', ') : ''}, ` +
  `${(d.lengthM / 1000).toFixed(1)} km, ${M.count} samples, ${M.stations} stations${M.provisional ? ' (PROVISIONAL)' : ''}`);

ok(d.lengthM > 1000 && Number.isFinite(d.lengthM), 'lengthM finite and > 1 km');
ok(Math.abs((M.count - 1) * M.stepM - d.lengthM) < M.stepM * 2 + 1000, 'count*stepM ≈ lengthM');

// pointAt over the whole route
let badHead = 0, badGrade = 0, maxGrade = 0, badEle = 0;
for (let m = 0; m <= d.lengthM; m += 250) {
  const p = d.pointAt(m);
  if (!(p.heading >= 0 && p.heading < 360)) badHead++;
  if (!Number.isFinite(p.grade) || Math.abs(p.grade) > 0.25) badGrade++;
  maxGrade = Math.max(maxGrade, Math.abs(p.grade));
  if (!(p.ele > -50 && p.ele < 2100) || !(p.lat > 44 && p.lat < 53) || !(p.lon > 22 && p.lon < 41)) badEle++;
}
ok(badHead === 0, `heading in [0,360) everywhere (${badHead} bad)`);
ok(badGrade === 0, `grade plausible (|g| ≤ 25%), max ${(maxGrade * 100).toFixed(1)}%`);
ok(badEle === 0, `lat/lon inside Ukraine, ele plausible (${badEle} bad)`);
const p0 = d.pointAt(-100), pE = d.pointAt(d.lengthM + 1e6);
ok(Number.isFinite(p0.lat) && Number.isFinite(pE.lat), 'pointAt clamps out-of-range m');

// horizon: Carpathians (first ~200 km) vs plains near Poltava (lon 34–35)
function farMean(m) { let s = 0; for (let b = 0; b < 360; b += 2) s += d.horizonAt(m, b, 2); return s / 180; }
function farMax(m) { let s = -99; for (let b = 0; b < 360; b += 2) s = Math.max(s, d.horizonAt(m, b, 2)); return s; }
let carp = -99, carpKm = 0;
for (let m = 0; m <= Math.min(200000, d.lengthM); m += 5000) { const v = farMax(m); if (v > carp) { carp = v; carpKm = m / 1000; } }
let poltM = -1;
for (let m = 0; m <= d.lengthM; m += 2000) { const p = d.pointAt(m); if (p.lon > 34.2 && p.lon < 34.9 && p.lat > 49.3 && p.lat < 49.8) { poltM = m; break; } }
if (poltM < 0) poltM = d.lengthM * 0.85;
const plains = farMax(poltM);
console.log(`  far-band max: Carpathians ${carp.toFixed(2)}° @ km ${carpKm}, plains ${plains.toFixed(2)}° @ km ${(poltM / 1000).toFixed(0)} (mean ${farMean(poltM).toFixed(2)}°)`);
ok(carp > plains + 1, 'Carpathian horizon clearly higher than the Poltava plains');
let badH = 0;
for (let k = 0; k < 2000; k++) {
  const v = d.horizonAt(Math.random() * d.lengthM * 1.1 - 1000, Math.random() * 1080 - 360, (Math.random() * 4 | 0) - 0);
  if (!Number.isFinite(v) || v < -6 || v > 45) badH++;
}
ok(badH === 0, `horizonAt finite in [-6°,45°] for random/out-of-range args (${badH} bad)`);
ok(Math.abs(d.horizonAt(50000, 0, 1) - d.horizonAt(50000, 359.999, 1)) < 1, 'azimuth wraps at 0/360');

// places / rivers (may be empty on provisional data)
const pl = M.places || [], rv = M.rivers || [];
console.log(`  ${pl.length} places, ${rv.length} rivers`);
ok(Array.isArray(d.placesNear(1000)) && Array.isArray(d.riversNear(1000)), 'placesNear/riversNear return arrays');
const np = d.nextPlace(0);
ok(pl.length ? np && np.dM > 0 : np === null, 'nextPlace(0) consistent with places list');
if (pl.length) {
  const mid = pl[pl.length >> 1];
  const near = d.placesNear(mid.km * 1000 + 100, 5000);
  ok(near.length > 0 && near.every((p, k) => k === 0 || Math.abs(near[k - 1].dM) <= Math.abs(p.dM)), 'placesNear sorted by |dM|');
  ok(pl.every((p, k) => k === 0 || pl[k - 1].km <= p.km), 'places sorted by km');
  const big = pl.filter(p => p.type === 'city').map(p => p.name);
  console.log('  cities: ' + big.join(', '));
  const kyiv = d.riversNear(pl.find(p => /Київ/.test(p.name))?.km * 1000 || -1e9, 30000);
  if (pl.some(p => /Київ/.test(p.name))) ok(kyiv.some(r => /Дніпро/.test(r.name)), 'Dnipro crossing near Kyiv');
}
const ll = d.latlngs(500);
ok(ll.length > 10 && ll.every(p => p.length === 2), `latlngs(500) → ${ll.length} points`);

// hot-path timing
const t1 = performance.now();
let acc = 0;
for (let k = 0; k < 384 * 3 * 100; k++) acc += d.horizonAt(123456 + k, k * 0.15, k % 3);
console.log(`  horizonAt: ${((performance.now() - t1) / 100).toFixed(2)} ms per 1152 calls (one frame)`);

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
