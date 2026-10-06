// "Redactar con IA": genera, a partir del ultimo analisis de afecciones, un
// texto listo para pegar en la herramienta de IA que use la empresa
// (Claude, Copilot...) y obtener un BORRADOR del apartado ambiental de la
// memoria de una oferta.
//
// Decision de diseno (2026-09-29, opcion A de las tres valoradas con
// Francisco): el visor NO llama a ninguna IA ni envia datos a ningun
// servicio -- solo arma el texto y lo copia al portapapeles. Asi no hace
// falta servidor ni clave de API (el visor es estatico y el repo publico),
// la persona ve exactamente que va a compartir antes de pegarlo, y la
// decision de usar IA con datos de una licitacion queda en manos de quien
// la usa y de la politica de la empresa.
//
// La IA solo REDACTA: todas las cifras, nombres y distancias salen del
// analisis determinista de analysis.js, y las instrucciones le prohiben
// anadir datos o normativa propios (lo normativo se marca "[VERIFICAR]").
//
// Depende de analysis.js (lastAnalysisResults, formatMeters, NIVEL_LABEL,
// ANALYSIS_COVERAGE_NOTE...), cargado antes en index.html.

const AI_WORK_TYPES = [
  { value: "", label: "Sin especificar" },
  { value: "Carretera o vial", label: "Carretera o vial" },
  { value: "Puerto u obra marítima", label: "Puerto u obra marítima" },
  { value: "Cerramiento o edificación", label: "Cerramiento o edificación" },
  { value: "Otra", label: "Otra" },
];

// Estado de campo en forma corta, para no repetir "en campo" en la frase
// "Comprobación en campo: ...".
const AI_FIELD_STATUS_SHORT = {
  "Sin confirmar": "sin confirmar",
  "Confirmado en campo": "confirmado",
  "Descartado en campo": "descartado",
};

function aiFieldStatus(u, layerId) {
  const status = (u.fieldStatus || {})[layerId] || FIELD_STATUS_OPTIONS[0];
  return AI_FIELD_STATUS_SHORT[status] || status.toLowerCase();
}

// (formatHa vive en analysis.js)

// Descripcion breve de la geometria subida: longitud de las lineas, area y
// perimetro de los poligonos, numero de puntos.
// Las marcas de PK (tramos.js) no son obra: se mide solo lo analizado.
function describeTrazado(u) {
  let lineM = 0;
  let polyHa = 0;
  let polyPerimM = 0;
  let points = 0;
  for (const f of u.tramoSplit.obra.features) {
    if (!f.geometry) continue;
    const t = f.geometry.type;
    if (t === "LineString" || t === "MultiLineString") {
      lineM += turf.length(f, { units: "kilometers" }) * 1000;
    } else if (t === "Polygon" || t === "MultiPolygon") {
      polyHa += turf.area(f) / 10000;
      polyPerimM += turf.length(turf.polygonToLine(f), { units: "kilometers" }) * 1000;
    } else if (t === "Point") {
      points += 1;
    } else if (t === "MultiPoint") {
      points += f.geometry.coordinates.length;
    }
  }
  const parts = [];
  if (lineM > 0) parts.push(`trazado lineal de ${formatMeters(lineM)} m`);
  if (polyHa > 0) parts.push(`superficie de ${formatHa(polyHa)} ha (perímetro de ${formatMeters(polyPerimM)} m)`);
  if (points > 0) parts.push(`${points} punto${points === 1 ? "" : "s"}`);
  let text = parts.length ? parts.join(" + ") : "geometría sin medidas";
  const { tramos, markers } = u.tramoSplit;
  if (tramos.length > 1) text += `, en ${tramos.length} tramos`;
  if (markers.length) text += ` (más ${markers.length} puntos de PK o hitos de los tramos, no analizados como obra)`;
  return text;
}

function aiDefaultProjectName(u) {
  const title = document.getElementById("export-title").value.trim();
  if (title && title !== "Geovisor Ambiental") return title;
  return u.name.replace(/\.[^.]+$/, "").replace(/_+/g, " ");
}

// opts: { projectName, workType }
function buildAiPrompt(u, results, meta, opts) {
  const hits = results.filter((r) => r.count > 0);
  const nearOnly = results.filter((r) => r.nearby.length > 0);
  const clean = results.filter((r) => r.count === 0 && r.nearby.length === 0 && !r.serviceError);
  const noData = results.filter((r) => r.serviceError);
  const workType = opts.workType || "Sin especificar";
  const multi = isMultiTramo(meta);

  const lines = [];
  lines.push(
    'Eres técnico ambiental en una consultora de ingeniería en España. Con los datos de abajo, redacta un BORRADOR del apartado "Condicionantes ambientales" de la memoria técnica de una oferta de licitación.',
    "",
    "Reglas:",
    "- Usa solo los datos de este mensaje. No inventes espacios protegidos, cifras, distancias ni normativa.",
    '- Si crees que aplica alguna norma, trámite o estudio, indícalo como "[VERIFICAR: ...]", sin citar artículos concretos.',
    "- Deja claro que es un cribado previo con cartografía oficial, no un estudio de detalle, y que los hallazgos deben confirmarse en campo y con el análisis SIG definitivo.",
    '- Menciona expresamente los elementos marcados "AL BORDE DEL BUFFER".',
    "- Un hallazgo descartado en campo menciónalo solo como comprobado y descartado.",
    "- Si la obra es de costa o mar, di en las limitaciones que el cribado no incluye el Dominio Público Marítimo-Terrestre ni los hábitats marinos.",
    "- Español de España, tono técnico y prudente, sin emojis ni tablas. Entre 250 y 400 palabras.",
    ...(multi ? ["- La obra tiene varios tramos: di en qué tramos está cada afección (usa sus nombres tal cual) y cuáles no tienen ninguna."] : []),
    "",
    "Estructura:",
    "1. Resumen (2-3 frases).",
    "2. Afecciones directas.",
    "3. Elementos próximos.",
    "4. Recomendaciones (estudios o comprobaciones a prever en la oferta).",
    "5. Limitaciones del cribado.",
    "",
    "DATOS DEL PROYECTO",
    `- Proyecto: ${opts.projectName || "Sin nombre"}`,
    `- Tipo de obra: ${workType}`,
    `- Geometría analizada: ${describeTrazado(u)}`,
    `- Buffer general: ${bufferLabel(u.bufferMeters)} (algunas capas usan uno propio, indicado en cada una)`,
    `- Fecha del análisis: ${new Date().toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric" })}`
  );
  if (multi) {
    lines.push("", "AFECCIONES POR TRAMO (lo que hay en el buffer de cada tramo y cómo lo toca)");
    for (const t of meta.tramoSummary) {
      const pk = t.markers.length ? ` [puntos: ${t.markers.join(", ")}]` : "";
      lines.push(`- ${t.name} (${tramoSizeText(t)})${pk}: ${t.hits.length ? t.hits.map(tramoHitPlainText).join("; ") : "sin afecciones en su buffer"}.`);
    }
  }
  lines.push("", "AFECCIONES DIRECTAS (la capa cruza el trazado o su buffer)");
  if (hits.length === 0) {
    lines.push("- Ninguna.");
  }
  for (const r of hits) {
    const medida = [];
    if (r.totalHa > 0) medida.push(`${formatHa(r.totalHa)} ha dentro del buffer`);
    if (r.totalM > 0) medida.push(`${formatMeters(r.totalM)} m dentro del buffer`);
    const nombres = r.names.length ? ` (${r.names.join("; ")})` : "";
    lines.push(
      `- ${r.layer.nombre} [${NIVEL_LABEL[r.layer.nivel]}; sensibilidad ${r.sensitivity}; buffer ${bufferLabel(r.bufferM)}; fuente ${r.layer.fuente || "sin indicar"}]: ` +
        `${r.count} elemento${r.count === 1 ? "" : "s"}${nombres}${medida.length ? ", " + medida.join(", ") : ""}. ` +
        `Afección: ${AFECCION_LABEL[r.afeccion].toLowerCase()}. Motivo de la sensibilidad: ${r.reason}. ` +
        `Comprobación en campo: ${aiFieldStatus(u, r.layer.id)}.`
    );
  }

  lines.push("", `ELEMENTOS PRÓXIMOS FUERA DEL BUFFER (hasta ${NEAREST_SEARCH_MARGIN_M / 1000} km más allá; distancia medida desde el trazado)`);
  if (nearOnly.length === 0) {
    lines.push("- Ninguno.");
  }
  for (const r of nearOnly) {
    const items = r.nearby.map(
      (e) =>
        `${e.name || "sin nombre"} a ${formatMeters(e.distanceM)} m (${formatMeters(e.edgeM)} m fuera del buffer de ${bufferLabel(r.bufferM)})` +
        (e.tramoName ? `, junto al tramo ${e.tramoName}` : "") +
        (e.atEdge ? " AL BORDE DEL BUFFER" : "")
    );
    const estado = r.count === 0 ? ` Comprobación en campo: ${aiFieldStatus(u, r.layer.id)}.` : "";
    lines.push(`- ${r.layer.nombre} [${NIVEL_LABEL[r.layer.nivel]}; sensibilidad ${r.count > 0 ? r.nearSensitivity : r.sensitivity}]: ${items.join("; ")}.${estado}`);
  }

  lines.push("", "CAPAS ANALIZADAS SIN HALLAZGOS");
  lines.push(clean.length ? `- ${clean.map((r) => `${r.layer.nombre} (buffer ${bufferLabel(r.bufferM)})`).join("; ")}.` : "- Ninguna.");
  if (noData.length) {
    lines.push(
      "",
      "CAPAS SIN DATOS (no se pudieron consultar; NO significa que no haya afección, dilo así)",
      `- ${noData.map((r) => r.layer.nombre).join("; ")}.`
    );
  }

  lines.push(
    "",
    "NOTAS DEL ANÁLISIS",
    "- Nivel 1 = afección jurídica plena. Nivel 2 = afección estimada, con matiz metodológico (p. ej. la red hidrográfica con 100 m aproxima la zona de policía de cauces donde no hay deslinde).",
    "- La superficie indicada es la del elemento dentro del buffer, no solo bajo el trazado.",
    "- La sensibilidad (Muy Alta/Alta/Media/Baja) combina la importancia del elemento según su régimen legal con cómo lo toca la obra: directa (la obra lo pisa), en el entorno (solo dentro del buffer) o próxima (fuera del buffer). Un \"roce, a verificar\" es un contacto tan pequeño que puede deberse a la precisión del dato. Es criterio interno de Quadrante, no una clasificación reglamentaria.",
    `- Cobertura: ${ANALYSIS_COVERAGE_NOTE}`,
    `- Zonas inundables: ${ANALYSIS_FLOOD_COVERAGE_NOTE}`
  );
  if (meta && meta.incomplete) {
    lines.push(`- AVISO: ${ANALYSIS_INCOMPLETE_NOTE}`);
  }
  return lines.join("\n");
}

// --- UI ---

const aiBackdrop = document.getElementById("ai-modal-backdrop");
const aiProjectInput = document.getElementById("ai-project-name");
const aiWorkTypeSelect = document.getElementById("ai-work-type");
const aiPromptText = document.getElementById("ai-prompt-text");
const aiCopyStatus = document.getElementById("ai-copy-status");

aiWorkTypeSelect.innerHTML = AI_WORK_TYPES.map((t) => `<option value="${t.value}">${t.label}</option>`).join("");

// Solo en el modo completo (ver config.js).
document.getElementById("analysis-ai-btn").hidden = !FEATURES.redactarIA;

function refreshAiPrompt() {
  if (!lastAnalysisResults) return;
  const { u, results, meta } = lastAnalysisResults;
  aiPromptText.value = buildAiPrompt(u, results, meta, {
    projectName: aiProjectInput.value.trim(),
    workType: aiWorkTypeSelect.value,
  });
  aiCopyStatus.textContent = "";
  aiCopyStatus.className = "";
}

document.getElementById("analysis-ai-btn").addEventListener("click", () => {
  if (!lastAnalysisResults) return;
  const { u } = lastAnalysisResults;
  // El nombre y el tipo de obra se recuerdan por tramo, para no tener que
  // volver a escribirlos tras un recalculo.
  aiProjectInput.value = u.aiProjectName ?? aiDefaultProjectName(u);
  aiWorkTypeSelect.value = u.aiWorkType ?? "";
  refreshAiPrompt();
  aiBackdrop.hidden = false;
});

aiProjectInput.addEventListener("input", () => {
  if (lastAnalysisResults) lastAnalysisResults.u.aiProjectName = aiProjectInput.value;
  refreshAiPrompt();
});

aiWorkTypeSelect.addEventListener("change", () => {
  if (lastAnalysisResults) lastAnalysisResults.u.aiWorkType = aiWorkTypeSelect.value;
  refreshAiPrompt();
});

document.getElementById("ai-close-btn").addEventListener("click", () => {
  aiBackdrop.hidden = true;
});

document.getElementById("ai-copy-btn").addEventListener("click", async () => {
  const text = aiPromptText.value;
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch (e) {
    // Portapapeles moderno no disponible (p. ej. pagina sin https, o
    // permiso denegado): se intenta el metodo antiguo con el texto
    // seleccionado.
    aiPromptText.focus();
    aiPromptText.select();
    try {
      copied = document.execCommand("copy");
    } catch (e2) {
      copied = false;
    }
  }
  if (copied) {
    aiCopyStatus.textContent = "✓ Copiado. Pégalo en tu herramienta de IA.";
    aiCopyStatus.className = "ok";
  } else {
    aiPromptText.focus();
    aiPromptText.select();
    aiCopyStatus.textContent = "No se pudo copiar automáticamente: el texto ya está seleccionado, cópialo con Ctrl+C.";
    aiCopyStatus.className = "error";
  }
});
