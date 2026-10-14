#!/usr/bin/env node
// Rebuilds game/js/mapshape.js (inset-map borders) from a local copy of Natural Earth 1:50m countries:
//   curl -LO https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_countries.geojson
//   node tools/build-mapshape.mjs ne_50m_admin_0_countries.geojson game/js/mapshape.js
// Usage: node tools/build-mapshape.mjs <ne_50m_admin_0_countries.geojson> <out.js>
import fs from 'node:fs';
const [, , src, out] = process.argv;
const g = JSON.parse(fs.readFileSync(src, 'utf8'));
const BOX = [21.0, 42.6, 41.4, 53.0]; // lon0 lat0 lon1 lat1
const inPoly = (pt, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi) + xi) c = !c; } return c; };
function clip(ring) { // Sutherland–Hodgman against BOX
  const edges = [[p => p[0] >= BOX[0], (a, b) => ix(a, b, 0, BOX[0])], [p => p[0] <= BOX[2], (a, b) => ix(a, b, 0, BOX[2])],
    [p => p[1] >= BOX[1], (a, b) => ix(a, b, 1, BOX[1])], [p => p[1] <= BOX[3], (a, b) => ix(a, b, 1, BOX[3])]];
  function ix(a, b, k, v) { const t = (v - a[k]) / (b[k] - a[k]); return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]; }
  let pts = ring;
  for (const [inside, cut] of edges) {
    const res = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i];
      if (inside(b)) { if (!inside(a)) res.push(cut(a, b)); res.push(b); } else if (inside(a)) res.push(cut(a, b));
    }
    pts = res; if (!pts.length) break;
  }
  return pts;
}
function dp(pts, tol) { // Douglas–Peucker on a closed ring (lon scaled by cos lat)
  const k = Math.cos(48.5 * Math.PI / 180);
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const mid = pts.length >> 1; keep[mid] = 1; const st = [[0, mid], [mid, pts.length - 1]];
  while (st.length) {
    const [a, b] = st.pop(); let best = -1, bi = -1;
    const ax = pts[a][0] * k, ay = pts[a][1], bx = pts[b][0] * k, by = pts[b][1], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-9;
    for (let i = a + 1; i < b; i++) { const d = Math.abs((pts[i][0] * k - ax) * dy - (pts[i][1] - ay) * dx) / L; if (d > best) { best = d; bi = i; } }
    if (best > tol) { keep[bi] = 1; st.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}
const area = r => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s / 2); };
const enc = r => '[' + r.map(p => Math.round(p[0] * 100) + ',' + Math.round(p[1] * 100)).join(',') + ']';
const ukr = [], other = [];
let total = 0;
for (const f of g.features) {
  const a3 = f.properties.ADM0_A3;
  const polys = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const pl of polys) {
    const outer = pl[0];
    const isCrimea = a3 === 'RUS' && inPoly([34.1, 44.95], outer);
    let c = clip(outer); if (c.length < 3) continue;
    if (area(c) < 0.02) continue;
    const s = dp(c.concat([c[0]]), a3 === 'UKR' || isCrimea ? 0.035 : 0.07).slice(0, -1);
    if (s.length < 3) continue;
    total += s.length;
    (a3 === 'UKR' || isCrimea ? ukr : other).push(s);
  }
}
const lines = [
  '// Simplified borders for the inset map (lon, lat × 100, flat [x0,y0,x1,y1,…] rings).',
  '// Source: Natural Earth 1:50m admin-0 countries (public domain), clipped to 21–41.4°E, 42.6–53°N,',
  '// Douglas–Peucker simplified. Ukraine includes Crimea (internationally recognised borders).',
  `export const BOX = [${BOX.map(v => v * 100).join(', ')}];`,
  `export const UKRAINE = [\n  ${ukr.map(enc).join(',\n  ')},\n];`,
  `export const NEIGHBOURS = [\n  ${other.map(enc).join(',\n  ')},\n];`, ''];
fs.writeFileSync(out, lines.join('\n'));
console.log('ukraine rings', ukr.map(r => r.length), 'neighbours', other.map(r => r.length), 'total pts', total);
