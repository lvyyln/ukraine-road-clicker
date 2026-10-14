# tools/pixel — free pixel-art pipeline

Two tools, no paid services, no GPU AI models:

- **`pixelize.mjs`** — Node CLI: any PNG (Blender render, photo, AI image) → clean game pixel art.
- **`blender-sprite.py`** — renders consistent sprite frames in headless Blender (fixed camera
  presets, shared ortho scale, animation), then pixelizes them into a sprite sheet.

Research, comparison of AI tools, and the honest quality notes are in
[`docs/PIXEL-ART-TOOLS.md`](../../docs/PIXEL-ART-TOOLS.md).

## Setup

```
cd tools/pixel && npm install        # only dependency: pngjs (pure JS, ~0.7 MB)
```

Blender 5.2 is needed only for `blender-sprite.py`.

## pixelize.mjs

```
node tools/pixel/pixelize.mjs in.png out.png --w 64 --colors 16 --outline --dither bayer4 --palette ukraine
node tools/pixel/pixelize.mjs frames/ out/ --w 48 --palette ukraine --outline --sheet out/car_sheet.png --cols 4
node tools/pixel/pixelize.mjs --help
```

Pipeline: **key background → (trim) → downscale → grade → palette → dither → cleanup → outline → upscale**.

| Option | Default | What it does |
|---|---|---|
| `--w N` / `--h N` | 64 / aspect | Output size. With `--outline` the content is shrunk by 2 px so the size stays `--w`. |
| `--sample` | `dominant` | `dominant` = 2-means per cell, keep the majority colour (crisp edges, no AA mush). `area` = alpha-weighted average (softer). `center` = nearest neighbour. |
| `--alpha T` | 0.5 | A cell is opaque when at least T of it is covered. Output alpha is always 0 or 255. |
| `--trim` | off | Crop to the opaque box. In batch mode it uses the **union** box of all frames, so animation stays aligned. |
| `--colors N` | 16 | k-means (k-means++ init, OKLab) palette size. |
| `--palette P` | `auto` | `auto`, `ukraine`, `pico8`, or a `.hex`/`.gpl`/`.txt` file (Lospec/GIMP format). With a palette plus `--colors N`, the image gets the N best-fitting palette entries. |
| `--merge X` | 0.04 | Auto palette only: fold near-duplicate colours together. |
| `--chroma-weight X` | 2 | Palette matching: how much hue/chroma counts against lightness. |
| `--sat` / `--contrast` | 1.15 / 1.08 | Grade before quantising (renders read flat as pixel art otherwise). |
| `--dither` | `none` | `bayer2`, `bayer4`, `bayer8`. Ordered dither on lightness only. `--dither-amt` 0..1 (0.5). |
| `--outline [hex]` | off | 1-px outline round the silhouette (default colour = darkest colour of the full palette). |
| `--outline-style` | `solid` | `selective` = a darker shade of the colour next to the edge (softer, "pro" look). |
| `--inner-shade` | off | Darken the bottom/right inner silhouette edge one step. |
| `--cleanup N` | 1 | Passes that remove floating specks, 1-px silhouette spikes, orphan colour pixels and pin-holes. |
| `--key K` | `auto` | Background removal. `auto` keeps existing alpha; otherwise it flood-fills from the border with the most common border colour. `#rrggbb` gives an explicit key colour; `none` disables it. `--key-tol` 40. |
| `--scale N` | 1 | Nearest-neighbour upscale of the main output. |
| `--preview N` | off | Also writes `name@Nx.png`. |
| `--compare F` | — | Single-file mode: before/after image side by side. |
| `--sheet F` / `--cols N` | — | Batch mode: pack frames (sorted by name) into a sheet plus `F.json` (frame rects). |
| `--shared-palette` | on | Batch mode: one palette for every frame (no colour flicker in animation). |

Speed (measured): about 0.1–0.6 s per 384–512 px frame on the i7-6700, single-threaded.

### Palettes (`palettes/`)

- `ukraine.hex`: 37 colours for the countryside. It has asphalt and concrete greys, panel-block beige, soil and wood, wheat and flag yellow with darker ochre ramps, field and poplar greens, sky and flag blue, roof red, and signal red/amber. It is built from the colours the game already uses.
- `pico8.hex`: the standard PICO-8 16.
- Add your own by dropping a Lospec `.hex` file here and passing `--palette <name>`.

**Palette tip:** a fixed palette needs a *ramp* (light → dark) for every main object colour. Otherwise shadows jump to another hue. For example, with pico8 a yellow car's shaded side turns green, because pico8 has no dark ochre.

## blender-sprite.py

```
"C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup -P tools/pixel/blender-sprite.py -- --model car --preset rear-chase --frames 4 --color "#c8302a" --out tools/pixel/samples/car-rear-chase --pixelize "--w 48 --colors 12 --palette ukraine --outline --preview 6"
```
(In PowerShell, prefix the quoted exe path with `&`.)

| Arg | Meaning |
|---|---|
| `--model` | `car` (5-door hatchback), `khrushchevka` (5-storey panel block), `poplar`, or a path to `.blend`/`.glb`/`.gltf`/`.fbx`/`.obj` |
| `--preset` | `rear-chase` (az 0°, el 14°), `side` (90°, 6°), `three-quarter` (35°, 28°), `front`, `top-down`, `turntable` (`--angles N` directions) |
| `--elev D` | override camera elevation |
| `--frames N` | animation: car = wheel spin + suspension bob; poplar = wind sway; `.blend` = its own timeline sampled N times |
| `--res` | render size (384) |
| `--color` | car body colour |
| `--engine` | `eevee` (default), `workbench`, `cycles` (CPU) |
| `--persp` | perspective camera instead of orthographic |
| `--out` | writes `raw/` (transparent renders) and, with `--pixelize`, `px/` plus `<name>_sheet.png/.json` |

All frames in one run use the **same orthographic scale**, so a car is the same pixel size in every direction and animation frame. Fixed views are centred on the silhouette. Turntable views stay centred on the model, so the anchor doesn't jump. The view transform is `Standard`, not AgX, so colours stay flat and saturated.

A 1-frame run takes about 12–16 s, most of it Blender start-up and shader compilation. Extra frames are quick (EEVEE, GTX 1080).

## Samples (`samples/`)

| Folder | Content |
|---|---|
| `car-rear-chase/` | 4-frame rear chase view, 48 px, red |
| `car-side/` | 4-frame side view with wheel spin, 64 px, flag blue |
| `car-turntable/` | 8 directions, 48 px, yellow |
| `poplar-sway/` | 4-frame sway, 18 px wide (trimmed) |
| `khrushchevka/raw/` | facade and 3/4 renders (pixelized versions in `compare/`) |
| `compare/` | `*_before-after.png` pairs plus the bare outputs; variants show auto palette, pico8, `--sample area`, selective outline, Bayer dither |

All sample inputs are procedural Blender geometry made by `blender-sprite.py`. No third-party images or models are used.
