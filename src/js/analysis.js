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

// --- Punto kilometrico (PK) de entrada/salida ---------------------------
// PK = distancia acumulada en km desde el inicio del trazado ORIGINAL
// subido (no del buffer) hasta el punto donde empieza/termina de estar
// dentro del radio de buffer de una entidad afectada.
//
// IMPORTANTE -- el "PK 0" de la app es el PRIMER VERTICE DEL ARCHIVO
// SUBIDO, no el PK oficial del proyecto. Es un PK relativo (geometria
// pura, distancia geodesica entre vertices) para ubicar afecciones
// dentro del propio archivo -- si se sube un extracto parcial de un
// trazado real, no coincidira con el kilometraje oficial de la memoria.
// No sustituye el PK oficial, hay que cotejarlo a mano contra el
// proyecto real (ver README §6).
//
// Simplificacion documentada: si el tramo subido tiene varias partes
// (varias features de linea, o una MultiLineString), se concatenan en el
// orden en que vienen en el archivo para formar UNA referencia continua
// de PK -- correcto para el caso normal (un unico trazado, quiza partido
// en varios tramos del mismo archivo), pero puede dar un PK erroneo si
// las partes no estan en orden o representan trazados distintos sin
// relacion entre si. Tampoco distingue "entra y sale varias veces": se
// reporta el rango PK minimo-maximo (envolvente), no cada cruce por
// separado.
function buildPkLine(geojson) {
  const coords = [];
  for (const f of geojson.features) {
    if (!f.geometry) continue;
    if (f.geometry.type === "LineString") coords.push(...f.geometry.coordinates);
    else if (f.geometry.type === "MultiLineString") {
      for (const part of f.geometry.coordinates) coords.push(...part);
    }
  }
  if (coords.length < 2) return null;
  try {
    return turf.lineString(coords);
  } catch (e) {
    return null;
  }
}

// Busca, a lo largo de pkLine, los chunks de 10 m cuyo punto medio cae
// dentro de targetPolygon, y devuelve el PK (km acumulados desde el
// inicio de pkLine) minimo y maximo entre ellos.
function computePkRange(pkLine, targetPolygon) {
  let chunks;
  try {
    chunks = turf.lineChunk(pkLine, ANALYSIS_CHUNK_KM, { units: "kilometers" }).features;
  } catch (e) {
    chunks = [pkLine];
  }
  let cumKm = 0;
  let minKm = null;
  let maxKm = null;
  for (const chunk of chunks) {
    const len = turf.length(chunk, { units: "kilometers" });
    if (len > 0) {
      const mid = turf.along(chunk, len / 2, { units: "kilometers" });
      if (turf.booleanPointInPolygon(mid, targetPolygon)) {
        const pk = cumKm + len / 2;
        if (minKm === null || pk < minKm) minKm = pk;
        if (maxKm === null || pk > maxKm) maxKm = pk;
      }
    }
    cumKm += len;
  }
  return minKm === null ? null : { minKm, maxKm };
}

// Expande una entidad afectada por el mismo radio de buffer que se aplico
// al trazado, y acumula en `acc` el PK minimo/maximo donde pkLine cae
// dentro de esa entidad expandida -- ver comentario de computePkRange.
function accumulatePkRange(acc, pkLine, entityGeom, bufferMeters) {
  if (!pkLine) return;
  let buffered;
  try {
    buffered = turf.buffer(entityGeom, bufferMeters / 1000, { units: "kilometers" });
  } catch (e) {
    return;
  }
  if (!buffered) return;
  const range = computePkRange(pkLine, buffered);
  if (!range) return;
  if (acc.minKm === null || range.minKm < acc.minKm) acc.minKm = range.minKm;
  if (acc.maxKm === null || range.maxKm > acc.maxKm) acc.maxKm = range.maxKm;
}

// "12+340" al estilo de PK de infraestructura lineal (km + metros).
function formatPK(km) {
  const meters = Math.round(km * 1000);
  const kmPart = Math.floor(meters / 1000);
  const mPart = meters % 1000;
  return `${kmPart}+${String(mPart).padStart(3, "0")}`;
}

async function analyzeUploadedLayer(u) {
  if (!u.bufferMeters || !u.bufferGeojson || u.bufferGeojson.features.length === 0) {
    alert("Aplica primero un buffer a este tramo para poder analizar las afecciones.");
    return;
  }

  const overlay = document.getElementById("analysis-overlay");
  overlay.hidden = false;

  try {
    const bufferPolygon = unifyBuffer(u.bufferGeojson);
    if (!bufferPolygon) throw new Error("No se pudo calcular el buffer.");
    const pkLine = buildPkLine(u.geojson); // null si el tramo no trae una linea (p. ej. solo puntos)

    const bbox = turf.bbox(bufferPolygon);
    map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], {
      padding: 60,
      animate: false,
      maxZoom: 17,
    });

    const targetLayers = LAYERS.filter((l) => ANALYSIS_NIVELES.includes(l.nivel));

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

    const results = [];
    for (const l of targetLayers) {
      const idsToCheck = l.geom === "polygon" ? [`${l.id}-fill`] : [`${l.id}-line`];
      const existing = idsToCheck.filter((id) => map.getLayer(id));
      const nameField = l.analysisNameField || l.labelField;
      let count = 0;
      let totalHa = 0;
      let totalM = 0;
      const names = new Set();
      const pk = { minKm: null, maxKm: null };
      if (existing.length) {
        const feats = map.queryRenderedFeatures(undefined, { layers: existing });
        const intersecting = feats.filter((f) => f.geometry && turf.booleanIntersects(f, bufferPolygon));

        const addName = (f) => {
          if (!nameField) return;
          const raw = f.properties[nameField];
          const clean = raw == null ? "" : String(raw).trim();
          if (clean && !ANALYSIS_PLACEHOLDER_NAMES.has(clean.toLowerCase())) names.add(clean);
        };

        if (l.presenceOnly) {
          // p. ej. HIC: la capa trae un poligono repetido por cada codigo
          // de habitat presente en una misma celda de malla, asi que ni
          // el conteo de "elementos" ni la superficie de interseccion son
          // representativos aqui -- se listan los codigos (via nameField)
          // y no se suma area (ver layers.js).
          intersecting.forEach(addName);
        } else if (l.geom === "polygon" && l.idField) {
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
            const unioned = unionFeatureGroup(group);
            totalHa += polygonIntersectionHectares(unioned, bufferPolygon);
            accumulatePkRange(pk, pkLine, unioned, u.bufferMeters);
          }
          // Fragmentos sin id legible (dato de origen incompleto): se
          // miden por separado, con el mismo riesgo de sobreestimacion
          // que antes de este fix -- caso raro, no el camino normal.
          for (const f of noId) {
            addName(f);
            count++;
            totalHa += polygonIntersectionHectares(f, bufferPolygon);
            accumulatePkRange(pk, pkLine, f, u.bufferMeters);
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
            accumulatePkRange(pk, pkLine, f, u.bufferMeters);
          }
        }
      }
      if (l.presenceOnly) count = names.size;
      results.push({
        layer: l,
        count,
        totalHa,
        totalM,
        names: [...names].sort(),
        pkMinKm: l.presenceOnly ? null : pk.minKm,
        pkMaxKm: l.presenceOnly ? null : pk.maxKm,
      });
    }

    for (const l of targetLayers) {
      if (layerVisible[l.id] !== prevVisible[l.id]) setLayerVisible(l, prevVisible[l.id]);
    }

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

function showAnalysisResults(u, results) {
  document.getElementById("analysis-subtitle").textContent =
    `${u.name} · buffer de ${bufferLabel(u.bufferMeters)} · estimación de cribado, no sustituye el análisis en QGIS`;

  const container = document.getElementById("analysis-results");
  let html = "";
  let anyPresenceOnly = false;
  let anyPk = false;
  for (const nivel of ANALYSIS_NIVELES) {
    const rows = results.filter((r) => r.layer.nivel === nivel);
    const afectadas = rows.filter((r) => r.count > 0);
    html += `<div class="analysis-nivel-block"><h3>${NIVEL_LABEL[nivel]}</h3>`;
    if (afectadas.length === 0) {
      html += `<p class="analysis-empty">Sin afecciones detectadas en este nivel.</p>`;
    } else {
      html += `<table class="analysis-table"><thead><tr>
        <th>Capa</th><th>Elementos</th><th>Nombres / códigos</th><th>Long. afectada (m)</th><th>Superficie afectada (ha)</th><th>PK</th>
      </tr></thead><tbody>`;
      for (const r of afectadas) {
        if (r.layer.presenceOnly) anyPresenceOnly = true;
        const nombres = r.names.length ? escapeHtml(r.names.join(", ")) : "-";
        const ha = r.layer.presenceOnly
          ? "—*"
          : r.totalHa > 0
            ? r.totalHa.toLocaleString("es-ES", { maximumFractionDigits: 2 })
            : "-";
        if (r.pkMinKm != null) anyPk = true;
        const pk = r.pkMinKm != null ? `${formatPK(r.pkMinKm)} - ${formatPK(r.pkMaxKm)}` : "-";
        html += `<tr>
          <td>${escapeHtml(r.layer.nombre)}</td>
          <td class="num">${r.count}</td>
          <td class="names">${nombres}</td>
          <td class="num">${r.totalM > 0 ? Math.round(r.totalM).toLocaleString("es-ES") : "-"}</td>
          <td class="num">${ha}</td>
          <td class="num">${pk}</td>
        </tr>`;
      }
      html += `</tbody></table>`;
    }
    html += `</div>`;
  }
  if (anyPresenceOnly) {
    html += `<p class="modal-note">* Capa de presencia en malla (no delimitación real): se listan los códigos detectados, no se calcula superficie.</p>`;
  }
  if (anyPk) {
    html += `<p class="modal-note">PK: rango mínimo-máximo (no cada cruce por separado) medido sobre el trazado subido, no sobre el buffer. Si el tramo subido tiene varias partes, se concatenan en el orden del archivo.</p>`;
  }
  container.innerHTML = html;

  lastAnalysisResults = { u, results };
  document.getElementById("analysis-modal-backdrop").hidden = false;
}

document.getElementById("analysis-close-btn").addEventListener("click", () => {
  document.getElementById("analysis-modal-backdrop").hidden = true;
});

const RESULTS_HEADER = [
  "Nivel", "Capa", "Elementos", "Nombres/códigos",
  "Longitud afectada (m)", "Superficie afectada (ha)", "PK inicio", "PK fin",
];

// Fila por capa afectada, con tipos ya listos para CSV (todo texto) o
// Excel (numeros como numeros, no como texto) -- comparten esta funcion
// para no mantener la logica de "que va en cada columna" por duplicado.
function resultsToRows(results) {
  const rows = [];
  for (const r of results) {
    if (r.count === 0) continue;
    rows.push([
      r.layer.nivel,
      r.layer.nombre,
      r.count,
      r.names.join(" | "),
      Math.round(r.totalM * 10) / 10,
      r.layer.presenceOnly ? "" : Math.round(r.totalHa * 1000) / 1000,
      r.pkMinKm != null ? formatPK(r.pkMinKm) : "",
      r.pkMaxKm != null ? formatPK(r.pkMaxKm) : "",
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
  for (const row of resultsToRows(results)) {
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

document.getElementById("analysis-download-xlsx").addEventListener("click", () => {
  if (!lastAnalysisResults) return;
  const { u, results } = lastAnalysisResults;
  const rows = resultsToRows(results);

  const sheet = XLSX.utils.aoa_to_sheet([RESULTS_HEADER, ...rows]);
  // Anchos de columna aproximados (en caracteres) para que la tabla se
  // pueda leer sin tener que ajustar manualmente al abrir el Excel.
  sheet["!cols"] = [
    { wch: 6 }, { wch: 34 }, { wch: 10 }, { wch: 45 },
    { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 10 },
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Afecciones");

  const infoSheet = XLSX.utils.aoa_to_sheet([
    ["Tramo/punto", u.name],
    ["Buffer aplicado", bufferLabel(u.bufferMeters)],
    ["Nota", "Estimación de cribado a partir de teselas vectoriales -- no sustituye el análisis en QGIS. Ver README del proyecto."],
  ]);
  infoSheet["!cols"] = [{ wch: 16 }, { wch: 90 }];
  XLSX.utils.book_append_sheet(workbook, infoSheet, "Info");

  XLSX.writeFile(workbook, `afecciones_${u.name.replace(/\.[^.]+$/, "")}.xlsx`);
});
