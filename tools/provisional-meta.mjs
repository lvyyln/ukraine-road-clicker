#!/usr/bin/env node
// Derives a provisional game/data/route.json from an existing route.bin + horizon.bin
// (no network). Used to unblock the game while the full build (places/rivers) runs.
//   node tools/provisional-meta.mjs [--from Ужгород] [--to Харків] [--quality ultra]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'game', 'data');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const STEP_M = 10, STATION_M = 10000, AZ = 720;
const BANDS = [[150, 3000], [3000, 10000], [10000, 30500]];

const route = fs.readFileSync(path.join(OUT, 'route.bin'));
const horizon = fs.readFileSync(path.join(OUT, 'horizon.bin'));
if (route.length % 12) throw new Error('route.bin size is not a multiple of 12');
if (horizon.length % (BANDS.length * AZ * 2)) throw new Error('horizon.bin size does not match 3 bands × 720 az');
const count = route.length / 12;
const stations = horizon.length / (BANDS.length * AZ * 2);
const lengthM = (count - 1) * STEP_M;

let eleMin = Infinity, eleMax = -Infinity;
for (let i = 0; i < count; i++) {
  const e = route.readFloatLE(i * 12 + 8);
  if (e < eleMin) eleMin = e;
  if (e > eleMax) eleMax = e;
}
const stationEle = [];
for (let s = 0; s < stations; s++) {
  const i = Math.min(count - 1, Math.round(s * STATION_M / STEP_M));
  stationEle.push(Math.round(route.readFloatLE(i * 12 + 8)));
}

const meta = {
  version: 1, built: new Date().toISOString(), quality: arg('quality', 'ultra'),
  from: arg('from', 'Ужгород'), to: arg('to', 'Харків'), via: [],
  lengthM, stepM: STEP_M, count, stationM: STATION_M, stations, az: AZ, bands: BANDS, stationEle,
  eleMin: Math.round(eleMin), eleMax: Math.round(eleMax),
  places: [], rivers: [],
  attribution: 'Roads, places, rivers © OpenStreetMap contributors (ODbL). Terrain: AWS Terrain Tiles (SRTM/NASA, et al.).',
  provisional: true,
};
fs.writeFileSync(path.join(OUT, 'route.json'), JSON.stringify(meta));
console.log(`✔ provisional route.json — ${(lengthM / 1000).toFixed(1)} km, ${count} samples, ${stations} stations, ele ${meta.eleMin}–${meta.eleMax} m`);
