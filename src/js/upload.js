// Subida del tramo/punto de la actuacion (GeoJSON, SHP en ZIP, KML/KMZ),
// una o varias a la vez. Cada archivo se guarda como una capa subida
// independiente (propio color, visibilidad, opacidad y buffer), listada
// en su propio panel "Tramos y puntos subidos" -- igual que las capas
// ambientales, pero separado, porque en una licitacion suele haber varios
// tramos/puntos a la vez que hace falta controlar por separado.
//
// GPKG queda fuera por ahora -- necesitaria un motor SQLite en
// WebAssembly (@ngageoint/geopackage-js), bastante mas pesado que estos
// tres formatos juntos; se puede anadir despues si hace falta.
//
// Buffer: se calcula con Turf.js (turf.buffer), en un radio fijo elegido
// por el usuario (25/50/100/200/500 m). El resultado se anade como una
// capa de relleno translucido por debajo del trazado original.

const UPLOAD_COLORS = ["#E91E63", "#00BCD4", "#FF9800", "#673AB7", "#CDDC39", "#F44336", "#3F51B5", "#009688"];
const BUFFER_OPTIONS = [0, 25, 50, 100, 200, 500]; // metros, 0 = sin buffer

let uploadCounter = 0;
const uploadedLayers = []; // { id, name, geojson, color, visible, opacity, bufferMeters, bufferOpacity }

function nextUploadColor() {
  return UPLOAD_COLORS[uploadCounter % UPLOAD_COLORS.length];
}

function uploadLayerIds(u) {
  return [`${u.id}-fill`, `${u.id}-line`, `${u.id}-point`, `${u.id}-buffer`];
}

function addUploadedLayerToMap(u) {
  if (map.getSource(u.id)) return;

  map.addSource(u.id, { type: "geojson", data: u.geojson });
  map.addSource(`${u.id}-buffer-src`, {
    type: "geojson",
    data: u.bufferGeojson || { type: "FeatureCollection", features: [] },
  });

  // El buffer se anade primero para que quede POR DEBAJO del trazado.
  map.addLayer({
    id: `${u.id}-buffer`,
    type: "fill",
    source: `${u.id}-buffer-src`,
    layout: { visibility: u.visible && u.bufferMeters ? "visible" : "none" },
    paint: { "fill-color": u.color, "fill-opacity": u.bufferOpacity, "fill-outline-color": u.color },
  });

  map.addLayer({
    id: `${u.id}-fill`,
    type: "fill",
    source: u.id,
    filter: ["==", ["geometry-type"], "Polygon"],
    layout: { visibility: u.visible ? "visible" : "none" },
    paint: { "fill-color": u.color, "fill-opacity": u.opacity * 0.4 },
  });
  map.addLayer({
    id: `${u.id}-line`,
    type: "line",
    source: u.id,
    filter: ["match", ["geometry-type"], ["LineString", "Polygon"], true, false],
    layout: { visibility: u.visible ? "visible" : "none" },
    paint: { "line-color": u.color, "line-width": 4, "line-opacity": u.opacity },
  });
  map.addLayer({
    id: `${u.id}-point`,
    type: "circle",
    source: u.id,
    filter: ["==", ["geometry-type"], "Point"],
    layout: { visibility: u.visible ? "visible" : "none" },
    paint: {
      "circle-color": u.color,
      "circle-radius": 7,
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 2,
      "circle-opacity": u.opacity,
    },
  });
}

// Cambiar de mapa base reemplaza el estilo entero (setStyle), lo que
// borra las fuentes/capas anadidas dinamicamente -- se vuelven a dibujar
// todas las capas subidas si habia alguna.
map.on("styledata", () => {
  for (const u of uploadedLayers) {
    if (!map.getSource(u.id)) addUploadedLayerToMap(u);
  }
});

function featureBounds(geojson) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const visit = (coords) => {
    if (typeof coords[0] === "number") {
      const [x, y] = coords;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    } else {
      coords.forEach(visit);
    }
  };
  const features = geojson.type === "FeatureCollection" ? geojson.features : [geojson];
  for (const f of features) {
    if (f.geometry) visit(f.geometry.coordinates);
  }
  return [minX, minY, maxX, maxY];
}

function showUploadStatus(message, kind) {
  const el = document.getElementById("upload-status");
  el.textContent = message;
  el.className = kind || "";
  el.hidden = false;
}

function computeBuffer(u) {
  if (!u.bufferMeters) {
    u.bufferGeojson = { type: "FeatureCollection", features: [] };
    return;
  }
  const buffered = turf.buffer(u.geojson, u.bufferMeters / 1000, { units: "kilometers" });
  u.bufferGeojson = buffered.type === "FeatureCollection" ? buffered : { type: "FeatureCollection", features: [buffered] };
}

function applyUploadedLayerState(u) {
  const vis = u.visible ? "visible" : "none";
  if (map.getLayer(`${u.id}-fill`)) {
    map.setLayoutProperty(`${u.id}-fill`, "visibility", vis);
    map.setPaintProperty(`${u.id}-fill`, "fill-opacity", u.opacity * 0.4);
  }
  if (map.getLayer(`${u.id}-line`)) {
    map.setLayoutProperty(`${u.id}-line`, "visibility", vis);
    map.setPaintProperty(`${u.id}-line`, "line-opacity", u.opacity);
  }
  if (map.getLayer(`${u.id}-point`)) {
    map.setLayoutProperty(`${u.id}-point`, "visibility", vis);
    map.setPaintProperty(`${u.id}-point`, "circle-opacity", u.opacity);
  }
  if (map.getLayer(`${u.id}-buffer`)) {
    map.setLayoutProperty(`${u.id}-buffer`, "visibility", u.bufferMeters ? vis : "none");
    map.setPaintProperty(`${u.id}-buffer`, "fill-opacity", u.bufferOpacity);
  }
  if (map.getSource(`${u.id}-buffer-src`)) {
    map.getSource(`${u.id}-buffer-src`).setData(u.bufferGeojson);
  }
}

function removeUploadedLayer(id) {
  const idx = uploadedLayers.findIndex((u) => u.id === id);
  if (idx === -1) return;
  const u = uploadedLayers[idx];
  for (const layerId of uploadLayerIds(u)) {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
  }
  if (map.getSource(u.id)) map.removeSource(u.id);
  if (map.getSource(`${u.id}-buffer-src`)) map.removeSource(`${u.id}-buffer-src`);
  uploadedLayers.splice(idx, 1);
  buildUploadPanel();
}

function buildUploadPanel() {
  const panel = document.getElementById("upload-panel");
  const empty = document.getElementById("upload-panel-empty");

  if (uploadedLayers.length === 0) {
    panel.innerHTML = "";
    panel.appendChild(empty);
    return;
  }

  let html = "";
  for (const u of uploadedLayers) {
    const opacityPct = Math.round(u.opacity * 100);
    const bufferOptionsHtml = BUFFER_OPTIONS.map(
      (m) => `<option value="${m}" ${u.bufferMeters === m ? "selected" : ""}>${m === 0 ? "Sin buffer" : m + " m"}</option>`
    ).join("");
    html += `
      <div class="layer-row upload-row">
        <div class="layer-row-main">
          <label>
            <input type="checkbox" class="upload-toggle" data-id="${u.id}" ${u.visible ? "checked" : ""}>
            <span class="swatch" style="background:${u.color}"></span>
            <span class="layer-name" title="${u.name}">${u.name}</span>
          </label>
          <button class="upload-remove-btn" data-id="${u.id}" title="Quitar">✕</button>
        </div>
        <input type="range" class="upload-opacity" data-id="${u.id}" min="0" max="100" value="${opacityPct}" title="Transparencia del trazado">
        <label class="upload-buffer-row">
          Buffer:
          <select class="upload-buffer-select" data-id="${u.id}">${bufferOptionsHtml}</select>
        </label>
        <div class="upload-buffer-opacity-row" ${u.bufferMeters ? "" : 'style="display:none"'}>
          <span>Transparencia del buffer</span>
          <input type="range" class="upload-buffer-opacity" data-id="${u.id}" min="0" max="100" value="${Math.round(u.bufferOpacity * 100)}">
        </div>
        <button class="upload-analyze-btn" data-id="${u.id}" ${u.bufferMeters ? "" : "disabled"}>🧮 Analizar afecciones</button>
      </div>`;
  }
  panel.innerHTML = html;

  panel.querySelectorAll(".upload-toggle").forEach((cb) => {
    cb.addEventListener("change", () => {
      const u = uploadedLayers.find((x) => x.id === cb.dataset.id);
      u.visible = cb.checked;
      applyUploadedLayerState(u);
    });
  });
  panel.querySelectorAll(".upload-opacity").forEach((sl) => {
    sl.addEventListener("input", () => {
      const u = uploadedLayers.find((x) => x.id === sl.dataset.id);
      u.opacity = Number(sl.value) / 100;
      applyUploadedLayerState(u);
    });
  });
  panel.querySelectorAll(".upload-buffer-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      const u = uploadedLayers.find((x) => x.id === sel.dataset.id);
      u.bufferMeters = Number(sel.value);
      computeBuffer(u);
      applyUploadedLayerState(u);
      const row = sel.closest(".upload-row");
      row.querySelector(".upload-buffer-opacity-row").style.display = u.bufferMeters ? "" : "none";
      row.querySelector(".upload-analyze-btn").disabled = !u.bufferMeters;
    });
  });
  panel.querySelectorAll(".upload-buffer-opacity").forEach((sl) => {
    sl.addEventListener("input", () => {
      const u = uploadedLayers.find((x) => x.id === sl.dataset.id);
      u.bufferOpacity = Number(sl.value) / 100;
      applyUploadedLayerState(u);
    });
  });
  panel.querySelectorAll(".upload-remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => removeUploadedLayer(btn.dataset.id));
  });
  panel.querySelectorAll(".upload-analyze-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const u = uploadedLayers.find((x) => x.id === btn.dataset.id);
      if (u) analyzeUploadedLayer(u);
    });
  });
}

function addUploadedLayer(name, geojson) {
  uploadCounter++;
  const fc = geojson.type === "FeatureCollection" ? geojson : { type: "FeatureCollection", features: [geojson] };
  const u = {
    id: `upload-${uploadCounter}`,
    name,
    geojson: fc,
    bufferGeojson: { type: "FeatureCollection", features: [] },
    color: nextUploadColor(),
    visible: true,
    opacity: 1,
    bufferMeters: 0,
    bufferOpacity: 0.3,
  };
  uploadedLayers.push(u);
  addUploadedLayerToMap(u);
  buildUploadPanel();
  return u;
}

async function parseUploadedFile(file) {
  const name = file.name.toLowerCase();

  if (name.endsWith(".geojson") || name.endsWith(".json")) {
    const text = await file.text();
    return JSON.parse(text);
  }

  if (name.endsWith(".zip")) {
    const buffer = await file.arrayBuffer();
    const result = await shp(buffer);
    // shpjs devuelve un FeatureCollection, o un array si el zip trae varias capas
    return Array.isArray(result) ? result[0] : result;
  }

  if (name.endsWith(".kml")) {
    const text = await file.text();
    const xml = new DOMParser().parseFromString(text, "text/xml");
    return toGeoJSON.kml(xml);
  }

  if (name.endsWith(".kmz")) {
    const buffer = await file.arrayBuffer();
    const zip = await JSZip.loadAsync(buffer);
    const kmlEntry = Object.values(zip.files).find((f) => f.name.toLowerCase().endsWith(".kml"));
    if (!kmlEntry) throw new Error("El KMZ no contiene ningún archivo .kml dentro.");
    const kmlText = await kmlEntry.async("text");
    const xml = new DOMParser().parseFromString(kmlText, "text/xml");
    return toGeoJSON.kml(xml);
  }

  throw new Error("Formato no soportado. Usa GeoJSON, SHP (en .zip), KML o KMZ.");
}

function fitToAllUploaded() {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const u of uploadedLayers) {
    const [a, b, c, d] = featureBounds(u.geojson);
    if (a < minX) minX = a;
    if (b < minY) minY = b;
    if (c > maxX) maxX = c;
    if (d > maxY) maxY = d;
  }
  if (isFinite(minX)) {
    map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 80, maxZoom: 16, duration: 800 });
  }
}

// --- UI wiring ---
const uploadOpenBtn = document.getElementById("upload-open-btn");
const uploadFileInput = document.getElementById("upload-file-input");

uploadOpenBtn.addEventListener("click", () => uploadFileInput.click());

uploadFileInput.addEventListener("change", async () => {
  const files = Array.from(uploadFileInput.files);
  if (files.length === 0) return;

  showUploadStatus(`Procesando ${files.length} archivo${files.length === 1 ? "" : "s"}...`, "");
  let ok = 0;
  const errors = [];
  for (const file of files) {
    try {
      const geojson = await parseUploadedFile(file);
      addUploadedLayer(file.name, geojson);
      ok++;
    } catch (e) {
      console.error(e);
      errors.push(`${file.name}: ${e.message}`);
    }
  }
  fitToAllUploaded();

  if (errors.length === 0) {
    showUploadStatus(`${ok} archivo${ok === 1 ? "" : "s"} cargado${ok === 1 ? "" : "s"} correctamente.`, "ok");
  } else {
    showUploadStatus(`${ok} OK, ${errors.length} con error: ${errors.join(" | ")}`, "error");
  }
  uploadFileInput.value = "";
});

// --- Panel colapsable ---
document.getElementById("upload-panel-toggle").addEventListener("click", () => {
  document.getElementById("upload-panel-container").classList.toggle("collapsed");
});
