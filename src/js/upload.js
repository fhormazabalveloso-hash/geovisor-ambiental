// Subida del tramo/punto de la actuacion (GeoJSON, SHP en ZIP, KML/KMZ) y
// dibujo en el mapa. GPKG queda fuera por ahora -- necesitaria un motor
// SQLite en WebAssembly (@ngageoint/geopackage-js), bastante mas pesado
// que estos tres formatos juntos; se puede anadir despues si hace falta.

const UPLOAD_SOURCE_ID = "uploaded-trace";
const UPLOAD_LAYER_COLOR = "#E91E63"; // magenta, para distinguirlo claramente de las capas ambientales
let lastUploadedGeoJSON = null;

// Cambiar de mapa base reemplaza el estilo entero (setStyle), lo que borra
// las fuentes/capas añadidas dinámicamente -- se vuelve a dibujar el
// tramo subido si habia uno.
map.on("styledata", () => {
  if (lastUploadedGeoJSON && !map.getSource(UPLOAD_SOURCE_ID)) {
    ensureUploadLayers();
    map.getSource(UPLOAD_SOURCE_ID).setData(lastUploadedGeoJSON);
  }
});

function ensureUploadLayers() {
  if (map.getSource(UPLOAD_SOURCE_ID)) return;

  map.addSource(UPLOAD_SOURCE_ID, {
    type: "geojson",
    data: { type: "FeatureCollection", features: [] },
  });

  map.addLayer({
    id: `${UPLOAD_SOURCE_ID}-fill`,
    type: "fill",
    source: UPLOAD_SOURCE_ID,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: { "fill-color": UPLOAD_LAYER_COLOR, "fill-opacity": 0.25 },
  });
  map.addLayer({
    id: `${UPLOAD_SOURCE_ID}-line`,
    type: "line",
    source: UPLOAD_SOURCE_ID,
    filter: ["match", ["geometry-type"], ["LineString", "Polygon"], true, false],
    paint: { "line-color": UPLOAD_LAYER_COLOR, "line-width": 4 },
  });
  map.addLayer({
    id: `${UPLOAD_SOURCE_ID}-point`,
    type: "circle",
    source: UPLOAD_SOURCE_ID,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-color": UPLOAD_LAYER_COLOR,
      "circle-radius": 7,
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 2,
    },
  });
}

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

function loadGeoJSONOntoMap(geojson) {
  ensureUploadLayers();
  const fc = geojson.type === "FeatureCollection" ? geojson : { type: "FeatureCollection", features: [geojson] };
  lastUploadedGeoJSON = fc;
  map.getSource(UPLOAD_SOURCE_ID).setData(fc);

  const [minX, minY, maxX, maxY] = featureBounds(fc);
  if (isFinite(minX)) {
    map.fitBounds([[minX, minY], [maxX, maxY]], { padding: 80, maxZoom: 16, duration: 800 });
  }

  const nFeatures = fc.features.length;
  showUploadStatus(`Tramo cargado: ${nFeatures} elemento${nFeatures === 1 ? "" : "s"}.`, "ok");
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

// --- UI wiring ---
const uploadOpenBtn = document.getElementById("upload-open-btn");
const uploadFileInput = document.getElementById("upload-file-input");

uploadOpenBtn.addEventListener("click", () => uploadFileInput.click());

uploadFileInput.addEventListener("change", async () => {
  const file = uploadFileInput.files[0];
  if (!file) return;

  showUploadStatus(`Procesando ${file.name}...`, "");
  try {
    const geojson = await parseUploadedFile(file);
    loadGeoJSONOntoMap(geojson);
  } catch (e) {
    console.error(e);
    showUploadStatus("Error: " + e.message, "error");
  } finally {
    uploadFileInput.value = "";
  }
});
