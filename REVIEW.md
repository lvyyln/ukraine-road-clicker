# Final review — «Дорога України»

Reviewer: DATA agent. Scope: everything in `game/` and `tools/`, plus `.team/notes-*.md` (none were filed).
Per-owner details are in `.team/review-{A,B,C,D}.md`.

## Verdict

The game is releasable. No blocking bugs, no XSS, and no contract violations. Save handling is defensive. All URLs are
relative and the file-name case matches, so it is itch.io- and GitHub Pages-safe. Smoke test at `http://localhost:8084`:
the page loads, gas/shop work, the fly-through (`?fly=790`, Ходьба/Політ, seek, Вийти) works, the Leaflet map loads OSM
tiles, and the console has **zero errors**.

## Findings

| # | owner | file:line | severity | finding | status |
|---|-------|-----------|----------|---------|--------|
| C1 | C | game.js:652-653 | medium | In-session offline credit uses `Date.now()`, so a clock change while the tab is hidden farms 8 h of income per hide/show. Use `performance.now()` | **fixed** (performance.now) |
| C2 | C | game.js:703 | low | Cross-session clock-forward gives ≤ 8 h per reload. Optional `maxSeenAt` guard | **fixed** (savedAt never moves back) |
| C3 | C | game.js:109-116, economy.js:124 | low | A save with another `v` counts as corrupt and is overwritten for good. Keep a `.corrupt` copy and add a migrate hook | **fixed** (.corrupt copy + MIGRATIONS hook; verified in Node) |
| C4 | C | game.js:374 | nit | town and city both say «Місто» (intended?) | **fixed** («Містечко») |
| B1 | B | vehicles.js:569 | low | «байдуже на бездоріжжя» is a Russian calque. Use «якому бездоріжжя не страшне» | **fixed** («якому бездоріжжя не страшне») |
| B2 | B | vehicles.js:314 | nit | ЛуАЗ has no night palette | won't fix — intentional (open-top), now commented |
| D1 | D | map.js:15-16 | low | Leaflet from cdnjs has no SRI `integrity` | open |
| D2 | D | map.js:26 | nit | town → «містечко» vs «місто» in game.js | open |
| A1 | A | data.js:142 | nit | placesNear allocates per hit (fine for current callers) | info |

Checked and clean:
- Integer drawing everywhere except the documented vehicle tilt.
- No per-frame allocations in scene/vehicles.
- Listeners are removed on fly stop and map close.
- No Russian-only letters in the UI text.
- The apostrophe in «з’єднання» is a typographic ’, as are the font aliases ’ ʼ.
- Place names never reach `innerHTML` unescaped.

## Data and tooling (DATA's own)

- The route was rebuilt as Ужгород → Львів → Київ → Харків: 1 265.4 km, 126 541 samples, 127 stations, 204 places,
  77 river crossings, Дніпро at km 794.4. `node tools/check-route.mjs` passes.
- The pipeline is hardened in these ways:
  - Overpass is cached by the SHA-1 of the query, and only valid answers are cached.
  - Requests back off and fall back to a second endpoint.
  - A failing chunk is split recursively (2 splits were needed). A chunk that still fails fails the build unless `--allow-missing-places` is passed.
  - The grid search radius is computed per axis, and places are projected onto the nearest route segment.
  - Out-and-back spurs at via points are cut (876 m at Львів).
  - Road tiles are padded, which fixes 0 m elevation holes near Житомир, and missing tiles now fail the build.
- `lengthM` is now `(count − 1) × stepM`, exactly as the contract implies. OSRM's own length is kept as `osrmLengthM`.
- `tools/package-itch.mjs` builds `dist/ukraine-road-clicker-itch.zip`: 14 files, 2.16 MB, `index.html` at the root, dev pages
  excluded, CRCs verified.
