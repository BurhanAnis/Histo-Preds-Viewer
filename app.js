// app.js

const slidesIndexUrl = "slides_index.json";

let viewer;

// Prediction heatmap (tiled) state
let overlayItem = null;
let overlayVisible = true;

// Ground truth (client-side canvas) state
let overlayGTVisible = false;
let gtIndex = null;            // { schema?, patch_size, image_size:[H,W], tumour:[[y,x],...] }
let gtCanvas = null;
let gtCtx = null;

// FP/FN (client-side canvas) state
let overlayFPFNVisible = false;
let patchesIndex = null;       // { schema, patch_size, image_size, prob_scale, patches:[[y,x,q,t],...] }
let fpfnCanvas = null;
let fpfnCtx = null;
let threshold = 0.5;           // τ for FP/FN

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
  if (!el) return;
  el.textContent = msg;
  el.className = `status ${cls}`.trim();
}

function updateFPFNLegend() {
  const box = document.getElementById("legend-fpfn");
  const tEl = document.getElementById("legend-thresh");
  if (!box) return;
  if (overlayFPFNVisible) {
    box.classList.add("show");
    if (tEl) tEl.textContent = Number(threshold).toFixed(2);
  } else {
    box.classList.remove("show");
  }
}

function showToast(msg, duration = 2000) {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), duration);
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

// ---------- overlay canvases ----------
function ensureGTCanvas() {
  if (gtCanvas) return;
  const container = document.getElementById("viewer");
  gtCanvas = document.createElement("canvas");
  gtCanvas.className = "gt-overlay";
  gtCanvas.style.position = "absolute";
  gtCanvas.style.left = "0";
  gtCanvas.style.top = "0";
  gtCanvas.style.pointerEvents = "none";
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

function ensureFPFNCanvas() {
  if (fpfnCanvas) return;
  const container = document.getElementById("viewer");
  fpfnCanvas = document.createElement("canvas");
  fpfnCanvas.className = "fpfn-overlay";
  fpfnCanvas.style.position = "absolute";
  fpfnCanvas.style.left = "0";
  fpfnCanvas.style.top = "0";
  fpfnCanvas.style.pointerEvents = "none";
  container.appendChild(fpfnCanvas);
  fpfnCtx = fpfnCanvas.getContext("2d");

  function resize() {
    const r = container.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(r.width));
    const h = Math.max(1, Math.ceil(r.height));
    if (w !== fpfnCanvas.width || h !== fpfnCanvas.height) {
      fpfnCanvas.width = w; fpfnCanvas.height = h;
      drawFPFNOverlay();
    }
  }
  resize();
  new ResizeObserver(resize).observe(container);
}

function imageRectToScreenRect(imgX, imgY, imgW, imgH) {
  const vpRect = viewer.viewport.imageToViewportRectangle(imgX, imgY, imgW, imgH);
  const topLeft = viewer.viewport.viewportToViewerElementCoordinates(vpRect.getTopLeft());
  const botRight = viewer.viewport.viewportToViewerElementCoordinates(vpRect.getBottomRight());
  return { x: topLeft.x, y: topLeft.y, w: botRight.x - topLeft.x, h: botRight.y - topLeft.y };
}

// ---------- GT drawing ----------
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
  gtCtx.fillStyle = "#ff0000";   // red GT fill
  gtCtx.strokeStyle = "#a00000"; // darker red outline
  gtCtx.lineWidth = 1;

  for (let i = 0; i < tumour.length; i++) {
    const y = tumour[i][0], x = tumour[i][1];
    if (x > imgMaxX || x + P < imgMinX || y > imgMaxY || y + P < imgMinY) continue;

    const r = imageRectToScreenRect(x, y, P, P); // note: (x,y,w,h)
    if (r.w < 0.5 || r.h < 0.5) continue;

    gtCtx.fillRect(r.x, r.y, r.w, r.h);
    // gtCtx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  }
  gtCtx.globalAlpha = 1.0;
}

// ---------- FP/FN drawing ----------
function drawFPFNOverlay() {
  if (!fpfnCtx || !fpfnCanvas) return;
  fpfnCtx.clearRect(0, 0, fpfnCanvas.width, fpfnCanvas.height);
  if (!overlayFPFNVisible || !patchesIndex || !viewer || !viewer.world.getItemCount()) return;

  const P = patchesIndex.patch_size || 256;
  const S = patchesIndex.prob_scale || 1000;
  const rows = patchesIndex.patches || [];

  // viewport bounds in image coords
  const vpBounds = viewer.viewport.getBounds(true);
  const imgTL = viewer.viewport.viewportToImageCoordinates(vpBounds.getTopLeft());
  const imgBR = viewer.viewport.viewportToImageCoordinates(vpBounds.getBottomRight());
  const imgMinX = Math.min(imgTL.x, imgBR.x);
  const imgMaxX = Math.max(imgTL.x, imgBR.x);
  const imgMinY = Math.min(imgTL.y, imgBR.y);
  const imgMaxY = Math.max(imgTL.y, imgBR.y);

  const alpha = 0.45;
  // FP = amber, FN = cyan
  const FP_FILL = "#ff9800", FP_STROKE = "#c77700";
  const FN_FILL = "#00e5ff", FN_STROKE = "#009bb3";

  for (let i = 0; i < rows.length; i++) {
    const y = rows[i][0], x = rows[i][1];
    if (x > imgMaxX || x + P < imgMinX || y > imgMaxY || y + P < imgMinY) continue;

    const p = rows[i][2] / S; // de-quantize
    const t = !!rows[i][3];   // GT tumour flag

    const predPos = p >= threshold;
    const isFP = predPos && !t;
    const isFN = !predPos && t;
    if (!isFP && !isFN) continue;

    const r = imageRectToScreenRect(x, y, P, P);
    if (r.w < 0.5 || r.h < 0.5) continue;

    fpfnCtx.globalAlpha = alpha;
    if (isFP) {
      fpfnCtx.fillStyle = FP_FILL;
      fpfnCtx.strokeStyle = FP_STROKE;
    } else {
      fpfnCtx.fillStyle = FN_FILL;
      fpfnCtx.strokeStyle = FN_STROKE;
    }
    fpfnCtx.fillRect(r.x, r.y, r.w, r.h);
    // fpfnCtx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1);
  }
  fpfnCtx.globalAlpha = 1.0;
}

// ---------- core ----------
async function openFromManifest(manifestUrl) {
  setStatus("loading…", "loading");
  overlayItem = null;

  // reset client overlays on slide change
  overlayGTVisible = false;
  overlayFPFNVisible = false;
  gtIndex = null;
  patchesIndex = null;
  drawGTOverlay();
  drawFPFNOverlay();
  updateFPFNLegend();

  const m = await getJSON(manifestUrl);

  // allow relative paths inside manifest
  let baseDzi = m?.base?.dzi;
  let overlayDzi = m?.overlay?.dzi;
  let gtIndexUrl = m?.gtIndex || null;
  let patchesIndexUrl = m?.patchesIndex || null;

  if (!baseDzi) throw new Error("manifest.base.dzi missing");
  if (!overlayDzi) throw new Error("manifest.overlay.dzi missing");

  if (baseDzi.startsWith(".")) baseDzi = resolveRelative(manifestUrl, baseDzi);
  if (overlayDzi.startsWith(".")) overlayDzi = resolveRelative(manifestUrl, overlayDzi);
  if (gtIndexUrl && gtIndexUrl.startsWith(".")) gtIndexUrl = resolveRelative(manifestUrl, gtIndexUrl);
  if (patchesIndexUrl && patchesIndexUrl.startsWith(".")) patchesIndexUrl = resolveRelative(manifestUrl, patchesIndexUrl);

  // open base
  viewer.open(baseDzi);

  // add overlays when base is ready
  viewer.addOnceHandler("open", async () => {
    // predictions layer (tiled)
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

    // load patches index for FP/FN
    if (patchesIndexUrl) {
      try {
        patchesIndex = await getJSON(patchesIndexUrl);
      } catch (e) {
        console.warn("Failed to load patchesIndex:", e);
      }
      drawFPFNOverlay();
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

  // overlay canvases
  ensureGTCanvas();
  ensureFPFNCanvas();

  // wire controls
  const select = document.getElementById("slideSelect");
  const toggle = document.getElementById("toggle");
  const toggleGT = document.getElementById("toggleGT");
  const toggleFPFN = document.getElementById("toggleFPFN");
  const opacity = document.getElementById("opacity");
  const thresh = document.getElementById("thresh");
  const threshNum = document.getElementById("threshNum");

    // Drawer wiring
  const drawer = document.getElementById("drawer");
  const drawerToggle = document.getElementById("drawerToggle");
  const drawerClose = document.getElementById("drawerClose");
  const drawerScrim = document.getElementById("drawerScrim");

  function openDrawer()  { document.body.classList.add("drawer-open"); }
  function closeDrawer() { document.body.classList.remove("drawer-open"); }

  drawerToggle.addEventListener("click", openDrawer);
  drawerClose.addEventListener("click", closeDrawer);
  drawerScrim.addEventListener("click", closeDrawer);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });


  // prediction heatmap toggle + opacity
  toggle.addEventListener("click", () => {
    overlayVisible = !overlayVisible;
    if (overlayItem) overlayItem.setOpacity(overlayVisible ? Number(opacity.value) : 0);
  });
  opacity.addEventListener("input", (e) => {
    if (overlayItem && overlayVisible) overlayItem.setOpacity(Number(e.target.value));
  });

  // GT toggle with "non-tumor" toast (only when turning on)
  toggleGT.addEventListener("click", () => {
    if (!overlayGTVisible) { // attempting to turn on
      if (!gtIndex || (gtIndex.tumour || []).length === 0) {
        showToast("This is a non-tumor slide");
        return;
      }
    }
    overlayGTVisible = !overlayGTVisible;
    drawGTOverlay();
  });

  // Threshold control (kept in sync)
  function setThreshold(v) {
    threshold = Math.min(1, Math.max(0, Number(v) || 0));
    if (thresh) thresh.value = threshold.toFixed(2);
    if (threshNum) threshNum.value = threshold.toFixed(2);
    if (overlayFPFNVisible) drawFPFNOverlay();
  }
  if (thresh) thresh.addEventListener("input", (e) => setThreshold(e.target.value));
  if (threshNum) threshNum.addEventListener("change", (e) => setThreshold(e.target.value));
  setThreshold(threshold); // initialize controls
  updateFPFNLegend();
  // FP/FN toggle
  toggleFPFN.addEventListener("click", () => {
    if (!patchesIndex || !patchesIndex.patches || patchesIndex.patches.length === 0) {
      showToast("No patch index available for FP/FN");
      return;
    }
    overlayFPFNVisible = !overlayFPFNVisible;
    updateFPFNLegend();
    drawFPFNOverlay();
  });

  // redraw overlays on viewport changes
  viewer.addHandler("update-viewport", () => { drawGTOverlay(); drawFPFNOverlay(); });
  viewer.addHandler("animation", () => { drawGTOverlay(); drawFPFNOverlay(); });
  viewer.addHandler("resize", () => { drawGTOverlay(); drawFPFNOverlay(); });
  viewer.addHandler("open", () => { drawGTOverlay(); drawFPFNOverlay(); });

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







