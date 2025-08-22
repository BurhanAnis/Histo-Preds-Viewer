const slidesIndexUrl = "slides_index.json";

let viewer;
let overlayItem = null;
let overlayVisible = true;

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

// ---------- core ----------
async function openFromManifest(manifestUrl) {
  setStatus("loading…", "loading");
  overlayItem = null;

  const m = await getJSON(manifestUrl);

  // allow relative DZI paths inside the manifest
  let baseDzi = m?.base?.dzi;
  let overlayDzi = m?.overlay?.dzi;
  if (!baseDzi) throw new Error("manifest.base.dzi missing");
  if (!overlayDzi) throw new Error("manifest.overlay.dzi missing");

  if (baseDzi.startsWith(".")) baseDzi = resolveRelative(manifestUrl, baseDzi);
  if (overlayDzi.startsWith(".")) overlayDzi = resolveRelative(manifestUrl, overlayDzi);

  // open base
  viewer.open(baseDzi);

  // add overlay once base is ready
  viewer.addOnceHandler("open", () => {
    viewer.addTiledImage({
      tileSource: overlayDzi,
      x: 0, y: 0, width: 1,
      opacity: parseFloat(document.getElementById("opacity").value) || 0.5,
      success: e => { overlayItem = e.item; setStatus("ready"); },
      error: e => { console.error("Overlay load error", e); setStatus("overlay failed", "error"); }
    });
  });
}

async function init() {
  // init OSD
  viewer = OpenSeadragon({
    id: "viewer",
    prefixUrl: "https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.1/images/",
    showNavigator: true,
    // sensible zoom bounds for L2-native pyramids
    minZoomLevel: 0,           // allow zooming out to full view
    maxZoomPixelRatio: 4       // limit how far past native resolution
  });

  // wire controls
  const select = document.getElementById("slideSelect");
  const toggle = document.getElementById("toggle");
  const opacity = document.getElementById("opacity");

  toggle.addEventListener("click", () => {
    overlayVisible = !overlayVisible;
    if (overlayItem) overlayItem.setOpacity(overlayVisible ? Number(opacity.value) : 0);
  });
  opacity.addEventListener("input", (e) => {
    if (overlayItem && overlayVisible) overlayItem.setOpacity(Number(e.target.value));
  });

  // load slides index and populate dropdown
  setStatus("loading slides…", "loading");
  const idx = await getJSON(slidesIndexUrl);
  if (!idx?.slides?.length) { setStatus("no slides found", "error"); return; }

  // only include slides beginning with "test_" (safety filter)
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
}

init().catch(err => { console.error(err); setStatus(err.message, "error"); });




