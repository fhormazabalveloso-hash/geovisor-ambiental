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

// Un valor en px CSS de pantalla (96 DPI) expresado en px del lienzo de
// exportacion -- para dibujar en la leyenda un simbolo de linea con el
// mismo grosor fisico que tiene esa linea en el mapa exportado.
function cssPxToOutputPx(v) {
  return (v * EXPORT_DPI) / 96;
}

// Mapa de situacion (inset): recuadro pequeno abajo a la derecha con la
// zona del proyecto en su contexto regional -- elemento habitual en un
// plano de licitacion (README §7). Escala fija: a 1:2.500.000, 70 mm de
// ancho cubren unos 175 km, suficiente para situar una provincia.
const INSET_SCALE = 2500000;
const INSET_MM = { w: 70, h: 52 };

// Poligonos de provincia del inset (pipeline/build_situacion.py; sustituyen a
// las lineas limite, retiradas del visor el 2026-09-29). Se cargan solo la
// primera vez que se exporta con mapa de situacion, no al abrir el visor.
// Con poligonos se puede resaltar la provincia del proyecto (y aclarar
// su comunidad autonoma), cosa que las lineas sueltas no permitian.
const SITUACION_URL = "../data-web/situacion_provincias.geojson";
const SITUACION_SOURCE = "situacion-provincias";
// Distancia maxima para asignar provincia cuando el centro del plano cae
// fuera de todas (p. ej. en el mar, en una obra portuaria).
const SITUACION_MAX_DIST_KM = 30;
// Unicas capas (ademas del mapa base) que se dejan visibles en el inset.
const INSET_CONTEXT_LAYER_IDS = [
  "situacion-ccaa-fill",
  "situacion-prov-fill",
  "situacion-prov-line",
  "situacion-prov-highlight-line",
];
let situacionData = null;

// Anade (una vez por estilo: un cambio de mapa base las borra) la fuente y
// las capas del inset, ocultas. Tiene que ocurrir ANTES de escalar los
// grosores de linea para la exportacion (captureMapAtScale), para que las
// lineas de provincia salgan con el mismo grosor fisico que el resto.
async function ensureSituacionLayers() {
  if (!situacionData) {
    const res = await fetch(SITUACION_URL);
    if (!res.ok) throw new Error(`No se pudo cargar ${SITUACION_URL} (${res.status})`);
    situacionData = await res.json();
  }
  if (map.getSource(SITUACION_SOURCE)) return;
  map.addSource(SITUACION_SOURCE, { type: "geojson", data: situacionData });
  const hidden = { visibility: "none" };
  const none = ["==", ["get", "prov"], ""];
  map.addLayer({
    id: "situacion-ccaa-fill",
    type: "fill",
    source: SITUACION_SOURCE,
    layout: hidden,
    filter: none,
    paint: { "fill-color": "#FFFFFF", "fill-opacity": 0.28 },
  });
  map.addLayer({
    id: "situacion-prov-fill",
    type: "fill",
    source: SITUACION_SOURCE,
    layout: hidden,
    filter: none,
    paint: { "fill-color": "#FFFFFF", "fill-opacity": 0.55 },
  });
  map.addLayer({
    id: "situacion-prov-line",
    type: "line",
    source: SITUACION_SOURCE,
    layout: hidden,
    paint: { "line-color": "#FFFFFF", "line-width": 0.8, "line-opacity": 0.9 },
  });
  map.addLayer({
    id: "situacion-prov-highlight-line",
    type: "line",
    source: SITUACION_SOURCE,
    layout: hidden,
    filter: none,
    paint: { "line-color": "#182C54", "line-width": 1.2 },
  });
}

// Provincia (y comunidad) del punto dado: la que lo contiene o, si ninguna,
// la mas cercana a menos de SITUACION_MAX_DIST_KM. Los poligonos estan
// simplificados a ~400 m: cerca de un limite provincial puede elegir la
// vecina, aceptable para rotular un mapa de situacion.
function findProvincia(lng, lat) {
  const pt = turf.point([lng, lat]);
  for (const f of situacionData.features) {
    if (turf.booleanPointInPolygon(pt, f)) return f.properties;
  }
  let best = null;
  let bestKm = Infinity;
  for (const f of situacionData.features) {
    // flatten: solo LineString simples (ver minDistanceMetersToFeature en
    // analysis.js, mismo problema con MultiPolygon con huecos).
    for (const line of turf.flatten(turf.polygonToLine(f)).features) {
      const km = turf.pointToLineDistance(pt, line, { units: "kilometers" });
      if (km < bestKm) {
        bestKm = km;
        best = f.properties;
      }
    }
  }
  return bestKm <= SITUACION_MAX_DIST_KM ? best : null;
}

// "Almería, Andalucía"; solo la comunidad si su nombre ya incluye el de la
// provincia (uniprovinciales: "Comunidad de Madrid", "Cantabria"...).
function provinciaLabel(p) {
  if (!p) return null;
  return p.ccaa.toLowerCase().includes(p.prov.toLowerCase()) ? p.ccaa : `${p.prov}, ${p.ccaa}`;
}

// Pasos de la cuadricula UTM, en metros -- se elige el menor que deje como
// mucho ~6 lineas a lo ancho del mapa.
const UTM_GRID_STEPS = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 25000, 50000, 100000];
const UTM_GRID_MAX_LINES = 6;
const UTM_GRID_SAMPLES = 16;

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

// Huso UTM segun la longitud del centro del mapa. Espana peninsular y
// Baleares caen en 29-31; Canarias en 27-28.
function utmZoneForLon(lon) {
  return Math.min(31, Math.max(27, Math.floor((lon + 180) / 6) + 1));
}

// Sistema de referencia de la cuadricula, para el cajetin. En Canarias el
// oficial es REGCAN95 (EPSG:4082/4083), no ETRS89 -- mismo elipsoide GRS80
// y diferencias submetricas, asi que la cuadricula es la misma; solo cambia
// como se nombra.
function utmCrsLabel(zone, lat) {
  if (lat < 30) return `REGCAN95 · Cuadrícula UTM huso ${zone}N (EPSG:${zone === 27 ? 4082 : 4083})`;
  return `ETRS89 · Cuadrícula UTM huso ${zone}N (EPSG:258${zone})`;
}

// Cuadricula UTM del mapa YA encuadrado a la escala de exportacion (se
// llama desde captureMapAtScale antes de restaurar la vista). Devuelve las
// lineas ya en px del lienzo de exportacion. Las lineas de E/N constante
// no son exactamente rectas sobre Web Mercator (convergencia de
// meridianos), asi que se muestrean en UTM_GRID_SAMPLES puntos en vez de
// dibujarse como una recta entre dos extremos. Usa proj4 (index.html);
// si no ha cargado, se exporta sin cuadricula en vez de fallar.
function computeUtmGrid(outW, outH, dpr) {
  if (typeof proj4 === "undefined") return null;
  const cssW = outW / dpr;
  const cssH = outH / dpr;
  const center = map.unproject([cssW / 2, cssH / 2]);
  const zone = utmZoneForLon(center.lng);
  const def = `+proj=utm +zone=${zone} +ellps=GRS80 +units=m +no_defs`;
  const toUtm = (ll) => proj4("EPSG:4326", def, [ll.lng, ll.lat]);

  let minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    for (const p of [[t * cssW, 0], [t * cssW, cssH], [0, t * cssH], [cssW, t * cssH]]) {
      const [e, n] = toUtm(map.unproject(p));
      minE = Math.min(minE, e); maxE = Math.max(maxE, e);
      minN = Math.min(minN, n); maxN = Math.max(maxN, n);
    }
  }
  const widthM = maxE - minE;
  const step = UTM_GRID_STEPS.find((s) => widthM / s <= UTM_GRID_MAX_LINES) || UTM_GRID_STEPS[UTM_GRID_STEPS.length - 1];

  const toOut = (e, n) => {
    const [lng, lat] = proj4(def, "EPSG:4326", [e, n]);
    const p = map.project([lng, lat]);
    return [p.x * dpr, p.y * dpr];
  };
  const eastings = [];
  for (let e = Math.ceil(minE / step) * step; e <= maxE; e += step) {
    const line = [];
    for (let i = 0; i <= UTM_GRID_SAMPLES; i++) line.push(toOut(e, minN + ((maxN - minN) * i) / UTM_GRID_SAMPLES));
    eastings.push({ value: e, line });
  }
  const northings = [];
  for (let n = Math.ceil(minN / step) * step; n <= maxN; n += step) {
    const line = [];
    for (let i = 0; i <= UTM_GRID_SAMPLES; i++) line.push(toOut(minE + ((maxE - minE) * i) / UTM_GRID_SAMPLES, n));
    northings.push({ value: n, line });
  }
  return { zone, crsLabel: utmCrsLabel(zone, center.lat), eastings, northings };
}

// Segunda captura, para el mapa de situacion: mismo centro, escala fija
// INSET_SCALE, y solo el mapa base + limites provinciales/autonomicos (el
// resto de capas se ocultan un momento y se restauran al terminar).
// mainCorners: las 4 esquinas del mapa principal ya exportado, para poder
// marcar en el inset que zona abarca.
async function captureInset(insetW, insetH, dpr, center, mainCorners) {
  const mapEl = document.getElementById("map");
  const provincia = findProvincia(center.lng, center.lat);
  const provFilter = ["==", ["get", "prov"], provincia ? provincia.prov : ""];
  map.setFilter("situacion-prov-fill", provFilter);
  map.setFilter("situacion-prov-highlight-line", provFilter);
  map.setFilter("situacion-ccaa-fill", ["all", ["==", ["get", "ccaa"], provincia ? provincia.ccaa : ""], ["!", provFilter]]);

  const prevVis = [];
  for (const layerDef of map.getStyle().layers) {
    if (layerDef.id === "basemap") continue;
    prevVis.push([layerDef.id, map.getLayoutProperty(layerDef.id, "visibility") || "visible"]);
    map.setLayoutProperty(layerDef.id, "visibility", INSET_CONTEXT_LAYER_IDS.includes(layerDef.id) ? "visible" : "none");
  }

  mapEl.style.width = `${insetW / dpr}px`;
  mapEl.style.height = `${insetH / dpr}px`;
  map.resize();
  map.jumpTo({ center, zoom: map.getZoom() });
  const targetMetersPerCssPx = ((INSET_SCALE * MM_PER_IN) / 1000 / EXPORT_DPI) * dpr;
  const zoomAdjustment = Math.log2(measureMetersPerCssPixel() / targetMetersPerCssPx);
  map.jumpTo({ center, zoom: map.getZoom() + zoomAdjustment });

  await new Promise((resolve) => {
    map.once("idle", resolve);
    setTimeout(resolve, 8000);
  });
  await new Promise((resolve) => setTimeout(resolve, 300));

  const extentPx = mainCorners.map((ll) => {
    const p = map.project(ll);
    return [p.x * dpr, p.y * dpr];
  });
  const dataUrl = map.getCanvas().toDataURL("image/png");

  for (const [id, vis] of prevVis) map.setLayoutProperty(id, "visibility", vis);
  return { dataUrl, extentPx, w: insetW, h: insetH, label: provinciaLabel(provincia) };
}

// Tipo de simbolo de leyenda para un tramo/punto subido segun su geometria.
function uploadSwatchType(u) {
  const types = u.geojson.features.filter((f) => f.geometry).map((f) => f.geometry.type);
  if (types.some((t) => t.includes("Polygon"))) return "fill";
  if (types.some((t) => t.includes("LineString"))) return "line";
  return "point";
}

// options: { grid: bool, inset: bool } -- ver checkboxes del modal.
async function captureMapAtScale(targetScaleN, mapW, mapH, options = {}) {
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
  // Antes del escalado de grosores: ver ensureSituacionLayers.
  if (options.inset) await ensureSituacionLayers();
  // Capas en linea visibles (zonas inundables): cargar el encuadre que se
  // va a exportar, que puede ser mas grande que la vista de pantalla. Si el
  // servicio falla, la capa sale sin elementos y su fila en el panel lo dice.
  await refreshWfsForView();

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

  // Mismo criterio que analyzeUploadedLayer (analysis.js): repintado
  // forzado para que "idle" llegue siempre, y si se agota el tope se avisa
  // en vez de exportar en silencio un plano al que le puede faltar alguna
  // capa todavia sin dibujar.
  map.triggerRepaint();
  const waitOutcome = await new Promise((resolve) => {
    map.once("idle", () => resolve("idle"));
    setTimeout(() => resolve("timeout"), ANALYSIS_IDLE_TIMEOUT_MS);
  });
  // Tambien "incompleta" si una capa en linea visible no se pudo cargar.
  const wfsFailed = LAYERS.some((l) => l.wfs && layerVisible[l.id] && ["error", "zoom"].includes(wfsStatus[l.id].state));
  const incomplete = waitOutcome !== "idle" || wfsFailed;
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
  // propio color, y otra para su buffer si lo tiene (2026-09-25: el area
  // de afeccion tampoco salia en la leyenda).
  const uploadLegendRows = [];
  for (const u of uploadedLayers) {
    if (!u.visible) continue;
    const trackIds = [`${u.id}-fill`, `${u.id}-line`, `${u.id}-point`].filter((id) => map.getLayer(id));
    if (trackIds.length && map.queryRenderedFeatures({ layers: trackIds }).length > 0) {
      uploadLegendRows.push({
        fill: u.color,
        line: u.color,
        nombre: u.name.replace(/\.[^.]+$/, "").replace(/_+/g, " "),
        swatch: uploadSwatchType(u),
        lineWidthPx: u.lineWidth,
      });
    }
    if (u.bufferMeters > 0) {
      const bufferIds = [`${u.id}-buffer`, `${u.id}-buffer-line`].filter(
        (id) => map.getLayer(id) && map.getLayoutProperty(id, "visibility") !== "none"
      );
      if (bufferIds.length && map.queryRenderedFeatures({ layers: bufferIds }).length > 0) {
        uploadLegendRows.push({
          fill: u.color,
          line: u.color,
          nombre: `Buffer ${bufferLabel(u.bufferMeters)}`,
          swatch: "buffer",
          bufferStyle: u.bufferStyle,
          bufferOpacity: u.bufferOpacity,
        });
      }
    }
    // Buffers por capa del ultimo analisis (ver setAnalysisBuffers en
    // upload.js), uno por distancia, con las capas que lo usaron debajo.
    const ringLayerId = `${u.id}-analysis-buffers-line`;
    if (map.getLayer(ringLayerId)) {
      for (const ring of u.analysisBuffers || []) {
        const drawn = map.queryRenderedFeatures({ layers: [ringLayerId], filter: ["==", ["get", "meters"], ring.meters] });
        if (drawn.length === 0) continue;
        uploadLegendRows.push({
          fill: u.color,
          line: u.color,
          nombre: `Buffer de análisis ${bufferLabel(ring.meters)}`,
          subtitle: ring.layerNames.join(", "),
          swatch: "buffer",
          bufferStyle: "contorno",
          dotted: true,
        });
      }
    }
  }

  const grid = options.grid ? computeUtmGrid(mapW, mapH, dpr) : null;
  const mainCorners = [[0, 0], [mapW / dpr, 0], [mapW / dpr, mapH / dpr], [0, mapH / dpr]].map((p) => map.unproject(p));
  const mainCenter = map.getCenter();

  const dataUrl = map.getCanvas().toDataURL("image/png");

  // El inset se captura con los grosores de linea todavia escalados para
  // la exportacion (se restauran justo despues), asi los limites
  // administrativos salen con el mismo criterio de grosor fisico que el
  // mapa principal.
  const inset = options.inset ? await captureInset(px(INSET_MM.w), px(INSET_MM.h), dpr, mainCenter, mainCorners) : null;

  for (const [id, original] of restoreTextSizes) {
    map.setLayoutProperty(id, "text-size", original);
  }
  for (const [id, original] of restoreLineWidths) {
    map.setPaintProperty(id, "line-width", original);
  }

  mapEl.setAttribute("style", prevStyle);
  map.resize();
  map.jumpTo({ center: originalCenter, zoom: originalZoom, bearing: originalBearing, pitch: originalPitch });

  return { dataUrl, renderedLayerIds, renderedFieldValues, renderedNames, uploadLegendRows, grid, inset, incomplete };
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
        swatch: l.geom === "line" ? "line" : "fill",
        subtitle: legendNamesSubtitle(namesByVariant && namesByVariant.get("_all")),
      });
    }
  }
  return rows;
}

// Simbolo de una fila de leyenda: cuadrado relleno (poligono), trazo
// (linea), circulo (punto) o recuadro discontinuo/relleno (buffer, segun
// su estilo en upload.js) -- que el simbolo se parezca a lo que se ve en
// el mapa, como en cualquier leyenda cartografica.
function drawLegendSwatch(ctx, row, sx, sy, size) {
  ctx.save();
  const swatch = row.swatch || "fill";
  if (swatch === "line") {
    const w = row.lineWidthPx != null ? cssPxToOutputPx(row.lineWidthPx) : px(0.6);
    ctx.strokeStyle = row.line;
    ctx.lineWidth = Math.max(w, px(0.3));
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(sx, sy + size / 2);
    ctx.lineTo(sx + size, sy + size / 2);
    ctx.stroke();
  } else if (swatch === "point") {
    ctx.fillStyle = row.fill;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = px(0.4);
    ctx.beginPath();
    ctx.arc(sx + size / 2, sy + size / 2, size * 0.35, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else if (swatch === "buffer") {
    const hasFill = row.bufferStyle === "relleno" || row.bufferStyle === "ambos";
    const hasOutline = row.bufferStyle !== "relleno";
    if (hasFill) {
      ctx.globalAlpha = Math.max(row.bufferOpacity != null ? row.bufferOpacity : 0.3, 0.15);
      ctx.fillStyle = row.fill;
      ctx.fillRect(sx, sy, size, size);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = row.line;
    if (hasOutline && row.dotted) {
      // Punteado, igual que el trazo del buffer de analisis en el mapa.
      ctx.lineWidth = px(0.5);
      ctx.lineCap = "round";
      ctx.setLineDash([px(0.2), px(0.9)]);
    } else if (hasOutline) {
      ctx.lineWidth = px(0.5);
      ctx.setLineDash([px(1.2), px(0.8)]);
    } else {
      ctx.lineWidth = px(0.25);
    }
    ctx.strokeRect(sx, sy, size, size);
  } else {
    ctx.fillStyle = row.fill;
    ctx.fillRect(sx, sy, size, size);
    ctx.strokeStyle = row.line;
    ctx.lineWidth = px(0.25);
    ctx.strokeRect(sx, sy, size, size);
  }
  ctx.restore();
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

  const box = { x: x - boxPad, y: y - px(11), w: barPx + boxPad * 2 + px(20), h: px(20) };
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.88)";
  ctx.fillRect(box.x, box.y, box.w, box.h);

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
  return box;
}

// fillText con ancho maximo ESTRECHA el texto que no cabe, y con varios
// nombres largos quedaba ilegible (p. ej. "RAMBLA DE LAS CONTRAVIESAS,
// RAMBLA DE LOS RINCONES..." en el caso del puerto de Carboneras). Se
// tolera un estrechamiento leve; a partir de ahi se recorta con "…".
function fitLegendText(ctx, text, maxWidth) {
  const tolerance = 1.12;
  if (ctx.measureText(text).width <= maxWidth * tolerance) return text;
  let cut = text.replace(/…$/, "");
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth * tolerance) {
    cut = cut.slice(0, -1);
  }
  return `${cut.replace(/[\s,]+$/, "")}…`;
}

// Ancho de la leyenda segun su contenido, entre estos limites -- con un
// ancho fijo de 75 mm los nombres largos se estrechaban o se cortaban
// aunque sobrara sitio en el plano.
const LEGEND_MIN_W_MM = 60;
const LEGEND_MAX_W_MM = 100;

// legendRows: array ya construido (buildLegendRows para las capas
// ambientales, concatenado con las filas de los tramos/puntos subidos --
// ver generateCartography) para poder combinar ambas fuentes sin que
// drawLegend tenga que saber de donde viene cada fila.
// Devuelve { width, height } del recuadro dibujado.
function drawLegend(ctx, x, y, legendRows, maxHeight) {
  const titleSize = px(5.5);
  const rowTextSize = px(4);
  const subtitleTextSize = px(3.2);
  const swatchSize = px(4.5);
  const rowH = px(7.5);
  const subtitleH = px(4); // espacio extra solo para las filas que traen subtitle
  const padding = px(5);
  const titleBlockH = px(11);

  ctx.save();
  let widestText = 0;
  for (const row of legendRows) {
    ctx.font = `${rowTextSize}px Arial`;
    widestText = Math.max(widestText, ctx.measureText(row.nombre).width);
    if (row.subtitle) {
      ctx.font = `italic ${subtitleTextSize}px Arial`;
      widestText = Math.max(widestText, ctx.measureText(row.subtitle).width);
    }
  }
  ctx.restore();
  const width = Math.min(
    px(LEGEND_MAX_W_MM),
    Math.max(px(LEGEND_MIN_W_MM), padding * 2 + swatchSize + px(3) + widestText)
  );

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
    drawLegendSwatch(ctx, row, x + padding, rowY + (rowH - swatchSize) / 2, swatchSize);

    const textMaxW = width - padding * 2 - swatchSize - px(3);
    ctx.fillStyle = "#222";
    ctx.font = `${rowTextSize}px Arial`;
    ctx.fillText(
      fitLegendText(ctx, row.nombre, textMaxW),
      x + padding + swatchSize + px(3),
      rowY + (rowH - rowTextSize) / 2,
      textMaxW
    );
    if (row.subtitle) {
      ctx.fillStyle = "#666";
      ctx.font = `italic ${subtitleTextSize}px Arial`;
      ctx.fillText(fitLegendText(ctx, row.subtitle, textMaxW), x + padding + swatchSize + px(3), rowY + rowH, textMaxW);
    }
    rowY += thisRowH;
  }
  ctx.restore();
  return { width, height };
}

// Donde cruza una polilinea la recta eje=valor (axis 0: x, 1: y) --
// devuelve la otra coordenada, o null si no la cruza.
function polylineCrossing(line, axis, value) {
  const other = 1 - axis;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    if (a[axis] === b[axis]) continue;
    if ((a[axis] - value) * (b[axis] - value) <= 0) {
      const t = (value - a[axis]) / (b[axis] - a[axis]);
      return a[other] + (b[other] - a[other]) * t;
    }
  }
  return null;
}

// Lineas de la cuadricula UTM. Se dibujan ANTES que leyenda, flecha,
// escala e inset, para que estos queden por encima.
function drawUtmGridLines(ctx, grid, mapW, mapH) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, mapW, mapH);
  ctx.clip();
  const strokePolyline = (line) => {
    ctx.beginPath();
    line.forEach(([lx, ly], i) => (i ? ctx.lineTo(lx, ly) : ctx.moveTo(lx, ly)));
    ctx.stroke();
  };
  // Doble trazo (oscuro debajo, claro encima): legible tanto sobre
  // ortofoto como sobre mapa base claro.
  for (const pass of [{ color: "rgba(0,0,0,0.35)", width: px(0.45) }, { color: "rgba(255,255,255,0.85)", width: px(0.2) }]) {
    ctx.strokeStyle = pass.color;
    ctx.lineWidth = pass.width;
    for (const g of grid.eastings) strokePolyline(g.line);
    for (const g of grid.northings) strokePolyline(g.line);
  }
  ctx.restore();
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Rotulos de coordenadas en el borde del mapa (E arriba y abajo, N a
// izquierda y derecha). Se dibujan AL FINAL y se descarta cualquiera que
// choque con un recuadro (leyenda, flecha, escala, inset): si se dibujaran
// antes, quedarian medio tapados por esos recuadros -- visto en la primera
// prueba de esta funcion, con "4.479.000" cortado por la leyenda.
function drawUtmGridLabels(ctx, grid, mapW, mapH, avoidRects) {
  ctx.save();
  const fontSize = px(2.6);
  ctx.font = `${fontSize}px Arial`;
  ctx.fillStyle = "#182C54";
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineWidth = px(0.8);
  ctx.lineJoin = "round";
  const pad = px(0.8);
  const label = (text, lx, ly, align, baseline) => {
    const w = ctx.measureText(text).width;
    const x0 = align === "center" ? lx - w / 2 : align === "right" ? lx - w : lx;
    const y0 = baseline === "top" ? ly : baseline === "bottom" ? ly - fontSize : ly - fontSize / 2;
    const rect = { x: x0 - pad, y: y0 - pad, w: w + pad * 2, h: fontSize + pad * 2 };
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.w > mapW || rect.y + rect.h > mapH) return;
    if (avoidRects.some((r) => rectsIntersect(rect, r))) return;
    ctx.textAlign = align;
    ctx.textBaseline = baseline;
    ctx.strokeText(text, lx, ly);
    ctx.fillText(text, lx, ly);
  };
  const fmt = (v) => Math.round(v).toLocaleString("es-ES");
  const edge = px(1.2);
  for (const g of grid.eastings) {
    const top = polylineCrossing(g.line, 1, 0);
    const bottom = polylineCrossing(g.line, 1, mapH);
    if (top != null) label(fmt(g.value), top, edge, "center", "top");
    if (bottom != null) label(fmt(g.value), bottom, mapH - edge, "center", "bottom");
  }
  for (const g of grid.northings) {
    const left = polylineCrossing(g.line, 0, 0);
    const right = polylineCrossing(g.line, 0, mapW);
    if (left != null) label(fmt(g.value), edge, left, "left", "middle");
    if (right != null) label(fmt(g.value), mapW - edge, right, "right", "middle");
  }
  ctx.restore();
}

// Mapa de situacion: imagen del inset con un marco, la zona del mapa
// principal marcada en rojo (o un punto si a esta escala queda demasiado
// pequena para verse como recuadro) y el rotulo "Situación".
function drawInset(ctx, insetImg, inset, x, y) {
  const { w, h } = inset;
  ctx.save();
  ctx.fillStyle = "#fff";
  ctx.fillRect(x - px(1), y - px(1), w + px(2), h + px(2));
  ctx.drawImage(insetImg, x, y, w, h);
  ctx.strokeStyle = "#182C54";
  ctx.lineWidth = px(0.4);
  ctx.strokeRect(x, y, w, h);

  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  const pts = inset.extentPx.map(([ex, ey]) => [x + ex, y + ey]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const boxW = Math.max(...xs) - Math.min(...xs);
  const boxH = Math.max(...ys) - Math.min(...ys);
  ctx.strokeStyle = "#D50000";
  ctx.fillStyle = "rgba(213,0,0,0.25)";
  ctx.lineWidth = px(0.5);
  if (boxW < px(3) || boxH < px(3)) {
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
    const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    ctx.beginPath();
    ctx.arc(cx, cy, px(1.6), 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }

  const titleSize = px(3);
  ctx.font = `bold ${titleSize}px Arial`;
  const title = "Situación";
  const tw = ctx.measureText(title).width;
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.fillRect(x, y, tw + px(3), titleSize + px(2));
  ctx.fillStyle = "#182C54";
  ctx.textBaseline = "top";
  ctx.fillText(title, x + px(1.5), y + px(1));

  // Provincia y comunidad del proyecto, abajo a la izquierda (ver
  // findProvincia): la provincia va resaltada en el propio mapa.
  if (inset.label) {
    const labelSize = px(2.6);
    ctx.font = `${labelSize}px Arial`;
    const label = fitLegendText(ctx, inset.label, w - px(4));
    const lw = Math.min(ctx.measureText(label).width, w - px(4));
    const boxH = labelSize + px(2);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.fillRect(x, y + h - boxH, lw + px(3), boxH);
    ctx.fillStyle = "#182C54";
    ctx.fillText(label, x + px(1.5), y + h - boxH + px(1), w - px(4));
  }
  ctx.restore();
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

// crsText: sistema de referencia a mostrar en el cajetin -- el de la
// cuadricula UTM si se ha dibujado (ver computeUtmGrid), o el generico
// del proyecto si no.
async function drawCajetin(ctx, x, y, width, height, title, subtitle, crsText) {
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
  const fuente2 = crsText || "ETRS89 / EPSG:4326 (visor) · EPSG:25830 (QGIS)";
  ctx.fillText(fuente1, x + width - px(6), y + height * 0.38);
  ctx.fillText(fuente2, x + width - px(6), y + height * 0.62);
  ctx.restore();
}

// options: { grid: bool, inset: bool } -- checkboxes del modal de
// exportacion (ambos activados por defecto).
async function generateCartography(orientation, title, subtitle, scaleN, options = {}) {
  const totalMM = orientation === "horizontal"
    ? { w: A3_MM.w, h: A3_MM.h }
    : { w: A3_MM.h, h: A3_MM.w };

  const totalW = mmToPx(totalMM.w, EXPORT_DPI);
  const totalH = mmToPx(totalMM.h, EXPORT_DPI);
  const cajetinH = Math.round(totalH * CAJETIN_HEIGHT_RATIO);
  const mapH = totalH - cajetinH;
  const mapW = totalW;

  const { dataUrl, renderedLayerIds, renderedFieldValues, renderedNames, uploadLegendRows, grid, inset, incomplete } =
    await captureMapAtScale(scaleN, mapW, mapH, options);
  const mapImg = await loadImage(dataUrl);

  const canvas = document.createElement("canvas");
  canvas.width = totalW;
  canvas.height = totalH;
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, totalW, totalH);
  ctx.drawImage(mapImg, 0, 0, mapW, mapH);

  // Lineas de cuadricula primero (debajo de todo); sus rotulos al final,
  // evitando los recuadros (ver drawUtmGridLabels).
  if (grid) drawUtmGridLines(ctx, grid, mapW, mapH);

  const margin = px(8);
  const avoidRects = [];
  const visibleLayers = LAYERS.filter((l) => renderedLayerIds.has(l.id));
  // Filas de las capas ambientales + una por cada tramo/punto subido
  // visible con algo dibujado en esta vista (idea de Francisco,
  // 2026-09-24: la línea del proyecto no salía en la leyenda).
  const legendRows = buildLegendRows(visibleLayers, renderedFieldValues, renderedNames).concat(uploadLegendRows);
  const legendBox = drawLegend(ctx, margin, margin, legendRows, mapH - margin * 2);
  avoidRects.push({ x: margin, y: margin, w: legendBox.width, h: legendBox.height });

  const arrowSize = Math.round(totalW * 0.035);
  await drawNorthArrow(ctx, mapW - arrowSize - margin, margin, arrowSize);
  avoidRects.push({ x: mapW - arrowSize - margin, y: margin, w: arrowSize, h: arrowSize });

  avoidRects.push(drawScaleBar(ctx, margin, mapH - px(14), scaleN));

  if (inset) {
    const insetImg = await loadImage(inset.dataUrl);
    const ix = mapW - margin - inset.w;
    const iy = mapH - margin - inset.h;
    drawInset(ctx, insetImg, inset, ix, iy);
    avoidRects.push({ x: ix - px(1), y: iy - px(1), w: inset.w + px(2), h: inset.h + px(2) });
  }

  if (grid) drawUtmGridLabels(ctx, grid, mapW, mapH, avoidRects);

  await drawCajetin(ctx, 0, mapH, totalW, cajetinH, title, subtitle, grid ? grid.crsLabel : null);

  return { canvas, totalMM, incomplete };
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
const exportInsetCheck = document.getElementById("export-inset");
const exportGridCheck = document.getElementById("export-grid");
const exportDownloadReport = document.getElementById("export-download-report");
const exportReportNote = document.getElementById("export-report-note");

let lastExport = null; // { canvas, totalMM, meta: { title, subtitle, scaleN } }

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

  const options = { inset: exportInsetCheck.checked, grid: exportGridCheck.checked };

  exportOverlay.hidden = false;
  try {
    lastExport = await generateCartography(orientation, title, subtitle, scaleN, options);
    lastExport.meta = { title, subtitle, scaleN };
    exportPreview.src = lastExport.canvas.toDataURL("image/png");
    document.getElementById("export-incomplete-note").hidden = !lastExport.incomplete;
    // El informe junta cartografia + tabla de afecciones: sin analisis
    // previo no hay tabla que incluir, asi que se desactiva y se explica.
    // lastAnalysisResults vive en analysis.js (cargado despues), pero
    // esto solo se ejecuta al hacer clic, con todos los scripts ya
    // cargados.
    const hasAnalysis = typeof lastAnalysisResults !== "undefined" && lastAnalysisResults != null;
    exportDownloadReport.disabled = !hasAnalysis;
    exportReportNote.hidden = hasAnalysis;
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

// --- Informe PDF unico: cartografia + tabla de afecciones ---
//
// Un solo archivo para adjuntar al expediente en vez de tres (plano PNG/PDF
// + Excel + notas). Pagina 1: la cartografia A3 recien generada. Paginas
// siguientes (A4 apaisado): la tabla de afecciones del ultimo analisis,
// con el semaforo de sensibilidad coloreado, y las mismas notas de
// metodologia que la hoja "Info" del Excel. Tabla con jspdf-autotable
// (index.html) para que el texto quede seleccionable/buscable en el PDF,
// no como imagen.

function hexToRgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const REPORT_BLUE = hexToRgb("#182C54");
const REPORT_BAND = [242, 242, 242];

function buildReportPdf() {
  const { jsPDF } = window.jspdf;
  const { canvas, totalMM, meta } = lastExport;
  const { u, results } = lastAnalysisResults;
  const analysisMeta = lastAnalysisResults.meta || {};

  const pdf = new jsPDF({
    orientation: totalMM.w > totalMM.h ? "landscape" : "portrait",
    unit: "mm",
    format: [totalMM.w, totalMM.h],
  });
  // JPEG en vez de PNG: la ortofoto comprime mucho mejor asi y el informe
  // no pasa de ~15 MB a ~3 MB sin perdida apreciable a esta resolucion.
  pdf.addImage(canvas.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, totalMM.w, totalMM.h);

  pdf.addPage([297, 210], "landscape");
  const pageW = 297;
  const marginX = 12;

  pdf.setFont("helvetica", "bold");
  pdf.setFontSize(15);
  pdf.setTextColor(...REPORT_BLUE);
  pdf.text("Informe de afecciones ambientales", marginX, 16);

  pdf.setFont("helvetica", "normal");
  pdf.setFontSize(9);
  pdf.setTextColor(70, 70, 70);
  const proyecto = meta.subtitle ? `${meta.title} — ${meta.subtitle}` : meta.title;
  pdf.text(
    [
      `Proyecto: ${proyecto}`,
      `Tramo/punto analizado: ${u.name}  ·  Buffer por defecto: ${bufferLabel(u.bufferMeters)}  ·  Fecha: ${new Date().toLocaleDateString("es-ES")}`,
    ],
    marginX,
    23
  );

  // Resultado posiblemente incompleto (ver analyzeUploadedLayer): aviso
  // bien visible antes de la tabla, no solo en las notas del final.
  // Igual para una capa en linea que no se pudo consultar (serviceErrorsText
  // en analysis.js): queda sin resultado y tiene que verse antes de la tabla.
  let tableStartY = 32;
  const avisos = [];
  if (analysisMeta.incomplete) avisos.push(ANALYSIS_INCOMPLETE_NOTE);
  if (serviceErrorsText(analysisMeta)) avisos.push(serviceErrorsText(analysisMeta));
  if (avisos.length) {
    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(183, 28, 28);
    const lines = pdf.splitTextToSize(avisos.map((a) => `AVISO: ${a}`).join("\n"), pageW - marginX * 2);
    pdf.text(lines, marginX, 32);
    tableStartY = 32 + lines.length * 4 + 2;
  }

  const rows = resultsToRows(u, results);
  const body = rows.map((row) =>
    row.map((v) => {
      if (v === "" || v == null) return "-";
      if (typeof v === "number") return v.toLocaleString("es-ES");
      return String(v);
    })
  );

  const drawFooter = () => {
    const pageH = pdf.internal.pageSize.getHeight();
    const w = pdf.internal.pageSize.getWidth();
    pdf.setFont("helvetica", "normal");
    pdf.setFontSize(7.5);
    pdf.setTextColor(120, 120, 120);
    pdf.text("Quadrante · Geovisor Ambiental · Estimación de cribado, no sustituye el análisis en QGIS", marginX, pageH - 8);
    pdf.text(`Página ${pdf.internal.getNumberOfPages()}`, w - marginX, pageH - 8, { align: "right" });
  };

  if (body.length === 0) {
    pdf.setFontSize(10);
    pdf.setTextColor(70, 70, 70);
    pdf.text("Sin afecciones ni elementos cercanos detectados en el análisis.", marginX, tableStartY + 4);
    drawFooter();
  } else {
    pdf.autoTable({
      head: [RESULTS_HEADER],
      body,
      startY: tableStartY,
      margin: { left: marginX, right: marginX, bottom: 16 },
      styles: { fontSize: 7, cellPadding: 1.4, valign: "middle", lineColor: [220, 220, 220], lineWidth: 0.1 },
      headStyles: { fillColor: REPORT_BLUE, textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: REPORT_BAND },
      // 12 columnas en A4 apaisado (273 mm utiles): las de texto largo
      // (nombres y cercanos) con ancho fijo, el resto las reparte autoTable.
      columnStyles: {
        0: { cellWidth: 20, halign: "center" },
        1: { cellWidth: 10, halign: "center" },
        2: { cellWidth: 30 },
        3: { cellWidth: 24 },
        6: { cellWidth: 40 },
        9: { cellWidth: 52 },
      },
      didParseCell: (data) => {
        if (data.section !== "body" || data.column.index !== 0) return;
        const color = SENSITIVITY_COLOR[data.cell.raw];
        if (!color) return;
        data.cell.styles.fillColor = hexToRgb(color);
        data.cell.styles.textColor = 255;
        data.cell.styles.fontStyle = "bold";
      },
      didDrawPage: drawFooter,
    });
  }

  // Notas de metodologia -- mismo contenido que la hoja "Info" del Excel
  // (analysisNotes en analysis.js).
  const notes = analysisNotes(u, analysisMeta);
  let y = (pdf.lastAutoTable ? pdf.lastAutoTable.finalY : 40) + 8;
  const pageH = pdf.internal.pageSize.getHeight();
  const textW = pageW - marginX * 2 - 32;
  pdf.setFontSize(8);
  for (const [label, text] of notes) {
    const lines = pdf.splitTextToSize(text, textW);
    const blockH = lines.length * 3.6 + 1.5;
    if (y + blockH > pageH - 16) {
      pdf.addPage([297, 210], "landscape");
      drawFooter();
      y = 18;
    }
    pdf.setFont("helvetica", "bold");
    pdf.setTextColor(...REPORT_BLUE);
    pdf.text(label, marginX, y);
    pdf.setFont("helvetica", "normal");
    pdf.setTextColor(70, 70, 70);
    pdf.text(lines, marginX + 32, y);
    y += blockH;
  }

  return pdf;
}

exportDownloadReport.addEventListener("click", () => {
  if (!lastExport || typeof lastAnalysisResults === "undefined" || !lastAnalysisResults) return;
  try {
    const pdf = buildReportPdf();
    const base = lastAnalysisResults.u.name.replace(/\.[^.]+$/, "");
    pdf.save(`informe_afecciones_${base}.pdf`);
  } catch (e) {
    console.error(e);
    alert("Error generando el informe: " + e.message);
  }
});
