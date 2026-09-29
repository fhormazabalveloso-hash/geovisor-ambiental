// Capas EN LINEA (l.wfs en layers.js): hoy las zonas inundables del SNCZI,
// consultadas en vivo al servicio WFS de MITECO en vez de teselarlas en
// data-web/ (las laminas T10/T100/T500 de origen pesan 1-1,9 GB cada una y
// eran 3 de las 5 capas grandes pendientes -- ver README §9).
//
// Probado antes de integrarlo (2026-09-29, ver README §2):
// - CORS abierto (Access-Control-Allow-Origin: *): se consulta directamente
//   desde el navegador, sin servidor propio.
// - Rapido: 0,1-0,3 s por capa y consulta.
// - Pesado: cada elemento es la zona ENTERA de un tramo estudiado (el
//   Guadalquivir en Cordoba, 12,8 km, son ~0,5 MB). Por eso en el mapa solo
//   se carga para la vista actual y con la vista no demasiado grande.
// - Geometria con 4 decimales (~10 m): de sobra para un cribado.
// - Solo hay zona inundable donde el SNCZI ha hecho el estudio: un cauce
//   sin zona puede ser simplemente un cauce no estudiado (ver
//   ANALYSIS_FLOOD_COVERAGE_NOTE en analysis.js).
//
// Usa wfsData / wfsFeatureCollection / wfsLabelCollection de main.js
// (cargado antes en index.html).

const WFS_URL = "https://gis.miteco.gob.es/geoserver/wfs";
const WFS_MAX_FEATURES = 500;
const WFS_TIMEOUT_MS = 20000;
// Por encima de esta diagonal de vista no se cargan en el mapa: con media
// provincia en pantalla serian decenas de MB.
const WFS_MAX_VIEW_KM = 60;
const WFS_REFRESH_DEBOUNCE_MS = 400;

const WFS_STATUS_TEXT = {
  idle: "En línea · MITECO",
  loading: "Cargando…",
  ok: "En línea · MITECO",
  zoom: "Acerca el mapa para cargarla",
  truncated: `Solo los primeros ${WFS_MAX_FEATURES} elementos`,
  error: "Servicio de MITECO no disponible",
};

const wfsStatus = {};
for (const l of LAYERS) if (l.wfs) wfsStatus[l.id] = { state: "idle", message: "" };

function wfsStatusHtml(layerId) {
  const s = wfsStatus[layerId] || { state: "idle" };
  const title = s.message ? ` title="${String(s.message).replace(/"/g, "&quot;")}"` : "";
  return `<span class="layer-live-status layer-live-${s.state}" data-id="${layerId}"${title}>${WFS_STATUS_TEXT[s.state]}</span>`;
}

function setWfsStatus(l, state, message = "") {
  wfsStatus[l.id] = { state, message };
  const el = document.querySelector(`.layer-live-status[data-id="${l.id}"]`);
  if (el) el.outerHTML = wfsStatusHtml(l.id);
}

// Algunas demarcaciones ponen el codigo del tramo delante del nombre
// ("ES030-12-04-1-01 Río Manzanares", "ES030-X-04-1-53 Arroyo de
// Antequina en Madrid") y en la leyenda, el mapa y el informe solo es ruido.
// El codigo sigue disponible en id_zona.
const WFS_NAME_CODE_PREFIX = /^ES\d{3}[-A-Z0-9_.]*\s+/;

function cleanWfsName(f, field) {
  const raw = f.properties && f.properties[field];
  if (typeof raw === "string") f.properties[field] = raw.replace(WFS_NAME_CODE_PREFIX, "").trim() || raw;
}

// Elementos de la capa que tocan el rectangulo bbox [oeste, sur, este,
// norte] (grados). Lanza un error si el servicio falla, tarda mas de
// WFS_TIMEOUT_MS o responde algo que no es GeoJSON -- quien llama decide
// como avisarlo; nunca se trata como "sin elementos".
async function fetchWfsFeatures(l, bbox) {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeNames: l.wfs.typeName,
    outputFormat: "application/json",
    srsName: "EPSG:4326",
    count: String(WFS_MAX_FEATURES),
    // CRS84 = orden longitud/latitud; con EPSG:4326 a secas WFS 2.0 espera
    // latitud/longitud.
    bbox: `${bbox.join(",")},urn:ogc:def:crs:OGC:1.3:CRS84`,
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WFS_TIMEOUT_MS);
  try {
    const res = await fetch(`${WFS_URL}?${params}`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`el servicio respondió HTTP ${res.status}`);
    const fc = await res.json();
    if (!fc || !Array.isArray(fc.features)) throw new Error("respuesta no válida del servicio");
    const features = fc.features.filter((f) => f.geometry);
    if (l.labelField) for (const f of features) cleanWfsName(f, l.labelField);
    return { features, truncated: fc.features.length >= WFS_MAX_FEATURES };
  } catch (e) {
    if (e.name === "AbortError") throw new Error(`sin respuesta en ${WFS_TIMEOUT_MS / 1000} s`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Guarda los elementos (sin duplicar: por id_zona, o el id de GeoServer) y
// refresca las fuentes del mapa.
function storeWfsFeatures(l, features) {
  const store = wfsData[l.id];
  for (const f of features) {
    const key = f.properties && f.properties[l.idField] != null ? f.properties[l.idField] : f.id;
    if (key == null) continue;
    store.set(key, f);
  }
  const src = map.getSource(`src-${l.id}`);
  if (src) src.setData(wfsFeatureCollection(l.id));
  const labels = map.getSource(`src-${l.id}-labels`);
  if (labels && l.labelField) labels.setData(wfsLabelCollection(l));
}

function currentViewBbox() {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}

// Carga las capas en linea VISIBLES para la vista actual. Tambien la usa la
// exportacion de cartografia (export.js) antes de capturar.
async function refreshWfsForView() {
  const bbox = currentViewBbox();
  const tooBig = turf.distance([bbox[0], bbox[1]], [bbox[2], bbox[3]]) > WFS_MAX_VIEW_KM;
  const targets = LAYERS.filter((l) => l.wfs && layerVisible[l.id]);
  await Promise.all(
    targets.map(async (l) => {
      if (tooBig) {
        setWfsStatus(l, "zoom");
        return;
      }
      setWfsStatus(l, "loading");
      try {
        const { features, truncated } = await fetchWfsFeatures(l, bbox);
        storeWfsFeatures(l, features);
        setWfsStatus(l, truncated ? "truncated" : "ok");
      } catch (e) {
        console.warn(`Capa en línea ${l.id}:`, e);
        setWfsStatus(l, "error", e.message);
      }
    })
  );
}

let wfsRefreshTimer = null;
function scheduleWfsRefresh() {
  clearTimeout(wfsRefreshTimer);
  wfsRefreshTimer = setTimeout(refreshWfsForView, WFS_REFRESH_DEBOUNCE_MS);
}

map.on("moveend", scheduleWfsRefresh);
