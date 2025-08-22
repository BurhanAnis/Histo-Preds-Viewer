#!/usr/bin/env python3
import argparse, pickle, xml.etree.ElementTree as ET
from pathlib import Path
import numpy as np
from PIL import Image
import json

def heatmap_rgb(v: np.ndarray):
    """
    Classic heatmap/jet-like mapping for v in [0,1].
    Returns (r,g,b) uint8 arrays.
    """
    v = np.clip(v, 0.0, 1.0)

    # piecewise "jet-ish" mapping
    def ramp(x):
        return np.clip(x, 0.0, 1.0)

    r = ramp(1.5*v - 0.5) + ramp(1.5*v - 1.0)  # rises from yellow to red
    g = ramp(1.5*v) - ramp(1.5*v - 1.0)        # peaks around green/yellow
    b = ramp(1.5*(1.0 - v))                    # high at low v (blue)

    # normalize to [0,1]
    r = np.clip(r, 0.0, 1.0)
    g = np.clip(g, 0.0, 1.0)
    b = np.clip(b, 0.0, 1.0)

    r = (r * 255).astype(np.uint8)
    g = (g * 255).astype(np.uint8)
    b = (b * 255).astype(np.uint8)
    return r, g, b

def read_dzi_size(dzi_path):
    root = ET.parse(dzi_path).getroot()
    size = root.find('{http://schemas.microsoft.com/deepzoom/2008}Size')
    # DZI stores Width, Height; we return (W2, H2)
    return int(size.attrib['Width']), int(size.attrib['Height'])

def to_rgba_value_alpha(val):
    """Classic heatmap colours; alpha proportional to value [0..1]."""
    v = np.clip(val, 0.0, 1.0)
    r, g, b = heatmap_rgb(v)
    a = (v * 200).astype(np.uint8)
    return np.stack([r, g, b, a], axis=-1)

def to_rgba_mask_alpha(val, mask, opacity=160):
    """Classic heatmap colours; constant alpha inside mask, 0 outside."""
    v = np.clip(val, 0.0, 1.0)
    r, g, b = heatmap_rgb(v)
    a = np.zeros_like(r, dtype=np.uint8)
    a[mask] = np.uint8(opacity)
    return np.stack([r, g, b, a], axis=-1)


parser = argparse.ArgumentParser()
parser.add_argument('--pkl', required=True)
parser.add_argument('--slide-id', required=True)
parser.add_argument('--base-dzi', required=True, help='base.dzi generated from [level=2]')
parser.add_argument('--out-dir', required=True)
parser.add_argument('--patch-size', type=int, default=256, help='patch size in L2 pixels')
parser.add_argument('--alpha-mode', choices=['mask', 'value'], default='mask',
                    help='alpha strategy: "mask"=constant alpha on covered pixels, "value"=alpha proportional to prob')
parser.add_argument('--opacity', type=int, default=180, help='opacity 0..255 when alpha-mode=mask')
args = parser.parse_args()

out_dir = Path(args.out_dir)
out_dir.mkdir(parents=True, exist_ok=True)

# Load PKL
with open(args.pkl, 'rb') as f:
    data = pickle.load(f)

entry = data[args.slide_id]
assert entry.get('level', 2) == 2, f"Predictions are level {entry.get('level')}, expected 2"
probs = np.asarray(entry['probs'], dtype=np.float32)
patches = entry['patches']  # expected (y, x, ...) in L2 pixels

# Read L2 canvas size from base.dzi
W2, H2 = read_dzi_size(args.base_dzi)
canvas = np.zeros((H2, W2), dtype=np.float32)
counts = np.zeros((H2, W2), dtype=np.float32)

P = args.patch_size

tumour = []
# Rasterize patch probs onto the L2 canvas
for (y, x, is_tumour), p in zip(patches, probs):
    y0, x0 = int(y), int(x)
    if y0 >= H2 or x0 >= W2:
        continue
    y1, x1 = min(y0 + P, H2), min(x0 + P, W2)
    canvas[y0:y1, x0:x1] += p
    counts[y0:y1, x0:x1] += 1.0
    if is_tumour:
        tumour.append([int(y), int(x)])

# Average where we have coverage
covered = counts > 0
canvas[covered] /= counts[covered]

# OPTIONAL: slight blur to soften patch boundaries (uncomment if desired)
# from scipy.ndimage import gaussian_filter
# canvas = gaussian_filter(canvas, sigma=0.8)

# Color + alpha
if args.alpha_mode == 'mask':
    rgba = to_rgba_mask_alpha(canvas, covered, opacity=args.opacity)
else:
    rgba = to_rgba_value_alpha(canvas)

out_png = out_dir / 'overlay.png'
Image.fromarray(rgba, mode='RGBA').save(out_png)
print(f"Saved overlay: {out_png} ({W2}x{H2}), alpha_mode={args.alpha_mode}")

gt_json = {
    "patch_size": int(P),
    "image_size": [int(H2), int(W2)],  # [H2, W2] for reference
    "tumour": tumour                   # [[y,x], ...] in L2 pixels
}

with open(out_dir / "gt_patches.json", "w") as f:
    json.dump(gt_json, f, separators=(",", ":"))

prob_scale = 1000
patch_rows = []
for (y, x, is_tumour), p in zip(patches, probs):
    patch_rows.append([int(y), int(x), int(round(float(p) * prob_scale)), int(bool(is_tumour))])

patches_json = {
    "schema": "patches_v1",
    "patch_size": int(P),
    "image_size": [int(H2), int(W2)],
    "prob_scale": prob_scale,
    "patches": patch_rows
}
with open(out_dir / "patches_index.json", "w") as f:
    json.dump(patches_json, f, separators=(",", ":"))