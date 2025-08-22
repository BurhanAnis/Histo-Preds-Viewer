#!/usr/bin/env python3
import argparse, pickle, xml.etree.ElementTree as ET
from pathlib import Path
import numpy as np
from PIL import Image

def read_dzi_size(dzi_path):
    root = ET.parse(dzi_path).getroot()
    size = root.find('{http://schemas.microsoft.com/deepzoom/2008}Size')
    # DZI stores Width, Height; we return (W2, H2)
    return int(size.attrib['Width']), int(size.attrib['Height'])

def to_rgba_value_alpha(val):
    """Blue→Red, alpha proportional to value [0..1]."""
    v = np.clip(val, 0.0, 1.0)
    r = (v * 255).astype(np.uint8)
    g = np.zeros_like(r, dtype=np.uint8)
    b = (255 - r).astype(np.uint8)
    a = (v * 200).astype(np.uint8)  # up to ~200/255
    return np.stack([r, g, b, a], axis=-1)

def to_rgba_mask_alpha(val, mask, opacity=160):
    """Blue→Red, alpha = 0 outside mask; constant inside mask."""
    v = np.clip(val, 0.0, 1.0)
    r = (v * 255).astype(np.uint8)
    g = np.zeros_like(r, dtype=np.uint8)
    b = (255 - r).astype(np.uint8)
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
parser.add_argument('--opacity', type=int, default=160, help='opacity 0..255 when alpha-mode=mask')
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

# Rasterize patch probs onto the L2 canvas
for (y, x, *_), p in zip(patches, probs):
    y0, x0 = int(y), int(x)
    if y0 >= H2 or x0 >= W2:
        continue
    y1, x1 = min(y0 + P, H2), min(x0 + P, W2)
    canvas[y0:y1, x0:x1] += p
    counts[y0:y1, x0:x1] += 1.0

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
