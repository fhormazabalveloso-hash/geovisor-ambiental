// Exportacion de cartografia a A3 (PNG / PDF) con leyenda, flecha norte,
// escala grafica y cajetin Quadrante -- pensado para pegar directamente en
// documentos de licitacion (memoria / condicionantes ambientales).
//
// Tecnica: MapLibre dibuja en un lienzo WebGL, así que la captura tiene que
// pedirsela al propio mapa (map.getCanvas()) -- un "screenshot" normal de
// la pagina no funciona con WebGL. Para que la imagen exportada tenga
// buena resolucion de impresion (no la de la ventana del navegador).
//
// Documentacion sobre la calidad: como el DPI de impresion se logra
// redimensionando el propio mapa visible a las dimensiones de salida en
// pixeles (fuera de pantalla, con position:fixed), durante ese momento el
// mapa cambia de tamano - se hace con el mapa movido fuera del viewport
// para que no se note, y se restaura al terminar.

const EXPORT_DPI = 200;
const MM_PER_IN = 25.4;
const A3_MM = { w: 420, h: 297 }; // horizontal; vertical = invertido
const CAJETIN_HEIGHT_RATIO = 0.09;

function mmToPx(mm, dpi) {
  return Math.round((mm / MM_PER_IN) * dpi);
}

// Tamanos fisicos (mm sobre el papel) de los elementos de la cartografia,
// para que se vean bien proporcionados independientemente de la resolucion
// de exportacion (EXPORT_DPI). Usar pixeles fijos aqui era el bug anterior:
// a resolucion de impresion (miles de pixeles) un texto de "11px" es
// practicamente invisible en el A3 final.
const px = (mm) => mmToPx(mm, EXPORT_DPI);

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
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

async function captureMapAtResolution(widthPx, heightPx) {
  const mapEl = document.getElementById("map");
  const prevStyle = mapEl.getAttribute("style") || "";
  const dpr = window.devicePixelRatio || 1;

  // Guardamos el encuadre exacto que se ve en pantalla para restaurarlo
  // despues, y para forzar que la exportacion muestre lo mismo (ver abajo).
  const originalBounds = map.getBounds();
  const originalCenter = map.getCenter();
  const originalZoom = map.getZoom();
  const originalBearing = map.getBearing();
  const originalPitch = map.getPitch();

  mapEl.style.position = "fixed";
  mapEl.style.left = "-99999px";
  mapEl.style.top = "0";
  mapEl.style.width = `${widthPx / dpr}px`;
  mapEl.style.height = `${heightPx / dpr}px`;
  map.resize();

  // Redimensionar a proporciones A3 con el MISMO zoom numerico muestra MAS
  // area (el lienzo es mas grande) -- por eso la exportacion salia "mas
  // alejada" que la vista en pantalla. fitBounds fuerza a que se vea
  // exactamente el mismo encuadre geografico que tenias, sea cual sea el
  // tamano/proporcion del lienzo de salida.
  map.fitBounds(originalBounds, { animate: false, padding: 0 });

  await new Promise((resolve) => {
    map.once("idle", resolve);
    // por si el mapa ya estaba "idle" y el evento no vuelve a disparar
    setTimeout(resolve, 8000);
  });
  // Margen extra: la colocacion final de las etiquetas de texto (symbol
  // layers) puede terminar un poco despues del evento "idle" -- sin esta
  // espera, la captura a veces salia sin los nombres de las capas.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const dataUrl = map.getCanvas().toDataURL("image/png");
  const bounds = map.getBounds();

  mapEl.setAttribute("style", prevStyle);
  map.resize();
  map.jumpTo({
    center: originalCenter,
    zoom: originalZoom,
    bearing: originalBearing,
    pitch: originalPitch,
  });

  return { dataUrl, bounds };
}

function drawScaleBar(ctx, x, y, bounds, mapWidthPx) {
  const metersWide = haversineMeters(
    bounds.getSouth(),
    bounds.getWest(),
    bounds.getSouth(),
    bounds.getEast()
  );
  const metersPerPx = metersWide / mapWidthPx;
  const targetBarPx = px(70); // barra de ~70mm de largo sobre el papel
  const niceMeters = niceScaleDistance(targetBarPx * metersPerPx);
  const barPx = niceMeters / metersPerPx;

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
  // marcas en los extremos
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
  ctx.fillText("Escala gráfica aproximada", x, y + px(9));
  ctx.restore();
}

function drawLegend(ctx, x, y, visibleLayers, maxHeight) {
  const titleSize = px(5.5);
  const rowTextSize = px(4);
  const swatchSize = px(4.5);
  const rowH = px(7.5);
  const padding = px(5);
  const titleBlockH = px(11);
  const width = px(75);
  const rows = visibleLayers.length;
  const height = Math.min(maxHeight, padding * 2 + titleBlockH + rows * rowH);

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
  for (const l of visibleLayers) {
    if (rowY + rowH > y + height) break;
    ctx.fillStyle = l.color.fill;
    ctx.fillRect(x + padding, rowY + (rowH - swatchSize) / 2, swatchSize, swatchSize);
    ctx.strokeStyle = l.color.line;
    ctx.lineWidth = px(0.25);
    ctx.strokeRect(x + padding, rowY + (rowH - swatchSize) / 2, swatchSize, swatchSize);

    ctx.fillStyle = "#222";
    ctx.font = `${rowTextSize}px Arial`;
    ctx.fillText(
      l.nombre,
      x + padding + swatchSize + px(3),
      rowY + (rowH - rowTextSize) / 2,
      width - padding * 2 - swatchSize - px(3)
    );
    rowY += rowH;
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

async function generateCartography(orientation, title, subtitle) {
  const totalMM = orientation === "horizontal"
    ? { w: A3_MM.w, h: A3_MM.h }
    : { w: A3_MM.h, h: A3_MM.w };

  const totalW = mmToPx(totalMM.w, EXPORT_DPI);
  const totalH = mmToPx(totalMM.h, EXPORT_DPI);
  const cajetinH = Math.round(totalH * CAJETIN_HEIGHT_RATIO);
  const mapH = totalH - cajetinH;
  const mapW = totalW;

  const { dataUrl, bounds } = await captureMapAtResolution(mapW, mapH);
  const mapImg = await loadImage(dataUrl);

  const canvas = document.createElement("canvas");
  canvas.width = totalW;
  canvas.height = totalH;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, totalW, totalH);
  ctx.drawImage(mapImg, 0, 0, mapW, mapH);

  const margin = px(8);
  const visibleLayers = LAYERS.filter((l) => {
    const cb = document.querySelector(`.layer-toggle[data-id="${l.id}"]`);
    return cb && cb.checked;
  });
  drawLegend(ctx, margin, margin, visibleLayers, mapH - margin * 2);

  const arrowSize = Math.round(totalW * 0.035);
  await drawNorthArrow(ctx, mapW - arrowSize - margin, margin, arrowSize);

  drawScaleBar(ctx, margin, mapH - px(14), bounds, mapW);

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

let lastExport = null; // { canvas, totalMM }

exportOpenBtn.addEventListener("click", () => {
  exportResult.hidden = true;
  exportModalBackdrop.hidden = false;
});

exportCancelBtn.addEventListener("click", () => {
  exportModalBackdrop.hidden = true;
});

exportGenerateBtn.addEventListener("click", async () => {
  const orientation = document.querySelector('input[name="export-orientation"]:checked').value;
  const title = document.getElementById("export-title").value.trim() || "Geovisor Ambiental";
  const subtitle = document.getElementById("export-subtitle").value.trim();

  exportOverlay.hidden = false;
  try {
    lastExport = await generateCartography(orientation, title, subtitle);
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
