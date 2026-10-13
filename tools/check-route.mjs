#!/usr/bin/env node
// Sanity checks for game/data (route.bin, horizon.bin, route.json). Exit code 1 on any failure.
//   node tools/check-route.mjs [--expect "Львів;Київ;Полтава;Харків"] [--river Дніпро]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'game', 'data');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const EXPECT = arg('expect', 'Львів;Київ;Полтава;Харків').split(';').filter(Boolean);
const RIVER = arg('river', 'Дніпро');

let fails = 0;
const ok = (cond, msg) => { console.log((cond ? '  ✔ ' : '  ✖ ') + msg); if (!cond) fails++; };
const rad = d => d * Math.PI / 180;
function hav(a, b) {
  const s = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(s));
}
function bearing(a, b) {
  const y = Math.sin(rad(b[1] - a[1])) * Math.cos(rad(b[0]));
  const x = Math.cos(rad(a[0])) * Math.sin(rad(b[0])) - Math.sin(rad(a[0])) * Math.cos(rad(b[0])) * Math.cos(rad(b[1] - a[1]));
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

const meta = JSON.parse(fs.readFileSync(path.join(DIR, 'route.json'), 'utf8'));
const rb = fs.readFileSync(path.join(DIR, 'route.bin'));
const hb = fs.readFileSync(path.join(DIR, 'horizon.bin'));
const nb = meta.bands.length;
const route = new Float32Array(rb.buffer, rb.byteOffset, rb.length / 4);
const hz = new Int16Array(hb.buffer.slice(hb.byteOffset, hb.byteOffset + hb.length));
const P = i => [route[i * 3], route[i * 3 + 1]];

console.log(`route.json: ${meta.from} → ${meta.via.join(' → ')}${meta.via.length ? ' → ' : ''}${meta.to}, ${(meta.lengthM / 1000).toFixed(1)} km, quality ${meta.quality}${meta.provisional ? ' (PROVISIONAL)' : ''}`);
console.log('\nsizes');
ok(rb.length === meta.count * 12, `route.bin ${rb.length} B = count ${meta.count} × 12`);
ok(hb.length === meta.stations * nb * meta.az * 2, `horizon.bin ${hb.length} B = ${meta.stations} stations × ${nb} bands × ${meta.az} az × 2`);
ok(meta.lengthM === (meta.count - 1) * meta.stepM, `lengthM ${meta.lengthM} = (count−1) × stepM`);
ok(meta.stations === Math.floor(meta.lengthM / meta.stationM) + 1 || meta.stations === Math.ceil(meta.lengthM / meta.stationM),
  `stations ${meta.stations} cover ${meta.lengthM} m every ${meta.stationM} m`);
ok(meta.stationEle.length === meta.stations, `stationEle has ${meta.stationEle.length} entries`);

console.log('\nsamples');
const gaps = new Float32Array(meta.count - 1);
let eMin = Infinity, eMax = -Infinity, outside = 0, nan = 0;
for (let i = 0; i < meta.count; i++) {
  const [la, lo] = P(i), e = route[i * 3 + 2];
  if (!Number.isFinite(la) || !Number.isFinite(lo) || !Number.isFinite(e)) { nan++; continue; }
  if (la < 44.3 || la > 52.4 || lo < 22.1 || lo > 40.3) outside++;
  if (e < eMin) eMin = e; if (e > eMax) eMax = e;
  if (i) gaps[i - 1] = hav(P(i - 1), P(i));
}
ok(nan === 0, `no NaN samples (${nan})`);
// samples are stepM apart ALONG the road: the chord is shorter at sharp corners, and Float32 lat/lon adds ±0.4 m
gaps.sort();
const pc = q => gaps[Math.min(gaps.length - 1, Math.floor(q * gaps.length))];
ok(pc(0.01) > meta.stepM * 0.95 && pc(0.99) < meta.stepM * 1.05 && gaps[0] > meta.stepM * 0.05 && gaps.at(-1) < meta.stepM * 1.1,
  `consecutive spacing p1 ${pc(0.01).toFixed(2)} / median ${pc(0.5).toFixed(2)} / p99 ${pc(0.99).toFixed(2)} m, min ${gaps[0].toFixed(2)}, max ${gaps.at(-1).toFixed(2)} ≈ ${meta.stepM} m`);
ok(outside === 0, `all lat/lon inside Ukraine bbox (${outside} outside)`);
ok(eMin > -20 && eMax < 2100, `elevation ${eMin.toFixed(0)}–${eMax.toFixed(0)} m plausible for Ukraine`);
ok(Math.round(eMin) === meta.eleMin && Math.round(eMax) === meta.eleMax, `eleMin/eleMax match route.bin`);

console.log('\nplaces & rivers');
const L = meta.lengthM / 1000;
ok(meta.places.every((p, i) => p.km >= 0 && p.km <= L && (!i || meta.places[i - 1].km <= p.km)), `${meta.places.length} places sorted, km in [0, ${L.toFixed(1)}]`);
ok(meta.places.every(p => ['city', 'town', 'village'].includes(p.type) && Number.isFinite(p.pop) && p.name), 'place types / pop / names valid');
ok(new Set(meta.places.map(p => p.name)).size === meta.places.length, 'one entry per place name');
ok(meta.rivers.every((r, i) => r.km >= 0 && r.km <= L && (!i || meta.rivers[i - 1].km <= r.km) && r.name), `${meta.rivers.length} rivers sorted, km in range`);
const bad = [...meta.places, ...meta.rivers].filter(p => /[ыэъёЫЭЪЁ]/.test(p.name));
if (bad.length) console.log(`  · ${bad.length} names contain Russian-only letters (from OSM): ${bad.slice(0, 5).map(p => p.name).join(', ')}`);
const kmOf = {};
for (const name of [meta.from, ...EXPECT]) {
  const p = meta.places.find(q => q.name === name);
  kmOf[name] = p ? p.km : null;
  ok(!!p, `${name} present${p ? ` at km ${p.km.toFixed(1)} (${p.type}, pop ${p.pop})` : ''}`);
}
const riv = meta.rivers.filter(r => r.name === RIVER);
ok(riv.length > 0, `river ${RIVER} crossed${riv.length ? ' at km ' + riv.map(r => r.km.toFixed(1)).join(', ') : ''}`);

console.log('\nhorizon');
const farMax = s => { let m = -Infinity; for (let a = 0; a < meta.az; a++) m = Math.max(m, hz[(s * nb + 2) * meta.az + a]); return m / 100; };
const carp = [], plains = [];
for (let s = 0; s < meta.stations; s++) (s * meta.stationM <= 200000 ? carp : s * meta.stationM >= 400000 ? plains : []).push(farMax(s));
const med = a => [...a].sort((x, y) => x - y)[a.length >> 1];
console.log(`  · far-band max angle: Carpathians (≤200 km) median ${med(carp).toFixed(2)}°, max ${Math.max(...carp).toFixed(2)}°; plains (≥400 km) median ${med(plains).toFixed(2)}°`);
ok(Math.max(...carp) > 2 && med(carp) > med(plains) + 0.5, 'Carpathian far ridges clearly above the plains');
ok(hz.every(v => v > -2000 && v < 4500), 'horizon angles within −20°…45°');

console.log('\nU-turns (heading flip > 150° within 300 m)');
const W = Math.max(1, Math.round(50 / meta.stepM)), GAP = Math.round(300 / meta.stepM);
const head = i => bearing(P(i), P(Math.min(meta.count - 1, i + W)));
const flips = [];
for (let i = 0; i + GAP + W < meta.count; i += W) {
  const d = Math.abs(((head(i + GAP) - head(i)) + 540) % 360 - 180);
  // a true backtrack returns over the same ground: the point 2×300 m on is close to where we started
  if (d > 150 && hav(P(i), P(Math.min(meta.count - 1, i + 2 * GAP))) < 120) {
    if (!flips.length || i * meta.stepM / 1000 - flips.at(-1) > 1) flips.push(i * meta.stepM / 1000);
  }
}
console.log(`  · ${flips.length} backtrack-like spots${flips.length ? ': km ' + flips.slice(0, 20).map(k => k.toFixed(1)).join(', ') : ''}`);
for (const v of meta.via) {
  const k = kmOf[v] ?? meta.places.find(p => p.name === v)?.km;
  if (k == null) { ok(false, `via ${v}: not found in places`); continue; }
  const near = flips.filter(f => Math.abs(f - k) < 15);
  ok(near.length === 0, `no backtrack within 15 km of via ${v} (km ${k.toFixed(1)})${near.length ? ' — at km ' + near.map(f => f.toFixed(1)).join(', ') : ''}`);
}

console.log(fails ? `\n✖ ${fails} check(s) failed` : '\n✔ all checks passed');
process.exit(fails ? 1 : 0);
