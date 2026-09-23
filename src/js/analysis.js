// Cruce cuantitativo de afecciones: el buffer de un tramo/punto subido
// contra las capas ambientales de Nivel 1 (obligatorio) y Nivel 2
// (estimado). El Nivel 3 queda fuera del cruce automatico -- es solo
// contexto activable, no una afeccion juridica (ver README §5/§6).
//
// IMPORTANTE -- esto es una ESTIMACION de cribado, no un calculo de
// precision catastral: los datos vienen de teselas vectoriales (MVT), que
// simplifican algo la geometria segun el zoom, y las features se
// consultan tal como MapLibre las tiene renderizadas en ese momento
// (recortadas por tesela). El pipeline de teselado (GDAL MVT) anade un
// pequeno margen de solape entre teselas vecinas, asi que una misma
// entidad puede aparecer repetida en varias teselas dentro del buffer --
// para las capas con un identificador de entidad fiable (l.idField en
// layers.js) los fragmentos se agrupan y se unen antes de medir (ver
// unionFeatureGroup mas abajo); para las que no lo tienen, sigue siendo
// una aproximacion. Para una memoria definitiva de licitacion, esto es
// un punto de partida -- el dato preciso sigue saliendo de QGIS.

const ANALYSIS_NIVELES = [1, 2];
const ANALYSIS_CHUNK_KM = 0.01; // 10 m -- granularidad para medir longitud de linea dentro del buffer

// Cuando una capa no cruza el buffer, hasta donde se busca el elemento mas
// cercano (idea #4 de investigacion/ideas-mejora-geovisores-referencia.md):
// "el trazado pasa a 340 m de un ZEC" es informacion que hoy se descarta en
// silencio (turf.booleanIntersects simplemente no la incluye). El margen se
// mide mas alla del buffer EFECTIVO de cada capa (ver effectiveBufferM en
// analyzeUploadedLayer), no desde el trazado, para no disparar el area que
// hay que renderizar/consultar en capas muy densas.
const NEAREST_SEARCH_MARGIN_M = 2000;
// Granularidad de muestreo del trazado para aproximar esa distancia minima
// (ver sampleTrazadoPoints) -- 100 m es de sobra para una distancia que se
// mide en cientos/miles de metros; no hace falta la precision de 10 m que
// usa ANALYSIS_CHUNK_KM para longitud dentro del buffer.
const NEAREST_SAMPLE_KM = 0.1;

// Estados posibles de la verificacion en campo de un hallazgo (idea #6 de
// investigacion/ideas-mejora-geovisores-referencia.md) -- el primero es el
// valor por defecto (sin confirmar todavia).
const FIELD_STATUS_OPTIONS = ["Sin confirmar", "Confirmado en campo", "Descartado en campo"];

// Mismos valores placeholder que main.js filtra en las etiquetas del mapa
// (ver comentario junto a "text-field" en main.js) -- una capa que use
// alguno de estos como nombre en realidad no tiene nombre propio.
const ANALYSIS_PLACEHOLDER_NAMES = new Set(["sin nombre", "s/n", "sin identificar", ""]);

let lastAnalysisResults = null;

// Une todos los poligonos de buffer (puede haber uno por elemento subido)
// en un unico poligono, para no contar dos veces el area donde se solapan.
function unifyBuffer(bufferFC) {
  const feats = bufferFC.features.filter((f) => f.geometry);
  if (feats.length === 0) return null;
  let result = feats[0];
  for (let i = 1; i < feats.length; i++) {
    try {
      const u = turf.union(result, feats[i]);
      if (u) result = u;
    } catch (e) {
      console.warn("No se pudo unir un poligono de buffer:", e);
    }
  }
  return result;
}

function lineLengthInsidePolygonMeters(lineFeature, polygonFeature) {
  const geom = lineFeature.geometry;
  const lines =
    geom.type === "MultiLineString"
      ? geom.coordinates.map((c) => turf.lineString(c))
      : [lineFeature];

  let totalKm = 0;
  for (const line of lines) {
    let chunks;
    try {
      chunks = turf.lineChunk(line, ANALYSIS_CHUNK_KM, { units: "kilometers" }).features;
    } catch (e) {
      chunks = [line];
    }
    for (const chunk of chunks) {
      const len = turf.length(chunk, { units: "kilometers" });
      if (len === 0) continue;
      const mid = turf.along(chunk, len / 2, { units: "kilometers" });
      if (turf.booleanPointInPolygon(mid, polygonFeature)) {
        totalKm += len;
      }
    }
  }
  return totalKm * 1000;
}

function polygonIntersectionHectares(envFeature, bufferFeature) {
  let inter;
  try {
    inter = turf.intersect(envFeature, bufferFeature);
  } catch (e) {
    return 0;
  }
  if (!inter) return 0;
  return turf.area(inter) / 10000;
}

// El pipeline tesela con el driver MVT de GDAL, que por defecto anade un
// pequeno margen de solape entre teselas vecinas (para que el renderizado
// no se vea "cortado" en el borde). Consecuencia: una misma entidad puede
// aparecer repetida -- entera o en fragmentos parciales -- en varias
// teselas que caen dentro del buffer. Sumar area/longitud fragmento a
// fragmento sin deduplicar puede inflar el resultado (verificado con un
// caso real en HIC: ver layers.js). Para las capas que traen un campo de
// id real (l.idField), se agrupan los fragmentos de una misma entidad y
// se unen con turf.union ANTES de medir, para contar cada entidad una
// sola vez con su geometria completa reconstruida.
function unionFeatureGroup(feats) {
  let result = feats[0];
  for (let i = 1; i < feats.length; i++) {
    try {
      const u = turf.union(result, feats[i]);
      if (u) result = u;
    } catch (e) {
      console.warn("No se pudo unir fragmentos de una misma entidad:", e);
    }
  }
  return result;
}

// Buffer unificado (mismo criterio que unifyBuffer) a partir de una
// geometria y una distancia propia -- usado cuando una capa tiene un buffer
// distinto al general del tramo (override explicito o l.suggestedBufferM en
// layers.js, ver analyzeUploadedLayer).
function computeUnifiedBufferPolygon(geojson, meters) {
  const buffered = turf.buffer(geojson, meters / 1000, { units: "kilometers" });
  const fc = buffered.type === "FeatureCollection" ? buffered : { type: "FeatureCollection", features: [buffered] };
  return unifyBuffer(fc);
}

// Muestrea puntos a lo largo del trazado/punto subido cada NEAREST_SAMPLE_KM,
// para aproximar la distancia minima a un elemento cercano que no llega a
// cruzar el buffer (idea #4). Un punto subido se usa tal cual; una linea se
// recorre a intervalos; un poligono subido (p. ej. un cerramiento) se
// muestrea por su borde -- no tiene sentido medir distancia "al centro" de
// un cerramiento cuando lo relevante es donde pasa su perimetro.
function sampleTrazadoPoints(geojson, stepKm) {
  const points = [];
  const sampleLine = (line) => {
    const len = turf.length(line, { units: "kilometers" });
    if (len === 0) {
      points.push(turf.point(line.geometry.coordinates[0]));
      return;
    }
    const steps = Math.max(1, Math.ceil(len / stepKm));
    for (let i = 0; i <= steps; i++) {
      points.push(turf.along(line, Math.min(i * stepKm, len), { units: "kilometers" }));
    }
  };
  for (const f of geojson.features) {
    if (!f.geometry) continue;
    const t = f.geometry.type;
    if (t === "Point") {
      points.push(turf.point(f.geometry.coordinates));
    } else if (t === "MultiPoint") {
      for (const c of f.geometry.coordinates) points.push(turf.point(c));
    } else if (t === "LineString") {
      sampleLine(f);
    } else if (t === "MultiLineString") {
      for (const c of f.geometry.coordinates) sampleLine(turf.lineString(c));
    } else if (t === "Polygon" || t === "MultiPolygon") {
      let boundary;
      try {
        boundary = turf.polygonToLine(f);
      } catch (e) {
        continue;
      }
      const blines = boundary.type === "FeatureCollection" ? boundary.features : [boundary];
      for (const bl of blines) {
        if (bl.geometry.type === "MultiLineString") {
          for (const c of bl.geometry.coordinates) sampleLine(turf.lineString(c));
        } else {
          sampleLine(bl);
        }
      }
    }
  }
  return points;
}

// Distancia minima (metros) entre cualquiera de los puntos muestreados del
// trazado y una feature candidata (poligono, linea o punto). Aproximada por
// muestreo -- coherente con el resto de la metodologia de cribado del
// proyecto (ver cabecera del fichero), no un calculo geometrico exacto.
function minDistanceMetersToFeature(samplePoints, feature) {
  const geom = feature.geometry;
  let min = Infinity;

  if (geom.type === "Point" || geom.type === "MultiPoint") {
    const coords = geom.type === "Point" ? [geom.coordinates] : geom.coordinates;
    for (const c of coords) {
      const fp = turf.point(c);
      for (const p of samplePoints) {
        const d = turf.distance(p, fp, { units: "kilometers" });
        if (d < min) min = d;
      }
    }
    return min * 1000;
  }

  let line = feature;
  if (geom.type === "Polygon" || geom.type === "MultiPolygon") {
    try {
      line = turf.polygonToLine(feature);
    } catch (e) {
      return Infinity;
    }
  }
  const lines =
    line.type === "FeatureCollection" ? line.features
    : line.geometry.type === "MultiLineString" ? line.geometry.coordinates.map((c) => turf.lineString(c))
    : [line];

  for (const l of lines) {
    for (const p of samplePoints) {
      const d = turf.pointToLineDistance(p, l, { units: "kilometers" });
      if (d < min) min = d;
    }
  }
  return min * 1000;
}

// overrides: { layerId: metros } -- buffer explicito elegido por el usuario
// para esa capa en el panel de resultados (idea #2), vacio en el primer
// analisis de un tramo.
async function analyzeUploadedLayer(u, overrides = {}) {
  if (!u.bufferMeters || !u.bufferGeojson || u.bufferGeojson.features.length === 0) {
    alert("Aplica primero un buffer a este tramo para poder analizar las afecciones.");
    return;
  }

  const overlay = document.getElementById("analysis-overlay");
  overlay.hidden = false;

  try {
    const targetLayers = LAYERS.filter((l) => ANALYSIS_NIVELES.includes(l.nivel));

    // Buffer efectivo por capa: override explicito del usuario > sugerido
    // por la propia capa (l.suggestedBufferM en layers.js, p. ej. la zona
    // de policia de cauces) > buffer general del tramo. Ver README §9.
    const effectiveBufferM = {};
    for (const l of targetLayers) {
      effectiveBufferM[l.id] =
        overrides[l.id] != null ? overrides[l.id]
        : l.suggestedBufferM != null ? l.suggestedBufferM
        : u.bufferMeters;
    }

    const globalBufferPolygon = unifyBuffer(u.bufferGeojson);
    if (!globalBufferPolygon) throw new Error("No se pudo calcular el buffer.");

    // El mapa se encuadra al mayor buffer efectivo + el margen de busqueda
    // de "elemento mas cercano" (NEAREST_SEARCH_MARGIN_M) -- si no, esas
    // teselas ni siquiera se renderizan y queryRenderedFeatures no puede
    // encontrar nada fuera del buffer normal.
    const maxBufferM = Math.max(u.bufferMeters, ...Object.values(effectiveBufferM));
    const searchPolygon = computeUnifiedBufferPolygon(u.geojson, maxBufferM + NEAREST_SEARCH_MARGIN_M);
    if (!searchPolygon) throw new Error("No se pudo calcular el area de busqueda.");

    const bbox = turf.bbox(searchPolygon);
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
      padding: 60,
      animate: false,
      maxZoom: 17,
    });

    // Se fuerzan temporalmente visibles las capas a analizar -- MapLibre
    // solo tiene datos consultables (renderizados) para capas visibles,
    // asi que se restaura el estado original al terminar.
    const prevVisible = {};
    for (const l of targetLayers) {
      prevVisible[l.id] = layerVisible[l.id];
      if (!layerVisible[l.id]) setLayerVisible(l, true);
    }

    await new Promise((resolve) => {
      map.once("idle", resolve);
      setTimeout(resolve, 8000);
    });

    const trazadoSamples = sampleTrazadoPoints(u.geojson, NEAREST_SAMPLE_KM);

    const results = [];
    for (const l of targetLayers) {
      const layerBufferM = effectiveBufferM[l.id];
      const bufferPolygon =
        layerBufferM === u.bufferMeters ? globalBufferPolygon : computeUnifiedBufferPolygon(u.geojson, layerBufferM);

      const idsToCheck = l.geom === "polygon" ? [`${l.id}-fill`] : [`${l.id}-line`];
      const existing = bufferPolygon ? idsToCheck.filter((id) => map.getLayer(id)) : [];
      const nameField = l.labelField;
      let count = 0;
      let totalHa = 0;
      let totalM = 0;
      const names = new Set();
      let nearestM = null;
      let nearestName = null;

      if (existing.length) {
        const feats = map.queryRenderedFeatures(undefined, { layers: existing });
        const intersecting = feats.filter((f) => f.geometry && turf.booleanIntersects(f, bufferPolygon));

        const addName = (f) => {
          if (!nameField) return;
          const raw = f.properties[nameField];
          const clean = raw == null ? "" : String(raw).trim();
          if (clean && !ANALYSIS_PLACEHOLDER_NAMES.has(clean.toLowerCase())) names.add(clean);
        };

        if (l.geom === "polygon" && l.idField) {
          // Agrupar fragmentos de la misma entidad (repetidos por el
          // margen de solape entre teselas MVT, ver unionFeatureGroup)
          // y unirlos antes de medir, para no contar el mismo area mas
          // de una vez ni de menos si la entidad cae partida en varias
          // teselas dentro del buffer.
          const groups = new Map();
          const noId = [];
          for (const f of intersecting) {
            const key = f.properties[l.idField];
            if (key == null) { noId.push(f); continue; }
            if (!groups.has(key)) groups.set(key, []);
            groups.get(key).push(f);
          }
          for (const group of groups.values()) {
            addName(group[0]);
            count++;
            totalHa += polygonIntersectionHectares(unionFeatureGroup(group), bufferPolygon);
          }
          // Fragmentos sin id legible (dato de origen incompleto): se
          // miden por separado, con el mismo riesgo de sobreestimacion
          // que antes de este fix -- caso raro, no el camino normal.
          for (const f of noId) {
            addName(f);
            count++;
            totalHa += polygonIntersectionHectares(f, bufferPolygon);
          }
        } else {
          // Capas de linea, o poligonos sin idField fiable (ver
          // layers.js): se mide fragmento a fragmento como antes. Para
          // lineas el riesgo de doble conteo por margen de tesela es
          // pequeno (solo el tramo solapado en el borde, no la entidad
          // completa); para los poligonos sin id es una limitacion
          // conocida, documentada en layers.js capa por capa.
          for (const f of intersecting) {
            addName(f);
            count++;
            if (l.geom === "polygon") {
              totalHa += polygonIntersectionHectares(f, bufferPolygon);
            } else {
              totalM += lineLengthInsidePolygonMeters(f, bufferPolygon);
            }
          }
        }

        // Sin cruce directo: busca el elemento renderizado mas cercano al
        // TRAZADO (no al buffer) entre los que trajo la consulta -- todos
        // estan, por definicion, fuera del buffer en este punto. Se
        // descarta si el minimo cae fuera del margen de busqueda (puede
        // pasar si la consulta trajo algo justo en el borde de la vista).
        if (count === 0) {
          let min = Infinity;
          let minName = "";
          for (const f of feats) {
            if (!f.geometry) continue;
            const d = minDistanceMetersToFeature(trazadoSamples, f);
            if (d < min) {
              min = d;
              minName = nameField ? String(f.properties[nameField] ?? "").trim() : "";
            }
          }
          if (isFinite(min) && min <= layerBufferM + NEAREST_SEARCH_MARGIN_M) {
            nearestM = min;
            nearestName = minName && !ANALYSIS_PLACEHOLDER_NAMES.has(minName.toLowerCase()) ? minName : "";
          }
        }
      }
      results.push({ layer: l, count, totalHa, totalM, names: [...names].sort(), nearestM, nearestName, bufferM: layerBufferM });
    }

    for (const l of targetLayers) {
      if (layerVisible[l.id] !== prevVisible[l.id]) setLayerVisible(l, prevVisible[l.id]);
    }

    u.layerBufferOverrides = overrides;
    showAnalysisResults(u, results);
  } catch (e) {
    console.error(e);
    alert("Error analizando afecciones: " + e.message);
  } finally {
    overlay.hidden = true;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Select de "confirmado en campo" para una fila de resultado (idea #6) --
// el estado vive en u.fieldStatus (por capa), no en el objeto de resultado,
// para que sobreviva a un recalculo con otro buffer (ver analyzeUploadedLayer).
function fieldStatusSelectHtml(u, layerId) {
  if (!u.fieldStatus) u.fieldStatus = {};
  const current = u.fieldStatus[layerId] || FIELD_STATUS_OPTIONS[0];
  const optionsHtml = FIELD_STATUS_OPTIONS.map(
    (opt) => `<option value="${escapeHtml(opt)}" ${opt === current ? "selected" : ""}>${escapeHtml(opt)}</option>`
  ).join("");
  return `<select class="analysis-field-status" data-layer-id="${layerId}">${optionsHtml}</select>`;
}

function showAnalysisResults(u, results) {
  document.getElementById("analysis-subtitle").textContent =
    `${u.name} · buffer de ${bufferLabel(u.bufferMeters)} · estimación de cribado, no sustituye el análisis en QGIS`;

  const container = document.getElementById("analysis-results");

  // Buffer por capa (idea #2): por defecto el del tramo, salvo que la
  // propia capa traiga un valor sugerido (l.suggestedBufferM en layers.js)
  // o el usuario ya lo haya cambiado en un recalculo anterior. El 0 ("sin
  // buffer") se excluye aqui -- no tiene sentido para un cruce por distancia.
  const perLayerBufferOptions = BUFFER_OPTIONS.filter((m) => m > 0);
  let controlsHtml = `<div class="analysis-buffer-controls">
    <p class="modal-note">Buffer aplicado por capa -- por defecto el del tramo (${bufferLabel(u.bufferMeters)}); cámbialo si esa capa tiene una distancia propia (p. ej. zona de policía de cauces) y pulsa «Recalcular».</p>
    <div class="analysis-buffer-grid">`;
  for (const r of results) {
    const effective = r.bufferM;
    const optionsHtml = perLayerBufferOptions
      .map((m) => `<option value="${m}" ${effective === m ? "selected" : ""}>${bufferLabel(m)}</option>`)
      .join("");
    controlsHtml += `<label class="analysis-buffer-row">
      <span class="swatch" style="background:${r.layer.color.fill}"></span>
      <span class="analysis-buffer-layer-name">${escapeHtml(r.layer.nombre)}</span>
      <select class="analysis-buffer-select" data-layer-id="${r.layer.id}">${optionsHtml}</select>
    </label>`;
  }
  controlsHtml += `</div><button id="analysis-recalc-btn" class="primary">🔄 Recalcular con estos buffers</button></div>`;

  let html = "";
  for (const nivel of ANALYSIS_NIVELES) {
    const rows = results.filter((r) => r.layer.nivel === nivel);
    const afectadas = rows.filter((r) => r.count > 0);
    const cercanas = rows.filter((r) => r.count === 0 && r.nearestM != null);
    html += `<div class="analysis-nivel-block"><h3>${NIVEL_LABEL[nivel]}</h3>`;
    if (afectadas.length === 0) {
      html += `<p class="analysis-empty">Sin afecciones detectadas en este nivel.</p>`;
    } else {
      html += `<table class="analysis-table"><thead><tr>
        <th>Capa</th><th>Elementos</th><th>Nombres / códigos</th><th>Long. afectada (m)</th><th>Superficie afectada (ha)</th><th>Confirmado en campo</th>
      </tr></thead><tbody>`;
      for (const r of afectadas) {
        const nombres = r.names.length ? escapeHtml(r.names.join(", ")) : "-";
        const ha = r.totalHa > 0 ? r.totalHa.toLocaleString("es-ES", { maximumFractionDigits: 2 }) : "-";
        html += `<tr>
          <td>${escapeHtml(r.layer.nombre)}</td>
          <td class="num">${r.count}</td>
          <td class="names">${nombres}</td>
          <td class="num">${r.totalM > 0 ? Math.round(r.totalM).toLocaleString("es-ES") : "-"}</td>
          <td class="num">${ha}</td>
          <td>${fieldStatusSelectHtml(u, r.layer.id)}</td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }
    if (cercanas.length > 0) {
      html += `<p class="analysis-near-title">Cerca, sin cruce directo (hasta ${(NEAREST_SEARCH_MARGIN_M / 1000).toLocaleString("es-ES")} km más allá del buffer aplicado):</p>`;
      html += `<table class="analysis-table analysis-table-near"><thead><tr>
        <th>Capa</th><th>Elemento más cercano</th><th>Distancia (m)</th><th>Confirmado en campo</th>
      </tr></thead><tbody>`;
      for (const r of cercanas) {
        html += `<tr>
          <td>${escapeHtml(r.layer.nombre)}</td>
          <td class="names">${r.nearestName ? escapeHtml(r.nearestName) : "-"}</td>
          <td class="num">${Math.round(r.nearestM).toLocaleString("es-ES")}</td>
          <td>${fieldStatusSelectHtml(u, r.layer.id)}</td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }
    html += `</div>`;
  }
  container.innerHTML = controlsHtml + html;

  container.querySelectorAll(".analysis-field-status").forEach((sel) => {
    sel.addEventListener("change", () => {
      if (!u.fieldStatus) u.fieldStatus = {};
      u.fieldStatus[sel.dataset.layerId] = sel.value;
      // Todos los selects de la misma capa (tabla de afectadas + de
      // cercanas no pueden coincidir a la vez, pero por si acaso) quedan
      // en sync -- solo puede haber uno visible por capa en la practica.
    });
  });

  container.querySelector("#analysis-recalc-btn").addEventListener("click", () => {
    const newOverrides = {};
    container.querySelectorAll(".analysis-buffer-select").forEach((sel) => {
      newOverrides[sel.dataset.layerId] = Number(sel.value);
    });
    analyzeUploadedLayer(u, newOverrides);
  });

  lastAnalysisResults = { u, results };
  document.getElementById("analysis-modal-backdrop").hidden = false;
}

document.getElementById("analysis-close-btn").addEventListener("click", () => {
  document.getElementById("analysis-modal-backdrop").hidden = true;
});

const RESULTS_HEADER = [
  "Nivel", "Capa", "Fuente", "Buffer aplicado (m)", "Elementos", "Nombres/códigos",
  "Longitud afectada (m)", "Superficie afectada (ha)", "Distancia al más cercano (m)",
  "Confirmado en campo",
];

// Fila por capa afectada -- o, si no hay cruce directo pero se detecto un
// elemento cerca (idea #4), una fila con Elementos=0 y la distancia en vez
// de long./superficie. Tipos ya listos para CSV (todo texto) o Excel
// (numeros como numeros, no como texto) -- comparten esta funcion para no
// mantener la logica de "que va en cada columna" por duplicado.
function resultsToRows(u, results) {
  const fieldStatus = u.fieldStatus || {};
  const rows = [];
  for (const r of results) {
    if (r.count === 0 && r.nearestM == null) continue;
    rows.push([
      r.layer.nivel,
      r.layer.nombre,
      r.layer.fuente || "",
      r.bufferM,
      r.count,
      r.names.join(" | "),
      r.totalM > 0 ? Math.round(r.totalM * 10) / 10 : "",
      r.totalHa > 0 ? Math.round(r.totalHa * 1000) / 1000 : "",
      r.nearestM != null ? Math.round(r.nearestM) : "",
      fieldStatus[r.layer.id] || FIELD_STATUS_OPTIONS[0],
    ]);
  }
  return rows;
}

function csvField(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

document.getElementById("analysis-download-csv").addEventListener("click", () => {
  if (!lastAnalysisResults) return;
  const { u, results } = lastAnalysisResults;
  let csv = RESULTS_HEADER.join(",") + "\n";
  for (const row of resultsToRows(u, results)) {
    csv += row.map((v) => (typeof v === "number" ? v : csvField(v))).join(",") + "\n";
  }
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `afecciones_${u.name.replace(/\.[^.]+$/, "")}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// Cabecera en el azul corporativo Quadrante (mismo tono que el cajetin,
// ver --quadrante-blue en style.css) y una columna de "Color" por fila
// con el mismo color que esa capa tiene en el panel/mapa (l.color.fill
// en layers.js), para que la tabla se pueda leer de un vistazo sin tener
// que darle formato a mano en Excel. Se usa ExcelJS (no SheetJS) porque
// SheetJS solo escribe estilos/colores en su version de pago -- se probo
// y el color no sobrevivia al guardar el archivo.
const XLSX_HEADER_FILL = "FF182C54";
const XLSX_BAND_FILL = "FFF2F2F2";

document.getElementById("analysis-download-xlsx").addEventListener("click", async () => {
  if (!lastAnalysisResults) return;
  const { u, results } = lastAnalysisResults;
  // Mismo criterio que resultsToRows: afectadas de verdad + "cerca, sin
  // cruce directo" (idea #4) -- en ese mismo orden, para que fila a fila
  // coincida uno a uno con `rows`.
  const exportable = results.filter((r) => r.count > 0 || r.nearestM != null);
  const rows = resultsToRows(u, results); // mismo filtro/orden que `exportable`

  // Color como columna aparte (idea #10: capa + fuente citables sin salir
  // del Excel) -- Buffer/Distancia/Confirmado en campo son las nuevas
  // columnas de las ideas #2/#4/#6 del informe de investigacion.
  const header = [
    "Nivel", "Capa", "Color", "Fuente", "Buffer aplicado (m)", "Elementos", "Nombres/códigos",
    "Longitud afectada (m)", "Superficie afectada (ha)", "Distancia al más cercano (m)", "Confirmado en campo",
  ];
  const tableRows = rows.map(([nivel, capa, fuente, bufferM, count, nombres, m, ha, dist, estado]) => [
    nivel, capa, "", fuente, bufferM, count, nombres, m, ha, dist, estado,
  ]);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Afecciones");

  // Tabla nativa de Excel (con desplegables de filtro incluidos) - el
  // color propio y las bandas se aplican encima a mano para seguir la
  // paleta del geovisor en vez del tema con nombre que trae addTable.
  sheet.addTable({
    name: "TablaAfecciones",
    ref: "A1",
    headerRow: true,
    style: { showRowStripes: false },
    columns: header.map((name) => ({ name })),
    rows: tableRows,
  });

  [6, 34, 4, 24, 12, 10, 45, 16, 16, 16, 20].forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });

  sheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XLSX_HEADER_FILL } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  });

  exportable.forEach((r, i) => {
    const row = sheet.getRow(i + 2);
    const layerColor = "FF" + r.layer.color.fill.replace("#", "");
    const band = i % 2 === 1 ? XLSX_BAND_FILL : "FFFFFFFF";
    for (let c = 1; c <= header.length; c++) {
      row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: c === 3 ? layerColor : band } };
    }
    row.getCell(7).alignment = { wrapText: true, vertical: "top" };
    // Fila "cerca, sin cruce directo" (Elementos=0 con distancia): en
    // cursiva para distinguirla de un cruce real de un vistazo.
    if (r.count === 0 && r.nearestM != null) {
      row.eachCell((cell) => { cell.font = { ...(cell.font || {}), italic: true }; });
    }
  });

  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const infoSheet = workbook.addWorksheet("Info");
  infoSheet.getColumn(1).width = 16;
  infoSheet.getColumn(1).font = { bold: true };
  infoSheet.getColumn(2).width = 90;
  infoSheet.addRows([
    ["Tramo/punto", u.name],
    ["Buffer aplicado", bufferLabel(u.bufferMeters) + " (por defecto -- ver columna 'Buffer aplicado (m)' de la tabla, algunas capas pueden usar uno distinto)"],
    ["Nota", "Estimación de cribado a partir de teselas vectoriales -- no sustituye el análisis en QGIS. Ver README del proyecto."],
    ["Fuente y vigencia", "Cada capa indica su organismo de origen en la columna 'Fuente'. El catálogo se descarga periódicamente del origen oficial (MITECO/IGN/REDIAM/CNIG según capa) -- confirmar la fecha de descarga vigente con el equipo antes de una entrega final."],
  ]);

  const buf = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `afecciones_${u.name.replace(/\.[^.]+$/, "")}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
});
