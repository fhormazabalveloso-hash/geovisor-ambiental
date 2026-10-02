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
// por el usuario (25 m - 5 km). Se dibuja por debajo del trazado original,
// como contorno discontinuo, relleno translucido o ambos (BUFFER_STYLES).

const UPLOAD_COLORS = ["#E91E63", "#00BCD4", "#FF9800", "#673AB7", "#CDDC39", "#F44336", "#3F51B5", "#009688"];
// metros, 0 = sin buffer. Hasta 500 m para afecciones puntuales (DPH,
// vias pecuarias); 1-5 km para el ambito de estudio real de una EIA
// (avifauna, cuenca hidrografica) sobre trazados largos -- ver README §9.
const BUFFER_OPTIONS = [0, 25, 50, 100, 200, 500, 1000, 2000, 5000];
// Grosor de linea del trazado subido, en px CSS -- personalizable por
// tramo/punto (pedido por Francisco probando el visor con un caso real,
// 2026-09-24: en la cartografia exportada la linea del proyecto se veia
// demasiado fina). El valor se escala automaticamente para la resolucion
// de exportacion en export.js (ver dpiScaleFactor), asi que "10" aqui se
// ve igual de grueso en pantalla que en el PDF/PNG impreso.
const LINE_WIDTH_MIN = 1;
const LINE_WIDTH_MAX = 10;
const LINE_WIDTH_DEFAULT = 4;

// Como se dibuja el buffer. Por defecto solo el contorno discontinuo: con
// relleno, un buffer grande tapa las capas ambientales que tiene debajo --
// justo lo que se esta intentando ver (visto en una cartografia real de
// Francisco, 2026-09-25: el circulo de buffer apagaba todo el mapa).
const BUFFER_STYLES = {
  contorno: "Contorno",
  relleno: "Relleno",
  ambos: "Relleno + contorno",
};
const BUFFER_STYLE_DEFAULT = "contorno";

function bufferHasFill(u) {
  return u.bufferStyle === "relleno" || u.bufferStyle === "ambos";
}

function bufferHasOutline(u) {
  return u.bufferStyle === "contorno" || u.bufferStyle === "ambos";
}

function bufferLabel(m) {
  if (m === 0) return "Sin buffer";
  return m >= 1000 ? `${m / 1000} km` : `${m} m`;
}

let uploadCounter = 0;
const uploadedLayers = []; // { id, name, geojson, color, visible, opacity, lineWidth, bufferMeters, bufferOpacity, bufferStyle }

function uploadColorFor(n) {
  return UPLOAD_COLORS[n % UPLOAD_COLORS.length];
}

function uploadLayerIds(u) {
  return [`${u.id}-fill`, `${u.id}-line`, `${u.id}-point`, `${u.id}-buffer`, `${u.id}-buffer-line`, `${u.id}-analysis-buffers-line`];
}

const EMPTY_FC = { type: "FeatureCollection", features: [] };

// Buffers por capa usados en el ultimo analisis, cuando no coinciden con el
// buffer general del tramo (p. ej. Red Natura a 1 km con el tramo a
// 500 m). Los calcula analysis.js; aqui solo se guardan y se dibujan, con
// un trazo punteado distinto del discontinuo del buffer general. Ver
// investigacion/ejemplos-de-uso/caso-puerto-dique-carboneras.md §4.5.
// rings: [{ meters, layerNames, polygon }]
function setAnalysisBuffers(u, rings) {
  u.analysisBuffers = rings.map((r) => ({ meters: r.meters, layerNames: r.layerNames }));
  u.analysisBuffersGeojson = {
    type: "FeatureCollection",
    features: rings.map((r) => ({ type: "Feature", geometry: r.polygon.geometry, properties: { meters: r.meters } })),
  };
  const src = map.getSource(`${u.id}-analysis-buffers-src`);
  if (src) src.setData(u.analysisBuffersGeojson);
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
    layout: { visibility: u.visible && u.bufferMeters && bufferHasFill(u) ? "visible" : "none" },
    paint: { "fill-color": u.color, "fill-opacity": u.bufferOpacity },
  });
  map.addLayer({
    id: `${u.id}-buffer-line`,
    type: "line",
    source: `${u.id}-buffer-src`,
    layout: { visibility: u.visible && u.bufferMeters && bufferHasOutline(u) ? "visible" : "none" },
    paint: { "line-color": u.color, "line-width": 2, "line-dasharray": [3, 2] },
  });
  map.addSource(`${u.id}-analysis-buffers-src`, { type: "geojson", data: u.analysisBuffersGeojson || EMPTY_FC });
  map.addLayer({
    id: `${u.id}-analysis-buffers-line`,
    type: "line",
    source: `${u.id}-analysis-buffers-src`,
    layout: { visibility: u.visible ? "visible" : "none", "line-cap": "round" },
    paint: { "line-color": u.color, "line-width": 1.5, "line-dasharray": [0.5, 2] },
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
    paint: { "line-color": u.color, "line-width": u.lineWidth, "line-opacity": u.opacity },
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
    map.setPaintProperty(`${u.id}-line`, "line-width", u.lineWidth);
  }
  if (map.getLayer(`${u.id}-point`)) {
    map.setLayoutProperty(`${u.id}-point`, "visibility", vis);
    map.setPaintProperty(`${u.id}-point`, "circle-opacity", u.opacity);
  }
  if (map.getLayer(`${u.id}-buffer`)) {
    map.setLayoutProperty(`${u.id}-buffer`, "visibility", u.bufferMeters && bufferHasFill(u) ? vis : "none");
    map.setPaintProperty(`${u.id}-buffer`, "fill-opacity", u.bufferOpacity);
  }
  if (map.getLayer(`${u.id}-buffer-line`)) {
    map.setLayoutProperty(`${u.id}-buffer-line`, "visibility", u.bufferMeters && bufferHasOutline(u) ? vis : "none");
  }
  if (map.getSource(`${u.id}-buffer-src`)) {
    map.getSource(`${u.id}-buffer-src`).setData(u.bufferGeojson);
  }
  if (map.getLayer(`${u.id}-analysis-buffers-line`)) {
    map.setLayoutProperty(`${u.id}-analysis-buffers-line`, "visibility", vis);
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
  if (map.getSource(`${u.id}-analysis-buffers-src`)) map.removeSource(`${u.id}-analysis-buffers-src`);
  uploadedLayers.splice(idx, 1);
  buildUploadPanel();
}

// --- Solapamiento entre buffers de varios tramos/puntos subidos (idea #9
// de investigacion/ideas-mejora-geovisores-referencia.md) ---
//
// No modela impacto acumulativo real (eso exigiria conocer el tipo de
// afeccion de cada proyecto, fuera de alcance de un cribado) -- solo
// compara los buffers dos a dos y señala donde coinciden geometricamente,
// que es justo el dato de partida que pide el apartado de "efectos
// sinergicos y acumulativos" de casi cualquier EIA.
let lastOverlapGeojson = { type: "FeatureCollection", features: [] };

function addOverlapLayerToMap() {
  if (map.getSource("upload-overlaps")) return;
  map.addSource("upload-overlaps", { type: "geojson", data: lastOverlapGeojson });
  map.addLayer({
    id: "upload-overlaps-fill",
    type: "fill",
    source: "upload-overlaps",
    paint: { "fill-color": "#D50000", "fill-opacity": 0.35 },
  });
  map.addLayer({
    id: "upload-overlaps-line",
    type: "line",
    source: "upload-overlaps",
    paint: { "line-color": "#D50000", "line-width": 2, "line-dasharray": [2, 1] },
  });
}

// Igual que con las capas subidas: un cambio de mapa base reemplaza el
// estilo entero y borra las fuentes/capas dinamicas.
map.on("styledata", () => {
  if (!map.getSource("upload-overlaps")) addOverlapLayerToMap();
});

// unifyBuffer() esta definida en analysis.js (cargado despues que este
// fichero en index.html) pero solo se invoca aqui dentro de un manejador de
// clic, mucho despues de que todos los <script> ya se hayan ejecutado -- el
// mismo patron que ya usa este fichero para llamar a analyzeUploadedLayer.
function computeUploadOverlaps() {
  const withBuffer = uploadedLayers.filter(
    (u) => u.bufferMeters > 0 && u.bufferGeojson && u.bufferGeojson.features.length > 0
  );
  const overlaps = [];
  for (let i = 0; i < withBuffer.length; i++) {
    for (let j = i + 1; j < withBuffer.length; j++) {
      const a = unifyBuffer(withBuffer[i].bufferGeojson);
      const b = unifyBuffer(withBuffer[j].bufferGeojson);
      if (!a || !b) continue;
      let inter;
      try {
        inter = turf.intersect(a, b);
      } catch (e) {
        continue;
      }
      if (!inter) continue;
      const ha = turf.area(inter) / 10000;
      if (ha <= 0) continue;
      overlaps.push({ a: withBuffer[i], b: withBuffer[j], ha, geometry: inter });
    }
  }
  return overlaps;
}

function showOverlapResults() {
  const overlaps = computeUploadOverlaps();
  addOverlapLayerToMap();
  lastOverlapGeojson = {
    type: "FeatureCollection",
    features: overlaps.map((o) => ({
      type: "Feature",
      geometry: o.geometry.geometry,
      properties: { a: o.a.name, b: o.b.name, ha: o.ha },
    })),
  };
  if (map.getSource("upload-overlaps")) map.getSource("upload-overlaps").setData(lastOverlapGeojson);

  const resultsEl = document.getElementById("upload-overlap-results");
  if (!resultsEl) return;
  resultsEl.hidden = false;
  if (overlaps.length === 0) {
    resultsEl.innerHTML = `<p class="analysis-empty">Sin solapamiento entre los buffers de los tramos/puntos subidos.</p>`;
    return;
  }
  resultsEl.innerHTML = overlaps
    .map(
      (o) =>
        `<p class="upload-overlap-row">⚠️ <strong>${o.a.name}</strong> × <strong>${o.b.name}</strong>: ${o.ha.toLocaleString("es-ES", { maximumFractionDigits: 2 })} ha solapadas</p>`
    )
    .join("");
}

function buildUploadPanel() {
  const panel = document.getElementById("upload-panel");

  if (uploadedLayers.length === 0) {
    // No se reutiliza el nodo #upload-panel-empty original: la primera vez
    // que hay al menos un tramo, panel.innerHTML se reemplaza por completo
    // mas abajo y ese nodo desaparece del documento -- reusarlo aqui
    // (bug preexistente: document.getElementById devolvia null y
    // appendChild(null) lanzaba TypeError la segunda vez que se llegaba a
    // 0 tramos) rompia al quitar todos los tramos subidos.
    panel.innerHTML = `<p id="upload-panel-empty">Sin tramos subidos todavía.</p>`;
    if (map.getSource("upload-overlaps")) map.getSource("upload-overlaps").setData({ type: "FeatureCollection", features: [] });
    return;
  }

  let html = "";
  if (uploadedLayers.length >= 2 && FEATURES.solapamiento) {
    html += `<div class="upload-overlap-section">
      <button id="upload-overlap-btn" class="upload-overlap-btn">🔗 Ver solapamientos entre buffers</button>
      <div id="upload-overlap-results" hidden></div>
    </div>`;
  } else if (map.getSource("upload-overlaps")) {
    // Quedaba 1 tramo o menos (se borro uno): el resaltado de solapamiento
    // en el mapa, si lo habia, ya no es valido -- se limpia.
    map.getSource("upload-overlaps").setData({ type: "FeatureCollection", features: [] });
  }
  for (const u of uploadedLayers) {
    const opacityPct = Math.round(u.opacity * 100);
    const bufferOptionsHtml = BUFFER_OPTIONS.map(
      (m) => `<option value="${m}" ${u.bufferMeters === m ? "selected" : ""}>${bufferLabel(m)}</option>`
    ).join("");
    const bufferStyleOptionsHtml = Object.entries(BUFFER_STYLES)
      .map(([key, label]) => `<option value="${key}" ${u.bufferStyle === key ? "selected" : ""}>${label}</option>`)
      .join("");
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
        <div class="upload-linewidth-row">
          <span>Grosor de línea</span>
          <input type="range" class="upload-linewidth" data-id="${u.id}" min="${LINE_WIDTH_MIN}" max="${LINE_WIDTH_MAX}" step="0.5" value="${u.lineWidth}" title="Grosor de línea del trazado">
        </div>
        <label class="upload-buffer-row">
          Buffer:
          <select class="upload-buffer-select" data-id="${u.id}">${bufferOptionsHtml}</select>
        </label>
        <label class="upload-buffer-row upload-buffer-style-row" ${u.bufferMeters ? "" : 'style="display:none"'}>
          Estilo:
          <select class="upload-buffer-style" data-id="${u.id}">${bufferStyleOptionsHtml}</select>
        </label>
        <div class="upload-buffer-opacity-row" ${u.bufferMeters && bufferHasFill(u) ? "" : 'style="display:none"'}>
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
  panel.querySelectorAll(".upload-linewidth").forEach((sl) => {
    sl.addEventListener("input", () => {
      const u = uploadedLayers.find((x) => x.id === sl.dataset.id);
      u.lineWidth = Number(sl.value);
      applyUploadedLayerState(u);
    });
  });
  panel.querySelectorAll(".upload-buffer-select").forEach((sel) => {
    sel.addEventListener("change", () => {
      const u = uploadedLayers.find((x) => x.id === sel.dataset.id);
      u.bufferMeters = Number(sel.value);
      computeBuffer(u);
      // Los buffers por capa del analisis anterior ya no corresponden al
      // buffer nuevo del tramo: se quitan hasta que se vuelva a analizar.
      setAnalysisBuffers(u, []);
      applyUploadedLayerState(u);
      const row = sel.closest(".upload-row");
      row.querySelector(".upload-buffer-style-row").style.display = u.bufferMeters ? "" : "none";
      row.querySelector(".upload-buffer-opacity-row").style.display = u.bufferMeters && bufferHasFill(u) ? "" : "none";
      row.querySelector(".upload-analyze-btn").disabled = !u.bufferMeters;
    });
  });
  panel.querySelectorAll(".upload-buffer-style").forEach((sel) => {
    sel.addEventListener("change", () => {
      const u = uploadedLayers.find((x) => x.id === sel.dataset.id);
      u.bufferStyle = sel.value;
      applyUploadedLayerState(u);
      const row = sel.closest(".upload-row");
      row.querySelector(".upload-buffer-opacity-row").style.display = u.bufferMeters && bufferHasFill(u) ? "" : "none";
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
  const overlapBtn = document.getElementById("upload-overlap-btn");
  if (overlapBtn) overlapBtn.addEventListener("click", showOverlapResults);
}

function addUploadedLayer(name, geojson) {
  // El contador solo avanza si el tramo llega a anadirse (ver
  // addUploadedLayerWhenReady: un reintento no debe saltarse ids/colores).
  const n = uploadCounter + 1;
  const fc = geojson.type === "FeatureCollection" ? geojson : { type: "FeatureCollection", features: [geojson] };
  const u = {
    id: `upload-${n}`,
    name,
    geojson: fc,
    bufferGeojson: { type: "FeatureCollection", features: [] },
    color: uploadColorFor(n),
    visible: true,
    opacity: 1,
    lineWidth: LINE_WIDTH_DEFAULT,
    bufferMeters: 0,
    bufferOpacity: 0.3,
    bufferStyle: BUFFER_STYLE_DEFAULT,
  };
  // Primero al mapa y despues a la lista: si addSource/addLayer fallan, el
  // tramo no se queda "fantasma" en uploadedLayers (el manejador de
  // styledata lo acabaria dibujando igualmente aunque el panel dijera que
  // no hay tramos -- visto al subir un archivo con el estilo aun cargando).
  addUploadedLayerToMap(u);
  uploadCounter = n;
  uploadedLayers.push(u);
  buildUploadPanel();
  return u;
}

// Justo al abrir el visor, o durante un cambio de mapa base, map.addSource
// lanza "Style is not done loading" mientras la definicion del estilo aun
// no esta lista. No sirve esperar a map.isStyleLoaded(): devuelve false
// mientras quede CUALQUIER tesela por cargar, y la subida se quedaba
// esperando indefinidamente. Se reintenta solo ese error concreto, con tope.
const STYLE_READY_TIMEOUT_MS = 15000;

async function addUploadedLayerWhenReady(name, geojson) {
  const deadline = performance.now() + STYLE_READY_TIMEOUT_MS;
  for (;;) {
    try {
      return addUploadedLayer(name, geojson);
    } catch (e) {
      if (!/Style is not done loading/.test(e.message) || performance.now() > deadline) throw e;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
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
      await addUploadedLayerWhenReady(file.name, geojson);
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
