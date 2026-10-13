#!/usr/bin/env node
// Headless economy simulation for «Дорога України».
//   node tools/sim-economy.mjs            active player + idle-only player
//   node tools/sim-economy.mjs --quiet    summary only
// Active player: 4 clicks/s for the first 10 min, then 2 clicks/s; buys greedily (cheapest affordable first).
// Idle player: no clicks at all, same buying rule. 1 s steps. Reads game/data/route.json for length/places/rivers.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = p => import(pathToFileURL(path.join(ROOT, p)).href);
const E = await imp('game/js/economy.js');
const B = await imp('game/js/balance.js');
const quiet = process.argv.includes('--quiet');

const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'game/data/route.json'), 'utf8'));
const lengthM = meta.lengthM;
const places = (meta.places || []).slice().sort((a, b) => a.km - b.km);
const rivers = (meta.rivers || []).slice().sort((a, b) => a.km - b.km);

// Vehicle order: from vehicles.js if it imports cleanly, otherwise balance.js key order.
let ids = Object.keys(B.VEHICLE_ECONOMY), names = {};
try {
  const V = await imp('game/js/vehicles.js');
  if (Array.isArray(V.VEHICLES) && V.VEHICLES.length) { ids = V.VEHICLES.map(v => v.id); for (const v of V.VEHICLES) names[v.id] = v.name; }
} catch (e) { console.log('(vehicles.js not importable: ' + e.message + ' — using balance.js order)'); }
const vehicles = ids.map(id => ({ id, name: names[id] || id, ...B.VEHICLE_ECONOMY[id] }));

// Cities to time: real km from route.json when present, otherwise rough estimates.
const CITY_NAMES = ['Мукачево', 'Стрий', 'Львів', 'Рівне', 'Житомир', 'Київ', 'Полтава', 'Харків'];
const cities = [];
for (const n of CITY_NAMES) {
  const p = places.find(p => p.name === n);
  if (p) cities.push({ name: n, m: p.km * 1000 });
}
if (!cities.some(c => c.name === 'Львів')) cities.push({ name: 'Львів (≈260 км, оцінка)', m: 260000 });
cities.push({ name: 'Фініш ' + meta.to, m: lengthM });
cities.sort((a, b) => a.m - b.m);

const fmtT = s => s == null ? '—' : `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function simulate(cpsAt, label, maxS = 30 * 3600) {
  const st = { distM: 0, money: 0, vi: 0, up: Object.fromEntries(E.UPGRADE_IDS.map(id => [id, 0])) };
  const log = { cities: {}, vehicles: { [vehicles[0].id]: 0 }, upgrades: [], incomeAt: [], km100: {}, bonus: 0, firstUpgrade: null };
  // like the game: places/rivers at the start position (km 0 = the start city) pay nothing
  let pi = places.findIndex(p => p.km > 0), ri = rivers.findIndex(r => r.km > 0), t = 0;
  if (pi < 0) pi = places.length; if (ri < 0) ri = rivers.length;
  for (; t < maxS && st.distM < lengthM; t++) {
    const veh = vehicles[st.vi];
    const r = E.rates(veh, st.up, cpsAt(t));
    const prev = st.distM;
    st.distM = Math.min(lengthM, st.distM + r.mps);
    st.money += (st.distM - prev) * r.incomePerM;
    while (pi < places.length && places[pi].km * 1000 <= st.distM) { const b = E.placeBonus(places[pi++], r.incomePerM); st.money += b; log.bonus += b; }
    while (ri < rivers.length && rivers[ri].km * 1000 <= st.distM) { const b = E.riverBonus(rivers[ri++], r.incomePerM); st.money += b; log.bonus += b; }
    for (const c of cities) if (log.cities[c.name] == null && st.distM >= c.m) log.cities[c.name] = t + 1;
    const k = Math.floor(st.distM / 100000) * 100;
    if (k && log.km100[k] == null) log.km100[k] = t + 1;
    if (t % 1800 === 0) log.incomeAt.push([t, r.incomePerS, r.mps, st.distM]);
    // greedy: buy the cheapest affordable thing, repeat
    for (;;) {
      const opts = E.UPGRADE_IDS.map(id => ({ kind: 'up', id, cost: E.upgradeCost(id, st.up[id]) }));
      if (st.vi + 1 < vehicles.length) opts.push({ kind: 'veh', cost: vehicles[st.vi + 1].cost });
      opts.sort((a, b) => a.cost - b.cost);
      const o = opts[0];
      if (!(o.cost <= st.money)) break;
      st.money -= o.cost;
      if (o.kind === 'veh') { st.vi++; log.vehicles[vehicles[st.vi].id] = t + 1; }
      else { st.up[o.id]++; log.upgrades.push([t + 1, o.id, st.up[o.id]]); if (log.firstUpgrade == null) log.firstUpgrade = t + 1; }
    }
  }
  log.end = t; log.final = st;
  return log;
}

function report(log, label) {
  console.log(`\n================ ${label} ================`);
  console.log(`first upgrade bought at ${fmtT(log.firstUpgrade)}   (town/river bonuses total ${E.formatMoney(log.bonus)})`);
  console.log('\nCity / milestone            km      time');
  for (const c of cities) console.log(`  ${c.name.padEnd(26)}${String(Math.round(c.m / 1000)).padStart(5)}   ${fmtT(log.cities[c.name])}`);
  if (!quiet) {
    console.log('\nEvery 100 km: ' + Object.entries(log.km100).map(([k, t]) => `${k}:${fmtT(t)}`).join('  '));
  }
  console.log('\nVehicle                              cost        bought');
  for (const v of vehicles) console.log(`  ${v.name.padEnd(36)}${E.formatMoney(v.cost).padStart(12)}   ${fmtT(log.vehicles[v.id])}`);
  console.log('\nUpgrade levels reached (time of level 1/5/10/15/20/25/30/40):');
  for (const id of E.UPGRADE_IDS) {
    const at = lv => { const u = log.upgrades.find(([, i, l]) => i === id && l === lv); return u ? fmtT(u[0]) : '—'; };
    console.log(`  ${E.upgradeDef(id).name.padEnd(10)} ` + [1, 5, 10, 15, 20, 25, 30, 40].map(l => `L${l} ${at(l)}`).join('  ') + `   final L${log.final.up[id]}`);
  }
  if (!quiet) {
    console.log('\n  time      ₴/s          m/s      km');
    for (const [t, inc, mps, d] of log.incomeAt) console.log(`  ${fmtT(t)}  ${E.formatMoney(inc).padStart(12)}  ${mps.toFixed(1).padStart(7)}  ${(d / 1000).toFixed(0).padStart(5)}`);
  }
  console.log(`\nfinished: ${log.final.distM >= lengthM ? 'yes at ' + fmtT(log.end) : 'NO (stopped at ' + fmtT(log.end) + ', km ' + (log.final.distM / 1000).toFixed(0) + ')'}`);
}

console.log(`Route ${meta.from} → ${meta.to}: ${(lengthM / 1000).toFixed(0)} km, ${places.length} places, ${rivers.length} rivers${meta.provisional ? ' (PROVISIONAL)' : ''}`);
report(simulate(t => (t < 600 ? 4 : 2), 'active'), 'ACTIVE (4 cps first 10 min, then 2 cps)');
report(simulate(() => 0, 'idle', 60 * 3600), 'IDLE ONLY (no clicks)');
