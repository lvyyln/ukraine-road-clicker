// Tunable economy numbers. Pure data: no DOM, no window — Node imports this (tools/sim-economy.mjs).
// Tune with:  node tools/sim-economy.mjs

// ₴ earned per metre before any multiplier.
export const INCOME_PER_M = 0.1;

// Overrides {clickM, autoMps, incomeMult, cost} on B's VEHICLES (keyed by id) at load.
// clickM = metres per «Газ!» click, autoMps = auto-drive m/s, incomeMult = ₴ multiplier, cost = ₴.
export const VEHICLE_ECONOMY = {
  bike:     { clickM: 3   , autoMps: 1.5 , incomeMult: 1    , cost: 0 },
  moped:    { clickM: 3.5 , autoMps: 4.5 , incomeMult: 2.2  , cost: 200 },
  zaz965:   { clickM: 3.8 , autoMps: 7   , incomeMult: 5    , cost: 1600 },
  zaz968m:  { clickM: 4   , autoMps: 8.5 , incomeMult: 11   , cost: 9000 },
  tavria:   { clickM: 4   , autoMps: 9.5 , incomeMult: 25   , cost: 45000 },
  luaz:     { clickM: 4   , autoMps: 10  , incomeMult: 55   , cost: 2.2e5 },
  laz695:   { clickM: 4   , autoMps: 10  , incomeMult: 120  , cost: 1e6 },
  bogdan:   { clickM: 4   , autoMps: 10.5, incomeMult: 270  , cost: 5e6 },
  kraz:     { clickM: 4   , autoMps: 10.5, incomeMult: 600  , cost: 2.5e7 },
  electron: { clickM: 4   , autoMps: 11  , incomeMult: 1300 , cost: 1.3e8 },
  an2:      { clickM: 6   , autoMps: 20  , incomeMult: 3000 , cost: 9e8 },
  an225:    { clickM: 12  , autoMps: 60  , incomeMult: 8000 , cost: 1.7e9 },
};

// Upgrades: cost(level) = base × growth^level. Effect: linear 1 + add·level (speed upgrades — speed must
// stay bounded or the trip ends too fast), compounding mult^level (Вантаж), or +cps auto-clicks/s per level.
export const UPGRADES = [
  { id: 'steer', name: 'Кермо', base: 10, growth: 1.75, max: 15, add: 0.07 },
  { id: 'fuel', name: 'Пальне', base: 30, growth: 1.75, max: 15, add: 0.07 },
  { id: 'cargo', name: 'Вантаж', base: 60, growth: 1.45, max: 100, mult: 1.1 },
  { id: 'helper', name: 'Помічник', base: 150, growth: 1.85, max: 10, cps: 0.1 },
];

// Town bonus = metres-equivalent × current ₴ per metre × popularity factor.
export const PLACE_BONUS_M = { city: 2000, town: 500, village: 100 };
// popFactor = clamp(1 + log10(pop / POP_REF) * POP_SLOPE, 1, POP_MAX); pop 0 (unknown) → 1.
export const POP_REF = 2000, POP_SLOPE = 0.5, POP_MAX = 3;

export const RIVER_BONUS_M = 300;
// Rivers whose bridge pays extra (name substring → multiplier).
export const BIG_RIVERS = { 'Дніпро': 10, 'Дністер': 3, 'Десна': 2, 'Тиса': 2, 'Західний Буг': 2, 'Сіверський Донець': 2 };

// Offline: only auto income (auto-drive + Помічник), at this share, capped.
export const OFFLINE = { rate: 0.5, capS: 8 * 3600, minS: 60 };

// Clicks per second cap accepted from the player (anti-autoclicker / key repeat).
export const MAX_CPS = 15;
