# Pixel-art tools for «Дорога України»

_Researched and built 2026-10-14. Prices and quotas change, so recheck the links before you pay for anything._

The US game we are modelled on made all of its art (1,185 images, 71 of them animated vehicles) with an AI tool called «Pixel Diffusion». Our hand-coded `fillRect` art looks poorer. This page covers three things:

1. Which free or cheap AI tools exist, and what this PC can run.
2. The free pipeline we built and own: `tools/pixel/`.
3. How good its output really is, and what to do next.

---

## TL;DR: top 3 for this machine

| | **A. Our Blender → pixelize pipeline** (built) | **B. PixelLab free tier** | **C. Local SDXL + pixel-art-xl LoRA (ComfyUI)** |
|---|---|---|---|
| Cost | Free | Free: 40 fast generations, then 5 slow ones a day. Paid plans $12 / $24 / $50 a month | Free |
| Licence of output | Ours: procedural geometry, our code | Users own the copyright; commercial use allowed on every tier; outputs may not be used to train models ([ToS](https://www.pixellab.ai/termsofservice)) | SDXL OpenRAIL++-M and pixel-art-xl OpenRAIL-M: commercial use of images is allowed |
| Runs on this PC? | **Yes, today.** About 15 s per run, a few MB on disk | Cloud only; nothing to install | **Borderline.** About 8 GB to download; slow on a GTX 1080 |
| Consistent sets / rotations / animation | **Best.** Same camera, scale and palette, generated mechanically | Good. Built-in 4/8-direction rotation and skeleton animation; official MCP server for Claude Code | Weak on its own. Needs img2img or ControlNet from our Blender renders for consistency |
| Look | Clean, "low-poly-render" pixel art. Only as rich as the 3D model | Hand-drawn feel; strongest for characters | Richest texture and detail, but noisy and off-grid; needs our pixelizer afterwards |

**Recommendation:**
- Use **A** for every vehicle, building and roadside prop where consistency matters, i.e. most of the game.
- Add **B** for a few hero images and characters, within the free daily quota.
- Try **C** only if you accept the downloads and the slowness. Then use it in img2img mode on top of A's renders and run its output through `pixelize.mjs`.

---

## 1. This machine

Measured with `nvidia-smi` and `Get-CimInstance`:

| Part | Value | Meaning for AI art |
|---|---|---|
| GPU | NVIDIA **GTX 1080, 8 GB VRAM** (Pascal, driver 582.66, CUDA 13.0) | No tensor cores, and fp16 brings no speed gain. SD 1.5 runs fine; SDXL is slow; Flux is impractical |
| RAM | **16 GB**, only **0.8 GB free** when checked | The tight spot. SDXL and Flux offload weights to RAM; close Unity, Unreal and browsers first |
| CPU | i7-6700 (4 cores / 8 threads) | Fine for pixelize.mjs and Blender EEVEE |
| Disk | 86 GB free on C: | Enough for SD models |

**Unverified risk:** PyTorch's newest CUDA 12.8+ wheels have been dropping old GPU generations. On a GTX 1080 you may need a cu126 (or older) PyTorch build. Check before installing ComfyUI.

---

## 2. Research: what each option is

### «Pixel Diffusion», the tool the US game credits

- **What it most likely is:** an iOS / iPadOS / Apple-Silicon Mac app by Farida Yarullina ([App Store](https://apps.apple.com/us/app/pixel-diffusion/id6477541945)). It does text-to-pixel-art with fixed palettes and colour reduction.
- **Cost:** free download, then credits: 100 for $4.99, 1,000 for $19.99.
- **Licence:** the store page gives no commercial terms. **Doesn't run on Windows.**
- **Unverified:** I couldn't find the US game's credits page. Native animated vehicles suggest it may really have been Retro Diffusion or PixelLab under a loose name.

### Retro Diffusion (Astropulse)

The best-looking dedicated pixel model, but **not free and not open**.

- **Web / API:** 50 free credits at sign-up, then prepaid credits from $5, which never expire.
- **Price per image:** rd_fast $0.03, rd_plus $0.06, rd_pro $0.18. Animation $0.07–0.25; 8-direction rotation $0.25. The "Pixel Fixer" is free ([api-examples](https://github.com/Retro-Diffusion/api-examples)).
- **Local Aseprite extension:** a one-time $65 (Lite $20). It wants at least 4 GB VRAM and 16 GB RAM; fp8 needs an RTX 30-series or newer, so the 1080 is limited.
- **Licence:** sources say the local version's output is yours. I couldn't read the web terms (unverified).
- **Avoid:** a Hugging Face upload "LostMedia/RetroDiffusion" is of unknown origin.

**Verdict:** the cheapest paid upgrade if free isn't enough. About $10 of API credit buys roughly 150 rd_plus vehicles.

### PixelLab ([pixellab.ai](https://www.pixellab.ai))

- **Cost:** free tier of 40 fast generations, then 5 slow ones a day, no card. Paid: $12 / $24 / $50 a month.
- **Features:** 4/8-direction rotation (also isometric), skeleton- and text-driven animation, inpainting, tilesets, an Aseprite plugin, an API, and an **official MCP server** usable from Claude Code ([listing](https://mcpservers.org/servers/pixellab-code/pixellab-mcp)).
- **Licence:** commercial use is OK on all tiers.
- **Gaps:** cloud only. How well it handles vehicles rather than characters is unverified.

### Local Stable Diffusion with pixel-art LoRAs (ComfyUI / Forge / Fooocus)

Speeds below are estimates from public reports, not measured here.

| Model | Download | Licence (outputs) | GTX 1080 estimate |
|---|---|---|---|
| SD 1.5 + pixel LoRA or checkpoint | about 2 GB | OpenRAIL-M: commercial use OK | **About 8–10 s per 512² image. Best fit** |
| SDXL + [nerijs/pixel-art-xl](https://huggingface.co/nerijs/pixel-art-xl) (170 MB) + LCM-LoRA (about 0.4 GB) | about 7 GB | OpenRAIL++-M: commercial use OK | About 40–60 s per 1024² image at 25 steps; about 15–20 s with LCM (8 steps); needs `--medvram` |
| FLUX.1-schnell (GGUF Q4) | about 7 GB + T5 encoder | Apache-2.0 | About 1–2 min per image; RAM-starved here |
| FLUX.1-dev | about 7–23 GB | Model licence is non-commercial; outputs are usable commercially | Several minutes per image. **No** |
| SD 3.5 Medium/Large, FLUX.2 klein 4B, Z-Image-Turbo (6B, Apache-2.0) | 5–16 GB | Various | Borderline or unverified on Pascal |

- **Sprite-specific models:** the SD 1.5 checkpoint [SD_PixelArt_SpriteSheet_Generator](https://huggingface.co/Onodofthenorth/SD_PixelArt_SpriteSheet_Generator) (Apache-2.0) has front/right/back/left view trigger words. A FLUX.2-klein "spritesheet" LoRA (Apache-2.0) makes 2×2 views of one object; untested on a 1080.
- **Install cost if you choose this path** (nothing was downloaded):
  - ComfyUI portable with PyTorch: about 4–5 GB installed.
  - SDXL base fp16: 6.9 GB.
  - pixel-art-xl LoRA: 0.17 GB.
  - LCM-LoRA SDXL: 0.4 GB.
  - Optional SD 1.5 checkpoint: 2 GB.
  - **Total about 12–14 GB.**
- **Before generating:** close other big apps; RAM is the bottleneck.

### Open-source pixelization models

- **[Pixelization](https://github.com/WuZongWei6/Pixelization)** (SIGGRAPH Asia 2022) and the A1111 "Pixelization" extension that wraps it: **commercial use is forbidden** without permission. Avoid both.

### Algorithmic pixelizers: all free for commercial use

| Tool | Licence | Notes |
|---|---|---|
| [pyxelate](https://github.com/sedthh/pyxelate) | MIT | Python. Edge-aware downsampling, palette learning, dither, works on sequences |
| [PixelOE](https://github.com/KohakuBlueleaf/PixelOE) | Apache-2.0 | Python. Contrast-aware outline expansion; best for cleaning **AI output**; has a ComfyUI node |
| [proper-pixel-art](https://github.com/KennethJAllen/proper-pixel-art) | MIT | Python. Rebuilds the true pixel grid from noisy AI images |
| [pixelit](https://github.com/giventofly/pixelit) | MIT | JavaScript; simple |
| **our `pixelize.mjs`** | ours | JavaScript, no native deps; Blender-render-oriented, batch + sprite sheet |

Our tool covers the same ground as pyxelate and pixelit. PixelOE or proper-pixel-art are worth adding (via `uv`) **only** if we start generating with diffusion models, because their output has a jittery, half-pixel grid.

### Free Hugging Face Spaces

- **Quota:** ZeroGPU gives 2 min/day without login, 5 min/day with a free account, 40 min/day on PRO ([docs](https://huggingface.co/docs/hub/spaces-zerogpu)).
- **Current state:** most pixel-art generator Spaces showed **runtime errors** on 2026-10-14 (artificialguybr/pixel-art-generator, nerijs-xl demos and others).
- **Workaround:** duplicate a Space onto a free account (2 ZeroGPU Spaces allowed). Not a production pipeline.

### Clean-up editors

| Editor | Cost | Licence |
|---|---|---|
| Aseprite | $19.99 | Source-available EULA: you can compile it yourself for personal use but not redistribute it; your art is yours. The Retro Diffusion and PixelLab plugins live here |
| LibreSprite | Free | GPLv2 fork of 2016 Aseprite; older; no AI plugins |
| [Pixelorama](https://github.com/Orama-Interactive/Pixelorama) | Free | MIT; Godot-based; actively developed. **Recommended free choice** |

Our `.hex` palettes load in all three.

---

## 3. What we built: `tools/pixel/`

Full usage is in [`tools/pixel/README.md`](../tools/pixel/README.md). In short:

```
cd tools/pixel && npm install
node tools/pixel/pixelize.mjs in.png out.png --w 64 --colors 16 --outline --dither bayer4 --palette ukraine
node tools/pixel/pixelize.mjs frames/ out/ --w 48 --palette ukraine --outline --trim --sheet out/sheet.png --cols 4
"C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup -P tools/pixel/blender-sprite.py -- --model car --preset turntable --angles 8 --color "#f2c418" --out tools/pixel/samples/car-turntable --pixelize "--w 48 --colors 12 --palette ukraine --outline --preview 6"
```

### pixelize.mjs

- **Dependencies:** pure JavaScript, only `pngjs`.
- **Colour space:** OKLab throughout.
- **Background keying:** keeps existing alpha, or flood-fills from the border so same-coloured pixels inside the subject survive.
- **Trim:** in batch mode it uses the union box of all frames.
- **Downscale:** `dominant` is the default. It runs 2-means per cell and keeps the majority colour, so edges stay crisp. `area` and `center` are also available.
- **Grade:** saturation and contrast are adjusted before quantising.
- **Palette:** k-means++ with merging of near-duplicates. Or a palette file, reduced to the N best entries with uniqueness, so tail-light red and body red stay apart.
- **Dither:** ordered Bayer 2/4/8 on lightness only.
- **Cleanup:** removes specks, spikes, orphan pixels and pin-holes.
- **Outline:** solid or selective, plus an optional inner shade.
- **Output:** nearest upscale and preview; batch mode with a shared palette; sprite sheet + JSON; before/after compare images.

### blender-sprite.py

- **Models:** procedural car (5-door hatchback, any colour), хрущовка (5 storeys, 4 entrances, balconies) and Lombardy poplar. Or any `.blend` / `.glb` / `.fbx` / `.obj`.
- **Camera presets:** rear-chase, side, three-quarter, front, top-down, and turntable with N directions.
- **Framing:** one shared orthographic scale per run, computed from the projected silhouette.
- **Animation:** car wheel spin and suspension bob; poplar wind sway; a `.blend`'s own timeline.
- **Render:** EEVEE, `Standard` view transform, transparent film.
- **Hand-off:** optionally calls pixelize.mjs to build the sprite sheet.

---

## 4. Samples and an honest assessment

All inputs are our own procedural Blender geometry; there are no third-party images. Everything is in `tools/pixel/samples/`. The `compare/*_before-after.png` files show the render on the left and the pixel art on the right.

| Sample | Verdict |
|---|---|
| `car-turntable/car_sheet@6x.png`: 8 directions, 48 px, yellow | **Good.** It reads clearly as a car from every angle, with a consistent size, palette and outline. Shaded sides use the ochre ramp. This is the main proof that consistent vehicle sets are cheap |
| `car-side/car_sheet@6x.png`: 4 frames, 64 px | **Good.** A clean side profile; the hub bolt makes the wheel spin readable |
| `car-rear-chase/car_sheet@6x.png`: 4 frames, 48 px | **OK.** Tail lights, plate, rear glass and mirrors all read. The roof takes up a lot of the frame. The suspension bob is under one pixel at 48 px, so the 4 frames are nearly identical; use more bob or bigger sprites for a visible bounce |
| `compare/poplar_*`: 18 px, and 28 px dithered | **OK.** A recognisable poplar silhouette with a lit side. The 28 px Bayer-dithered version gets a nice leafy texture |
| `compare/khrushchevka-facade_*`: 128 px | **Fair.** The window grid is mostly regular, but there are a few light-blue anti-aliasing specks round the windows and the balcony shadows are muddy |
| `compare/khrushchevka-34_*`: 96 px, 3/4 view | **Weak.** The windows alias into an irregular grid. A downscaler can't make a 1-px window grid regular at an oblique angle. Use the facade view, or a bigger size, or hand-fix. Dither makes it worse |
| `compare/car-34_pico8_*` | Shows the fixed-palette limitation: pico8 has no dark yellow, so the shaded side turns **green**. The `--chroma-weight` option doesn't fix this; a palette with ramps does |
| `compare/car-34_sample-area_*` vs default | `area` is softer and muddier; `dominant` keeps edges cleaner |
| `compare/car-34_selective-outline_*` | Softer, more "pro" outline; a matter of taste |

**Against the US game's AI art:** our output is clean, consistent and readable, but **plainer**. It is flat-shaded low-poly turned into pixels, without the hand-painted texture, highlights and detail that a diffusion model invents. The quality ceiling is the 3D model plus the materials. Detail you model (grille, door lines, rust, roof racks, window frames) shows up; detail you don't model never appears.

What it is clearly better at than single-image AI generation: every vehicle in every direction and animation frame has the **same scale, palette, light direction and outline**. That is exactly where AI tools struggle and charge extra ($0.10–0.25 per rotation set at Retro Diffusion).

**Known limits:**
- Thin features under about 1.5 px (antennas, poplar tip, window frames at 96 px) either vanish or alias.
- Muddy shadows come from the renderer, not the pixelizer.
- Ordered dither looks noisy on hard-surface objects.
- PNG input only.

---

## 5. Recommended next steps

1. **Use the pipeline for real assets now.**
   - Model the actual Ukrainian vehicle line-up in Blender: ВАЗ-2101/2107 «Жигулі», Таврія, Ланос, Sprinter/«маршрутка», a ЛАЗ bus, a ЗІЛ/КрАЗ truck, a tractor.
   - Each takes about 20–40 boxes, like `build_car`, or use CC0 low-poly models (Kenney, Quaternius, Poly Pizza; record the source).
   - Then run `--preset turntable --angles 8 --frames 4`.
2. **Add detail to the 3D models, not to the pixelizer.** Small bevels, darker panel seams, chrome strips, a roof rack and a two-tone flag stripe all survive at 48–64 px.
3. **Try PixelLab's free tier** (40 + 5 a day) for characters and hero images. Its MCP server can be added to Claude Code.
4. **Optional, needs your decision: local SDXL.**
   - **Downloads:** about 12–14 GB.
   - **Before installing:** check PyTorch Pascal support; close other apps.
   - **Workflow:** img2img our Blender renders at about 0.4–0.5 denoise with pixel-art-xl, then `pixelize.mjs --palette ukraine` to lock the grid and palette. This keeps the consistency and adds the hand-painted texture.
5. **Optional, cheapest paid boost:** about $10 of Retro Diffusion API credit for comparison renders of the same subjects.
6. Hand-polish key sprites in **Pixelorama** (free, MIT).
