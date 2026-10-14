"""blender-sprite.py — render consistent sprite frames in Blender (headless), then pixelize them.

Run with Blender's own Python (no extra installs):

  "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" -b --factory-startup \
      -P tools/pixel/blender-sprite.py -- --model car --preset rear-chase --frames 4 \
      --out tools/pixel/samples/car-rear --pixelize "--w 48 --palette ukraine --outline"

Models:  car | khrushchevka | poplar  (built procedurally here, no external assets)
         or a path to .blend / .glb / .gltf / .fbx / .obj (all mesh objects are framed)
Presets: rear-chase | side | three-quarter | front | top-down | turntable (--angles N directions)
Frames:  --frames N animates: car = wheel spin + suspension bob, poplar = wind sway,
         imported .blend = its own timeline sampled N times. Static models repeat.

Every frame of one run uses the same camera and the same ortho scale, so frames stay aligned
and the pixelizer (batch mode, shared palette) gives a clean sprite sheet.
"""
import argparse
import math
import os
import shutil
import subprocess
import sys

import bmesh
import bpy
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))

PRESETS = {
    # name: (azimuth deg — 0 = camera behind the object looking +Y, elevation deg)
    "rear-chase": (0, 14),
    "side": (90, 6),
    "three-quarter": (35, 28),
    "front": (180, 12),
    "top-down": (0, 89),
}


def parse():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    p = argparse.ArgumentParser(prog="blender-sprite")
    p.add_argument("--model", default="car")
    p.add_argument("--preset", default="rear-chase", choices=list(PRESETS) + ["turntable"])
    p.add_argument("--angles", type=int, default=8, help="turntable: number of directions")
    p.add_argument("--elev", type=float, default=None, help="override camera elevation (deg)")
    p.add_argument("--frames", type=int, default=1)
    p.add_argument("--res", type=int, default=384, help="render size in px (square)")
    p.add_argument("--color", default="#c8302a", help="car body colour")
    p.add_argument("--engine", default="eevee", choices=["eevee", "workbench", "cycles"])
    p.add_argument("--persp", action="store_true", help="perspective camera instead of ortho")
    p.add_argument("--out", required=True, help="output folder (raw/ and px/ are created inside)")
    p.add_argument("--pixelize", default=None, help="args passed to pixelize.mjs; omit to skip")
    p.add_argument("--name", default=None, help="base name for frames/sheet")
    return p.parse_args(argv)


# ---------------- scene helpers ----------------
def hex_rgba(h):
    h = h.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, 1.0)


_mats = {}


def mat(name, color, rough=0.6, metal=0.0, emit=0.0):
    if name in _mats:
        return _mats[name]
    m = bpy.data.materials.new(name)
    if hasattr(m, "use_nodes") and not m.node_tree:
        m.use_nodes = True
    b = m.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = hex_rgba(color)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit:
        b.inputs["Emission Color"].default_value = hex_rgba(color)
        b.inputs["Emission Strength"].default_value = emit
    m.diffuse_color = hex_rgba(color)  # used by Workbench "material" colour
    _mats[name] = m
    return m


def box(name, center, size, material, taper_top=(1.0, 1.0), parent=None):
    """Axis-aligned box; taper_top scales the top face in (x, y) for cabins/roofs."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        if v.co.z > 0:
            v.co.x *= taper_top[0]
            v.co.y *= taper_top[1]
        v.co.x = v.co.x * size[0]
        v.co.y = v.co.y * size[1]
        v.co.z = v.co.z * size[2]
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(material)
    ob.location = center
    bpy.context.collection.objects.link(ob)
    if parent:
        ob.parent = parent
    return ob


def cylinder(name, center, radius, depth, material, axis="X", verts=12, parent=None):
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=verts, radius1=radius, radius2=radius, depth=depth)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(material)
    bpy.context.collection.objects.link(ob)
    ob.location = center
    if axis == "X":
        ob.rotation_euler = (0, math.radians(90), 0)
    if parent:
        ob.parent = parent
    return ob


def blob(name, center, scale, material, seed=0, parent=None):
    """Lumpy ico-sphere for tree crowns."""
    me = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=2, radius=1.0)
    import random
    rnd = random.Random(seed)
    for v in bm.verts:
        v.co *= 1.0 + rnd.uniform(-0.12, 0.12)
    bm.to_mesh(me)
    bm.free()
    for poly in me.polygons:
        poly.use_smooth = False
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(material)
    bpy.context.collection.objects.link(ob)
    ob.location = center
    ob.scale = scale
    if parent:
        ob.parent = parent
    return ob


def bevel(ob, w=0.04, seg=2):
    m = ob.modifiers.new("bevel", "BEVEL")
    m.width = w
    m.segments = seg
    m.limit_method = "ANGLE"


# ---------------- procedural models ----------------
def build_car(color):
    """Low-poly 5-door hatchback (Lanos / Sens / 2109-ish), length along +Y, rear at -Y."""
    root = bpy.data.objects.new("car", None)
    bpy.context.collection.objects.link(root)
    body = mat("body", color, rough=0.35, metal=0.2)
    glass = mat("glass", "#1c2733", rough=0.15)
    black = mat("plastic", "#202024", rough=0.8)
    chrome = mat("chrome", "#b4b6bc", rough=0.3, metal=0.8)
    tail = mat("taillight", "#e0201c", rough=0.3, emit=1.5)
    plate = mat("plate", "#f2f4f6", rough=0.5)
    tyre = mat("tyre", "#18181c", rough=0.9)

    lower = box("body_lower", (0, 0, 0.7), (1.66, 3.9, 0.56), body, parent=root)
    bevel(lower, 0.06)
    # cabin: body-coloured shell with dark glass panels laid on top of each face
    cab = box("cabin", (0, -0.2, 1.22), (1.5, 2.2, 0.48), body, taper_top=(0.84, 0.72), parent=root)
    bevel(cab, 0.04)
    box("glass_rear", (0, -1.235, 1.22), (1.3, 0.06, 0.42), glass, taper_top=(0.86, 1), parent=root).rotation_euler = (math.radians(-35), 0, 0)
    box("glass_front", (0, 0.86, 1.22), (1.22, 0.06, 0.36), glass, taper_top=(0.86, 1), parent=root).rotation_euler = (math.radians(42), 0, 0)
    for sx in (-1, 1):
        g = box(f"glass_side_{sx}", (sx * 0.7, -0.2, 1.22), (0.06, 1.7, 0.34), glass, taper_top=(1, 0.8), parent=root)
        g.rotation_euler = (0, math.radians(sx * 9), 0)
    box("bumper_r", (0, -1.97, 0.5), (1.72, 0.18, 0.22), black, parent=root)
    box("bumper_f", (0, 1.97, 0.5), (1.72, 0.18, 0.22), black, parent=root)
    for sx in (-1, 1):
        box(f"tail_{sx}", (sx * 0.6, -1.96, 0.84), (0.4, 0.06, 0.2), tail, parent=root)
        box(f"head_{sx}", (sx * 0.6, 1.96, 0.8), (0.36, 0.06, 0.16), chrome, parent=root)
        box(f"mirror_{sx}", (sx * 0.9, 0.6, 1.08), (0.14, 0.1, 0.1), black, parent=root)
    box("plate", (0, -2.07, 0.66), (0.52, 0.03, 0.13), plate, parent=root)
    wheels = []
    for sx in (-1, 1):
        for sy in (-1.25, 1.25):
            w = cylinder(f"wheel_{sx}_{sy}", (sx * 0.72, sy, 0.32), 0.32, 0.26, tyre, parent=root)
            # wheel-local Z is the axle (+X world for both sides); hubcap pokes out of the tyre
            cylinder(f"hub_{sx}_{sy}", (0, 0, sx * 0.09), 0.17, 0.08, chrome, axis="Z", verts=8, parent=w)
            # dark off-centre bolt so the spin reads even at 48-64 px
            cylinder(f"bolt_{sx}_{sy}", (0.1, 0, sx * 0.115), 0.06, 0.04, black, axis="Z", verts=6, parent=w)
            wheels.append(w)
    body_parts = [o for o in root.children if not o.name.startswith("wheel")]
    return root, {"wheels": wheels, "body": body_parts}


def build_khrushchevka():
    """5-storey panel block (серія 1-464-ish): 4 entrances, window grid, balconies."""
    root = bpy.data.objects.new("khrushchevka", None)
    bpy.context.collection.objects.link(root)
    panel = mat("panel", "#d6d0c0", rough=0.9)
    seam = mat("seam", "#a8a294", rough=0.9)
    win = mat("window", "#2a3a55", rough=0.2)
    frame = mat("frame", "#f2f4f6", rough=0.6)
    roof = mat("roof", "#4a4c52", rough=0.9)
    door = mat("door", "#6e4a2c", rough=0.8)
    balc = mat("balcony", "#b4b6bc", rough=0.8)
    L, D, floors, fh = 16.0, 4.0, 5, 1.0
    box("walls", (0, 0, floors * fh / 2), (L, D, floors * fh), panel, parent=root)
    box("roof", (0, 0, floors * fh + 0.08), (L + 0.2, D + 0.2, 0.16), roof, parent=root)
    cols = 16
    for f in range(floors):
        z = f * fh + 0.55
        box(f"seam_{f}", (0, -D / 2 - 0.005, f * fh + 0.02), (L, 0.02, 0.04), seam, parent=root)
        for c in range(cols):
            x = -L / 2 + (c + 0.5) * L / cols
            entrance = c % 4 == 1
            if entrance and f == 0:
                box(f"door_{c}", (x, -D / 2 - 0.02, 0.4), (0.5, 0.04, 0.8), door, parent=root)
                box(f"canopy_{c}", (x, -D / 2 - 0.3, 0.9), (0.9, 0.6, 0.06), roof, parent=root)
                continue
            w, h = (0.3, 0.4) if entrance else (0.5, 0.5)  # stairwell windows are narrow
            zz = z + (0.25 if entrance else 0)
            box(f"frame_{f}_{c}", (x, -D / 2 - 0.01, zz), (w + 0.08, 0.02, h + 0.08), frame, parent=root)
            box(f"win_{f}_{c}", (x, -D / 2 - 0.025, zz), (w, 0.02, h), win, parent=root)
            if f >= 1 and c % 4 == 3:
                box(f"balc_{f}_{c}", (x, -D / 2 - 0.3, f * fh + 0.2), (0.9, 0.5, 0.35), balc, parent=root)
    return root, {}


def build_poplar():
    """Lombardy poplar: tall narrow column of leaf clumps on a thin trunk."""
    root = bpy.data.objects.new("poplar", None)
    bpy.context.collection.objects.link(root)
    import random
    bark = mat("bark", "#8a8c84", rough=0.9)
    leaf = mat("leaf", "#4a7a34", rough=0.85)
    leaf2 = mat("leaf_light", "#7aa848", rough=0.85)
    trunk = cylinder("trunk", (0, 0, 1.2), 0.26, 2.4, bark, axis="Z", verts=8, parent=root)
    crown = bpy.data.objects.new("crown", None)
    bpy.context.collection.objects.link(crown)
    crown.parent = root
    crown.location = (0, 0, 1.4)
    # spindle silhouette: many small clumps, widest at ~35 % height, tapering to a point;
    # clumps facing the sun (−X side) use the lighter green so the crown reads as 3-D
    rnd = random.Random(7)
    n = 22
    for i in range(n):
        t = i / (n - 1)
        width = 1.05 * math.sin(math.pi * min(1.0, 0.18 + t * 0.95)) ** 0.8 + 0.12
        ang = rnd.uniform(0, 2 * math.pi)
        off = width * rnd.uniform(0.25, 0.55)
        x, y, z = math.cos(ang) * off, math.sin(ang) * off, 0.3 + t * 6.2
        r = width * rnd.uniform(0.5, 0.7)
        m = leaf2 if (x < -0.05 or t > 0.85) and rnd.random() < 0.75 else leaf
        blob(f"clump_{i}", (x, y, z), (r, r, r * 1.5), m, seed=i, parent=crown)
    return root, {"crown": crown, "trunk": trunk}


def import_model(path):
    ext = os.path.splitext(path)[1].lower()
    if ext == ".blend":
        bpy.ops.wm.open_mainfile(filepath=path)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    else:
        raise SystemExit(f"unsupported model: {path}")
    return None, {}


# ---------------- rig: camera, light, render ----------------
def world_bbox(objs):
    pts = []
    dg = bpy.context.evaluated_depsgraph_get()
    for o in objs:
        if o.type != "MESH":
            continue
        oe = o.evaluated_get(dg)
        pts += [oe.matrix_world @ Vector(c) for c in oe.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def setup_render(a):
    sc = bpy.context.scene
    sc.render.resolution_x = sc.render.resolution_y = a.res
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.view_settings.view_transform = "Standard"  # AgX/Filmic wash out colours; pixel art wants them flat
    sc.view_settings.look = "None"
    if a.engine == "eevee":
        for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
            try:
                sc.render.engine = eng
                break
            except TypeError:
                pass
        try:
            sc.eevee.taa_render_samples = 16
        except AttributeError:
            pass
    elif a.engine == "cycles":
        sc.render.engine = "CYCLES"
        sc.cycles.samples = 32
        sc.cycles.device = "CPU"
    else:
        sc.render.engine = "BLENDER_WORKBENCH"
        sc.display.shading.light = "STUDIO"
        sc.display.shading.color_type = "MATERIAL"
        sc.display.shading.show_cavity = True
    # world: soft sky ambient so shadows aren't black
    w = bpy.data.worlds.new("w") if not sc.world else sc.world
    sc.world = w
    if not w.node_tree:
        w.use_nodes = True
    bg = w.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = hex_rgba("#a8c8e8")
        bg.inputs["Strength"].default_value = 0.8


def add_sun():
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 3.2
    sun.angle = math.radians(8)
    ob = bpy.data.objects.new("sun", sun)
    bpy.context.collection.objects.link(ob)
    # key light from upper-left, slightly toward the camera side
    ob.rotation_euler = (math.radians(50), math.radians(-25), math.radians(-35))
    return ob


def place_camera(center, radius, az, el, persp):
    cam = bpy.data.cameras.new("cam")
    ob = bpy.data.objects.new("cam", cam)
    bpy.context.collection.objects.link(ob)
    bpy.context.scene.camera = ob
    az, el = math.radians(az), math.radians(el)
    # az 0 = behind the object (camera on -Y looking +Y)
    direction = Vector((math.sin(az) * math.cos(el), -math.cos(az) * math.cos(el), math.sin(el)))
    ob.location = center + direction * radius * 4
    ob.rotation_euler = (-direction).to_track_quat("-Z", "Y").to_euler()
    cam.clip_end = radius * 20
    if persp:
        cam.type = "PERSP"
        cam.lens = 85
    else:
        cam.type = "ORTHO"
        cam.ortho_scale = radius * 2.15
    bpy.context.view_layer.update()
    return ob


def fit_extent(cam, meshes):
    """Half-size of the model's silhouette in camera space, plus the screen-space centre offset."""
    inv = cam.matrix_world.inverted()
    dg = bpy.context.evaluated_depsgraph_get()
    xs, ys = [], []
    for o in meshes:
        oe = o.evaluated_get(dg)
        for v in oe.data.vertices:
            p = inv @ (oe.matrix_world @ v.co)
            xs.append(p.x)
            ys.append(p.y)
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    return max(max(xs) - min(xs), max(ys) - min(ys)) / 2, (cx, cy)


def recentre(cam, off):
    """Shift an ortho camera sideways/up in its own plane so the model is centred."""
    right = cam.matrix_world.to_3x3() @ Vector((1, 0, 0))
    up = cam.matrix_world.to_3x3() @ Vector((0, 1, 0))
    cam.location = cam.location + right * off[0] + up * off[1]
    bpy.context.view_layer.update()


def animate(kind, rig, t):
    """t in [0,1): pose the model for frame t."""
    if kind == "car":
        for w in rig["wheels"]:
            w.rotation_mode = "ZYX"  # spin about the axle first, then lay the wheel on its side
            w.rotation_euler = (0, math.radians(90), t * 2 * math.pi)
        bob = 0.025 * math.sin(t * 2 * math.pi * 2)
        for o in rig["body"]:
            o.delta_location = (0, 0, bob)
    elif kind == "poplar":
        rig["crown"].rotation_euler = (math.radians(2.5 * math.sin(t * 2 * math.pi)), 0, 0)


def main():
    a = parse()
    a.out = os.path.abspath(a.out)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    kind = a.model if a.model in ("car", "khrushchevka", "poplar") else "file"
    if kind == "car":
        root, rig = build_car(a.color)
    elif kind == "khrushchevka":
        root, rig = build_khrushchevka()
    elif kind == "poplar":
        root, rig = build_poplar()
    else:
        root, rig = import_model(os.path.abspath(a.model))
    setup_render(a)
    sc = bpy.context.scene

    meshes = [o for o in sc.objects if o.type == "MESH"]
    lo, hi = world_bbox(meshes)
    center = (lo + hi) / 2
    # radius = bounding-sphere so every azimuth fits the same ortho scale → aligned frames
    radius = max((hi - lo).length / 2, 0.01)
    add_sun()

    views = []
    if a.preset == "turntable":
        el = a.elev if a.elev is not None else 28
        views = [(i * 360 / a.angles, el, f"a{int(round(i * 360 / a.angles)):03d}") for i in range(a.angles)]
    else:
        az, el = PRESETS[a.preset]
        views = [(az, a.elev if a.elev is not None else el, a.preset)]

    name = a.name or (kind if kind != "file" else os.path.splitext(os.path.basename(a.model))[0])
    raw = os.path.join(a.out, "raw")
    os.makedirs(raw, exist_ok=True)
    cam = None
    f_start, f_end = sc.frame_start, sc.frame_end
    # one ortho scale for every view of this run → all frames share the same pixel size.
    # Fixed views are centred on the silhouette; turntable views stay centred on the bbox so
    # the sprite's anchor doesn't jump between directions.
    extents = []
    for az, el, _ in views:
        c = place_camera(center, radius, az, el, a.persp)
        extents.append(fit_extent(c, meshes))
        bpy.data.objects.remove(c)
    scale = max(e[0] for e in extents) * 2 * 1.14  # margin: animation + 1-px outline room
    for (az, el, vname), (_, off) in zip(views, extents):
        if cam:
            bpy.data.objects.remove(cam)
        cam = place_camera(center, radius, az, el, a.persp)
        if not a.persp:
            cam.data.ortho_scale = scale
            if len(views) == 1:
                recentre(cam, off)
        for f in range(a.frames):
            t = f / a.frames
            if kind == "file":
                sc.frame_set(int(f_start + t * (f_end - f_start + 1)))
            else:
                animate(kind, rig, t)
            sc.render.filepath = os.path.join(raw, f"{name}_{vname}_f{f:02d}.png")
            bpy.ops.render.render(write_still=True)
    print(f"blender-sprite: rendered {len(views) * a.frames} frames → {raw}")

    if a.pixelize is not None:
        node = shutil.which("node") or r"C:\Program Files\nodejs\node.exe"
        px = os.path.join(a.out, "px")
        sheet = os.path.join(a.out, f"{name}_sheet.png")
        cols = a.frames if a.frames > 1 else min(16, len(views))
        cmd = [node, os.path.join(HERE, "pixelize.mjs"), raw, px, "--sheet", sheet,
               "--cols", str(cols)]
        cmd += a.pixelize.split()
        print("blender-sprite:", " ".join(cmd))
        subprocess.run(cmd, check=True)


main()
