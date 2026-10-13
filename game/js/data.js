// Data access for «Дорога України».
// loadData(base) fetches route.json + route.bin + horizon.bin and exposes fast,
// allocation-free lookups (see the Data typedef below). Works in the browser and in Node (fetch).
//
// Data = {
//   meta, lengthM,
//   pointAt(m) -> { lat, lon, ele, heading, grade }
//   horizonAt(m, bearingDeg, band) -> degrees
//   placesNear(m, radiusM = 5000) / riversNear(m, radiusM = 2000) -> [{ ...item, dM }] sorted by |dM|
//   nextPlace(m) -> { place, dM } | null
//   latlngs(stepM = 500) -> [[lat, lon], ...]
//   // extras (non-contract, used by scene.js): eleAt(m), headingAt(m), gradeAt(m), stationEleAt(m),
//   //   bearingBetween(m1, m2), places/rivers (km-sorted), placeM/riverM (Float64Array metres)
// base is fetched as given: keep it RELATIVE in the game ('data/') so it works inside an itch.io iframe.
// }

const DEG = Math.PI / 180;

async function fetchOk(url, kind) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('loadData: ' + url + ' → HTTP ' + r.status);
  return kind === 'json' ? r.json() : r.arrayBuffer();
}

function lowerBound(arr, v) { // first index with arr[i] >= v
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
  return lo;
}

export async function loadData(base = 'data/') {
  if (base && !base.endsWith('/')) base += '/';
  const [meta, rbuf, hbuf] = await Promise.all([
    fetchOk(base + 'route.json', 'json'),
    fetchOk(base + 'route.bin', 'buf'),
    fetchOk(base + 'horizon.bin', 'buf'),
  ]);

  // ---- road samples (little-endian Float32 triples) ----
  const rv = new DataView(rbuf);
  const count = Math.floor(rbuf.byteLength / 12);
  const lat = new Float64Array(count), lon = new Float64Array(count), ele = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    lat[i] = rv.getFloat32(i * 12, true);
    lon[i] = rv.getFloat32(i * 12 + 4, true);
    ele[i] = rv.getFloat32(i * 12 + 8, true);
  }
  const stepM = meta.stepM || 10;
  const lastM = (count - 1) * stepM;
  const lengthM = Math.min(meta.lengthM || lastM, lastM);

  // ---- horizon (little-endian Int16 centi-degrees) → Float32 degrees ----
  const az = meta.az || 720;
  const nBands = (meta.bands && meta.bands.length) || 3;
  const hvw = new DataView(hbuf);
  const hn = Math.floor(hbuf.byteLength / 2);
  const hor = new Float32Array(hn);
  for (let i = 0; i < hn; i++) hor[i] = hvw.getInt16(i * 2, true) / 100;
  const stations = Math.max(1, Math.min(meta.stations || 1, Math.floor(hn / (nBands * az))));
  const stationM = meta.stationM || 10000;
  const azPerDeg = az / 360;
  const stationEle = meta.stationEle || [];

  // ---- places / rivers (sorted by km) ----
  const places = (meta.places || []).slice().sort((a, b) => a.km - b.km);
  const rivers = (meta.rivers || []).slice().sort((a, b) => a.km - b.km);
  const placeM = Float64Array.from(places, p => p.km * 1000);
  const riverM = Float64Array.from(rivers, r => r.km * 1000);

  // ---- scalar, allocation-free lookups ----
  function idxF(m) { // fractional sample index, clamped
    if (!(m > 0)) return 0;
    if (m >= lastM) return count - 1;
    return m / stepM;
  }
  function lerpArr(arr, m) {
    const f = idxF(m), i = Math.floor(f), t = f - i;
    if (i >= count - 1) return arr[count - 1];
    return arr[i] + (arr[i + 1] - arr[i]) * t;
  }
  const eleAt = m => lerpArr(ele, m);
  const latAt = m => lerpArr(lat, m);
  const lonAt = m => lerpArr(lon, m);
  function bearing(la1, lo1, la2, lo2) {
    const p1 = la1 * DEG, p2 = la2 * DEG, dl = (lo2 - lo1) * DEG;
    const y = Math.sin(dl) * Math.cos(p2);
    const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
    let b = Math.atan2(y, x) / DEG;
    b = ((b % 360) + 360) % 360;
    return b >= 360 ? 0 : b;
  }
  function headingAt(m) {
    m = Math.max(0, Math.min(lengthM, m));
    let a = m - 50, b = m + 50;
    if (a < 0) { b -= a; a = 0; }
    if (b > lastM) { a -= b - lastM; b = lastM; if (a < 0) a = 0; }
    return bearing(latAt(a), lonAt(a), latAt(b), lonAt(b));
  }
  function bearingBetween(a, b) { // bearing from road point a to road point b (metres along road)
    a = Math.max(0, Math.min(lastM, a)); b = Math.max(0, Math.min(lastM, b));
    if (Math.abs(b - a) < 1) return headingAt(a);
    return bearing(latAt(a), lonAt(a), latAt(b), lonAt(b));
  }
  function gradeAt(m) {
    m = Math.max(0, Math.min(lengthM, m));
    let a = m - 25, b = m + 25;
    if (a < 0) a = 0;
    if (b > lastM) b = lastM;
    if (b - a < 1) return 0;
    return (eleAt(b) - eleAt(a)) / (b - a);
  }
  function stationEleAt(m) {
    if (!stationEle.length) return eleAt(m);
    const f = Math.max(0, Math.min(stationEle.length - 1, m / stationM));
    const i = Math.floor(f), j = Math.min(i + 1, stationEle.length - 1);
    return stationEle[i] + (stationEle[j] - stationEle[i]) * (f - i);
  }

  function pointAt(m) {
    m = Math.max(0, Math.min(lengthM, +m || 0));
    return { lat: latAt(m), lon: lonAt(m), ele: eleAt(m), heading: headingAt(m), grade: gradeAt(m) };
  }

  function horizonAt(m, bearingDeg, band) {
    let f = m / stationM;
    if (!(f > 0)) f = 0;
    if (f > stations - 1) f = stations - 1;
    const s0 = Math.floor(f), s1 = s0 < stations - 1 ? s0 + 1 : s0, ts = f - s0;
    let fa = bearingDeg * azPerDeg;
    fa = fa % az; if (fa < 0) fa += az;
    const a0 = Math.floor(fa) % az, a1 = a0 + 1 === az ? 0 : a0 + 1, ta = fa - Math.floor(fa);
    const b = band < 0 ? 0 : band >= nBands ? nBands - 1 : band | 0;
    const r0 = (s0 * nBands + b) * az, r1 = (s1 * nBands + b) * az;
    const v0 = hor[r0 + a0] + (hor[r0 + a1] - hor[r0 + a0]) * ta;
    const v1 = hor[r1 + a0] + (hor[r1 + a1] - hor[r1 + a0]) * ta;
    return v0 + (v1 - v0) * ts;
  }

  function near(list, ms, m, radiusM) {
    const out = [];
    for (let i = lowerBound(ms, m - radiusM); i < ms.length && ms[i] <= m + radiusM; i++) {
      out.push(Object.assign({}, list[i], { dM: ms[i] - m }));
    }
    out.sort((a, b) => Math.abs(a.dM) - Math.abs(b.dM));
    return out;
  }
  const placesNear = (m, radiusM = 5000) => near(places, placeM, m, radiusM);
  const riversNear = (m, radiusM = 2000) => near(rivers, riverM, m, radiusM);
  function nextPlace(m) {
    let i = lowerBound(placeM, m);
    while (i < placeM.length && placeM[i] <= m) i++;
    return i < places.length ? { place: places[i], dM: placeM[i] - m } : null;
  }

  function latlngs(step = 500) {
    const stride = Math.max(1, Math.round(step / stepM));
    const out = [];
    for (let i = 0; i < count; i += stride) out.push([lat[i], lon[i]]);
    if ((count - 1) % stride) out.push([lat[count - 1], lon[count - 1]]);
    return out;
  }

  return {
    meta, lengthM, pointAt, horizonAt, placesNear, riversNear, nextPlace, latlngs,
    // extras for the renderer (not part of the shared contract)
    eleAt, headingAt, gradeAt, stationEleAt, bearingBetween, places, rivers, placeM, riverM, stations, stationM, nBands,
  };
}
