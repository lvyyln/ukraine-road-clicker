// map.js (agent D) — «Мапа» overlay (Leaflet + OSM), the HUD minimap strip and the «Проліт» fly-through.
//
// export function createMap(data, { getDistanceM }) -> { open(), close(), toggle(), isOpen(), update(distanceM) }
//   Leaflet 1.9.4 is loaded lazily from cdnjs on the first open(). The overlay is our own DOM on document.body.
//   Optional extra option { offline: true } forces the no-tiles canvas fallback (also used when Leaflet fails to load).
//   While closed, update() only stores the distance (no Leaflet work). Esc closes it.
// export function drawMinimap(canvas, data, distanceM, opts = {})
//   Pixel elevation profile of the whole route. The static layers are cached per (data, width, height);
//   a call is two drawImage + a few fillRect. opts: { labels = true, ticks = true }.
// export function createFlythrough({ container, canvas, scene, data, vehicles, onExit, pickVehicle, view })
//   -> { start(km), seek(km), stop(), isActive(), frame(dt), positionM() }
//   Non-saving preview that renders through the same scene object. At the route end it stops at the last km
//   and pauses (no loop); pressing play there restarts from km 0.
//   `scene` may be a proxy that forwards to whichever scene is active. Optional:
//   pickVehicle(mode: 'walk'|'fly') -> { draw(ctx, x, y, env), flies, flyAltPx } is asked every frame, so a
//   view switch changes the sprite at once; view = { label(), toggle() } adds a «Вид» button (key V).
// export function createInset(canvas, data) -> { draw(drivenM, markerM) } — the corner map (see below).

const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
// SRI hashes as published by cdnjs (api.cdnjs.com/libraries/leaflet/1.9.4?fields=sri), verified against the files.
const LEAFLET_JS_SRI = 'sha512-puJW3E/qXDqYp9IfhAI54BJEaWIfloJ7JWs7OeD5i6ruC9JZL1gERT1wjtwXFlh7CjE7ZJ+/vcRZRkIYIb6p4g==';
const LEAFLET_CSS_SRI = 'sha512-h9FcoyWjHcOcmEVkxOfTLnmZFWIH0iZhZT1H2TbOq55xssQGEJHEaIm+PgoUaZbRvQTNTluNOEfb1ZRy6D3BOw==';
const OSM_ATTR = '© OpenStreetMap contributors';

// The pixel font is A's module; import it lazily so a missing/broken font never breaks this module.
let font = null;
let fontGen = 0;
import('./pixelfont.js').then(m => { if (m && m.drawText) { font = m; fontGen++; } }).catch(() => {});

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const fmtInt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const TYPE_UA = { city: 'місто', town: 'містечко', village: 'село' };

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function attributionText(data) {
  const a = data && data.meta && data.meta.attribution;
  return a ? (a.includes('OpenStreetMap') ? a : OSM_ATTR + ' · ' + a) : OSM_ATTR;
}

// ---------------------------------------------------------------- Leaflet loader
let leafletPromise = null;
function loadLeaflet() {
  if (window.L && window.L.map) return Promise.resolve(window.L);
  if (leafletPromise) return leafletPromise;
  leafletPromise = new Promise((resolve, reject) => {
    if (!document.querySelector('link[data-ukm-leaflet]')) {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = LEAFLET_CSS; css.integrity = LEAFLET_CSS_SRI; css.crossOrigin = 'anonymous';
      css.setAttribute('data-ukm-leaflet', '');
      document.head.appendChild(css);
    }
    const s = document.createElement('script');
    s.src = LEAFLET_JS; s.integrity = LEAFLET_JS_SRI; s.crossOrigin = 'anonymous'; s.async = true;
    s.setAttribute('data-ukm-leaflet', '');
    const timer = setTimeout(() => fail(new Error('timeout')), 20000);
    function fail(err) { clearTimeout(timer); s.remove(); reject(err); }
    s.onload = () => { clearTimeout(timer); window.L && window.L.map ? resolve(window.L) : fail(new Error('no L')); };
    s.onerror = () => fail(new Error('network'));
    document.head.appendChild(s);
  });
  leafletPromise.catch(() => { leafletPromise = null; }); // allow a retry on the next open()
  return leafletPromise;
}

// ---------------------------------------------------------------- createMap
export function createMap(data, { getDistanceM, offline = false } = {}) {
  let isOpenFlag = false, built = false, building = null;
  let distM = 0, lastIdx = -1;
  let meBtn, root, mapDiv, msg, kmLabel, L, map, drivenLine, drivenCasing, posMarker, villageLayer, pollTimer = 0;
  let pts = null; // precomputed latlngs (500 m)
  const STEP = 500;

  function buildDom() {
    root = el('div', 'ukm-map');
    root.hidden = true;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Мапа маршруту');
    const bar = el('div', 'ukm-map-bar');
    bar.appendChild(el('div', 'ukm-map-title', 'Мапа'));
    kmLabel = el('div', 'ukm-map-km', '');
    bar.appendChild(kmLabel);
    const me = meBtn = el('button', 'ukm-btn ukm-map-me', 'До мене');
    me.type = 'button';
    me.addEventListener('click', () => centreOnMe());
    const close = el('button', 'ukm-btn ukm-map-close', 'Закрити');
    close.type = 'button';
    close.addEventListener('click', () => api.close());
    bar.appendChild(me); bar.appendChild(close);
    mapDiv = el('div', 'ukm-map-leaflet');
    msg = el('div', 'ukm-map-msg', 'Завантаження мапи…');
    root.appendChild(bar); root.appendChild(mapDiv); root.appendChild(msg);
    document.body.appendChild(root);
  }

  // ---- offline fallback: the route drawn on a plain canvas (no tiles, no Leaflet) ----
  let off = null; // { canvas, ctx, proj }
  function buildOffline() {
    if (!pts) pts = data.latlngs(STEP);
    const c = el('canvas', 'ukm-map-offline');
    mapDiv.appendChild(c);
    const note = el('div', 'ukm-map-offnote', 'Мапа без підкладки (немає з’єднання з OpenStreetMap). ' + attributionText(data));
    mapDiv.appendChild(note);
    off = { canvas: c, ctx: c.getContext('2d') };
    meBtn.hidden = true;
    drawOffline();
  }
  function drawOffline() {
    if (!off) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = Math.max(50, mapDiv.clientWidth), H = Math.max(50, mapDiv.clientHeight);
    const c = off.canvas, g = off.ctx;
    if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    let a = Infinity, b = -Infinity, cc = Infinity, d = -Infinity;
    for (const p of pts) { if (p[0] < a) a = p[0]; if (p[0] > b) b = p[0]; if (p[1] < cc) cc = p[1]; if (p[1] > d) d = p[1]; }
    const k = Math.cos(((a + b) / 2) * Math.PI / 180), pad = 40;
    const s = Math.min((W - 2 * pad) / Math.max(1e-6, (d - cc) * k), (H - 2 * pad) / Math.max(1e-6, b - a));
    const ox = (W - (d - cc) * k * s) / 2, oy = (H - (b - a) * s) / 2;
    const X = lon => ox + (lon - cc) * k * s, Y = lat => oy + (b - lat) * s;
    g.fillStyle = '#16233a'; g.fillRect(0, 0, W, H);
    const line = (n, col, wd) => {
      g.strokeStyle = col; g.lineWidth = wd; g.lineJoin = 'round'; g.lineCap = 'round'; g.beginPath();
      for (let i = 0; i < n; i++) i ? g.lineTo(X(pts[i][1]), Y(pts[i][0])) : g.moveTo(X(pts[i][1]), Y(pts[i][0]));
      g.stroke();
    };
    const m = clamp(distM, 0, data.lengthM);
    line(pts.length, '#5b6474', 3);
    const idx = Math.min(pts.length, Math.floor(m / STEP) + 1);
    if (idx > 1) { line(idx, '#0057b7', 7); line(idx, '#ffd500', 3); }
    g.font = '13px system-ui, sans-serif'; g.textBaseline = 'middle';
    for (const r of (data.meta && data.meta.rivers) || []) {
      const p = data.pointAt(r.km * 1000);
      g.fillStyle = '#4fb3ff'; g.fillRect(Math.round(X(p.lon)) - 2, Math.round(Y(p.lat)) - 2, 5, 5);
    }
    for (const p of (data.meta && data.meta.places) || []) {
      if (p.type !== 'city') continue;
      const q = data.pointAt(p.km * 1000), x = X(q.lon), y = Y(q.lat);
      g.fillStyle = '#ffd500'; g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill();
      g.fillStyle = '#000'; g.fillText(p.name, x + 9, y + 1); g.fillStyle = '#fff'; g.fillText(p.name, x + 8, y);
    }
    const q = data.pointAt(m);
    g.fillStyle = '#ff3b30'; g.strokeStyle = '#fff'; g.lineWidth = 3;
    g.beginPath(); g.arc(X(q.lon), Y(q.lat), 8, 0, 7); g.stroke(); g.fill();
  }

  async function buildMap() {
    try {
      if (offline) throw new Error('offline');
      L = await loadLeaflet();
    } catch (e) {
      msg.hidden = false;
      msg.textContent = 'Не вдалося завантажити Leaflet — показую спрощену мапу.';
      setTimeout(() => { msg.hidden = true; }, 3000);
      buildOffline();
      return true;
    }
    msg.hidden = true;
    pts = data.latlngs(STEP);
    const renderer = L.canvas({ padding: 0.3 });
    map = L.map(mapDiv, { zoomControl: true, attributionControl: true, preferCanvas: true, renderer, minZoom: 5, maxZoom: 19 });
    map.attributionControl.setPrefix(false);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">' + OSM_ATTR + '</a>',
    }).addTo(map);
    const extra = data.meta && data.meta.attribution;
    if (extra) map.attributionControl.addAttribution(escapeHtml(extra));

    L.polyline(pts, { color: '#5b6474', weight: 4, opacity: 0.75, interactive: false, renderer }).addTo(map);
    drivenCasing = L.polyline([], { color: '#0057b7', weight: 8, opacity: 0.9, interactive: false, renderer }).addTo(map);
    drivenLine = L.polyline([], { color: '#ffd500', weight: 4, opacity: 1, interactive: false, renderer }).addTo(map);

    // places: cities + towns always, villages only from zoom 10
    const places = (data.meta && data.meta.places) || [];
    const mainLayer = L.layerGroup().addTo(map);
    villageLayer = L.layerGroup();
    for (const p of places) {
      const pt = data.pointAt(p.km * 1000);
      const city = p.type === 'city', town = p.type === 'town';
      const mk = L.circleMarker([pt.lat, pt.lon], {
        renderer, radius: city ? 7 : town ? 4.5 : 3,
        color: '#1b1b1b', weight: city ? 2 : 1, fillColor: city ? '#ffd500' : town ? '#ffffff' : '#c8d0da', fillOpacity: 1,
      });
      mk.bindPopup(() => placePopup(p));
      if (city) mk.bindTooltip(el('span', '', p.name), { permanent: true, direction: 'right', offset: [8, 0], className: 'ukm-map-tip' });
      (city || town ? mainLayer : villageLayer).addLayer(mk);
    }
    const syncVillages = () => {
      const want = map.getZoom() >= 10;
      if (want !== map.hasLayer(villageLayer)) want ? villageLayer.addTo(map) : villageLayer.remove();
    };
    map.on('zoomend', syncVillages);

    // river crossings
    for (const r of (data.meta && data.meta.rivers) || []) {
      const pt = data.pointAt(r.km * 1000);
      L.circleMarker([pt.lat, pt.lon], { renderer, radius: 4, color: '#0b3d91', weight: 2, fillColor: '#4fb3ff', fillOpacity: 1 })
        .bindPopup(() => {
          const d = el('div', 'ukm-pop');
          d.appendChild(el('b', '', 'Річка ' + r.name));
          d.appendChild(el('div', '', 'км ' + Math.round(r.km)));
          return d;
        }).addTo(map);
    }

    // start / finish flags (meta.from / meta.to)
    const flag = (latlng, text) => L.marker(latlng, {
      icon: L.divIcon({ className: 'ukm-map-flag', html: '<span>' + escapeHtml(text) + '</span>', iconSize: null }),
      interactive: false, keyboard: false,
    }).addTo(map);
    if (data.meta && data.meta.from) flag(pts[0], '🏁 ' + data.meta.from);
    if (data.meta && data.meta.to) flag(pts[pts.length - 1], '🏁 ' + data.meta.to);

    posMarker = L.marker(pts[0], {
      icon: L.divIcon({ className: 'ukm-map-pos', html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      keyboard: false, interactive: false, zIndexOffset: 1000,
    }).addTo(map);

    map.fitBounds(L.latLngBounds(pts), { padding: [24, 24] });
    syncVillages();
    return true;
  }

  function placePopup(p) {
    const d = el('div', 'ukm-pop');
    d.appendChild(el('b', '', p.name));
    d.appendChild(el('div', '', (TYPE_UA[p.type] || p.type || '') + ' · км ' + Math.round(p.km)));
    if (p.pop > 0) d.appendChild(el('div', '', 'населення ' + fmtInt(p.pop)));
    return d;
  }

  function apply() {
    if (off) {
      const idx = Math.floor(clamp(distM, 0, data.lengthM) / 2000);
      if (idx !== lastIdx) { lastIdx = idx; drawOffline(); }
      kmLabel.textContent = 'км ' + Math.floor(distM / 1000) + ' з ' + Math.round(data.lengthM / 1000);
      return;
    }
    if (!map) return;
    const m = clamp(distM, 0, data.lengthM);
    const pt = data.pointAt(m);
    posMarker.setLatLng([pt.lat, pt.lon]);
    const idx = Math.min(pts.length - 1, Math.floor(m / STEP));
    if (idx !== lastIdx) {
      lastIdx = idx;
      const prefix = pts.slice(0, idx + 1);
      prefix.push([pt.lat, pt.lon]);
      drivenLine.setLatLngs(prefix);
      drivenCasing.setLatLngs(prefix);
    }
    kmLabel.textContent = 'км ' + Math.floor(m / 1000) + ' з ' + Math.round(data.lengthM / 1000);
  }

  // keep Leaflet / the offline canvas sized to the overlay (iframe resizes, rotation, fullscreen)
  let ro = null;
  function onResize() {
    if (!isOpenFlag) return;
    if (map) map.invalidateSize({ pan: false });
    if (off) drawOffline();
  }

  function centreOnMe() {
    if (!map) return;
    const pt = data.pointAt(clamp(distM, 0, data.lengthM));
    map.setView([pt.lat, pt.lon], Math.max(map.getZoom(), 11));
  }

  function onKey(e) {
    if (e.key === 'Escape' && isOpenFlag) { e.preventDefault(); e.stopPropagation(); api.close(); }
  }

  const api = {
    open() {
      if (isOpenFlag) return;
      if (!root) buildDom();
      isOpenFlag = true;
      root.hidden = false;
      document.addEventListener('keydown', onKey, true);
      if (window.ResizeObserver) { if (!ro) ro = new ResizeObserver(onResize); ro.observe(root); }
      else window.addEventListener('resize', onResize);
      if (getDistanceM) {
        distM = +getDistanceM() || 0;
        pollTimer = setInterval(() => { if (isOpenFlag) api.update(+getDistanceM() || 0); }, 500);
      }
      if (!built) {
        if (!building) {
          msg.hidden = false; msg.textContent = 'Завантаження мапи…';
          building = buildMap().then(ok => { built = ok; building = null; if (ok && isOpenFlag) { onResize(); lastIdx = -1; apply(); } });
        }
      } else {
        onResize();
        lastIdx = -1;
        apply();
      }
    },
    close() {
      if (!isOpenFlag) return;
      isOpenFlag = false;
      root.hidden = true;
      document.removeEventListener('keydown', onKey, true);
      if (ro) ro.disconnect(); else window.removeEventListener('resize', onResize);
      clearInterval(pollTimer); pollTimer = 0;
      if (map) map.closePopup();
    },
    toggle() { isOpenFlag ? api.close() : api.open(); },
    isOpen() { return isOpenFlag; },
    update(distanceM) {
      distM = +distanceM || 0;
      if (isOpenFlag && built) apply();
    },
  };
  return api;
}

// ---------------------------------------------------------------- drawMinimap
const MM = {
  bg: '#0b1626', grid: '#13223a',
  dimBody: '#2e3c58', dimTop: '#6a7a99',
  litBody: '#0057b7', litTop: '#ffd500',
  tickCity: '#ffffff', tickTown: '#8a96ab',
  label: '#ffffff', labelShadow: '#000000',
  marker: '#ff3b30', markerHi: '#ffffff',
};
const mmCache = new WeakMap(); // data -> { key, dim, lit, labelY }

function eleOf(data, m) { return data.eleAt ? data.eleAt(m) : data.pointAt(m).ele; }

function buildMinimap(data, w, h) {
  const L = data.lengthM;
  const showLabels = !!font && h >= 18;
  const labelH = showLabels ? 8 : 0;
  const top = labelH + 1, bottom = h - 1;
  const ph = Math.max(2, bottom - top);
  // per-pixel column min/max/avg
  const mn = new Float32Array(w), mx = new Float32Array(w), av = new Float32Array(w);
  const per = L / w, n = Math.max(4, Math.min(64, Math.ceil(per / 50)));
  let gMin = Infinity, gMax = -Infinity;
  for (let x = 0; x < w; x++) {
    let lo = Infinity, hi = -Infinity, sum = 0;
    for (let k = 0; k <= n; k++) {
      const e = eleOf(data, x * per + (k / n) * per);
      if (e < lo) lo = e; if (e > hi) hi = e; sum += e;
    }
    mn[x] = lo; mx[x] = hi; av[x] = sum / (n + 1);
    if (lo < gMin) gMin = lo; if (hi > gMax) gMax = hi;
  }
  const meta = data.meta || {};
  const eMin = Math.min(gMin, meta.eleMin ?? gMin), eMax = Math.max(gMax, meta.eleMax ?? gMax, eMin + 50);
  const yOf = e => Math.round(bottom - ((e - eMin) / (eMax - eMin)) * (ph - 1));

  const make = (body, topCol) => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    for (let x = 0; x < w; x++) {
      const ya = yOf(av[x]), yh = yOf(mx[x]);
      g.fillStyle = body; g.fillRect(x, ya, 1, bottom - ya + 1);
      g.fillStyle = topCol; g.fillRect(x, yh, 1, Math.max(1, ya - yh + 1));
    }
    return c;
  };
  const dim = make(MM.dimBody, MM.dimTop);
  const lit = make(MM.litBody, MM.litTop);

  // static overlay: background is drawn per call; ticks + labels go on the dim layer and the lit layer
  const places = meta.places || [];
  const ticks = document.createElement('canvas');
  ticks.width = w; ticks.height = h;
  const tg = ticks.getContext('2d');
  tg.imageSmoothingEnabled = false;
  const used = new Uint8Array(w);
  // cities first, then towns where there is room
  for (const pass of ['city', 'town']) {
    for (const p of places) {
      if (p.type !== pass) continue;
      const x = clamp(Math.round((p.km * 1000 / L) * (w - 1)), 0, w - 1);
      if (pass === 'town' && (used[x] || (x > 0 && used[x - 1]) || (x < w - 1 && used[x + 1]))) continue;
      used[x] = 1;
      tg.fillStyle = pass === 'city' ? MM.tickCity : MM.tickTown;
      tg.fillRect(x, top, 1, pass === 'city' ? Math.min(4, ph) : Math.min(2, ph));
    }
  }
  // labels: from, via[], to (via matched to places by name)
  if (showLabels) {
    const lab = [];
    if (meta.from) lab.push({ x: 0, text: meta.from, align: 'left' });
    for (const v of meta.via || []) {
      const p = places.find(q => q.name === v) || places.find(q => q.name && v && (q.name.startsWith(v) || v.startsWith(q.name)));
      if (p) lab.push({ x: Math.round((p.km * 1000 / L) * (w - 1)), text: v, align: 'center' });
    }
    if (meta.to) lab.push({ x: w - 1, text: meta.to, align: 'right' });
    const spans = [];
    for (const l of lab) {
      const tw = font.measureText(l.text);
      let x0 = l.align === 'left' ? l.x : l.align === 'right' ? l.x - tw + 1 : l.x - (tw >> 1);
      x0 = clamp(x0, 0, Math.max(0, w - tw));
      if (spans.some(s => x0 < s[1] + 3 && x0 + tw > s[0] - 3)) continue;
      spans.push([x0, x0 + tw]);
      font.drawText(tg, l.text, x0, 1, MM.label, { shadow: MM.labelShadow });
      if (l.align === 'center') { tg.fillStyle = MM.tickCity; tg.fillRect(l.x, top, 1, Math.min(4, ph)); }
    }
  }
  return { dim, lit, ticks, top, bottom };
}

export function drawMinimap(canvas, data, distanceM, opts = {}) {
  if (!canvas || !data || !(data.lengthM > 0)) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width | 0, h = canvas.height | 0;
  if (w < 4 || h < 4) return;
  ctx.imageSmoothingEnabled = false;
  let c = mmCache.get(data);
  if (!c || c.w !== w || c.h !== h || c.fontGen !== fontGen) {
    c = buildMinimap(data, w, h);
    c.w = w; c.h = h; c.fontGen = fontGen;
    mmCache.set(data, c);
  }
  const f = clamp(distanceM / data.lengthM, 0, 1);
  const px = Math.round(f * (w - 1));
  ctx.fillStyle = MM.bg;
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(c.dim, 0, 0);
  if (px > 0) ctx.drawImage(c.lit, 0, 0, px, h, 0, 0, px, h);
  if (opts.ticks !== false || opts.labels !== false) ctx.drawImage(c.ticks, 0, 0);
  // position marker: a 1px line through the profile + a 3px head
  ctx.fillStyle = MM.markerHi;
  ctx.fillRect(px, c.top, 1, h - c.top);
  ctx.fillStyle = MM.marker;
  ctx.fillRect(px - 1, c.top, 3, 2);
  ctx.fillRect(px, c.top + 2, 1, 1);
}

// ---------------------------------------------------------------- createFlythrough
const WALK_MPS = 2000, FLY_MPS = 5000;

export function createFlythrough({ container, canvas, scene, data, vehicles, onExit, pickVehicle, view } = {}) {
  const list = vehicles || [];
  let ground = null;
  for (const v of list) if (!v.flies) ground = v;            // last ground vehicle = the best one
  const flyer = list.find(v => v.id === 'an225') || [...list].reverse().find(v => v.flies) || ground;
  const lengthKm = data.lengthM / 1000;

  let active = false, playing = true, mode = 'walk', m = 0, dragging = false;
  let uiAcc = 0, lastKmShown = -1, lastPlaceAt = -1e9, placeText = '';
  let vehicle = ground;
  let picked = null;
  const drawFn = (ctx, x, y, env) => {
    if (picked) picked.draw(ctx, x, y, env);
    else if (vehicle) vehicle.draw(ctx, x, y, env.t, env.speed, env);
  };
  const ropts = { flies: false, flyAltPx: 0, speedMps: 0, showNote: true };

  let ui = null, prevHidden = false;

  function buildUi() {
    const root = el('div', 'ukm-fly');
    const top = el('div', 'ukm-fly-row');
    const play = el('button', 'ukm-btn ukm-fly-play', '⏸');
    play.type = 'button'; play.title = 'Пауза / відтворення (пробіл)';
    const seg = el('div', 'ukm-fly-seg');
    seg.setAttribute('role', 'group'); seg.setAttribute('aria-label', 'Режим');
    const walk = el('button', 'ukm-btn', 'Ходьба'); walk.type = 'button';
    const fly = el('button', 'ukm-btn', 'Політ'); fly.type = 'button';
    seg.appendChild(walk); seg.appendChild(fly);
    const read = el('div', 'ukm-fly-read', '');
    const exit = el('button', 'ukm-btn ukm-fly-exit', 'Вийти'); exit.type = 'button';
    const viewBtn = view ? el('button', 'ukm-btn ukm-fly-view', view.label()) : null;
    top.appendChild(play); top.appendChild(seg);
    if (viewBtn) { viewBtn.type = 'button'; viewBtn.title = 'Камера: дорога / збоку (V)'; top.appendChild(viewBtn); }
    top.appendChild(read); top.appendChild(exit);
    const range = el('input', 'ukm-fly-range');
    range.type = 'range'; range.min = '0'; range.max = String(Math.floor(lengthKm * 10) / 10); range.step = '0.1';
    range.setAttribute('aria-label', 'Кілометр маршруту');
    const attr = el('div', 'ukm-fly-attr', attributionText(data));
    root.appendChild(top); root.appendChild(range); root.appendChild(attr);

    const onPlay = () => { if (!playing && m >= data.lengthM - 1) m = 0; playing = !playing; syncButtons(); };
    const onWalk = () => setMode('walk');
    const onFly = () => setMode('fly');
    const onExit_ = () => { api.stop(); if (onExit) onExit(); };
    const onInput = () => { dragging = true; seekM(+range.value * 1000); };
    const onChange = () => { dragging = false; seekM(+range.value * 1000); };
    const onUp = () => { dragging = false; };
    play.addEventListener('click', onPlay);
    walk.addEventListener('click', onWalk);
    fly.addEventListener('click', onFly);
    exit.addEventListener('click', onExit_);
    const onView = () => { view.toggle(); viewBtn.textContent = view.label(); };
    if (viewBtn) viewBtn.addEventListener('click', onView);
    range.addEventListener('input', onInput);
    range.addEventListener('change', onChange);
    range.addEventListener('pointerup', onUp);
    range.addEventListener('pointercancel', onUp);
    const onKey = e => {
      if (!active || document.querySelector('.ukm-map:not([hidden])')) return; // the map overlay owns keys while open
      const t = e.target;
      if (t && t !== range && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      let handled = true;
      if (e.key === ' ' || e.code === 'Space') onPlay();
      else if (e.key === 'Escape') onExit_();
      else if (e.key === 'ArrowRight' && t !== range) seekM(m + 10000);
      else if (e.key === 'ArrowLeft' && t !== range) seekM(m - 10000);
      else if (e.key === 'f' || e.key === 'F' || e.key === 'а' || e.key === 'А') setMode(mode === 'walk' ? 'fly' : 'walk');
      else if (viewBtn && (e.key === 'v' || e.key === 'V' || e.key === 'м' || e.key === 'М')) onView();
      else handled = false;
      if (handled) { e.preventDefault(); e.stopImmediatePropagation(); }
    };
    window.addEventListener('keydown', onKey, true);
    return { root, play, walk, fly, read, range, onKey, viewBtn };
  }

  function syncButtons() {
    if (!ui) return;
    ui.play.textContent = playing ? '⏸' : '▶';
    ui.play.setAttribute('aria-label', playing ? 'Пауза' : 'Відтворити');
    ui.walk.setAttribute('aria-pressed', String(mode === 'walk'));
    ui.fly.setAttribute('aria-pressed', String(mode === 'fly'));
  }

  function setMode(md) {
    mode = md === 'fly' ? 'fly' : 'walk';
    vehicle = mode === 'fly' ? flyer : ground;
    ropts.flies = !!(vehicle && vehicle.flies);
    ropts.flyAltPx = ropts.flies ? (vehicle.flyAltPx | 0) : 0;
    syncButtons();
  }

  function seekM(nm) {
    m = clamp(+nm || 0, 0, data.lengthM);
    lastKmShown = -1; lastPlaceAt = -1e9;
    updateUi(true);
  }

  function updateUi(force) {
    if (!ui) return;
    const km = Math.floor(m / 100) / 10;
    if (!dragging && (force || km !== lastKmShown)) ui.range.value = String(km);
    if (force || Math.abs(m - lastPlaceAt) > 400) {
      lastPlaceAt = m;
      const river = data.riversNear(m, 1000);
      const near = data.placesNear(m, 3000);
      if (river.length) placeText = 'міст через ' + river[0].name;
      else if (near.length) placeText = near[0].name;
      else {
        const nx = data.nextPlace(m);
        placeText = nx ? '→ ' + nx.place.name + ' ' + Math.max(1, Math.round(nx.dM / 1000)) + ' км' : '';
      }
      lastKmShown = -1;
    }
    if (force || km !== lastKmShown) {
      lastKmShown = km;
      ui.read.textContent = 'км ' + Math.floor(m / 1000) + ' / ' + Math.round(lengthKm) + (placeText ? ' · ' + placeText : '');
    }
  }

  const api = {
    start(km = 0) {
      if (!active) {
        active = true;
        if (container) {
          ui = buildUi();
          container.appendChild(ui.root);
          prevHidden = container.hidden;
          container.hidden = false;
          container.classList.add('ukm-fly-on');
        }
      }
      playing = true;
      setMode(mode);
      seekM((+km || 0) * 1000);
    },
    seek(km) { seekM((+km || 0) * 1000); },
    stop() {
      if (!active) return;
      active = false;
      if (ui) {
        window.removeEventListener('keydown', ui.onKey, true);
        ui.root.remove(); // removes the element listeners with it
        ui = null;
      }
      if (container) { container.classList.remove('ukm-fly-on'); container.hidden = prevHidden; }
    },
    isActive() { return active; },
    positionM() { return m; },
    frame(dt) {
      if (!active) return;
      dt = dt > 0 ? Math.min(dt, 0.1) : 0;
      const speed = mode === 'fly' ? FLY_MPS : WALK_MPS;
      const moving = playing && !dragging;
      if (moving) {
        m += speed * dt;
        if (m >= data.lengthM) { m = data.lengthM; playing = false; syncButtons(); }
      }
      ropts.speedMps = moving ? speed : 0;
      if (pickVehicle) {
        picked = pickVehicle(mode) || null;
        if (picked) { ropts.flies = !!picked.flies; ropts.flyAltPx = picked.flies ? (picked.flyAltPx | 0) : 0; }
      }
      if (ui && ui.viewBtn) { const t = view.label(); if (ui.viewBtn.textContent !== t) ui.viewBtn.textContent = t; }
      scene.render(m, dt, drawFn, ropts);
      uiAcc += dt;
      if (uiAcc >= 0.1) { uiAcc = 0; updateUi(false); }
    },
  };
  return api;
}

// ---------------------------------------------------------------- createInset
// export function createInset(canvas, data) -> { draw(drivenM, markerM = drivenM) }
//   The small pixel map of Ukraine in the corner of the game picture (like the original game's US map):
//   borders (mapshape.js), Чорне море, the whole route, the driven part in yellow, the 5 cities and a blinking
//   marker. Everything static is pre-rendered once; draw() is three drawImage calls plus ~2 px per km driven.
export const INSET_W = 112, INSET_H = 86;
const INS = {
  lon0: 21.8, lat1: 52.6, k: Math.cos(48.5 * Math.PI / 180), s: 9,
  sea: '#2f5f8f', wave: '#3d70a3', land: '#5b6656', ukr: '#e8dfb8', border: '#22344f',
  route: '#a8987a', driven: '#ffd500', drivenShadow: '#0057b7',
  cityDot: '#10203a', cityHi: '#ffffff', label: '#ffffff', labelShadow: '#10203a', seaLabel: '#a9c8e8',
  marker: '#ff3b30', markerHi: '#ffffff',
};
let shapePromise = null;
function loadShape() {
  if (!shapePromise) shapePromise = import('./mapshape.js').catch(e => { console.error('mapshape.js', e); return null; });
  return shapePromise;
}

export function createInset(canvas, data) {
  const W = INSET_W, H = INSET_H;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const X = lon => (lon - INS.lon0) * INS.k * INS.s, Y = lat => (INS.lat1 - lat) * INS.s;
  const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d'); g.imageSmoothingEnabled = false; return [c, g]; };
  let base = null, top = null, topGen = -1;

  // route as a 1-px pixel chain with the distance at each pixel
  const rx = [], ry = [], rm = [];
  {
    const STEP = 1000, pts = data.latlngs(STEP);
    let px = null, py = null;
    for (let i = 0; i < pts.length; i++) {
      const x1 = Math.round(X(pts[i][1])), y1 = Math.round(Y(pts[i][0]));
      if (px === null) { rx.push(x1); ry.push(y1); rm.push(0); px = x1; py = y1; continue; }
      // Bresenham from (px,py) to (x1,y1), skipping the start pixel
      let x = px, y = py;
      const dx = Math.abs(x1 - x), dy = -Math.abs(y1 - y), sx = x < x1 ? 1 : -1, sy = y < y1 ? 1 : -1;
      let err = dx + dy;
      const n = Math.max(dx, -dy);
      for (let k = 1; k <= n; k++) {
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x += sx; }
        if (e2 <= dx) { err += dx; y += sy; }
        rx.push(x); ry.push(y); rm.push(Math.min(data.lengthM, ((i - 1) + k / n) * STEP));
      }
      px = x1; py = y1;
    }
  }

  function buildBase(shape) {
    const [c, g] = mk();
    const mask = rings => {
      const [mc, mg] = mk();
      mg.fillStyle = '#fff';
      for (const r of rings) {
        mg.beginPath();
        for (let i = 0; i < r.length; i += 2) { const x = X(r[i] / 100), y = Y(r[i + 1] / 100); i ? mg.lineTo(x, y) : mg.moveTo(x, y); }
        mg.closePath(); mg.fill();
      }
      return mg.getImageData(0, 0, W, H).data;
    };
    const uk = shape ? mask(shape.UKRAINE) : null, nb = shape ? mask(shape.NEIGHBOURS) : null;
    const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const C = { sea: hex(INS.sea), wave: hex(INS.wave), land: hex(INS.land), ukr: hex(INS.ukr), border: hex(INS.border) };
    const img = g.createImageData(W, H), d = img.data;
    const isU = (x, y) => x >= 0 && y >= 0 && x < W && y < H && uk && uk[(y * W + x) * 4 + 3] >= 128;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      let col;
      if (isU(x, y)) col = isU(x - 1, y) && isU(x + 1, y) && isU(x, y - 1) && isU(x, y + 1) ? C.ukr : C.border;
      else if (nb && nb[i + 3] >= 128) col = C.land;
      else col = (x * 3 + y * 5) % 23 === 0 && y % 4 === 1 ? C.wave : C.sea;
      d[i] = col[0]; d[i + 1] = col[1]; d[i + 2] = col[2]; d[i + 3] = 255;
    }
    if (!shape) for (let i = 0; i < d.length; i += 4) { d[i] = C.ukr[0]; d[i + 1] = C.ukr[1]; d[i + 2] = C.ukr[2]; }
    g.putImageData(img, 0, 0);
    g.fillStyle = INS.route;
    for (let i = 0; i < rx.length; i++) g.fillRect(rx[i], ry[i], 1, 1);
    return c;
  }

  function buildTop() {
    const [c, g] = mk();
    const cities = ((data.meta && data.meta.places) || []).filter(p => p.type === 'city');
    const used = [];
    const free = (x, y, w, h) => x >= 0 && y >= 0 && x + w <= W && y + h <= H &&
      !used.some(u => x < u[0] + u[2] && x + w > u[0] && y < u[1] + u[3] && y + h > u[1]);
    for (const p of cities) {
      const q = data.pointAt(p.km * 1000), x = Math.round(X(q.lon)), y = Math.round(Y(q.lat));
      g.fillStyle = INS.cityDot; g.fillRect(x - 1, y - 1, 3, 3);
      g.fillStyle = INS.cityHi; g.fillRect(x, y, 1, 1);
      used.push([x - 1, y - 1, 3, 3]);
    }
    if (font) {
      g.fillStyle = INS.seaLabel;
      const sx = Math.round(X(34.3)), sy = Math.round(Y(43.55));
      font.drawText(g, 'Чорне море', sx, sy, INS.seaLabel, { align: 'center' });
      for (const p of cities) {
        const q = data.pointAt(p.km * 1000), x = Math.round(X(q.lon)), y = Math.round(Y(q.lat));
        const tw = font.measureText(p.name), th = 7;
        const tries = [[x + 3, y - 3], [x - (tw >> 1), y - 9], [x - (tw >> 1), y + 3], [x - tw - 3, y - 3], [x + 3, y - 9], [x + 3, y + 2]];
        const spot = tries.find(([tx, ty]) => free(tx - 2, ty - 1, tw + 4, th)) || tries[0];
        used.push([spot[0] - 2, spot[1] - 1, tw + 4, th]);                  // 2-px gap so neighbouring names never touch
        font.drawText(g, p.name, spot[0], spot[1], INS.label, { shadow: INS.labelShadow });
      }
    }
    return c;
  }

  let shape = null;
  loadShape().then(m => { shape = m; base = null; });
  return {
    draw(drivenM, markerM = drivenM) {
      if (!base) base = buildBase(shape);
      if (!top || topGen !== fontGen) { top = buildTop(); topGen = fontGen; }
      ctx.drawImage(base, 0, 0);
      let n = 0;
      while (n < rx.length && rm[n] <= drivenM) n++;
      ctx.fillStyle = INS.drivenShadow;
      for (let i = 0; i < n; i++) ctx.fillRect(rx[i], ry[i] + 1, 1, 1);
      ctx.fillStyle = INS.driven;
      for (let i = 0; i < n; i++) ctx.fillRect(rx[i], ry[i], 1, 1);
      ctx.drawImage(top, 0, 0);
      const q = data.pointAt(clamp(markerM, 0, data.lengthM)), x = Math.round(X(q.lon)), y = Math.round(Y(q.lat));
      if ((performance.now() / 400 | 0) % 2) {
        ctx.fillStyle = INS.markerHi; ctx.fillRect(x - 2, y - 1, 5, 3); ctx.fillRect(x - 1, y - 2, 3, 5);
        ctx.fillStyle = INS.marker; ctx.fillRect(x - 1, y - 1, 3, 3);
      } else { ctx.fillStyle = INS.marker; ctx.fillRect(x, y, 1, 1); }
    },
  };
}
