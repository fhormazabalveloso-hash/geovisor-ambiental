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
      const nameField = l.labelField;
      let count = 0;
      let totalHa = 0;
      let totalM = 0;
      const names = new Set();
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
      }
      results.push({ layer: l, count, totalHa, totalM, names: [...names].sort() });
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
  for (const nivel of ANALYSIS_NIVELES) {
    const rows = results.filter((r) => r.layer.nivel === nivel);
    const afectadas = rows.filter((r) => r.count > 0);
    html += `<div class="analysis-nivel-block"><h3>${NIVEL_LABEL[nivel]}</h3>`;
    if (afectadas.length === 0) {
      html += `<p class="analysis-empty">Sin afecciones detectadas en este nivel.</p>`;
    } else {
      html += `<table class="analysis-table"><thead><tr>
        <th>Capa</th><th>Elementos</th><th>Nombres / códigos</th><th>Long. afectada (m)</th><th>Superficie afectada (ha)</th>
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
        </tr>`;
      }
      html += `</tbody></table>`;
    }
    html += `</div>`;
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
  "Longitud afectada (m)", "Superficie afectada (ha)",
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
      Math.round(r.totalHa * 1000) / 1000,
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
  const afectadas = results.filter((r) => r.count > 0);
  const rows = resultsToRows(results); // mismo filtro/orden que `afectadas`

  const header = ["Nivel", "Capa", "Color", "Elementos", "Nombres/códigos", "Longitud afectada (m)", "Superficie afectada (ha)"];
  const tableRows = rows.map(([nivel, capa, count, nombres, m, ha]) => [nivel, capa, "", count, nombres, m, ha]);

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

  [6, 34, 4, 10, 45, 16, 16].forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
  });

  sheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XLSX_HEADER_FILL } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  });

  afectadas.forEach((r, i) => {
    const row = sheet.getRow(i + 2);
    const layerColor = "FF" + r.layer.color.fill.replace("#", "");
    const band = i % 2 === 1 ? XLSX_BAND_FILL : "FFFFFFFF";
    for (let c = 1; c <= header.length; c++) {
      row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: c === 3 ? layerColor : band } };
    }
    row.getCell(5).alignment = { wrapText: true, vertical: "top" };
  });

  sheet.views = [{ state: "frozen", ySplit: 1 }];

  const infoSheet = workbook.addWorksheet("Info");
  infoSheet.getColumn(1).width = 16;
  infoSheet.getColumn(1).font = { bold: true };
  infoSheet.getColumn(2).width = 90;
  infoSheet.addRows([
    ["Tramo/punto", u.name],
    ["Buffer aplicado", bufferLabel(u.bufferMeters)],
    ["Nota", "Estimación de cribado a partir de teselas vectoriales -- no sustituye el análisis en QGIS. Ver README del proyecto."],
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
