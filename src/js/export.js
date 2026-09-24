// Exportacion de cartografia a A3 (PNG / PDF) con leyenda, flecha norte,
// escala grafica y cajetin Quadrante -- pensado para pegar directamente en
// documentos de licitacion (memoria / condicionantes ambientales).
//
// Tecnica: MapLibre dibuja en un lienzo WebGL, así que la captura tiene que
// pedirsela al propio mapa (map.getCanvas()) -- un "screenshot" normal de
// la pagina no funciona con WebGL.
//
// DISENO DE LA ESCALA -- por que no se "captura la vista tal cual":
// A3 casi nunca tiene la misma proporcion ancho/alto que la ventana del
// navegador (y cambiar de tamano de papel no ayuda: toda la serie ISO 216
// -- A3, A4, A2... -- comparte la misma proporcion). Intentar preservar
// EXACTAMENTE el encuadre de pantalla dentro de esa forma distinta solo
// deja dos opciones, ninguna buena: bordes blancos, o mostrar mas area de
// la esperada. Esto NO es como funciona el software profesional: en el
// disenador de planos de QGIS, tu ELIGES la escala (1:1.000, 1:5.000...)
// y el programa calcula el area exacta a mostrar para esa escala y ese
// tamano de papel -- nunca intenta adivinar el encuadre de una ventana.
// Aqui se hace lo mismo: el usuario elige (o confirma) una escala en el
// panel de exportacion, y se ajusta el zoom del mapa a ESA escala exacta
// antes de capturar, sobre el mismo centro que tenia en pantalla. Al
// generarse el mapa directamente para la forma de A3, no hay bordes ni
// recorte ni distorsion -- porque nunca se intenta encajar una forma en
// otra.

const EXPORT_DPI = 200;
const MM_PER_IN = 25.4;
const A3_MM = { w: 420, h: 297 }; // horizontal; vertical = invertido
const CAJETIN_HEIGHT_RATIO = 0.09;
const SCREEN_MM_PER_CSS_PX = 25.4 / 96; // convencion estandar (96 DPI) para estimar la escala "de pantalla"
const SCALE_OPTIONS = [500, 1000, 2000, 2500, 5000, 10000, 25000, 50000, 100000];

// Debe coincidir con el "text-size" de las capas de etiqueta en main.js.
// Solo se usa como referencia de respaldo en captureMapAtScale() si por
// lo que sea el estilo no trae un valor numerico (p. ej. una expresion).
const ON_SCREEN_LABEL_TEXT_SIZE = 11;

// Factor para que cualquier valor en px CSS (grosor de linea, texto...)
// ocupe el mismo tamano FISICO en el papel exportado que en pantalla,
// sea cual sea EXPORT_DPI o el devicePixelRatio del navegador -- misma
// idea que ya se aplicaba solo al texto (ver captureMapAtScale). Sin
// esto, una linea de "4px" pensada para una pantalla normal (96 DPI) sale
// visiblemente mas fina de lo esperado en un export a 200 DPI (encontrado
// por Francisco probando el visor con un caso real, 2026-09-24: la linea
// del trazado subido se veia demasiado fina en la cartografia impresa).
function dpiScaleFactor(dpr) {
  return EXPORT_DPI / (96 * dpr);
}

// Escala un valor de "line-width" para la exportacion. No se puede
// envolver una expresion de zoom (["interpolate", ..., ["zoom"], ...],
// como la que usan las capas de linea en main.js) dentro de otra
// expresion tipo ["*", factor, expr] -- MapLibre exige que una expresion
// de camara/zoom quede como expresion de NIVEL SUPERIOR de la propiedad,
// si no rechaza el estilo entero (error real encontrado probando este
// mismo fix: "zoom expressions may only be used as top-level expressions
// [...] or a top-level 'step' or 'interpolate' expression"). En vez de
// envolverla, se reescribe la misma expresion con sus valores de salida
// multiplicados por el factor, que si es valido.
function scaleLineWidthExpr(value, factor) {
  if (typeof value === "number") return value * factor;
  if (Array.isArray(value) && value[0] === "interpolate") {
    // ["interpolate", tipo, entrada, parada1, valor1, parada2, valor2, ...]
    const [op, interp, input, ...stops] = value;
    const scaledStops = stops.map((v, i) => (i % 2 === 1 ? v * factor : v));
    return [op, interp, input, ...scaledStops];
  }
  if (Array.isArray(value) && value[0] === "step") {
    // ["step", entrada, valorBase, parada1, valor1, ...]
    const [op, input, base, ...rest] = value;
    const scaledRest = rest.map((v, i) => (i % 2 === 1 ? v * factor : v));
    return [op, input, base * factor, ...scaledRest];
  }
  // Expresion de otro tipo no contemplada -- se deja sin escalar en vez
  // de arriesgarse a romper el estilo con una que no se ha probado.
  return value;
}

function mmToPx(mm, dpi) {
  return Math.round((mm / MM_PER_IN) * dpi);
}

// Tamanos fisicos (mm sobre el papel) de los elementos de la cartografia,
// para que se vean bien proporcionados independientemente de la resolucion
// de exportacion (EXPORT_DPI).
const px = (mm) => mmToPx(mm, EXPORT_DPI);

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// Mide metros por pixel CSS en el CENTRO VERTICAL del mapa, ahora mismo --
// la misma tecnica que usa el control de escala nativo de MapLibre
// internamente (dos puntos a 100px de distancia, "unproyectados" a
// coordenadas geograficas, y se mide la distancia real entre ambos).
function measureMetersPerCssPixel() {
  const h = map.getContainer().clientHeight / 2;
  const p1 = map.unproject([0, h]);
  const p2 = map.unproject([100, h]);
  return p1.distanceTo(p2) / 100;
}

// Escala aproximada "1:N" de lo que se ve ahora mismo en pantalla (con la
// convencion habitual de 96 DPI para pantallas). Solo se usa para sugerir
// un valor por defecto en el selector -- el usuario puede cambiarlo.
function currentOnScreenScale() {
  const metersPerPx = measureMetersPerCssPixel();
  return (metersPerPx * 1000) / SCREEN_MM_PER_CSS_PX;
}

function nearestScaleOption(n) {
  return SCALE_OPTIONS.reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));
}

// Elige una distancia "redonda" (1, 2, 5, 10, 20, 50, 100... m/km) que quepa
// en el ancho de barra objetivo, al estilo de las escalas graficas de QGIS.
function niceScaleDistance(maxMeters) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500];
  const magnitude = Math.pow(10, Math.floor(Math.log10(maxMeters)));
  for (let i = steps.length - 1; i >= 0; i--) {
    const candidate = steps[i] * magnitude;
    if (candidate <= maxMeters) return candidate;
  }
  return magnitude;
}

async function captureMapAtScale(targetScaleN, mapW, mapH) {
  const mapEl = document.getElementById("map");
  const prevStyle = mapEl.getAttribute("style") || "";
  const dpr = window.devicePixelRatio || 1;

  const originalCenter = map.getCenter();
  const originalZoom = map.getZoom();
  const originalBearing = map.getBearing();
  const originalPitch = map.getPitch();

  // Ajuste de zoom para llegar a la escala EXACTA elegida, calculado por
  // proporcion (relativo al zoom actual) en vez de con una formula de
  // Mercator propia -- así no importa si acertamos la convencion interna
  // exacta de MapLibre (256 vs 512 px de tesela de referencia, etc.), el
  // resultado es correcto porque se calibra contra una medicion real del
  // propio mapa (measureMetersPerCssPixel), no contra una formula.
  const targetMetersPerOutputPx = (targetScaleN * MM_PER_IN) / 1000 / EXPORT_DPI;
  const targetMetersPerCssPx = targetMetersPerOutputPx * dpr;
  const currentMetersPerCssPx = measureMetersPerCssPixel();
  const zoomAdjustment = Math.log2(currentMetersPerCssPx / targetMetersPerCssPx);
  const targetZoom = originalZoom + zoomAdjustment;

  map.jumpTo({ center: originalCenter, zoom: targetZoom, bearing: originalBearing, pitch: originalPitch });

  mapEl.style.position = "fixed";
  mapEl.style.left = "-99999px";
  mapEl.style.top = "0";
  mapEl.style.width = `${mapW / dpr}px`;
  mapEl.style.height = `${mapH / dpr}px`;
  map.resize();

  // Los nombres de elemento (rios, espacios protegidos...) los dibuja el
  // propio MapLibre como "symbol" layers con text-size en px CSS (11,
  // ver main.js) -- pensado para verse bien en una pantalla normal. Al
  // exportar, el canvas se renderiza a EXPORT_DPI (200), mucho mas denso
  // que una pantalla, asi que ese mismo texto queda diminuto en el papel
  // si no se compensa. El resto de la cartografia (cajetin, leyenda,
  // escala) ya usa px() para ir de mm a pixeles segun EXPORT_DPI: aqui se
  // aplica la misma idea, tratando esos 11px como "pensados para 96 DPI"
  // (la referencia de pantalla que ya usa SCREEN_MM_PER_CSS_PX) y
  // escalandolos para que el texto ocupe el mismo tamano FISICO en el
  // papel sea cual sea EXPORT_DPI o el devicePixelRatio del navegador.
  const restoreTextSizes = [];
  for (const l of LAYERS) {
    if (!l.labelField) continue;
    const id = `${l.id}-label`;
    if (!map.getLayer(id)) continue;
    const original = map.getLayoutProperty(id, "text-size");
    restoreTextSizes.push([id, original]);
    const onScreenPx = typeof original === "number" ? original : ON_SCREEN_LABEL_TEXT_SIZE;
    const onScreenMm = onScreenPx * SCREEN_MM_PER_CSS_PX;
    const exportPx = (onScreenMm / MM_PER_IN) * EXPORT_DPI / dpr;
    map.setLayoutProperty(id, "text-size", exportPx);
  }

  // Mismo criterio que el texto, aplicado al grosor de linea de TODAS las
  // capas de tipo "line" del estilo actual (capas ambientales de linea,
  // el contorno de poligono, el trazado subido, su propia opcion de
  // "Grosor de linea"...) -- generico en vez de listar IDs a mano, asi
  // cubre cualquier capa de linea presente sin mantenimiento aparte.
  const lineWidthFactor = dpiScaleFactor(dpr);
  const restoreLineWidths = [];
  for (const layerDef of map.getStyle().layers) {
    if (layerDef.type !== "line") continue;
    const id = layerDef.id;
    const original = map.getPaintProperty(id, "line-width");
    if (original == null) continue;
    restoreLineWidths.push([id, original]);
    map.setPaintProperty(id, "line-width", scaleLineWidthExpr(original, lineWidthFactor));
  }

  await new Promise((resolve) => {
    map.once("idle", resolve);
    // por si el mapa ya estaba "idle" y el evento no vuelve a disparar
    setTimeout(resolve, 8000);
  });
  // Margen extra: la colocacion final de las etiquetas de texto (symbol
  // layers) puede terminar un poco despues del evento "idle".
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Que capas se exportan en la leyenda: solo las que tengan al menos un
  // elemento REALMENTE dibujado en esta vista concreta (no solo activadas
  // en el panel).
  // Para capas con colorByField (p. ej. TIPO en red_natura_2000 -- ver
  // layers.js), ademas de si la capa tiene algo dibujado, se anota QUE
  // valores de ese campo aparecen realmente en esta vista concreta, para
  // que la leyenda solo liste ZEC/ZEPA/ambas si de verdad hay alguno en
  // el encuadre exportado (misma logica que ya se aplicaba a nivel de
  // capa completa, extendida a sus variantes de color).
  const renderedLayerIds = new Set();
  const renderedFieldValues = new Map(); // l.id -> Set de valores de colorByField presentes
  // l.id -> Map(variante de colorByField, o "_all" si no tiene -> Set de
  // nombres) -- para poder listar en la leyenda que elemento concreto es
  // (p. ej. "Doñana", el río que se ve debajo de la capa de hidrografía)
  // cuando el nombre no llegue a verse como texto sobre el propio mapa
  // (su punto de etiqueta puede caer fuera del recuadro exportado, ver
  // investigacion/ejemplos-de-uso/caso-cerramiento-planta-agroindustrial.md
  // §4.3-bis -- pedido por Francisco probando el visor, 2026-09-24).
  // ANALYSIS_PLACEHOLDER_NAMES esta definida en analysis.js (cargado
  // despues que este fichero en index.html), pero esto solo se ejecuta
  // dentro de un manejador de clic, mucho despues de que todos los
  // <script> ya se hayan ejecutado -- mismo patron ya usado en upload.js.
  const renderedNames = new Map();
  for (const l of LAYERS) {
    const cb = document.querySelector(`.layer-toggle[data-id="${l.id}"]`);
    if (!cb || !cb.checked) continue;
    const candidateIds = [`${l.id}-fill`, `${l.id}-line`, `${l.id}-point`].filter((id) => map.getLayer(id));
    if (!candidateIds.length) continue;
    const feats = map.queryRenderedFeatures({ layers: candidateIds });
    if (feats.length === 0) continue;
    renderedLayerIds.add(l.id);
    if (l.colorByField) {
      renderedFieldValues.set(l.id, new Set(feats.map((f) => f.properties[l.colorByField])));
    }
    if (l.labelField) {
      const namesByVariant = new Map();
      for (const f of feats) {
        const variant = l.colorByField ? f.properties[l.colorByField] : "_all";
        const raw = f.properties[l.labelField];
        const clean = raw == null ? "" : String(raw).trim();
        if (!clean || ANALYSIS_PLACEHOLDER_NAMES.has(clean.toLowerCase())) continue;
        if (!namesByVariant.has(variant)) namesByVariant.set(variant, new Set());
        namesByVariant.get(variant).add(clean);
      }
      renderedNames.set(l.id, namesByVariant);
    }
  }

  // Igual que arriba pero para los tramos/puntos subidos por el usuario
  // (idea de Francisco, 2026-09-24: la propia línea del proyecto no
  // aparecía en la leyenda) -- una fila por tramo visible con algo
  // realmente dibujado en esta vista, con su nombre de archivo y su
  // propio color.
  const uploadLegendRows = [];
  for (const u of uploadedLayers) {
    if (!u.visible) continue;
    const candidateIds = [`${u.id}-fill`, `${u.id}-line`, `${u.id}-point`].filter((id) => map.getLayer(id));
    if (!candidateIds.length) continue;
    const feats = map.queryRenderedFeatures({ layers: candidateIds });
    if (feats.length === 0) continue;
    uploadLegendRows.push({ fill: u.color, line: u.color, nombre: u.name.replace(/\.[^.]+$/, "") });
  }

  const dataUrl = map.getCanvas().toDataURL("image/png");

  for (const [id, original] of restoreTextSizes) {
    map.setLayoutProperty(id, "text-size", original);
  }
  for (const [id, original] of restoreLineWidths) {
    map.setPaintProperty(id, "line-width", original);
  }

  mapEl.setAttribute("style", prevStyle);
  map.resize();
  map.jumpTo({ center: originalCenter, zoom: originalZoom, bearing: originalBearing, pitch: originalPitch });

  return { dataUrl, renderedLayerIds, renderedFieldValues, renderedNames, uploadLegendRows };
}

// Cuantos nombres distintos como mucho se listan bajo cada fila de
// leyenda (ver buildLegendRows) -- una capa muy densa en la vista
// exportada (p. ej. la red hidrografica) podria traer decenas, y no cabe
// ni tiene sentido listarlos todos.
const LEGEND_MAX_NAMES = 3;

function legendNamesSubtitle(namesSet) {
  if (!namesSet || namesSet.size === 0) return null;
  const arr = [...namesSet].sort();
  const shown = arr.slice(0, LEGEND_MAX_NAMES).join(", ");
  return arr.length > LEGEND_MAX_NAMES ? `${shown}…` : shown;
}

// Expande "capas visibles" a filas de leyenda: una fila por capa
// normalmente, pero varias para una capa con colorByField (una por cada
// valor de ese campo presente de verdad en esta vista -- ver
// renderedFieldValues en captureMapAtScale). Sin esto, red_natura_2000
// aparecería siempre como un unico verde en vez de distinguir ZEC/ZEPA.
//
// Cada fila lleva ademas un "subtitle" con el/los nombre(s) de elemento
// realmente presentes en la vista exportada (p. ej. "Doñana", o el
// nombre del rio) -- pensado como respaldo para cuando el nombre no
// llega a verse como texto sobre el propio mapa porque su punto de
// etiqueta cae fuera del recuadro exportado (limitacion documentada en
// investigacion/ejemplos-de-uso/caso-cerramiento-planta-agroindustrial.md
// §4.3-bis; pedido por Francisco probando el visor, 2026-09-24).
function buildLegendRows(visibleLayers, renderedFieldValues, renderedNames) {
  const rows = [];
  for (const l of visibleLayers) {
    const namesByVariant = renderedNames.get(l.id);
    if (l.colorByField && l.colorByValue) {
      const present = renderedFieldValues.get(l.id);
      const baseName = l.nombre.replace(/\s*\([^)]*\)\s*$/, "");
      for (const [value, cfg] of Object.entries(l.colorByValue)) {
        if (present && !present.has(value)) continue;
        rows.push({
          fill: cfg.fill,
          line: cfg.line,
          nombre: `${baseName} - ${cfg.label}`,
          subtitle: legendNamesSubtitle(namesByVariant && namesByVariant.get(value)),
        });
      }
    } else {
      rows.push({
        fill: l.color.fill,
        line: l.color.line,
        nombre: l.nombre,
        subtitle: legendNamesSubtitle(namesByVariant && namesByVariant.get("_all")),
      });
    }
  }
  return rows;
}

function drawScaleBar(ctx, x, y, scaleN) {
  // Como la escala es exactamente la que se eligio (no una estimacion),
  // se calcula la barra directamente a partir de scaleN -- sin depender
  // de leer ningun control en pantalla.
  const metersPerOutputPx = (scaleN * MM_PER_IN) / 1000 / EXPORT_DPI;
  const targetBarPx = px(70); // barra de ~70mm de largo sobre el papel
  const niceMeters = niceScaleDistance(targetBarPx * metersPerOutputPx);
  const barPx = niceMeters / metersPerOutputPx;
  const label = niceMeters >= 1000 ? `${niceMeters / 1000} km` : `${niceMeters} m`;

  const labelSize = px(4.5);
  const captionSize = px(3);
  const boxPad = px(4);

  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.fillRect(x - boxPad, y - px(11), barPx + boxPad * 2 + px(20), px(20));

  ctx.strokeStyle = "#182C54";
  ctx.lineWidth = px(1);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + barPx, y);
  ctx.stroke();
  [x, x + barPx].forEach((tx) => {
    ctx.beginPath();
    ctx.moveTo(tx, y - px(2));
    ctx.lineTo(tx, y + px(2));
    ctx.stroke();
  });

  ctx.fillStyle = "#182C54";
  ctx.font = `bold ${labelSize}px Arial`;
  ctx.textBaseline = "bottom";
  ctx.fillText(label, x, y - px(3));
  ctx.font = `${captionSize}px Arial`;
  ctx.fillText(`Escala 1:${scaleN.toLocaleString("es-ES")}`, x, y + px(9));
  ctx.restore();
}

// legendRows: array ya construido (buildLegendRows para las capas
// ambientales, concatenado con las filas de los tramos/puntos subidos --
// ver generateCartography) para poder combinar ambas fuentes sin que
// drawLegend tenga que saber de donde viene cada fila.
function drawLegend(ctx, x, y, legendRows, maxHeight) {
  const titleSize = px(5.5);
  const rowTextSize = px(4);
  const subtitleTextSize = px(3.2);
  const swatchSize = px(4.5);
  const rowH = px(7.5);
  const subtitleH = px(4); // espacio extra solo para las filas que traen subtitle
  const padding = px(5);
  const titleBlockH = px(11);
  const width = px(75);

  const rowHeights = legendRows.map((r) => rowH + (r.subtitle ? subtitleH : 0));
  const totalRowsH = rowHeights.reduce((a, b) => a + b, 0);
  const height = Math.min(maxHeight, padding * 2 + titleBlockH + totalRowsH);

  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.92)";
  ctx.strokeStyle = "#ccc";
  ctx.lineWidth = px(0.3);
  ctx.fillRect(x, y, width, height);
  ctx.strokeRect(x, y, width, height);

  ctx.fillStyle = "#182C54";
  ctx.font = `bold ${titleSize}px Arial`;
  ctx.textBaseline = "top";
  ctx.fillText("Leyenda", x + padding, y + padding);

  let rowY = y + padding + titleBlockH;
  for (let i = 0; i < legendRows.length; i++) {
    const row = legendRows[i];
    const thisRowH = rowHeights[i];
    if (rowY + thisRowH > y + height) break;
    ctx.fillStyle = row.fill;
    ctx.fillRect(x + padding, rowY + (rowH - swatchSize) / 2, swatchSize, swatchSize);
    ctx.strokeStyle = row.line;
    ctx.lineWidth = px(0.25);
    ctx.strokeRect(x + padding, rowY + (rowH - swatchSize) / 2, swatchSize, swatchSize);

    ctx.fillStyle = "#222";
    ctx.font = `${rowTextSize}px Arial`;
    ctx.fillText(
      row.nombre,
      x + padding + swatchSize + px(3),
      rowY + (rowH - rowTextSize) / 2,
      width - padding * 2 - swatchSize - px(3)
    );
    if (row.subtitle) {
      ctx.fillStyle = "#666";
      ctx.font = `italic ${subtitleTextSize}px Arial`;
      ctx.fillText(
        row.subtitle,
        x + padding + swatchSize + px(3),
        rowY + rowH,
        width - padding * 2 - swatchSize - px(3)
      );
    }
    rowY += thisRowH;
  }
  ctx.restore();
  return height;
}

async function drawNorthArrow(ctx, x, y, targetHeight) {
  try {
    const img = await loadImage("assets/NORTE.svg");
    const w = targetHeight * (img.width / img.height); // respeta la proporcion real del SVG (~1:1.88)
    ctx.drawImage(img, x + (targetHeight - w) / 2, y, w, targetHeight);
  } catch (e) {
    console.warn("No se pudo cargar la flecha norte:", e);
  }
}

async function drawCajetin(ctx, x, y, width, height, title, subtitle) {
  ctx.save();
  ctx.fillStyle = "#182C54";
  ctx.fillRect(x, y, width, height);

  try {
    const logo = await loadImage("assets/QDE_META_White.svg");
    const logoH = height * 0.55;
    const logoW = logoH * (logo.width / logo.height);
    ctx.drawImage(logo, x + px(6), y + (height - logoH) / 2, logoW, logoH);
  } catch (e) {
    console.warn("No se pudo cargar el logo:", e);
  }

  ctx.fillStyle = "#fff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${Math.round(height * 0.28)}px Arial`;
  ctx.fillText(title, x + width / 2, y + height * 0.38);
  if (subtitle) {
    ctx.font = `${Math.round(height * 0.16)}px Arial`;
    ctx.fillText(subtitle, x + width / 2, y + height * 0.68);
  }

  ctx.textAlign = "right";
  ctx.font = `${Math.round(height * 0.14)}px Arial`;
  const fuente1 = "Elaboración propia a partir de MITECO / IGN";
  const fuente2 = "ETRS89 / EPSG:4326 (visor) · EPSG:25830 (QGIS)";
  ctx.fillText(fuente1, x + width - px(6), y + height * 0.38);
  ctx.fillText(fuente2, x + width - px(6), y + height * 0.62);
  ctx.restore();
}

async function generateCartography(orientation, title, subtitle, scaleN) {
  const totalMM = orientation === "horizontal"
    ? { w: A3_MM.w, h: A3_MM.h }
    : { w: A3_MM.h, h: A3_MM.w };

  const totalW = mmToPx(totalMM.w, EXPORT_DPI);
  const totalH = mmToPx(totalMM.h, EXPORT_DPI);
  const cajetinH = Math.round(totalH * CAJETIN_HEIGHT_RATIO);
  const mapH = totalH - cajetinH;
  const mapW = totalW;

  const { dataUrl, renderedLayerIds, renderedFieldValues, renderedNames, uploadLegendRows } = await captureMapAtScale(scaleN, mapW, mapH);
  const mapImg = await loadImage(dataUrl);

  const canvas = document.createElement("canvas");
  canvas.width = totalW;
  canvas.height = totalH;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, totalW, totalH);
  ctx.drawImage(mapImg, 0, 0, mapW, mapH);

  const margin = px(8);
  const visibleLayers = LAYERS.filter((l) => renderedLayerIds.has(l.id));
  // Filas de las capas ambientales + una por cada tramo/punto subido
  // visible con algo dibujado en esta vista (idea de Francisco,
  // 2026-09-24: la línea del proyecto no salía en la leyenda).
  const legendRows = buildLegendRows(visibleLayers, renderedFieldValues, renderedNames).concat(uploadLegendRows);
  drawLegend(ctx, margin, margin, legendRows, mapH - margin * 2);

  const arrowSize = Math.round(totalW * 0.035);
  await drawNorthArrow(ctx, mapW - arrowSize - margin, margin, arrowSize);

  drawScaleBar(ctx, margin, mapH - px(14), scaleN);

  await drawCajetin(ctx, 0, mapH, totalW, cajetinH, title, subtitle);

  return { canvas, totalMM };
}

// --- UI wiring ---
const exportOpenBtn = document.getElementById("export-open-btn");
const exportModalBackdrop = document.getElementById("export-modal-backdrop");
const exportCancelBtn = document.getElementById("export-cancel-btn");
const exportGenerateBtn = document.getElementById("export-generate-btn");
const exportOverlay = document.getElementById("export-overlay");
const exportResult = document.getElementById("export-result");
const exportPreview = document.getElementById("export-preview");
const exportDownloadPng = document.getElementById("export-download-png");
const exportDownloadPdf = document.getElementById("export-download-pdf");
const exportScaleSelect = document.getElementById("export-scale");

let lastExport = null; // { canvas, totalMM }

exportOpenBtn.addEventListener("click", () => {
  exportResult.hidden = true;
  // Sugerencia de escala por defecto: la mas cercana a lo que se ve ahora
  // mismo en pantalla. El usuario puede cambiarla antes de generar.
  exportScaleSelect.value = String(nearestScaleOption(currentOnScreenScale()));
  exportModalBackdrop.hidden = false;
});

exportCancelBtn.addEventListener("click", () => {
  exportModalBackdrop.hidden = true;
});

exportGenerateBtn.addEventListener("click", async () => {
  const orientation = document.querySelector('input[name="export-orientation"]:checked').value;
  const title = document.getElementById("export-title").value.trim() || "Geovisor Ambiental";
  const subtitle = document.getElementById("export-subtitle").value.trim();
  const scaleN = Number(exportScaleSelect.value);

  exportOverlay.hidden = false;
  try {
    lastExport = await generateCartography(orientation, title, subtitle, scaleN);
    exportPreview.src = lastExport.canvas.toDataURL("image/png");
    exportResult.hidden = false;
  } catch (e) {
    console.error(e);
    alert("Error generando la cartografía: " + e.message);
  } finally {
    exportOverlay.hidden = true;
  }
});

exportDownloadPng.addEventListener("click", () => {
  if (!lastExport) return;
  lastExport.canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "geovisor_cartografia.png";
    a.click();
    URL.revokeObjectURL(url);
  }, "image/png");
});

exportDownloadPdf.addEventListener("click", () => {
  if (!lastExport) return;
  const { jsPDF } = window.jspdf;
  const { canvas, totalMM } = lastExport;
  const pdf = new jsPDF({
    orientation: totalMM.w > totalMM.h ? "landscape" : "portrait",
    unit: "mm",
    format: [totalMM.w, totalMM.h],
  });
  pdf.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, totalMM.w, totalMM.h);
  pdf.save("geovisor_cartografia.pdf");
});
