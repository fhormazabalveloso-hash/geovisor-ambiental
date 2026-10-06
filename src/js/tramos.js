// Tramos de un archivo subido (analisis por tramo, rama avanzado, 2026-10-02).
//
// Caso que lo motiva: la primera oferta real de cerramiento, un KMZ con 16
// tramos (cada LineString con su nombre, del tipo "linea_PKinicio_PKfin_margen")
// y, detras de cada uno, un punto con su PK de inicio. El analisis los trataba
// como una sola obra: no decia que tramo tocaba que, y un punto de PK que
// caia dentro de una zona inundable salia como "el punto de la obra cae dentro".
//
// Reglas:
// - Cada linea o poligono del archivo es un tramo, con su nombre (o "Tramo N").
//   Las margenes (MD/MI) son tramos distintos porque vienen como lineas distintas.
// - Un punto a menos de TRAMO_MARKER_MAX_M de algun tramo es una MARCA de ese
//   tramo (su PK, un hito): se asocia al tramo mas cercano y NO se analiza como
//   obra. Si dos tramos quedan casi igual de cerca (margenes MD y MI de un mismo
//   PK), se asocia a los dos.
// - Un punto lejos de todos los tramos, o un archivo solo de puntos, es obra
//   puntual: cada punto es su propio tramo.
//
// Sin FEATURES.porTramo (modo basico) no se separa nada: todo el archivo es
// una sola obra, como en la version piloto publicada.

const TRAMO_NAME_FIELDS = ["name", "Name", "NAME", "nombre", "Nombre", "NOMBRE", "tramo", "Tramo", "TRAMO", "denominacion", "Denominacion", "DENOMINACION", "id", "Id", "ID"];
const TRAMO_MARKER_MAX_M = 200;
const TRAMO_MARKER_TIE_M = 20;

function tramoFeatureName(f) {
  const p = f.properties || {};
  for (const k of TRAMO_NAME_FIELDS) {
    const v = p[k];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  return "";
}

function isPointGeometry(f) {
  return f.geometry.type === "Point" || f.geometry.type === "MultiPoint";
}

// Distancia (m) de un punto a una linea o poligono (0 si cae dentro).
function pointToShapeDistanceM(pt, shape) {
  let best = Infinity;
  for (const part of turf.flatten(shape).features) {
    const g = part.geometry;
    if (!g) continue;
    if (g.type === "LineString") {
      best = Math.min(best, turf.pointToLineDistance(pt, part, { units: "meters" }));
    } else if (g.type === "Polygon") {
      if (turf.booleanPointInPolygon(pt, part)) return 0;
      for (const ring of g.coordinates) best = Math.min(best, turf.pointToLineDistance(pt, turf.lineString(ring), { units: "meters" }));
    }
  }
  return best;
}

// Longitud (m) de las lineas y superficie (ha) de los poligonos de un tramo.
function tramoMeasures(f) {
  const t = f.geometry.type;
  if (t === "LineString" || t === "MultiLineString") return { lengthM: turf.length(f, { units: "kilometers" }) * 1000, areaHa: 0 };
  if (t === "Polygon" || t === "MultiPolygon") return { lengthM: 0, areaHa: turf.area(f) / 10000 };
  return { lengthM: 0, areaHa: 0 };
}

// { obra, tramos: [{ idx, name, feature, geojson, lengthM, areaHa, markers: [nombre] }],
//   markers: [{ name, feature, tramoIdx: [] }] }
// obra: lo que se analiza (todo menos las marcas), como FeatureCollection.
function splitTramos(geojson, fallbackName) {
  const feats = (geojson.features || []).filter((f) => f.geometry);
  const single = () => ({
    obra: { type: "FeatureCollection", features: feats },
    tramos: [{ idx: 0, name: fallbackName, feature: null, geojson: { type: "FeatureCollection", features: feats }, lengthM: 0, areaHa: 0, markers: [] }],
    markers: [],
  });
  if (!FEATURES.porTramo || feats.length === 0) return single();

  // Los MultiPoint se separan en puntos sueltos (cada uno puede ser una marca
  // de un tramo distinto).
  const items = [];
  for (const f of feats) {
    if (f.geometry.type === "MultiPoint") {
      for (const c of f.geometry.coordinates) items.push(turf.point(c, f.properties || {}));
    } else {
      items.push(f);
    }
  }
  const shapes = items.filter((f) => !isPointGeometry(f));

  // Que puntos son marcas, y de que tramos (indices en `shapes`).
  const markerOf = new Map();
  if (shapes.length) {
    for (const f of items) {
      if (!isPointGeometry(f)) continue;
      const d = shapes.map((s) => pointToShapeDistanceM(f, s));
      const nearest = Math.min(...d);
      if (nearest <= TRAMO_MARKER_MAX_M) {
        markerOf.set(f, d.map((v, i) => (v <= nearest + TRAMO_MARKER_TIE_M ? i : -1)).filter((i) => i >= 0));
      }
    }
  }

  // Tramos en el orden del archivo; nombres repetidos se numeran.
  const tramos = [];
  const tramoOfShape = new Map();
  const seen = new Map();
  for (const f of items) {
    if (markerOf.has(f)) continue;
    let name = tramoFeatureName(f) || `Tramo ${tramos.length + 1}`;
    const n = (seen.get(name) || 0) + 1;
    seen.set(name, n);
    if (n > 1) name = `${name} (${n})`;
    if (!isPointGeometry(f)) tramoOfShape.set(shapes.indexOf(f), tramos.length);
    tramos.push({ idx: tramos.length, name, feature: f, geojson: { type: "FeatureCollection", features: [f] }, ...tramoMeasures(f), markers: [] });
  }

  const markers = [];
  for (const [f, shapeIdx] of markerOf) {
    const name = tramoFeatureName(f) || "Punto sin nombre";
    const tramoIdx = shapeIdx.map((i) => tramoOfShape.get(i));
    for (const ti of tramoIdx) if (!tramos[ti].markers.includes(name)) tramos[ti].markers.push(name);
    markers.push({ name, feature: f, tramoIdx });
  }

  // Un solo tramo sin marcas: igual que sin separar (mismo nombre que el archivo).
  if (tramos.length === 1 && markers.length === 0) return single();
  return { obra: { type: "FeatureCollection", features: tramos.map((t) => t.feature) }, tramos, markers };
}

// Version tolerante para la subida: si algo falla al separar, el archivo se
// analiza entero como antes en vez de no poder subirse.
function splitTramosSafe(geojson, fallbackName) {
  try {
    return splitTramos(geojson, fallbackName);
  } catch (e) {
    console.warn("No se pudieron separar los tramos; se analiza el archivo entero:", e);
    const feats = (geojson.features || []).filter((f) => f.geometry);
    const fc = { type: "FeatureCollection", features: feats };
    return { obra: fc, tramos: [{ idx: 0, name: fallbackName, feature: null, geojson: fc, lengthM: 0, areaHa: 0, markers: [] }], markers: [] };
  }
}
