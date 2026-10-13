# Дорога України — Ukraine Road Clicker

A pixel-art browser clicker about a road trip across Ukraine. You drive **real OpenStreetMap roads**
past **real terrain**. The default route runs from Ужгород through Львів and Київ to Харків
(~1,270 km, one road sample every 10 m). The Carpathian ridges, the Dnipro crossing and every
town on the horizon come from open data. You click to drive and earn hryvnias (₴). You then buy
vehicles, from a bicycle «Україна» to the Ан-2 «Кукурузник» (and the Ан-225 «Мрія» as a tribute).
Those vehicles drive on their own.

Everything runs in the browser as vanilla ES modules: no build step and no npm packages at
runtime. The only exception is Leaflet 1.9.4 from cdnjs, which the map loads lazily.

## Play online

- **GitHub Pages:** <https://lvyyln.github.io/ukraine-road-clicker/>
- **itch.io:** <https://lvyyln.itch.io/ukraine-road-clicker> *(placeholder until the page is published)*

## How to play

| control | what it does |
|---------|--------------|
| **«Газ!»** button, **Space**, or a click/tap on the picture | drive a few metres; every metre earns ₴ |
| **Покращення** (shop) | 🏎 Кермо: more metres per click · ⛽ Пальне: faster autopilot · 📦 Вантаж: more ₴ per metre · 👷 Помічник: presses «Газ!» for you |
| **Транспорт** (shop) | buy the next vehicle in order: bike → moped → Запорожці → Таврія → ЛуАЗ → ЛАЗ → Богдан → КрАЗ → Електрон → Ан-2 → Ан-225 «Мрія» |
| 🗺 **Мапа** | real OpenStreetMap map with the route, towns, river crossings and your position (Esc closes it) |
| 🎥 **Проліт** | fly-through of the whole route. Scrub by km, toggle «Ходьба/Політ» (or press F), Space pauses, ←/→ jump 10 km, «Вийти» or Esc exits. Earning goes on in the background. |
| ❓ **Як грати** | in-game rules. Hover or long-press any number or button for a tooltip. |
| ↺ **Скинути** | wipe progress (asks first) · 🔊 sound · ⛶ fullscreen |

Every city, town and village you pass pays a bonus, and so does every bridge over a river. The
Дніпро pays the most. While you are away, the autopilot keeps earning: half the rate, for up to
8 hours. Progress is saved automatically in the browser (`localStorage`).



## Run it locally

```sh
npm install                      # only needed for the route builder (pngjs)
node tools/serve.mjs             # or: npm run serve   → http://localhost:8080
node tools/serve.mjs --port 8090 # another port
```

Then open <http://localhost:8080>. The game uses `fetch()` for its data files, so opening
`game/index.html` straight from disk (`file://`) will not work. Any static web server will do;
`tools/serve.mjs` is zero-dependency, binds to localhost only and disables caching.

Useful URL parameters:

| parameter  | effect |
|------------|--------|
| `?fly=420` | opens the fly-through at km 420 |
| `?nosave`  | does not read or write the save (good for testing) |
| `?km=300`  | starts at km 300 (implies no saving) |
| `?tod=0.9` | fixes the time of day (0 = midnight, 0.5 = noon) |

## Build any route

`tools/build-route.mjs` downloads everything it needs from free public services and writes
`game/data/`. Without `--yes` it only prints an estimate:

```sh
node tools/build-route.mjs --from "Ужгород" --via "Львів;Київ" --to "Харків"
#   ── estimate ─────────────────────────────
#   road length        1269.2 km (126,626 samples)
#   panoramas          127 × 61×61 km heightmaps
#   terrain tiles      240 road (z12) + 195 horizon (z10), 378 cached
#   download           ~5 MB, ~2 min
#   output size        ~2.1 MB
#   cost               $0 — all sources are free public OSM / AWS Open Data services

node tools/build-route.mjs --from "Ужгород" --via "Львів;Київ" --to "Харків" --quality ultra --yes
node tools/build-route.mjs --from "Одеса" --to "Харків" --yes
node tools/build-route.mjs --from "Чернівці" --via "Тернопіль;Вінниця" --to "Одеса" --quality standard --yes
node tools/check-route.mjs --expect "Тернопіль;Вінниця;Одеса" --river "Дністер"   # sanity checks
```

- `--from`, `--to` and `--via "A;B;C"` take any place name that Nominatim can find in Ukraine.
  Via points force the route through those places.
- `--quality draft | standard | ultra` (default `ultra`):

  | preset   | road sample spacing | panorama spacing | azimuths per panorama | terrain zoom (road / horizon) | output for ~1,270 km |
  |----------|--------------------:|-----------------:|----------------------:|-------------------------------|---------------------:|
  | draft    | 50 m                | 25 km            | 180 (every 2°)        | z11 / z9                      | ~0.4 MB              |
  | standard | 20 m                | 10 km            | 360 (every 1°)        | z12 / z10                     | ~1.0 MB              |
  | ultra    | 10 m                | 10 km            | 720 (every 0.5°)      | z12 / z10                     | ~2.1 MB              |

- `--allow-missing-places` still writes the route if some Overpass chunks keep failing. Without
  it, the build stops rather than ship a route with silent gaps in its town list.
- Every download is cached in `tools/.cache/`: terrain tiles, plus valid Overpass answers keyed by
  the SHA-1 of the query. Re-runs are fast and polite to the servers.
- The game reads all lengths and counts from `route.json`. A new route needs no code changes.

Pipeline: geocode the stops (Nominatim) → route by car (OSRM) → resample the polyline every
`stepM` → sample road elevation from terrain tiles, then smooth it with a median+mean filter
(~150 m) to remove bridge dips and cutting spikes → compute a horizon panorama every `stationM`
from a 61 × 61 km heightmap (earth curvature and refraction applied, eye height 2.5 m, in three
distance bands) → query Overpass in ~60 km bbox chunks for cities, towns, villages and rivers, and
match them to the road locally (towns within 4 km, villages within 800 m, rivers by real segment
intersection).

## Data format (`game/data/`)

| file          | content |
|---------------|---------|
| `route.bin`   | little-endian Float32 triples `[lat, lon, eleMetres]`; sample *i* is *i × stepM* metres along the road |
| `horizon.bin` | little-endian Int16 `[station][band][az]`, horizon elevation angle in centi-degrees. Station *s* is at *s × stationM*. Bands: 0 = 0.15–3 km, 1 = 3–10 km, 2 = 10–30.5 km. Azimuth *a* = bearing *a × 360 / az*, clockwise from north |
| `route.json`  | `{ version, built, quality, from, to, via[], lengthM, stepM, count, stationM, stations, az, bands, stationEle[], eleMin, eleMax, places: [{km, name, type, pop}], rivers: [{km, name}], attribution }` |

`type` is `city`, `town` or `village`. `km` is the distance along the road. Names prefer OSM
`name:uk`. `lengthM = (count − 1) × stepM`. `osrmLengthM` holds OSRM's own figure.

## Publish

The game is a set of plain static files. Every URL in it is relative, so it runs from any
sub-path, over HTTPS and inside an iframe.

### GitHub Pages

`.github/workflows/pages.yml` deploys `game/` automatically on every push to `main`. It first
drops the dev-only pages `map-test.html`, `scene-test.html` and `sprites.html`. Before the first
deploy, open the repository's **Settings → Pages** and set **Source** to **GitHub Actions**.

### itch.io (HTML5)

```sh
npm run package-itch     # → dist/ukraine-road-clicker-itch.zip
```

The script zips the contents of `game/` with `index.html` at the zip root. It leaves out dev-only
pages and OS junk. It fails loudly if itch.io limits are exceeded: max 1000 files, under 500 MB
extracted, and no file of 200 MB or more.

1. On itch.io, go to **Create new project**.
2. Set **Kind of project** to **HTML**.
3. Upload `dist/ukraine-road-clicker-itch.zip` and tick **This file will be played in the browser**.
4. Under **Embed options**, set the viewport size, for example **1152 × 648**. That is exactly 3× the
   384 × 216 scene, so the pixels stay crisp. Tick **Fullscreen button**. Optionally tick
   **Mobile friendly**.
5. Save, then view the page to test it.

Optional CLI route with [butler](https://itch.io/docs/butler/):

```sh
butler push dist/ukraine-road-clicker-itch.zip <user>/<game>:html5
```

## Data sources and licences

- **Roads, places, rivers:** © OpenStreetMap contributors, available under the
  [Open Database License (ODbL)](https://www.openstreetmap.org/copyright). The data is accessed via
  - [Nominatim](https://nominatim.openstreetmap.org/) (geocoding),
  - [OSRM on routing.openstreetmap.de](https://routing.openstreetmap.de/) (car routing),
  - the [Overpass API](https://overpass-api.de/) (with [overpass.private.coffee](https://overpass.private.coffee/) as a fallback).
- **Terrain:** [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (Terrarium PNG
  encoding). These are built from SRTM (NASA) and other open elevation sources. See their
  [attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).
- **Map tiles in the in-game map:** © OpenStreetMap contributors.

The game shows the attribution «© OpenStreetMap contributors» in its UI.
