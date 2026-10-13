// Pure economy math. No DOM, no window — imported by game.js AND by tools/sim-economy.mjs in Node.
import * as B from './balance.js';

export const UPGRADE_IDS = B.UPGRADES.map(u => u.id);
export const upgradeDef = id => B.UPGRADES.find(u => u.id === id);

// ---------- vehicles ----------
// Copy B's VEHICLES with the balance overrides applied, keeping prototypes (draw may be a method).
export function applyVehicleEconomy(vehicles, table = B.VEHICLE_ECONOMY) {
  return vehicles.map(v => {
    const copy = Object.assign(Object.create(Object.getPrototypeOf(v)), v);
    const o = table[v.id];
    if (o) for (const k of ['clickM', 'autoMps', 'incomeMult', 'cost']) if (Number.isFinite(o[k])) copy[k] = o[k];
    return copy;
  });
}

// ---------- upgrades ----------
export function upgradeCost(id, level) {
  const u = upgradeDef(id);
  if (!u || level >= u.max) return Infinity;
  return Math.ceil(u.base * Math.pow(u.growth, level));
}

export function multipliers(up = {}) {
  const lv = id => Math.max(0, up[id] | 0);
  // Upgrade effect: linear (1 + add·level) when 'add' is set, otherwise compounding (mult^level).
  const m = id => { const u = upgradeDef(id); return u.add != null ? 1 + u.add * lv(id) : Math.pow(u.mult, lv(id)); };
  return {
    click: m('steer'),                                 // Кермо
    auto: m('fuel'),                                   // Пальне
    income: m('cargo'),                                // Вантаж
    helperCps: lv('helper') * upgradeDef('helper').cps // Помічник
  };
}

// All rates for a vehicle + upgrade levels. clicksPerSec = player's manual clicks (for display/sim only).
export function rates(veh, up, clicksPerSec = 0) {
  const m = multipliers(up);
  const clickM = veh.clickM * m.click;
  const autoMps = veh.autoMps * m.auto;
  const helperMps = m.helperCps * clickM;
  const incomePerM = B.INCOME_PER_M * veh.incomeMult * m.income;
  const idleMps = autoMps + helperMps;
  const mps = idleMps + clicksPerSec * clickM;
  return { clickM, autoMps, helperMps, idleMps, mps, incomePerM, incomePerS: mps * incomePerM, idleIncomePerS: idleMps * incomePerM, mult: m };
}

// ---------- bonuses ----------
export function popFactor(pop) {
  if (!(pop > 0)) return 1;
  return Math.min(B.POP_MAX, Math.max(1, 1 + Math.log10(pop / B.POP_REF) * B.POP_SLOPE));
}
export function placeBonus(place, incomePerM) {
  const base = B.PLACE_BONUS_M[place.type] ?? B.PLACE_BONUS_M.village;
  return Math.round(base * popFactor(place.pop) * incomePerM);
}
export function riverMult(name = '') {
  for (const k in B.BIG_RIVERS) if (name.includes(k)) return B.BIG_RIVERS[k];
  return 1;
}
export function riverBonus(river, incomePerM) {
  return Math.round(B.RIVER_BONUS_M * riverMult(river.name) * incomePerM);
}

// ---------- offline ----------
// elapsedS = wall-clock seconds since last save. Negative / non-finite / tiny → nothing.
export function offlineEarnings(veh, up, elapsedS) {
  if (!Number.isFinite(elapsedS) || elapsedS < B.OFFLINE.minS) return { seconds: 0, money: 0 };
  const seconds = Math.min(elapsedS, B.OFFLINE.capS);
  const r = rates(veh, up, 0);
  return { seconds, capped: elapsedS > B.OFFLINE.capS, money: Math.floor(r.idleIncomePerS * seconds * B.OFFLINE.rate) };
}

// ---------- formatting (uk-UA) ----------
const nfInt = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 0 });
const nf1 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1, minimumFractionDigits: 0 });
const nf2 = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 2, minimumFractionDigits: 0 });
const SUFFIX = [[1e12, 'трлн'], [1e9, 'млрд'], [1e6, 'млн'], [1e4, 'тис.']];
// Intl may use U+202F/U+00A0 as group separator; the pixel font and some UIs prefer a plain thin space.
const clean = s => s.replace(/[  ]/g, ' ');

export function formatNum(n) {
  if (!Number.isFinite(n)) return n > 0 ? '∞' : '—';
  const a = Math.abs(n);
  for (const [v, s] of SUFFIX) if (a >= v) {
    const x = n / (s === 'тис.' ? 1e3 : v);
    return clean((Math.abs(x) < 100 ? nf1 : nfInt).format(x)) + ' ' + s;
  }
  if (a < 10 && a % 1) return clean(nf1.format(n));
  return clean(nfInt.format(Math.floor(n)));
}
export const formatMoney = n => formatNum(n) + ' ₴';
export function formatKm(m) {
  const km = m / 1000;
  return clean((km < 10 ? nf2 : km < 100 ? nf1 : nfInt).format(km)) + ' км';
}
export function formatDuration(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, sec = s % 60;
  if (h) return `${h} год ${m} хв`;
  if (m) return `${m} хв ${sec} с`;
  return `${sec} с`;
}

// ---------- save ----------
export const SAVE_VERSION = 1;
// Save migrations: MIGRATIONS[v](raw) → raw for version v+1. Empty while only v1 exists.
export const MIGRATIONS = {};

export function newState(firstVehicleId = 'bike') {
  return {
    v: SAVE_VERSION, distM: 0, money: 0, earned: 0, clicks: 0, playS: 0,
    vehicle: firstVehicleId, owned: 1,
    up: Object.fromEntries(UPGRADE_IDS.map(id => [id, 0])),
    hints: {}, flags: {}, finished: false, route: null, savedAt: 0,
  };
}

const finNN = x => typeof x === 'number' && Number.isFinite(x) && x >= 0;

// Validate a parsed save object. Returns a clean state or null (never throws).
// opts: { vehicleIds: string[], lengthM: number, route: {from,to,lengthM} }
export function sanitizeSave(raw, opts) {
  try {
    if (!raw || typeof raw !== 'object') return null;
    for (let guard = 0; raw.v !== SAVE_VERSION && MIGRATIONS[raw.v] && guard < 20; guard++) raw = MIGRATIONS[raw.v](raw);
    if (!raw || raw.v !== SAVE_VERSION) return null;
    const s = newState(opts.vehicleIds[0]);
    for (const k of ['distM', 'money', 'earned', 'clicks', 'playS', 'savedAt']) {
      if (!finNN(raw[k])) return null;
      s[k] = raw[k];
    }
    const vi = opts.vehicleIds.indexOf(raw.vehicle);
    if (vi < 0) return null;
    s.vehicle = raw.vehicle;
    s.owned = Number.isInteger(raw.owned) && raw.owned >= vi + 1 && raw.owned <= opts.vehicleIds.length ? raw.owned : vi + 1;
    if (!raw.up || typeof raw.up !== 'object') return null;
    for (const id of UPGRADE_IDS) {
      const l = raw.up[id] ?? 0;
      if (!Number.isInteger(l) || l < 0 || l > upgradeDef(id).max) return null;
      s.up[id] = l;
    }
    for (const k of ['hints', 'flags']) if (raw[k] && typeof raw[k] === 'object')
      for (const [h, val] of Object.entries(raw[k])) if (val === true) s[k][h] = true;
    s.finished = raw.finished === true;
    s.route = raw.route && typeof raw.route === 'object' ? { from: String(raw.route.from), to: String(raw.route.to), lengthM: +raw.route.lengthM } : null;
    // Route changed → keep money & upgrades, clamp distance.
    const r = opts.route;
    s.routeChanged = !!(r && s.route && (s.route.from !== r.from || s.route.to !== r.to || s.route.lengthM !== r.lengthM));
    if (s.distM > opts.lengthM) s.distM = opts.lengthM;
    if (s.routeChanged && s.distM < opts.lengthM) s.finished = false;
    if (r) s.route = { from: r.from, to: r.to, lengthM: r.lengthM };
    return s;
  } catch { return null; }
}

// True when every number in the state is safe to write.
export function stateIsSane(s) {
  if (!s || !['distM', 'money', 'earned', 'clicks', 'playS'].every(k => finNN(s[k]))) return false;
  return UPGRADE_IDS.every(id => Number.isInteger(s.up[id]) && s.up[id] >= 0);
}
