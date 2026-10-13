// game.js (agent C) — clicker gameplay, HUD, save, integration of data/scene/vehicles/map.
// Vanilla ES module, no build step. All asset URLs are relative (works from itch.io's iframe / any sub-path).

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SAVE_KEY = 'ukraineRoad.save.v1', BAK_KEY = SAVE_KEY + '.bak';

// ---------------------------------------------------------------- fatal / soft errors
function fatal(title, detail) {
  const box = $('fatal');
  if (!box) { document.body.textContent = title + ' ' + (detail || ''); return; }
  box.hidden = false;
  box.querySelector('h2').textContent = title;
  box.querySelector('pre').textContent = String(detail || '');
}
let softErrShown = false;
function softError(msg) {
  console.error(msg);
  if (softErrShown) return;
  softErrShown = true;
  try { toast('⚠ Помилка в грі: ' + String(msg).slice(0, 140), 'warn', 6000); } catch { /* ignore */ }
}
window.addEventListener('error', e => softError(e.message || e.error));
window.addEventListener('unhandledrejection', e => softError(e.reason && (e.reason.message || e.reason)));

// ---------------------------------------------------------------- module loading (defensive)
async function tryImport(path) {
  try { return { mod: await import(path) }; } catch (e) { console.error('import ' + path, e); return { err: e }; }
}
const [mData, mScene, mVeh, mMap, mEco, mBal] = await Promise.all(
  ['./data.js', './scene.js', './vehicles.js', './map.js', './economy.js', './balance.js'].map(tryImport));

if (mEco.err || mBal.err) {
  fatal('Не вдалося завантажити економіку гри', (mEco.err || mBal.err).message);
  throw mEco.err || mBal.err;
}
if (mData.err) {
  fatal('Не вдалося завантажити модуль data.js', mData.err.message);
  throw mData.err;
}
const E = mEco.mod, BAL = mBal.mod;

let data;
try {
  $('loading-text').textContent = 'Завантажую дорогу…';
  data = await mData.mod.loadData('data/');
  if (!data || !(data.lengthM > 0)) throw new Error('порожні дані маршруту');
} catch (e) {
  fatal('Не вдалося завантажити маршрут (data/route.json, route.bin, horizon.bin)', e && e.message);
  throw e;
}
const meta = data.meta || {};

// ---------------------------------------------------------------- vehicles
function fallbackVehicles() {
  const cols = ['#3a6', '#c33', '#6ac', '#c84', '#d44', '#786', '#da3', '#ec2', '#574', '#26c', '#9a8', '#ddd'];
  return Object.keys(BAL.VEHICLE_ECONOMY).map((id, i) => ({
    id, name: id, blurb: '', flies: id === 'an2' || id === 'an225', flyAltPx: id === 'an225' ? 60 : id === 'an2' ? 24 : 0,
    w: 24, h: 12, ...BAL.VEHICLE_ECONOMY[id],
    draw(ctx, x, y) { ctx.fillStyle = cols[i % cols.length]; ctx.fillRect(x - 12, y - 12, 24, 12); },
  }));
}
let baseVehicles = mVeh.mod && Array.isArray(mVeh.mod.VEHICLES) && mVeh.mod.VEHICLES.length ? mVeh.mod.VEHICLES : null;
if (!baseVehicles) { console.error('vehicles.js missing — using placeholder vehicles'); baseVehicles = fallbackVehicles(); }
const VEH = E.applyVehicleEconomy(baseVehicles);
const VIDS = VEH.map(v => v.id);

// ---------------------------------------------------------------- route facts
const lengthM = data.lengthM;
const places = (meta.places || []).filter(p => p && Number.isFinite(p.km) && p.name).slice().sort((a, b) => a.km - b.km);
const rivers = (meta.rivers || []).filter(r => r && Number.isFinite(r.km) && r.name).slice().sort((a, b) => a.km - b.km);
const routeId = { from: String(meta.from || ''), to: String(meta.to || ''), lengthM: Math.round(lengthM) };
const GENITIVE = { 'Львів': 'Львова', 'Київ': 'Києва', 'Харків': 'Харкова', 'Ужгород': 'Ужгорода', 'Рівне': 'Рівного',
  'Житомир': 'Житомира', 'Полтава': 'Полтави', 'Мукачево': 'Мукачева', 'Стрий': 'Стрия' };
const BIG_CITIES = ['Львів', 'Київ', 'Харків'];
const cityEvents = BIG_CITIES.map(n => places.find(p => p.name === n)).filter(Boolean)
  .map(p => ({ m: Math.max(0, p.km * 1000 - 4000), name: p.name }));
// first mountains + highest point (scan the road at 100 m)
let mtnM = null, topM = null;
{
  let best = -Infinity;
  for (let m = 0; m <= lengthM; m += 100) {
    let e;
    try { e = data.pointAt(m).ele; } catch { break; }
    if (!Number.isFinite(e)) continue;
    if (mtnM == null && e >= 450) mtnM = m;
    if (e > best) { best = e; topM = m; }
  }
  if (meta.eleMax != null && best < 300) topM = null;      // a flat route has no "summit"
}

// ---------------------------------------------------------------- state & save
const noSave = params.has('nosave') || params.has('km');
let storageOk = true;
function lsGet(k) { try { return localStorage.getItem(k); } catch { storageOk = false; return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch { storageOk = false; return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }

const sanitizeOpts = { vehicleIds: VIDS, lengthM, route: routeId };
function parseSave(str) {
  if (!str) return null;
  try { return E.sanitizeSave(JSON.parse(str), sanitizeOpts); } catch { return null; }
}

let state, loadNote = null;
if (noSave) {
  state = E.newState(VIDS[0]);
} else {
  const mainStr = lsGet(SAVE_KEY);
  state = parseSave(mainStr);
  if (state) lsSet(BAK_KEY, mainStr);                      // last-good backup
  else {
    const bak = parseSave(lsGet(BAK_KEY));
    if (bak) { state = bak; if (mainStr) loadNote = 'Збереження пошкоджене — відновлено резервну копію.'; }
    else { state = E.newState(VIDS[0]); if (mainStr) loadNote = 'Збереження пошкоджене — починаємо нову подорож.'; }
  }
  // Keep the unreadable save once (e.g. a future version) so a later release can still migrate it.
  if (mainStr && !parseSave(mainStr) && lsGet(SAVE_KEY + '.corrupt') == null) lsSet(SAVE_KEY + '.corrupt', mainStr);
}
state.route = routeId;
if (params.has('km')) state.distM = Math.min(lengthM, Math.max(0, (+params.get('km') || 0) * 1000));
const offlineFrom = state.savedAt;

let resetting = false;
function save() {
  if (noSave || resetting) return;
  state.savedAt = Math.max(state.savedAt, Date.now());   // never moves back: winding the clock back and forth pays once
  if (!E.stateIsSane(state)) { console.error('state not sane — not saving', state); return; }
  const prev = lsGet(SAVE_KEY);
  if (prev && parseSave(prev)) lsSet(BAK_KEY, prev);
  const { routeChanged, ...out } = state;
  lsSet(SAVE_KEY, JSON.stringify(out));
}

const veh = () => VEH[Math.min(VEH.length, Math.max(1, state.owned)) - 1];
state.vehicle = veh().id;

// ---------------------------------------------------------------- DOM refs
const canvas = $('scene');
const ctx2d = canvas.getContext('2d');
ctx2d.imageSmoothingEnabled = false;
const mm = $('minimap');
const flyUi = $('fly-ui');
const S = {
  km: $('s-km'), kmTot: $('s-kmtot'), next: $('s-next'), nextD: $('s-nextd'), ele: $('s-ele'),
  money: $('s-money'), rate: $('s-rate'), speed: $('s-speed'), veh: $('s-veh'),
};
const setText = (el, t) => { if (el && el.textContent !== t) el.textContent = t; };
$('attrib').textContent = (meta.attribution || 'Дороги © учасники OpenStreetMap.') + '  ·  Маршрут: ' +
  [meta.from, ...(meta.via || []), meta.to].filter(Boolean).join(' → ');

// ---------------------------------------------------------------- sound (starts only after first user gesture)
const sound = {
  ac: null, get muted() { return !!state.flags.muted; },
  unlock() {
    if (this.ac) { if (this.ac.state === 'suspended') this.ac.resume().catch(() => {}); return; }
    try { const AC = window.AudioContext || window.webkitAudioContext; if (AC) this.ac = new AC(); } catch { this.ac = null; }
  },
  tone(freq, dur, type = 'square', vol = 0.03, delay = 0) {
    if (this.muted || !this.ac || this.ac.state !== 'running') return;
    const t0 = this.ac.currentTime + delay, o = this.ac.createOscillator(), g = this.ac.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(vol, t0); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.ac.destination); o.start(t0); o.stop(t0 + dur + 0.02);
  },
  click() { this.tone(180 + Math.random() * 40, 0.05, 'square', 0.02); },
  coin() { this.tone(988, 0.08, 'square', 0.03); this.tone(1319, 0.16, 'square', 0.03, 0.07); },
  buy() { [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.12, 'triangle', 0.05, i * 0.07)); },
};
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, () => sound.unlock(), { capture: true, passive: true });
function syncSoundBtn() {
  const b = $('btn-sound');
  b.textContent = sound.muted ? '🔇' : '🔊';
  b.setAttribute('aria-pressed', String(!sound.muted));
}

// ---------------------------------------------------------------- toasts, pops, hints
function toast(text, kind = '', ms = 3500) {
  const box = $('toasts');
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = text;
  box.appendChild(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, ms);
}
let popCount = 0;
function pop(text, kind = '') {
  if (popCount > 10) return;
  const p = document.createElement('div');
  p.className = 'pop ' + kind;
  p.textContent = text;
  p.style.left = (25 + Math.random() * 50) + '%';
  $('stage').appendChild(p);
  popCount++;
  setTimeout(() => { p.remove(); popCount--; }, 800);
}

const HINTS = {
  start: 'Тисни «Газ!», Пробіл або торкайся картинки, щоб їхати. Кожен метр дороги приносить ₴.',
  upgrade: 'Тобі вистачає на покращення! Купи його в розділі «Покращення» — і їхатимеш швидше.',
  vehicle: 'Можна купити новий транспорт! Він швидший і більше заробляє за кожен метр.',
  town: 'За кожне місто, село й міст через річку на шляху ти отримуєш бонус ₴.',
};
const hintQueue = [];
function hint(id, extra) {
  if (state.hints[id] || hintQueue.some(h => h.id === id)) return;
  state.hints[id] = true;
  hintQueue.push({ id, text: extra ? extra + ' ' + HINTS[id] : HINTS[id] });
  if (hintQueue.length === 1) showHint();
}
function showHint() {
  const h = hintQueue[0], box = $('hint');
  $('stage').classList.toggle('hinting', !!h);
  if (!h) { box.hidden = true; return; }
  box.querySelector('.hint-text').textContent = h.text;
  box.hidden = false;
}
$('hint-ok').addEventListener('click', e => { e.stopPropagation(); hintQueue.shift(); showHint(); });

// ---------------------------------------------------------------- tooltips (hover + long-press / tap)
const tip = $('tooltip');
let tipFor = null, lpTimer = 0, suppressClick = null;
function tipText(el) { return typeof el._tip === 'function' ? el._tip() : el.dataset.tip; }
function showTip(el) {
  const t = tipText(el);
  if (!t) return;
  tip.textContent = t;
  tip.hidden = false;
  tipFor = el;
  const r = el.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
  let x = r.left + r.width / 2 - tw / 2, y = r.top - th - 8;
  if (y < 4) y = r.bottom + 8;
  x = Math.max(4, Math.min(window.innerWidth - tw - 4, x));
  y = Math.max(4, Math.min(window.innerHeight - th - 4, y));
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function hideTip() { tip.hidden = true; tipFor = null; }
const tipTarget = e => e.target instanceof Element ? e.target.closest('[data-tip]') : null;
document.addEventListener('pointerover', e => {
  if (e.pointerType !== 'mouse') return;
  const el = tipTarget(e);
  if (el && el !== tipFor) showTip(el); else if (!el && tipFor) hideTip();
});
document.addEventListener('pointerdown', e => {
  const el = tipTarget(e);
  if (e.pointerType === 'mouse') { if (!el) hideTip(); return; }
  clearTimeout(lpTimer);
  if (!el) { hideTip(); return; }
  const interactive = el.matches('button, a, input, .tap-action');
  if (!interactive) { if (tipFor === el) hideTip(); else showTip(el); return; }     // tap a stat → tip
  lpTimer = setTimeout(() => { showTip(el); suppressClick = el; }, 450);          // long-press a button → tip
}, true);
for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) document.addEventListener(ev, () => clearTimeout(lpTimer), true);
document.addEventListener('click', e => {
  if (suppressClick && e.target instanceof Element && suppressClick.contains(e.target)) { e.preventDefault(); e.stopPropagation(); }
  suppressClick = null;
}, true);
document.addEventListener('contextmenu', e => { if (tipTarget(e) && e.pointerType !== 'mouse') e.preventDefault(); });
window.addEventListener('scroll', hideTip, { passive: true, capture: true });
function refreshTip() { if (tipFor && !tip.hidden) { const t = tipText(tipFor); if (t !== tip.textContent) showTip(tipFor); } }

// ---------------------------------------------------------------- modal
function modal(title, buildBody, actions = [{ label: 'Гаразд' }]) {
  const m = $('modal');
  $('modal-title').textContent = title;
  const body = $('modal-body'); body.textContent = '';
  buildBody(body);
  const act = $('modal-actions'); act.textContent = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '');
    b.textContent = a.label;
    b.addEventListener('click', () => { closeModal(); if (a.onClick) a.onClick(); });
    act.appendChild(b);
  }
  m.hidden = false;
  (act.querySelector('.primary') || act.firstChild)?.focus();
}
function closeModal() { $('modal').hidden = true; }
$('modal').addEventListener('click', e => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('modal').hidden) { e.preventDefault(); closeModal(); } });
const para = (parent, text, cls) => { const p = document.createElement('p'); p.textContent = text; if (cls) p.className = cls; parent.appendChild(p); return p; };

const fmtM = E.formatMoney, fmtN = E.formatNum;
const fmtF = (x, d = 1) => fmtN(Math.round(x * 10 ** d) / 10 ** d);

function showHelp() {
  modal('Як грати', body => {
    const items = [
      ['🎯 Мета', `Проїхати справжньою дорогою ${meta.from || ''} → ${meta.to || ''} (${E.formatKm(lengthM)}) по OpenStreetMap, зі справжніми горами на горизонті.`],
      ['👆 Газ!', 'Кожен клік (або Пробіл, або дотик до картинки) проїжджає кілька метрів.'],
      ['🚗 Автопілот', 'Транспорт їде і сам — навіть коли ти не клікаєш.'],
      ['₴ Гривні', 'Кожен проїханий метр приносить ₴. Скільки — залежить від транспорту і «Вантажу».'],
      ['🏎 Кермо', 'Більше метрів за кожен клік.'],
      ['⛽ Пальне', 'Швидший автопілот.'],
      ['📦 Вантаж', 'Більше ₴ за кожен метр (множник).'],
      ['👷 Помічник', 'Сам натискає «Газ!» кілька разів за секунду.'],
      ['🚌 Транспорт', 'Купуй наступну машину: швидша і прибутковіша. Наприкінці — літаки Ан-2 та «Мрія».'],
      ['🏘 Бонуси', 'Кожне місто, село і міст через річку на шляху дають бонус ₴. Великі міста — більший.'],
      ['🌙 Поки тебе нема', 'Автопілот заробляє і без тебе (половину, до 8 годин).'],
      ['🗺 Мапа і Проліт', '«Мапа» показує маршрут на справжній мапі, «Проліт» — швидко переглянути всю дорогу. Заробіток іде далі.'],
      ['💡 Підказки', 'Наведи мишку або торкнись будь-якого числа чи кнопки (на телефоні — утримуй кнопку).'],
    ];
    const ul = document.createElement('ul'); ul.className = 'help-list';
    for (const [h, t] of items) {
      const li = document.createElement('li');
      const b = document.createElement('b'); b.textContent = h + ' ';
      li.appendChild(b); li.appendChild(document.createTextNode(t));
      ul.appendChild(li);
    }
    body.appendChild(ul);
    para(body, 'Прогрес зберігається в цьому браузері автоматично.' + (storageOk ? '' : ' (Зараз сховище недоступне — прогрес не збережеться.)'), 'muted');
  }, [{ label: 'Поїхали!', primary: true }]);
}

// ---------------------------------------------------------------- economy runtime
let clickQueue = 0, clickTimes = [], speedEma = 0, incomeEma = 0, sessionClicks = 0;
let curRates = E.rates(veh(), state.up, 0);
function recalc() { curRates = E.rates(veh(), state.up, 0); }

function gas() {
  if (fly && fly.isActive()) return;
  const now = performance.now();
  while (clickTimes.length && now - clickTimes[0] > 1000) clickTimes.shift();
  if (clickTimes.length >= BAL.MAX_CPS) return;
  clickTimes.push(now);
  if (state.distM >= lengthM) return;
  clickQueue += curRates.clickM;
  state.clicks++; sessionClicks++;
  sound.click();
  pop('+' + fmtF(curRates.clickM) + ' м');
  const g = $('gas'); g.classList.remove('bump'); void g.offsetWidth; g.classList.add('bump');
  if (hintQueue[0] && hintQueue[0].id === 'start' && state.clicks >= 5) { hintQueue.shift(); showHint(); }
}

function pay(amount) {
  if (!(amount > 0) || !Number.isFinite(amount)) return;
  state.money += amount; state.earned += amount;
}

let finishShown = false;
function advance(dt) {
  if (state.distM >= lengthM) { speedEma = 0; incomeEma *= 0.9; return; }
  const drain = clickQueue > 0.01 ? clickQueue * Math.min(1, dt * 12) : clickQueue;
  clickQueue -= drain;
  const prev = state.distM;
  const next = Math.min(lengthM, prev + curRates.idleMps * dt + drain);
  const dm = next - prev;
  state.distM = next;
  const inc = dm * curRates.incomePerM;
  pay(inc);
  const k = 1 - Math.exp(-dt / 1.5);
  speedEma += (dm / Math.max(dt, 1e-3) - speedEma) * k;
  incomeEma += (inc / Math.max(dt, 1e-3) - incomeEma) * k;
  crossings(prev, next);
  if (next >= lengthM) finish();
}

let pi = 0, ri = 0;
function syncPointers() {
  pi = places.findIndex(p => p.km * 1000 > state.distM); if (pi < 0) pi = places.length;
  ri = rivers.findIndex(r => r.km * 1000 > state.distM); if (ri < 0) ri = rivers.length;
}
syncPointers();
let lastTownToast = 0;
function crossings(a, b) {
  const ipm = curRates.incomePerM;
  while (pi < places.length && places[pi].km * 1000 <= b) {
    const p = places[pi++];
    const bonus = E.placeBonus(p, ipm);
    pay(bonus);
    if (p.type === 'village' && performance.now() - lastTownToast < 4000) pop('+' + fmtM(bonus), 'gold');
    else {
      lastTownToast = performance.now();
      const kind = p.type === 'city' ? 'Місто' : p.type === 'town' ? 'Містечко' : 'Село';
      toast(`${kind} ${p.name}: +${fmtM(bonus)}`, 'gold');
      sound.coin();
    }
    hint('town', 'Ти проїхав ' + p.name + '!');
  }
  while (ri < rivers.length && rivers[ri].km * 1000 <= b) {
    const r = rivers[ri++];
    const bonus = E.riverBonus(r, ipm);
    pay(bonus);
    toast(`Міст через ${r.name}: +${fmtM(bonus)}`, 'blue');
    sound.coin();
  }
  const crossed = m => m != null && a < m && b >= m;
  for (let km = Math.floor(a / 100000) + 1; km * 100000 <= b; km++) toast(`${km * 100} км позаду! 🎉`, 'green');
  if (crossed(mtnM)) toast('Перші гори! Дорога йде вгору — Карпати ⛰', 'green', 5000);
  if (crossed(topM)) toast(`Найвища точка маршруту: ${Math.round(data.pointAt(topM).ele)} м над морем! 🏔`, 'green', 5000);
  for (const c of cityEvents) if (crossed(c.m)) toast(`Ласкаво просимо до ${GENITIVE[c.name] || c.name}! 🏙`, 'gold', 5000);
}

function finish() {
  if (state.finished && finishShown) return;
  const first = !state.finished;
  state.finished = true;
  finishShown = true;
  if (first) { sound.buy(); save(); }
  showFinish();
}
function showFinish() {
  modal('🏁 Фініш! Ти доїхав до ' + (GENITIVE[meta.to] || meta.to || 'кінця'), body => {
    para(body, `Маршрут ${[meta.from, ...(meta.via || []), meta.to].filter(Boolean).join(' → ')} пройдено!`);
    const dl = document.createElement('dl'); dl.className = 'stats';
    const row = (k, v) => { const dt = document.createElement('dt'); dt.textContent = k; const dd = document.createElement('dd'); dd.textContent = v; dl.append(dt, dd); };
    row('Відстань', E.formatKm(lengthM));
    row('Час у грі', E.formatDuration(state.playS));
    row('Зароблено всього', fmtM(state.earned));
    row('Кліків «Газ!»', fmtN(state.clicks));
    row('Транспорт', veh().name);
    body.appendChild(dl);
    para(body, 'Можна пролетіти маршрутом ще раз і роздивитися краєвиди або почати подорож спочатку.', 'muted');
  }, [
    ...(fly ? [{ label: 'Проліт маршрутом', primary: true, onClick: () => startFly(0) }] : []),
    { label: 'Почати знову', danger: true, onClick: askReset },
    { label: 'Закрити' },
  ]);
}

// ---------------------------------------------------------------- shop
const upgEls = {};
const UPG_INFO = {
  steer: { icon: '🏎', desc: 'Більше метрів за кожен клік «Газ!».' },
  fuel: { icon: '⛽', desc: 'Швидший автопілот (м/с без кліків).' },
  cargo: { icon: '📦', desc: 'Більше ₴ за кожен метр дороги.' },
  helper: { icon: '👷', desc: 'Помічник сам тисне «Газ!» за тебе.' },
};
function upgEffect(id) {
  const lv = state.up[id], def = E.upgradeDef(id), max = lv >= def.max;
  const nu = { ...state.up, [id]: lv + 1 };
  const a = E.rates(veh(), state.up), b = E.rates(veh(), nu);
  switch (id) {
    case 'steer': return max ? `${fmtF(a.clickM)} м за клік` : `${fmtF(a.clickM)} → ${fmtF(b.clickM)} м за клік`;
    case 'fuel': return max ? `${fmtF(a.autoMps)} м/с` : `автопілот ${fmtF(a.autoMps)} → ${fmtF(b.autoMps)} м/с`;
    case 'cargo': return max ? `×${fmtF(a.mult.income, 2)} ₴` : `×${fmtF(a.mult.income, 2)} → ×${fmtF(b.mult.income, 2)} ₴ за метр`;
    case 'helper': return max ? `${fmtF(a.mult.helperCps)} кліків/с` : `${fmtF(a.mult.helperCps)} → ${fmtF(b.mult.helperCps)} кліків/с`;
  }
  return '';
}
function buildShop() {
  const box = $('upgrades');
  for (const def of BAL.UPGRADES) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'card upg';
    b.innerHTML = '<span class="c-head"><span class="c-name"></span><span class="c-lvl"></span></span><span class="c-desc"></span><span class="c-eff"></span><span class="c-cost"></span>';
    b.querySelector('.c-name').textContent = UPG_INFO[def.id].icon + ' ' + def.name;
    b.querySelector('.c-desc').textContent = UPG_INFO[def.id].desc;
    b.dataset.tip = '1';
    b._tip = () => `${def.name}: ${UPG_INFO[def.id].desc} Зараз рівень ${state.up[def.id]} з ${def.max}. ${upgEffect(def.id)}. Кожен рівень дорожчий за попередній.`;
    b.addEventListener('click', () => buyUpgrade(def.id));
    box.appendChild(b);
    upgEls[def.id] = { b, lvl: b.querySelector('.c-lvl'), eff: b.querySelector('.c-eff'), cost: b.querySelector('.c-cost') };
  }
  const vbox = $('vehicles');
  VEH.forEach((v, i) => {
    const row = document.createElement('div');
    row.className = 'veh';
    row.innerHTML = '<canvas class="v-pic"></canvas><div class="v-info"><div class="v-name"></div><div class="v-blurb"></div><div class="v-stats"></div></div><button type="button" class="btn v-buy"></button>';
    row.querySelector('.v-name').textContent = v.name;
    row.querySelector('.v-blurb').textContent = v.blurb || '';
    row.querySelector('.v-stats').textContent =
      `${fmtF(v.clickM)} м/клік · ${fmtF(v.autoMps)} м/с · ×${fmtN(v.incomeMult)} ₴${v.flies ? ' · літає' : ''}`;
    const pic = row.querySelector('.v-pic');
    drawThumb(pic, v);
    const btn = row.querySelector('.v-buy');
    btn.dataset.tip = '1';
    btn._tip = () => i < state.owned ? `${v.name} — вже твій.` :
      i === state.owned ? `Купити ${v.name} за ${fmtM(v.cost)}. ${v.flies ? 'Літає над дорогою!' : ''} Швидкість і заробіток зростуть.` :
        `Спершу купи попередній транспорт. Ціна: ${fmtM(v.cost)}.`;
    btn.addEventListener('click', () => buyVehicle(i));
    row.dataset.tip = '1';
    row._tip = () => `${v.name}. ${v.blurb || ''} Клік: ${fmtF(v.clickM)} м, автопілот: ${fmtF(v.autoMps)} м/с, ₴ за метр ×${fmtN(v.incomeMult)}.`;
    vbox.appendChild(row);
    v._row = row; v._btn = btn;
  });
}
function drawThumb(c, v) {
  try {
    const w = Math.max(40, Math.min(96, (v.w | 0) + 8)), h = Math.max(20, Math.min(48, (v.h | 0) + 6));
    c.width = w; c.height = h;
    const g = c.getContext('2d'); g.imageSmoothingEnabled = false;
    v.draw(g, w >> 1, h - 2, 0, 0, { t: 0, speed: 0, night: 0, grade: 0 });
  } catch (e) { console.warn('thumb', v.id, e); }
}
function buyUpgrade(id) {
  const cost = E.upgradeCost(id, state.up[id]);
  if (!(cost <= state.money)) { toast('Не вистачає ₴ — їдь далі!', '', 1500); return; }
  state.money -= cost; state.up[id]++;
  recalc(); sound.buy(); updateShop(true);
  if (hintQueue[0] && hintQueue[0].id === 'upgrade') { hintQueue.shift(); showHint(); }
}
function buyVehicle(i) {
  if (i !== state.owned || i >= VEH.length) return;
  const v = VEH[i];
  if (!(v.cost <= state.money)) { toast('Не вистачає ₴ на ' + v.name, '', 1500); return; }
  state.money -= v.cost; state.owned = i + 1; state.vehicle = v.id;
  recalc(); sound.buy(); updateShop(true);
  toast(`Новий транспорт: ${v.name}! 🎉`, 'gold', 4500);
  if (hintQueue[0] && hintQueue[0].id === 'vehicle') { hintQueue.shift(); showHint(); }
  save();
}
function updateShop() {
  let cheapest = Infinity;
  for (const def of BAL.UPGRADES) {
    const u = upgEls[def.id], lv = state.up[def.id], cost = E.upgradeCost(def.id, lv);
    cheapest = Math.min(cheapest, cost);
    setText(u.lvl, lv >= def.max ? 'макс.' : 'рів. ' + lv);
    setText(u.eff, upgEffect(def.id));
    setText(u.cost, Number.isFinite(cost) ? fmtM(cost) : '—');
    const can = cost <= state.money;
    u.b.disabled = !Number.isFinite(cost);
    u.b.classList.toggle('afford', can);
  }
  VEH.forEach((v, i) => {
    const st = i < state.owned - 1 ? 'owned' : i === state.owned - 1 ? 'current' : i === state.owned ? 'next' : 'locked';
    if (v._row.dataset.state !== st) v._row.dataset.state = st;
    setText(v._btn, st === 'owned' ? '✓ Є' : st === 'current' ? 'Їдеш' : fmtM(v.cost));
    v._btn.disabled = st !== 'next';
    v._btn.classList.toggle('afford', st === 'next' && v.cost <= state.money);
  });
  if (cheapest <= state.money && state.clicks > 0) hint('upgrade');
  const nv = VEH[state.owned];
  if (nv && state.owned >= 1 && nv.cost <= state.money) hint('vehicle', nv.name + ' вже по кишені.');
}

// ---------------------------------------------------------------- HUD
function updateHud() {
  const m = state.distM;
  setText(S.km, E.formatKm(m).replace(' км', ''));
  setText(S.kmTot, '/ ' + E.formatKm(lengthM));
  let np = null;
  try { np = data.nextPlace(m); } catch { /* ignore */ }
  if (np && np.place) { setText(S.next, np.place.name); setText(S.nextD, E.formatKm(Math.max(0, np.dM))); }
  else { setText(S.next, m >= lengthM ? 'Фініш!' : meta.to || '—'); setText(S.nextD, m >= lengthM ? '' : E.formatKm(lengthM - m)); }
  let ele = 0;
  try { ele = data.pointAt(m).ele; } catch { /* ignore */ }
  setText(S.ele, Math.round(ele) + ' м');
  setText(S.money, fmtM(state.money));
  setText(S.rate, fmtM(Math.max(0, incomeEma)) + '/с');
  setText(S.speed, fmtN(Math.round(Math.max(0, speedEma) * 3.6)) + ' км/год');
  setText(S.veh, veh().name);
  setText($('gas-sub'), '+' + fmtF(curRates.clickM) + ' м');
  updateShop();
  refreshTip();
}
const STAT_TIPS = {
  'st-km': () => `Скільки ти проїхав справжньою дорогою з ${E.formatKm(lengthM)} маршруту ${meta.from || ''} → ${meta.to || ''}.`,
  'st-next': () => 'Найближчий населений пункт попереду і відстань до нього. За кожне місто чи село — бонус ₴.',
  'st-ele': () => 'Висота дороги над рівнем моря тут (справжній рельєф з супутникових даних).',
  'st-money': () => 'Гривні (₴) — валюта гри. Заробляєш за кожен проїханий метр. Витрачай на покращення і транспорт.',
  'st-rate': () => `Скільки ₴ ти зараз заробляєш за секунду. Без кліків: ${fmtM(curRates.idleIncomePerS)}/с.`,
  'st-speed': () => `Поточна швидкість. Автопілот ${fmtF(curRates.autoMps)} м/с + помічник ${fmtF(curRates.helperMps)} м/с + твої кліки.`,
  'st-veh': () => `${veh().name}. ${veh().blurb || ''} Купуй новий транспорт у розділі «Транспорт».`,
  'minimap': () => 'Профіль висот усього маршруту. Позначка — де ти зараз.',
  'gas': () => `Газ! Кожне натискання — +${fmtF(curRates.clickM)} м. Також Пробіл або дотик до картинки.`,
};
for (const [id, fn] of Object.entries(STAT_TIPS)) { const el = $(id); if (el) { el.dataset.tip = '1'; el._tip = fn; } }

// ---------------------------------------------------------------- scene / map / fly-through
let scene = null;
if (mScene.mod && mScene.mod.createScene) {
  try { scene = mScene.mod.createScene(canvas, data); } catch (e) { console.error('createScene', e); }
}
if (!scene) {
  console.error('scene.js unavailable — fallback renderer');
  scene = {
    render(distM, dt, draw, opts = {}) {
      const c = ctx2d, gy = 170;
      c.fillStyle = '#7fb6f0'; c.fillRect(0, 0, 384, gy); c.fillStyle = '#555'; c.fillRect(0, gy, 384, 46);
      const y = opts.flies ? gy - (opts.flyAltPx || 0) : gy;
      draw(c, 120, y, { t: performance.now() / 1000, speed: opts.speedMps || 0, night: 0, grade: 0 });
      return { night: 0, timeOfDay: 0.5, vehicleX: 120, groundY: gy };
    },
  };
}
const M = mMap.mod || {};
let map = null, fly = null;
try { if (M.createMap) map = M.createMap(data, { getDistanceM: () => state.distM }); } catch (e) { console.error('createMap', e); }
try {
  if (M.createFlythrough) fly = M.createFlythrough({ container: flyUi, canvas, scene, data, vehicles: VEH, onExit: () => document.body.classList.remove('flying') });
} catch (e) { console.error('createFlythrough', e); }
if (!map) { $('btn-map').disabled = true; $('btn-map').dataset.tip = 'Мапа недоступна.'; }
if (!fly) { $('btn-fly').disabled = true; $('btn-fly').dataset.tip = 'Проліт недоступний.'; }

function startFly(km) {
  if (!fly) return;
  if (map && map.isOpen()) map.close();
  document.body.classList.add('flying');
  try { fly.start(Math.max(0, Math.min(lengthM / 1000, km))); } catch (e) { softError(e); document.body.classList.remove('flying'); }
}
const tod = params.has('tod') ? Math.max(0, Math.min(1, +params.get('tod') || 0)) : undefined;
const drawVehicle = (c, x, y, env) => { const v = veh(); v.draw(c, x, y, env.t, env.speed, env); };
let sceneFailed = 0;
function renderScene(dt) {
  const v = veh();
  const opts = { flies: !!v.flies, flyAltPx: v.flyAltPx | 0, speedMps: Math.max(0, speedEma) };
  if (tod !== undefined) opts.timeOfDay = tod;
  try { scene.render(state.distM, dt, drawVehicle, opts); }
  catch (e) { if (sceneFailed++ < 3) softError(e); }
}

// ---------------------------------------------------------------- buttons & input
$('gas').addEventListener('pointerdown', e => { if (e.button === 0) { e.preventDefault(); gas(); } });
$('gas').addEventListener('click', e => { if (e.detail === 0) gas(); });               // keyboard activation
canvas.addEventListener('pointerdown', e => { if (e.button === 0 && !(fly && fly.isActive())) { e.preventDefault(); gas(); } });
window.addEventListener('keydown', e => {
  if (e.code !== 'Space' && e.key !== ' ') return;
  if (fly && fly.isActive()) return;                     // the fly-through uses Space itself
  if (map && map.isOpen()) return;
  if (!$('modal').hidden) return;
  if (e.target instanceof Element && e.target.closest('input, textarea, select')) return;
  e.preventDefault();
  if (!e.repeat) gas();
});
$('btn-help').addEventListener('click', showHelp);
$('btn-map').addEventListener('click', () => { if (map) { map.toggle(); if (map.isOpen()) map.update(state.distM); } });
$('btn-fly').addEventListener('click', () => { if (fly && fly.isActive()) { fly.stop(); document.body.classList.remove('flying'); } else startFly(state.distM / 1000); });
$('btn-reset').addEventListener('click', askReset);
$('btn-sound').addEventListener('click', () => { state.flags.muted = !state.flags.muted; if (!state.flags.muted) delete state.flags.muted; syncSoundBtn(); });
syncSoundBtn();

// fullscreen (works inside itch.io's iframe when allowfullscreen is set; otherwise the button hides)
const fsEl = document.documentElement;
const fsEnabled = document.fullscreenEnabled || document.webkitFullscreenEnabled;
const fsActive = () => document.fullscreenElement || document.webkitFullscreenElement;
if (!fsEnabled) $('btn-fs').hidden = true;
$('btn-fs').addEventListener('click', () => {
  try {
    if (fsActive()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else { const p = (fsEl.requestFullscreen || fsEl.webkitRequestFullscreen).call(fsEl); if (p && p.catch) p.catch(() => toast('Повний екран недоступний тут.', '', 2000)); }
  } catch { toast('Повний екран недоступний тут.', '', 2000); }
});
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => document.body.classList.toggle('fs', !!fsActive()));

function askReset() {
  modal('Скинути прогрес?', body => {
    para(body, 'Усі гроші, покращення, транспорт і пройдені кілометри буде видалено. Це не можна скасувати.');
  }, [
    { label: 'Так, скинути', danger: true, onClick: () => {
      resetting = true;
      lsDel(SAVE_KEY); lsDel(BAK_KEY); lsDel(SAVE_KEY + '.corrupt');
      location.reload();
    } },
    { label: 'Скасувати', primary: true },
  ]);
}

// ---------------------------------------------------------------- save triggers & offline
setInterval(save, 10000);
document.addEventListener('visibilitychange', () => {
  // in-session absences use the monotonic clock, so changing the system clock can't farm offline income
  if (document.visibilityState === 'hidden') { hiddenAt = performance.now(); save(); }
  else if (hiddenAt) { applyOffline((performance.now() - hiddenAt) / 1000); hiddenAt = 0; }
});
window.addEventListener('pagehide', save);
let hiddenAt = 0;

function applyOffline(elapsedS) {
  if (!Number.isFinite(elapsedS) || elapsedS < 0 || elapsedS > 365 * 86400) return;   // clock went backwards / absurd
  if (state.distM >= lengthM) return;
  const r = E.offlineEarnings(veh(), state.up, elapsedS);
  if (!(r.money > 0)) return;
  pay(r.money);
  modal('Поки тебе не було…', body => {
    para(body, `Тебе не було ${E.formatDuration(elapsedS)}. Автопілот і помічник заробили:`);
    para(body, '+' + fmtM(r.money), 'big gold');
    para(body, `Поза грою заробляєш ${Math.round(BAL.OFFLINE.rate * 100)}% від автодоходу, максимум за ${E.formatDuration(BAL.OFFLINE.capS)}.` + (r.capped ? ' Ліміт досягнуто.' : ''), 'muted');
  }, [{ label: 'Чудово!', primary: true }]);
}

// ---------------------------------------------------------------- loop
let last = performance.now(), hudAcc = 1, mmAcc = 1, mapAcc = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
  last = now;
  step(dt);
}
function step(dt) {
  try {
    state.playS += dt;
    advance(dt);
    if (fly && fly.isActive()) fly.frame(dt);
    else renderScene(dt);
    hudAcc += dt; mmAcc += dt; mapAcc += dt;
    if (hudAcc >= 0.15) { hudAcc = 0; updateHud(); }
    if (mmAcc >= 0.25 && M.drawMinimap) { mmAcc = 0; try { M.drawMinimap(mm, data, state.distM); } catch (e) { M.drawMinimap = null; softError(e); } }
    if (mapAcc >= 1 && map && map.isOpen()) { mapAcc = 0; map.update(state.distM); }
  } catch (e) { softError(e && (e.stack || e.message || e)); }
}

// ---------------------------------------------------------------- start
buildShop();
recalc();
updateHud();
$('loading').hidden = true;
document.body.classList.add('ready');
if (loadNote) toast(loadNote, 'warn', 6000);
if (state.routeChanged) toast('Маршрут оновився — гроші й покращення збережено, позицію підправлено.', 'warn', 6000);
if (!storageOk && !noSave) toast('Сховище браузера недоступне — прогрес не збережеться.', 'warn', 6000);
if (state.distM === 0 && state.clicks === 0) toast(`Старт: ${meta.from || 'початок маршруту'}! Попереду ${E.formatKm(lengthM)}.`, 'green', 5000);
hint('start');
if (!noSave && offlineFrom > 0) applyOffline((Date.now() - offlineFrom) / 1000);
if (state.finished && state.distM >= lengthM) finishShown = true;      // don't nag on reload; button «Проліт» still works
requestAnimationFrame(t => { last = t; requestAnimationFrame(frame); });
if (params.has('fly') && fly) startFly(+params.get('fly') || 0);

// small debug/inspection hook (used by integration checks; harmless for players)
// tick(dt, n) steps the game by hand (rAF is paused in hidden tabs).
window.__road = { state, data, VEH, save, get rates() { return curRates; }, fly, map, tick(dt = 1 / 60, n = 1) { for (let i = 0; i < n; i++) step(dt); } };
