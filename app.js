// app.js

const slidesIndexUrl = "slides_index.json";

let viewer;
let overlayItem = null;
let overlayVisible = true;

// GT (client-side canvas) state
let overlayGTVisible = false;
let gtIndex = null;            // { schema?, patch_size, image_size:[H,W], tumour:[[y,x],...]}
let gtCanvas = null;
let gtCtx = null;

// ---------- helpers ----------
async function getJSON(u) {
  const r = await fetch(u, { cache: "no-store" });
  const t = await r.text();
  if (!r.ok) throw new Error(`Fetch ${u} failed: ${r.status}`);
  try { return JSON.parse(t); }
  catch (e) { throw new Error(`Bad JSON in ${u}: ${e.message}\n${t}`); }
}

function resolveRelative(baseUrl, rel) {
  if (!rel) return rel;
  if (!rel.startsWith(".")) return rel; // already absolute or full URL
  const base = baseUrl.slice(0, baseUrl.lastIndexOf("/") + 1);
  return base + rel.replace(/^\.\//, "");
}

function setStatus(msg, cls = "") {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = `status ${cls}`.trim();
}

// ---- heatmap mapping (JS mirror of Python) ----
function clamp01(x) { return Math.min(1, Math.max(0, x)); }
function ramp(x)    { return clamp01(x); }

/**
 * Classic heatmap/jet-ish mapping for v in [0,1].
 * Returns [r,g,b] integers in 0..255.
 */
function heatmapRGB(v) {
  v = clamp01(v);
  const r = ramp(1.5 * v - 0.5) + ramp(1.5 * v - 1.0);
  const g = ramp(1.5 * v) - ramp(1.5 * v - 1.0);
  const b = ramp(1.5 * (1.0 - v));
  return [
    Math.round(clamp01(r) * 255),
    Math.round(clamp01(g) * 255),
    Math.round(clamp01(b) * 255),
  ];
}

function drawColorbar() {
  const c = document.getElementById("colorbar");
  if (!c) return;
  const ctx = c.getContext("2d");
  const w = c.width, h = c.height;

  const img = ctx.createImageData(w, h);
  for (let x = 0; x < w; x++) {
    const v = x / (w - 1);
    const [r, g, b] = heatmapRGB(v);
    for (let y = 0; y < h; y++) {
      const i = 4 * (y * w + x);
      img.data[i+0] = r;
      img.data[i+1] = g;
      img.data[i+2] = b;
      img.data[i+3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// ---------- GT canvas drawing ----------
function ensureGTCanvas() {
  if (gtCanvas) return;
  const container = document.getElementById("viewer");
  gtCanvas = document.createElement("canvas");
  gtCanvas.className = "gt-overlay";
  container.appendChild(gtCanvas);
  gtCtx = gtCanvas.getContext("2d");

  function resizeGTCanvas() {
    const r = container.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(r.width));
    const h = Math.max(1, Math.ceil(r.height));
    if (w !== gtCanvas.width || h !== gtCanvas.height) {
      gtCanvas.width = w; gtCanvas.height = h;
      drawGTOverlay();
    }
  }
  resizeGTCanvas();
  new ResizeObserver(resizeGTCanvas).observe(container);
}

function imageRectToScreenRect(imgX, imgY, imgW, imgH) {
  const vpRect = viewer.viewport.imageToViewportRectangle(imgX, imgY, imgW, imgH);
  const topLeft = viewer.viewport.viewportToViewerElementCoordinates(vpRect.getTopLeft());
  const botRight = viewer.viewport.viewportToViewerElementCoordinates(vpRect.getBottomRight());
  return { x: topLeft.x, y: topLeft.y, w: botRight.x - topLeft.x, h: botRight.y - topLeft.y };
}

function drawGTOverlay() {
  if (!gtCtx || !gtCanvas) return;
  gtCtx.clearRect(0, 0, gtCanvas.width, gtCanvas.height);
  if (!overlayGTVisible || !gtIndex || !viewer || !viewer.world.getItemCount()) return;

  const P = gtIndex.patch_size || 256;
  const tumour = gtIndex.tumour || [];

  // viewport bounds in image coords
  const vpBounds = viewer.viewport.getBounds(true);
  const imgTL = viewer.viewport.viewportToImageCoordinates(vpBounds.getTopLeft());
  const imgBR = viewer.viewport.viewportToImageCoordinates(vpBounds.getBottomRight());
  const imgMinX = Math.min(imgTL.x, imgBR.x);
  const imgMaxX = Math.max(imgTL.x, imgBR.x);
  const imgMinY = Math.min(imgTL.y, imgBR.y);
  const imgMaxY = Math.max(imgTL.y, imgBR.y);

  gtCtx.globalAlpha = 0.35;
  gtCtx.fillStyle = "#00ff00";
  gtCtx.strokeStyle = "#00a000";
  gtCtx.lineWidth = 1;

  for (let i = 0; i < tumour.length; i++) {
    const y = tumour[i][0], x = tumour[i][1];
    if (x > imgMaxX || x + P < imgMinX || y > imgMaxY || y + P < imgMinY) continue;

    const r = imageRectToScreenRect(x, y, P, P); // note (x,y,w,h)
    if (r.w < 0.5 || r.h < 0.5) continue;

    gtCtx.fillRect(r.x, r.y, r.w, r.h);
    // Optional crisp border:
    // gtCtx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  }
  gtCtx.globalAlpha = 1.0;
}

// ---------- core ----------
async function openFromManifest(manifestUrl) {
  setStatus("loading…", "loading");
  overlayItem = null;
  gtIndex = null;

  const m = await getJSON(manifestUrl);

  // allow relative paths inside manifest
  let baseDzi = m?.base?.dzi;
  let overlayDzi = m?.overlay?.dzi;
  let gtIndexUrl = m?.gtIndex || null;

  if (!baseDzi) throw new Error("manifest.base.dzi missing");
  if (!overlayDzi) throw new Error("manifest.overlay.dzi missing");

  if (baseDzi.startsWith(".")) baseDzi = resolveRelative(manifestUrl, baseDzi);
  if (overlayDzi.startsWith(".")) overlayDzi = resolveRelative(manifestUrl, overlayDzi);
  if (gtIndexUrl && gtIndexUrl.startsWith(".")) gtIndexUrl = resolveRelative(manifestUrl, gtIndexUrl);

  // open base
  viewer.open(baseDzi);

  // add overlays when base is ready
  viewer.addOnceHandler("open", async () => {
    // predictions layer
    viewer.addTiledImage({
      tileSource: overlayDzi,
      x: 0, y: 0, width: 1,
      opacity: parseFloat(document.getElementById("opacity").value) || 0.5,
      success: e => { overlayItem = e.item; setStatus("ready"); },
      error: e => { console.error("Overlay load error", e); setStatus("overlay failed", "error"); }
    });

    // load GT index (tiny JSON)
    if (gtIndexUrl) {
      try {
        gtIndex = await getJSON(gtIndexUrl);
      } catch (e) {
        console.warn("Failed to load gtIndex:", e);
      }
      drawGTOverlay();
    }
  });
}

async function init() {
  // init OSD
  viewer = OpenSeadragon({
    id: "viewer",
    prefixUrl: "https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.1/images/",
    showNavigator: true,
    minZoomLevel: 0,
    maxZoomPixelRatio: 4
  });

  // GT canvas overlay
  ensureGTCanvas();

  // wire controls
  const select = document.getElementById("slideSelect");
  const toggle = document.getElementById("toggle");
  const toggleGT = document.getElementById("toggleGT");
  const opacity = document.getElementById("opacity");

  toggle.addEventListener("click", () => {
    overlayVisible = !overlayVisible;
    if (overlayItem) overlayItem.setOpacity(overlayVisible ? Number(opacity.value) : 0);
  });

  opacity.addEventListener("input", (e) => {
    if (overlayItem && overlayVisible) overlayItem.setOpacity(Number(e.target.value));
  });

  toggleGT.addEventListener("click", () => {
    overlayGTVisible = !overlayGTVisible;
    drawGTOverlay();
  });

  // redraw GT when viewport changes
  viewer.addHandler("update-viewport", drawGTOverlay);
  viewer.addHandler("animation", drawGTOverlay);
  viewer.addHandler("resize", drawGTOverlay);
  viewer.addHandler("open", drawGTOverlay);

  // load slides index and populate dropdown
  setStatus("loading slides…", "loading");
  const idx = await getJSON(slidesIndexUrl);
  if (!idx?.slides?.length) { setStatus("no slides found", "error"); return; }

  // only include slides beginning with "test_"
  const slides = idx.slides.filter(s => (s.id || s.name || "").startsWith("test_"));
  if (!slides.length) { setStatus("no test_* slides in index", "error"); return; }

  select.innerHTML = "";
  slides.forEach(s => {
    const opt = document.createElement("option");
    opt.value = s.manifest; opt.textContent = s.name || s.id;
    select.appendChild(opt);
  });
  select.addEventListener("change", () => openFromManifest(select.value));

  // open first slide by default
  select.value = slides[0].manifest;
  await openFromManifest(select.value);

  // legend
  drawColorbar();

  setStatus("ready");
}

init().catch(err => { console.error(err); setStatus(err.message, "error"); });






