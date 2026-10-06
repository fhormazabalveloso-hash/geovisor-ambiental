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
// mide en cientos/miles de metros.
const NEAREST_SAMPLE_KM = 0.1;

// Cuantos elementos cercanos (fuera del buffer) se listan como mucho por
// capa. Antes solo se mostraba el mas cercano, y en el caso de prueba del
// puerto de Carboneras una ZEC marina a 1,1 km quedaba oculta detras del
// Islote de San Andres, a 500 m (ver
// investigacion/ejemplos-de-uso/caso-puerto-dique-carboneras.md §4.3).
const NEARBY_MAX_PER_LAYER = 5;

// Un elemento cercano se marca "al borde del buffer" si queda a menos de
// 50 m, o del 10 % del buffer de esa capa si es mayor, fuera de su borde
// (mismo caso de prueba, §4.4: la ZEC quedaba a 7 m del borde de un buffer
// de 500 m y nada lo destacaba).
function bufferEdgeThresholdM(bufferM) {
  return Math.max(50, bufferM * 0.1);
}

// Espera maxima a que el mapa cargue Y dibuje las capas antes de
// consultarlas (queryRenderedFeatures solo ve lo dibujado). Si se agota,
// el resultado se marca como posiblemente incompleto en vez de darlo por
// bueno en silencio (mismo caso de prueba, §4.1).
const ANALYSIS_IDLE_TIMEOUT_MS = 20000;

const ANALYSIS_INCOMPLETE_NOTE =
  "Puede que alguna capa no terminara de cargar a tiempo (conexión lenta) y falten elementos en este resultado. Repite el análisis antes de usarlo.";

// Hueco de datos conocido, visible en cada resultado: sin estas capas, un
// "sin afecciones" en una obra de costa o mar puede ser falta de dato
// (caso de prueba del puerto de Carboneras, §4.6).
const ANALYSIS_COVERAGE_NOTE =
  "El catálogo todavía no incluye el Dominio Público Marítimo-Terrestre (deslinde de Costas) ni hábitats marinos como la posidonia. En obras de costa o mar, que no salgan afecciones no las descarta.";

// Las zonas inundables del SNCZI (capas en linea, ver wfs-layers.js) solo
// existen donde se ha hecho el estudio: en la carretera de prueba de 58 km
// por Sierra Morena cruzaban 22 cauces con nombre y solo el Guadalquivir
// tenia zona inundable.
const ANALYSIS_FLOOD_COVERAGE_NOTE =
  "Las zonas inundables del SNCZI solo existen para los tramos de río y de costa estudiados (sobre todo las áreas de riesgo potencial significativo, ARPSI). Que un cauce no tenga zona inundable no significa que no sea inundable: puede que no se haya estudiado.";

function serviceErrorsText(meta) {
  if (!meta || !meta.serviceErrors || meta.serviceErrors.length === 0) return "";
  const capas = meta.serviceErrors.map((e) => `${e.nombre} (${e.error})`).join("; ");
  return `No se pudieron consultar estas capas: ${capas}. Quedan SIN RESULTADO, lo que no significa que no haya afección. Repite el análisis más tarde.`;
}

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

// --- Longitud de una linea (rio, via pecuaria) dentro del buffer ---
//
// Exacta en la proyeccion local en metros (ver buildDistanceContext): para
// cada segmento se buscan los puntos donde cruza el borde del buffer y se
// suman los trozos que quedan dentro. Antes se partia la linea en trozos de
// 10 m con Turf y se comprobaba el punto medio de cada uno; en la carretera
// de prueba de 58 km por Sierra Morena eso eran 18 s de los ~24 del analisis
// (tramos de rio de decenas de km en las teselas de zoom bajo), y ademas
// redondeaba a multiplos de 10 m.

// Anillos del poligono ya proyectados, una vez por buffer (se reutiliza
// para todas las lineas de la capa).
const projectedPolygonCache = new WeakMap();

function projectPolygon(ctx, polygonFeature) {
  const cached = projectedPolygonCache.get(polygonFeature);
  if (cached && cached.project === ctx.project) return cached;
  const rings = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const part of turf.flatten(polygonFeature).features) {
    if (!part.geometry || part.geometry.type !== "Polygon") continue;
    for (const ring of part.geometry.coordinates) {
      const pr = ring.map(ctx.project);
      for (const [x, y] of pr) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      rings.push(pr);
    }
  }
  const result = { project: ctx.project, rings, bbox: [minX, minY, maxX, maxY] };
  projectedPolygonCache.set(polygonFeature, result);
  return result;
}

// Regla par-impar sobre todos los anillos: vale para huecos y para las
// partes de un MultiPolygon, que en un buffer unificado no se solapan.
function pointInRings(x, y, rings) {
  let inside = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

// Parametros t (0-1) del segmento A-B donde cruza algun borde de los anillos.
function segmentCrossings(ax, ay, bx, by, rings, out) {
  const sMinX = Math.min(ax, bx), sMaxX = Math.max(ax, bx);
  const sMinY = Math.min(ay, by), sMaxY = Math.max(ay, by);
  const rx = bx - ax, ry = by - ay;
  for (const ring of rings) {
    for (let i = 1; i < ring.length; i++) {
      const [cx, cy] = ring[i - 1];
      const [dx, dy] = ring[i];
      if (Math.max(cx, dx) < sMinX || Math.min(cx, dx) > sMaxX || Math.max(cy, dy) < sMinY || Math.min(cy, dy) > sMaxY) continue;
      const sx = dx - cx, sy = dy - cy;
      const den = rx * sy - ry * sx;
      if (den === 0) continue;
      const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
      const v = ((cx - ax) * ry - (cy - ay) * rx) / den;
      if (t > 0 && t < 1 && v >= 0 && v <= 1) out.push(t);
    }
  }
}

function lineLengthInsidePolygonMeters(ctx, lineFeature, polygonFeature) {
  const poly = projectPolygon(ctx, polygonFeature);
  const [pMinX, pMinY, pMaxX, pMaxY] = poly.bbox;
  let total = 0;
  for (const part of turf.flatten(lineFeature).features) {
    if (!part.geometry || part.geometry.type !== "LineString") continue;
    const pts = part.geometry.coordinates.map(ctx.project);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1];
      const [bx, by] = pts[i];
      if (Math.max(ax, bx) < pMinX || Math.min(ax, bx) > pMaxX || Math.max(ay, by) < pMinY || Math.min(ay, by) > pMaxY) continue;
      const segLen = Math.hypot(bx - ax, by - ay);
      if (segLen === 0) continue;
      const ts = [0, 1];
      segmentCrossings(ax, ay, bx, by, poly.rings, ts);
      ts.sort((a, b) => a - b);
      for (let k = 1; k < ts.length; k++) {
        const t0 = ts[k - 1], t1 = ts[k];
        if (t1 <= t0) continue;
        const tm = (t0 + t1) / 2;
        if (pointInRings(ax + tm * (bx - ax), ay + tm * (by - ay), poly.rings)) total += (t1 - t0) * segLen;
      }
    }
  }
  return total;
}

function polygonIntersection(envFeature, bufferFeature) {
  try {
    return turf.intersect(envFeature, bufferFeature);
  } catch (e) {
    return null;
  }
}

// Superficie de la UNION de los trozos que caen dentro del buffer, no la
// suma: una misma zona puede tener varias figuras a la vez en la misma
// capa (p. ej. en ENP el Parque Natural y la ZEC de Cabo de Gata-Nijar
// tienen la misma geometria) y sumarlas duplicaba las hectareas (caso de
// prueba del puerto de Carboneras, §4.7). Si una union falla, ese trozo
// se suma aparte: mejor pasarse un poco que perder superficie en silencio.
function unionAreaHectares(pieces) {
  if (pieces.length === 0) return 0;
  let acc = pieces[0];
  let extraM2 = 0;
  for (let i = 1; i < pieces.length; i++) {
    try {
      const u = turf.union(acc, pieces[i]);
      if (u) acc = u;
      else extraM2 += turf.area(pieces[i]);
    } catch (e) {
      extraM2 += turf.area(pieces[i]);
    }
  }
  return (turf.area(acc) + extraM2) / 10000;
}

// Nombre limpio de un elemento ("" si no tiene o es un marcador tipo
// "sin nombre").
function featureName(layer, f) {
  if (!layer.labelField) return "";
  const raw = f.properties[layer.labelField];
  const clean = raw == null ? "" : String(raw).trim();
  return ANALYSIS_PLACEHOLDER_NAMES.has(clean.toLowerCase()) ? "" : clean;
}

// Clave para agrupar fragmentos de un mismo elemento al listar los
// cercanos: primero el nombre, porque es lo que se muestra y porque un
// mismo rio viene partido en muchos tramos con distinto OBJECTID; si no
// hay nombre, el idField de la capa. null si no hay ninguno de los dos.
function entityKey(layer, f) {
  const name = featureName(layer, f);
  if (name) return `n:${name}`;
  if (layer.idField && f.properties[layer.idField] != null) return `i:${f.properties[layer.idField]}`;
  return null;
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

// --- Distancia del trazado a un elemento cercano ---
//
// Se mide en una proyeccion local en metros (equirectangular centrada en el
// tramo), no con las funciones geodesicas de Turf: a estas distancias (hasta
// unos pocos km) el error es inferior al 0,5 %, y es muchisimo mas rapido.
// Con turf.pointToLineDistance, una carretera de 58 km por Sierra Morena
// (590 puntos muestreados contra todos los elementos de la vista) tardaba
// 156 s con la pagina congelada.
const METERS_PER_DEGREE = 111320;

// Puntos muestreados del trazado ya proyectados, una vez por analisis.
function buildDistanceContext(samplePoints) {
  const lat0 = samplePoints.reduce((s, p) => s + p.geometry.coordinates[1], 0) / samplePoints.length;
  const kx = METERS_PER_DEGREE * Math.cos((lat0 * Math.PI) / 180);
  const project = (c) => [c[0] * kx, c[1] * METERS_PER_DEGREE];
  return { project, xy: samplePoints.map((p) => project(p.geometry.coordinates)) };
}

function pointSegmentDist2(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const ex = ax + t * dx - px;
  const ey = ay + t * dy - py;
  return ex * ex + ey * ey;
}

// Distancia minima (metros) entre los puntos muestreados del trazado y el
// borde de una feature (poligono, linea o punto), o Infinity si queda a
// mas de limitM. Aproximada por muestreo -- coherente con el resto de la
// metodologia de cribado del proyecto (ver cabecera del fichero).
//
// Para no calcular la distancia exacta desde todos los puntos del trazado,
// primero se acota con la distancia de cada punto al rectangulo envolvente
// de la feature (cota inferior barata), y solo se calcula la exacta en los
// puntos que aun pueden mejorar el minimo, de mas cerca a mas lejos.
//
// turf.flatten deja solo geometrias simples: un MultiPolygon con huecos
// daba antes MultiLineString, que turf.pointToLineDistance no acepta, y el
// error abortaba el analisis entero (misma carretera de prueba).
function minDistanceMetersToFeature(ctx, feature, limitM = Infinity) {
  return minDistanceInfo(ctx, feature, limitM).distanceM;
}

// Igual, pero dice ademas desde que punto muestreado del trazado (indice en
// ctx.xy), para saber a que tramo queda mas cerca (ctx.tramoOf).
function minDistanceInfo(ctx, feature, limitM = Infinity) {
  const paths = [];
  const points = [];
  for (const part of turf.flatten(feature).features) {
    const g = part.geometry;
    if (!g) continue;
    if (g.type === "Point") points.push(ctx.project(g.coordinates));
    else if (g.type === "LineString") paths.push(g.coordinates.map(ctx.project));
    else if (g.type === "Polygon") for (const ring of g.coordinates) paths.push(ring.map(ctx.project));
  }
  if (paths.length === 0 && points.length === 0) return { distanceM: Infinity, sampleIdx: -1 };

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const extend = ([x, y]) => {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  points.forEach(extend);
  paths.forEach((path) => path.forEach(extend));

  const candidates = [];
  ctx.xy.forEach(([x, y], k) => {
    const dx = Math.max(minX - x, 0, x - maxX);
    const dy = Math.max(minY - y, 0, y - maxY);
    const bound = Math.hypot(dx, dy);
    if (bound <= limitM) candidates.push([bound, x, y, k]);
  });
  candidates.sort((a, b) => a[0] - b[0]);

  let best2 = Infinity;
  let bestIdx = -1;
  for (const [bound, x, y, k] of candidates) {
    if (bound * bound >= best2) break;
    for (const [qx, qy] of points) {
      const d2 = (qx - x) ** 2 + (qy - y) ** 2;
      if (d2 < best2) { best2 = d2; bestIdx = k; }
    }
    for (const path of paths) {
      for (let i = 1; i < path.length; i++) {
        const d2 = pointSegmentDist2(x, y, path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
        if (d2 < best2) { best2 = d2; bestIdx = k; }
      }
    }
  }
  const best = Math.sqrt(best2);
  return best <= limitM ? { distanceM: best, sampleIdx: bestIdx } : { distanceM: Infinity, sampleIdx: -1 };
}

// --- Semaforo de sensibilidad (rediseno del 2026-09-29) ---
//
// Tres preguntas, cada una con una respuesta que se puede explicar:
//   1. ¿Que importancia tiene el elemento? (l.importancia en layers.js,
//      segun su regimen legal)
//   2. ¿Como lo toca la obra?
//      - directa: la obra en si (el trazado o la huella subida) lo pisa
//      - roce: lo pisa, pero tan poco que puede deberse a la precision del
//        dato (~10 m) -- se trata como "en el entorno" y se marca "a verificar"
//      - entorno: esta dentro del buffer, pero la obra no lo pisa
//      - proxima: fuera del buffer, a menos de NEAREST_SEARCH_MARGIN_M
//   3. Sensibilidad = importancia x como lo toca (ver sensitivityFor):
//
//                 Directa     Entorno/roce   Proxima
//        Alta     Muy Alta    Alta           Media
//        Media    Alta        Media          Baja
//        Baja     Media       Baja           Baja
//
// El "cuanto" (ha, m, % del espacio) no cambia el color salvo en el roce:
// no hay umbrales legales de superficie para un cribado, y ponerlos seria
// inventarlos. Siempre se muestra, en la explicacion de cada resultado.
// Antes: un nivel fijo por capa con dos ajustes (cercano -1, Red Natura
// ZEC+ZEPA +1), que no distinguia pisar el elemento de tenerlo en el buffer
// y no se entendia (README §2 2026-09-29).

// Por debajo de esto, un contacto directo se considera "roce, a verificar":
// del orden de la precision del dato (~10 m en las capas en linea,
// simplificacion de las teselas en las locales).
const DIRECT_MIN_M = 25;
const DIRECT_MIN_HA = 0.1;

// "borde": fuera del buffer pero al borde (bufferEdgeThresholdM: menos de
// 50 m o del 10 % del buffer). Simetrico al roce: tan cerca que la
// diferencia puede ser precision del dato, asi que cuenta como en el
// entorno y se marca "a verificar" (prueba completa del 2026-10-01: el
// Islote de San Andres, a 7 m del borde de un buffer de 500 m, salia
// "Media, proximo" y se perdia el aviso de "al borde" que ya habia).
const AFECCION_LABEL = {
  directa: "Directa",
  roce: "Roce (a verificar)",
  entorno: "En el entorno",
  borde: "Al borde del buffer (a verificar)",
  proxima: "Próxima",
};

function sensitivityFor(importancia, afeccion) {
  let idx = IMPORTANCIA_LEVELS.indexOf(importancia);
  if (idx === -1) idx = IMPORTANCIA_LEVELS.indexOf("Media");
  // Los indices de IMPORTANCIA_LEVELS (Baja 0, Media 1, Alta 2) coinciden con
  // los de SENSITIVITY_LEVELS para "en el entorno" (y roce y borde); directa
  // sube uno y proxima baja uno.
  const shift = afeccion === "directa" ? 1 : afeccion === "proxima" ? -1 : 0;
  return SENSITIVITY_LEVELS[Math.max(0, Math.min(SENSITIVITY_LEVELS.length - 1, idx + shift))];
}

function formatHa(ha) {
  return ha.toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function bboxOverlap(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

// "¿Toca f este poligono?" rapido para poligonos de muchas partes (el buffer
// de varios tramos separados). turf.booleanIntersects contra el poligono
// entero era el 70 % del tiempo del analisis (57 de 81 s) en una oferta de
// 16 tramos de cerramiento repartidos en ~100 km (prueba del 2026-10-01):
// cada elemento de la vista se comparaba con las 16 partes a la vez, aunque
// estuviera a 50 km de todas. Ahora se descarta primero por rectangulo
// envolvente y solo se compara con las partes cercanas.
function makeIntersector(polygonFeature) {
  const parts = turf.flatten(polygonFeature).features
    .filter((p) => p.geometry)
    .map((p) => ({ feature: p, bbox: turf.bbox(p) }));
  return (f) => {
    const fb = turf.bbox(f);
    return parts.some((p) => bboxOverlap(fb, p.bbox) && turf.booleanIntersects(f, p.feature));
  };
}

// Partes simples de la geometria subida, separadas por tipo, una vez por
// analisis.
function trazadoParts(geojson) {
  const parts = turf.flatten(geojson).features.filter((f) => f.geometry);
  return {
    all: parts,
    touches: makeIntersector({ type: "FeatureCollection", features: parts }),
    lines: parts.filter((f) => f.geometry.type === "LineString"),
    polys: parts.filter((f) => f.geometry.type === "Polygon"),
    points: parts.filter((f) => f.geometry.type === "Point"),
  };
}

// Contacto de la OBRA (no del buffer) con los elementos de una capa que ya
// se sabe que caen en el buffer. Devuelve null si la obra no toca ninguno,
// o { kind: "directa"|"roce", names, text } con el "cuanto" del contacto:
// - capa de poligonos: metros de trazado dentro, ha de la huella dentro o
//   puntos de la obra dentro (medido sobre la union de los elementos
//   tocados, para no contar dos veces figuras solapadas);
// - capa de lineas: veces que la obra cruza el elemento, o metros del
//   elemento dentro de la huella.
function directContactForLayer(l, entities, traz, ctx) {
  return contactFromMeasures(directContactMeasures(l, entities, traz, ctx));
}

// Las medidas del contacto, sin redactar: con el analisis por tramo se miden
// por separado en cada vista (ver planAnalysisViews) y se suman antes de
// escribir el texto (mergeContactMeasures).
function directContactMeasures(l, entities, traz, ctx) {
  const touching = entities.filter((e) => traz.touches(e.feature));
  if (touching.length === 0) return null;
  const m = {
    polygonLayer: l.geom === "polygon",
    names: new Set(touching.map((e) => e.name).filter(Boolean)),
    pointsInside: 0, lineM: 0, polyHa: 0, crossings: new Set(), elemM: 0,
  };
  if (m.polygonLayer) {
    const union = unionFeatureGroup(touching.map((e) => e.feature));
    m.pointsInside = traz.points.filter((p) => turf.booleanPointInPolygon(p, union)).length;
    m.lineM = traz.lines.reduce((s, ln) => s + lineLengthInsidePolygonMeters(ctx, ln, union), 0);
    m.polyHa = traz.polys.reduce((s, pg) => {
      const inter = polygonIntersection(pg, union);
      return s + (inter ? turf.area(inter) / 10000 : 0);
    }, 0);
  } else {
    // Cruces deduplicados por posicion (~1 m): un mismo cauce puede venir en
    // dos fragmentos solapados en el borde de una tesela.
    for (const e of touching) {
      for (const ln of traz.lines) {
        for (const pt of turf.lineIntersect(e.feature, ln).features) {
          m.crossings.add(pt.geometry.coordinates.map((c) => c.toFixed(5)).join(","));
        }
      }
      for (const pg of traz.polys) m.elemM += lineLengthInsidePolygonMeters(ctx, e.feature, pg);
    }
  }
  return m;
}

function mergeContactMeasures(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    polygonLayer: a.polygonLayer,
    names: new Set([...a.names, ...b.names]),
    pointsInside: a.pointsInside + b.pointsInside,
    lineM: a.lineM + b.lineM,
    polyHa: a.polyHa + b.polyHa,
    crossings: new Set([...a.crossings, ...b.crossings]),
    elemM: a.elemM + b.elemM,
  };
}

function contactFromMeasures(m) {
  if (!m) return null;
  const parts = [];
  let isDirect = false;
  if (m.polygonLayer) {
    if (m.pointsInside > 0) {
      isDirect = true;
      parts.push(m.pointsInside === 1 ? "el punto de la obra cae dentro" : `${m.pointsInside} puntos de la obra caen dentro`);
    }
    if (m.lineM > 0) {
      if (m.lineM >= DIRECT_MIN_M) isDirect = true;
      parts.push(`${formatMeters(m.lineM)} m de trazado dentro`);
    }
    if (m.polyHa > 0) {
      if (m.polyHa >= DIRECT_MIN_HA) isDirect = true;
      parts.push(`${formatHa(m.polyHa)} ha de la obra dentro`);
    }
  } else {
    if (m.crossings.size > 0) {
      isDirect = true;
      parts.push(m.crossings.size === 1 ? "la obra lo cruza 1 vez" : `la obra lo cruza ${m.crossings.size} veces`);
    }
    if (m.elemM > 0) {
      if (m.elemM >= DIRECT_MIN_M) isDirect = true;
      parts.push(`${formatMeters(m.elemM)} m dentro de la obra`);
    }
  }
  if (parts.length === 0) parts.push("toca su borde");
  return { kind: isDirect ? "directa" : "roce", names: [...m.names].sort(), text: parts.join(" · ") };
}

// La explicacion de un resultado, en una frase: sensibilidad, por que
// (importancia y como lo toca) y cuanto.
function sensitivityReason(r) {
  const imp = `importancia ${r.importancia.toLowerCase()} (${r.layer.importanciaMotivo})`;
  let how;
  if (r.afeccion === "directa") how = `la obra lo pisa: ${r.contact.text}`;
  else if (r.afeccion === "roce") how = `roce con la obra (${r.contact.text}), a verificar: puede deberse a la precisión del dato`;
  else if (r.afeccion === "entorno") how = `en el entorno: dentro del buffer de ${bufferLabel(r.bufferM)}, la obra no lo pisa`;
  else if (r.afeccion === "borde") how = `al borde del buffer: ${r.nearby[0].name || "un elemento"} a ${formatMeters(r.nearestM)} m del trazado, solo ${formatMeters(r.nearby[0].edgeM)} m fuera del buffer de ${bufferLabel(r.bufferM)}; se trata como dentro, a verificar`;
  else how = `próximo: a ${formatMeters(r.nearestM)} m del trazado, fuera del buffer de ${bufferLabel(r.bufferM)}`;
  let cuanto = "";
  if (r.count > 0 && r.totalHa > 0) cuanto = `${formatHa(r.totalHa)} ha dentro del buffer${r.pctText ? ` (${r.pctText})` : ""}`;
  else if (r.count > 0 && r.totalM > 0) cuanto = `${formatMeters(r.totalM)} m dentro del buffer`;
  return `${r.sensitivity}: ${[imp, how, cuanto].filter(Boolean).join(" · ")}`;
}

// --- Vistas del analisis (analisis por tramo, rama avanzado, 2026-10-02) ---
//
// queryRenderedFeatures solo ve lo dibujado, al zoom de la vista. Con todo el
// archivo en una sola vista, la oferta real de 16 tramos repartidos en ~100 km
// se analizaba a zoom 8,8: geometria simplificada a unos 30 m, cuando el
// umbral de roce es de 25 m. Ahora los tramos se agrupan en vistas que quepan
// a zoom >= ANALYSIS_VIEW_MIN_ZOOM (geometria a ~4 m) y cada vista se dibuja y
// se consulta por separado.
//
// Para no contar nada dos veces al sumar, los tramos cuyos buffers se tocan
// van siempre en la misma vista: asi los buffers de vistas distintas no se
// solapan y las hectareas y los metros de cada vista se pueden sumar. Un
// tramo que no cabe a ese zoom (la carretera de prueba de 58 km) se analiza
// en una sola vista, como antes.
const ANALYSIS_VIEW_MIN_ZOOM = 11;

function expandBboxMeters(b, m) {
  const lat = (b[1] + b[3]) / 2;
  const dLat = m / METERS_PER_DEGREE;
  const dLon = m / (METERS_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat];
}

function bboxUnion(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
}

// Zoom al que fitBounds dejaria ese rectangulo (mismo padding que el analisis).
function zoomForBbox(b) {
  const cam = map.cameraForBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 60, maxZoom: 17 });
  return cam && typeof cam.zoom === "number" ? cam.zoom : 0;
}

// Grupos de tramos (indices de `tramos`) que se analizan juntos, en el orden
// del archivo.
function planAnalysisViews(tramos, maxBufferM) {
  if (tramos.length === 1) return [[0]];
  // 1. Inseparables: tramos cuyos buffers (el mayor de todas las capas) se tocan.
  const parent = tramos.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const buffers = tramos.map((t) => computeUnifiedBufferPolygon(t.geojson, maxBufferM));
  const bufferBboxes = buffers.map((b, i) => (b ? turf.bbox(b) : expandBboxMeters(turf.bbox(tramos[i].geojson), maxBufferM)));
  for (let i = 0; i < tramos.length; i++) {
    for (let j = i + 1; j < tramos.length; j++) {
      if (find(i) === find(j) || !bboxOverlap(bufferBboxes[i], bufferBboxes[j])) continue;
      // Sin buffer calculable no se puede comprobar: mejor juntarlos.
      if (!buffers[i] || !buffers[j] || turf.booleanIntersects(buffers[i], buffers[j])) parent[find(j)] = find(i);
    }
  }
  const groups = new Map();
  tramos.forEach((_, i) => {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  });

  // 2. Se juntan grupos en una misma vista mientras quepan a ANALYSIS_VIEW_MIN_ZOOM.
  const searchBboxes = tramos.map((t) => expandBboxMeters(turf.bbox(t.geojson), maxBufferM + NEAREST_SEARCH_MARGIN_M));
  const views = [];
  for (const g of groups.values()) {
    const gb = g.map((i) => searchBboxes[i]).reduce(bboxUnion);
    const target = views.find((v) => zoomForBbox(bboxUnion(v.bbox, gb)) >= ANALYSIS_VIEW_MIN_ZOOM);
    if (target) {
      target.idx.push(...g);
      target.bbox = bboxUnion(target.bbox, gb);
    } else {
      views.push({ idx: [...g], bbox: gb });
    }
  }
  return views.map((v) => v.idx.sort((a, b) => a - b));
}

// Puntos muestreados de los tramos de una vista, sabiendo de que tramo es
// cada uno (ctx.tramoOf), para decir a que tramo queda mas cerca un elemento.
function buildViewDistanceContext(tramos, idxs) {
  const pts = [];
  const tramoOf = [];
  for (const i of idxs) {
    const s = sampleTrazadoPoints(tramos[i].geojson, NEAREST_SAMPLE_KM);
    for (const p of s) {
      pts.push(p);
      tramoOf.push(i);
    }
  }
  const ctx = buildDistanceContext(pts);
  ctx.tramoOf = tramoOf;
  return ctx;
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
  const overlayText = document.getElementById("analysis-overlay-text");
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

    // La obra es el archivo sin las marcas de PK (tramos.js); con un solo
    // tramo, el archivo entero como siempre.
    const { obra, tramos, markers } = u.tramoSplit;
    const multi = tramos.length > 1;

    const globalBufferPolygon = unifyBuffer(u.bufferGeojson);
    if (!globalBufferPolygon) throw new Error("No se pudo calcular el buffer.");

    // Cada vista se encuadra a su mayor buffer efectivo + el margen de
    // busqueda de "elemento mas cercano" (NEAREST_SEARCH_MARGIN_M) -- si no,
    // esas teselas ni siquiera se renderizan y queryRenderedFeatures no puede
    // encontrar nada fuera del buffer normal.
    const maxBufferM = Math.max(u.bufferMeters, ...Object.values(effectiveBufferM));
    const views = planAnalysisViews(tramos, maxBufferM);

    // Se fuerzan temporalmente visibles las capas a analizar -- MapLibre
    // solo tiene datos consultables (renderizados) para capas visibles,
    // asi que se restaura el estado original al terminar.
    const prevVisible = {};
    for (const l of targetLayers) {
      prevVisible[l.id] = layerVisible[l.id];
      if (!layerVisible[l.id] && !layerUnavailable[l.id]) setLayerVisible(l, true);
    }

    // Lo medido en cada vista, acumulado por capa.
    const acc = {};
    for (const l of targetLayers) {
      acc[l.id] = {
        entities: [], pieces: [], totalM: 0, names: new Set(), measures: null,
        nearbyByKey: new Map(), intersectingKeys: new Set(), tramoHits: new Map(),
        serviceError: null, truncated: false,
      };
    }
    let incomplete = false;

    for (let vi = 0; vi < views.length; vi++) {
      const idxs = views[vi];
      overlayText.textContent = views.length > 1 ? `Analizando afecciones… (zona ${vi + 1} de ${views.length})` : "Analizando afecciones…";
      const viewGeojson = views.length === 1 ? obra : { type: "FeatureCollection", features: idxs.flatMap((i) => tramos[i].geojson.features) };

      const searchPolygon = computeUnifiedBufferPolygon(viewGeojson, maxBufferM + NEAREST_SEARCH_MARGIN_M);
      if (!searchPolygon) throw new Error("No se pudo calcular el area de busqueda.");
      const searchBbox = turf.bbox(searchPolygon);
      map.fitBounds([[searchBbox[0], searchBbox[1]], [searchBbox[2], searchBbox[3]]], {
        padding: 60,
        animate: false,
        maxZoom: 17,
      });

      // Capas en linea (zonas inundables, ver wfs-layers.js): se piden al
      // servicio para el area de busqueda de la vista, en paralelo con la
      // espera de abajo. No dependen de lo dibujado, asi que no les afecta el
      // tope de espera; si el servicio falla, la capa queda marcada como SIN
      // RESULTADO, nunca como "sin afecciones".
      const wfsResults = {};
      const wfsPromise = Promise.all(
        targetLayers.filter((l) => l.wfs).map(async (l) => {
          try {
            const r = await fetchWfsFeatures(l, searchBbox);
            storeWfsFeatures(l, r.features);
            wfsResults[l.id] = { features: r.features, truncated: r.truncated, error: null };
          } catch (e) {
            console.warn(`Capa en línea ${l.id}:`, e);
            wfsResults[l.id] = { features: [], truncated: false, error: `servicio en línea de MITECO: ${e.message}` };
          }
        })
      );

      // triggerRepaint: sin cambios de camara ni de capas no habria fotograma
      // nuevo y "idle" no volveria a dispararse, y se agotaria el tope aunque
      // todo estuviera ya dibujado.
      map.triggerRepaint();
      const waitOutcome = await new Promise((resolve) => {
        map.once("idle", () => resolve("idle"));
        setTimeout(() => resolve("timeout"), ANALYSIS_IDLE_TIMEOUT_MS);
      });
      // Tope agotado = alguna capa puede no estar dibujada todavia, y saldria
      // vacia. Antes (tope de 8 s, sin aviso) dos pasadas iguales llegaron a
      // dar resultados distintos (caso de prueba del puerto de Carboneras,
      // §4.1) -- ahora se avisa en el modal, el Excel y el informe.
      if (waitOutcome !== "idle") incomplete = true;
      await wfsPromise;

      const distCtx = buildViewDistanceContext(tramos, idxs);
      const traz = trazadoParts(viewGeojson);
      const tramoTraz = multi ? new Map(idxs.map((i) => [i, trazadoParts(tramos[i].geojson)])) : null;
      const bufferCache = new Map(views.length === 1 ? [[u.bufferMeters, globalBufferPolygon]] : []);
      const tramoIntersectors = new Map();

      for (const l of targetLayers) {
        const a = acc[l.id];
        const layerBufferM = effectiveBufferM[l.id];
        if (!bufferCache.has(layerBufferM)) bufferCache.set(layerBufferM, computeUnifiedBufferPolygon(viewGeojson, layerBufferM));
        const bufferPolygon = bufferCache.get(layerBufferM);

        // Archivo de la capa que no se pudo cargar (main.js): SIN RESULTADO,
        // igual que una capa en linea cuyo servicio no responde -- nunca
        // "sin afecciones".
        if (layerUnavailable[l.id]) {
          a.serviceError = "no se pudo cargar su archivo de datos";
          continue;
        }
        const wfsResult = l.wfs ? wfsResults[l.id] : null;
        if (wfsResult) {
          if (wfsResult.error) a.serviceError = wfsResult.error;
          if (wfsResult.truncated) a.truncated = true;
        }
        const idsToCheck = l.geom === "polygon" ? [`${l.id}-fill`] : [`${l.id}-line`];
        const existing = bufferPolygon ? idsToCheck.filter((id) => map.getLayer(id)) : [];
        if (!existing.length) continue;

        const feats = wfsResult ? wfsResult.features : map.queryRenderedFeatures(undefined, { layers: existing });
        const touchesBuffer = makeIntersector(bufferPolygon);
        const intersecting = feats.filter((f) => f.geometry && touchesBuffer(f));

        // Elementos que caen en el buffer: { feature, name, props, bufferHa, key }.
        // Sirven para la superficie, los nombres, el % del espacio y el
        // contacto directo con la obra (directContactMeasures). key: el id de
        // la entidad si la capa lo tiene, para contarla una sola vez aunque
        // salga en varias vistas.
        const entities = [];
        const addEntity = (feature, props, key = null) => {
          const name = featureName(l, { properties: props });
          if (name) a.names.add(name);
          entities.push({ feature, name, props, bufferHa: 0, key });
        };
        // Trozos de cada elemento dentro del buffer; la superficie se mide
        // al final sobre su union (ver unionAreaHectares).
        const addPiece = (f) => {
          const piece = polygonIntersection(f, bufferPolygon);
          if (piece) {
            a.pieces.push(piece);
            entities[entities.length - 1].bufferHa = turf.area(piece) / 10000;
          }
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
          for (const [key, group] of groups) {
            const merged = unionFeatureGroup(group);
            addEntity(merged, group[0].properties, key);
            addPiece(merged);
          }
          // Fragmentos sin id legible (dato de origen incompleto): se
          // cuentan por separado -- caso raro, no el camino normal. La
          // union final evita al menos que su superficie se sume dos veces.
          for (const f of noId) {
            addEntity(f, f.properties);
            addPiece(f);
          }
        } else {
          // Capas de linea, o poligonos sin idField fiable (ver
          // layers.js): se cuenta fragmento a fragmento como antes. Para
          // lineas el riesgo de doble conteo por margen de tesela es
          // pequeno (solo el tramo solapado en el borde, no la entidad
          // completa); en poligonos la union final lo elimina en la
          // superficie, aunque el numero de elementos siga siendo aproximado.
          for (const f of intersecting) {
            addEntity(f, f.properties);
            if (l.geom === "polygon") {
              addPiece(f);
            } else {
              a.totalM += lineLengthInsidePolygonMeters(distCtx, f, bufferPolygon);
            }
          }
        }
        a.entities.push(...entities);

        // ¿La obra en si pisa algo? (no solo el buffer)
        a.measures = mergeContactMeasures(a.measures, directContactMeasures(l, entities, traz, distCtx));

        // En que tramos esta cada cosa: los elementos dentro del buffer de
        // cada tramo, y como los toca ese tramo.
        if (multi) {
          for (const i of idxs) {
            const tk = `${i}:${layerBufferM}`;
            if (!tramoIntersectors.has(tk)) {
              const poly = computeUnifiedBufferPolygon(tramos[i].geojson, layerBufferM);
              tramoIntersectors.set(tk, poly ? makeIntersector(poly) : () => false);
            }
            const inTramo = tramoIntersectors.get(tk);
            const ents = entities.filter((e) => inTramo(e.feature));
            if (!ents.length) continue;
            const c = contactFromMeasures(directContactMeasures(l, ents, tramoTraz.get(i), distCtx));
            a.tramoHits.set(i, {
              afeccion: c ? c.kind : "entorno",
              contactText: c ? c.text : "",
              names: [...new Set(ents.map((e) => e.name).filter(Boolean))].sort(),
            });
          }
        }

        // Elementos cercanos FUERA del buffer, tambien cuando la capa ya
        // tiene cruce directo: hasta NEARBY_MAX_PER_LAYER, el mas cercano
        // primero, con la distancia al TRAZADO y al borde del buffer.
        // Antes solo se daba el mas cercano, y solo si no habia cruce
        // (caso de prueba del puerto de Carboneras, §4.3). Los fragmentos
        // de un mismo elemento se agrupan (entityKey) y un elemento que
        // cruza el buffer no se repite aqui aunque otro trozo suyo quede
        // fuera (tampoco si lo cruza en otra vista: ver la union de abajo).
        const intersectingSet = new Set(intersecting);
        const intersectingKeys = new Set(intersecting.map((f) => entityKey(l, f)).filter((k) => k != null));
        for (const k of intersectingKeys) a.intersectingKeys.add(k);
        for (const f of feats) {
          if (!f.geometry || intersectingSet.has(f)) continue;
          // Sin nombre ni id no hay forma de agrupar fragmentos: todos van
          // a una misma clave y solo se lista el mas cercano de ellos.
          const key = entityKey(l, f) ?? "__sin_nombre";
          if (intersectingKeys.has(key)) continue;
          const info = minDistanceInfo(distCtx, f, layerBufferM + NEAREST_SEARCH_MARGIN_M);
          if (!isFinite(info.distanceM)) continue;
          const prev = a.nearbyByKey.get(key);
          if (!prev || info.distanceM < prev.distanceM) {
            a.nearbyByKey.set(key, { name: featureName(l, f), distanceM: info.distanceM, tramoIdx: distCtx.tramoOf[info.sampleIdx] });
          }
        }
      }
    }
    overlayText.textContent = "Analizando afecciones…";

    // Juntar lo de todas las vistas, capa a capa.
    const results = [];
    for (const l of targetLayers) {
      const a = acc[l.id];
      const layerBufferM = effectiveBufferM[l.id];
      // Una entidad con id que sale en varias vistas cuenta una vez, con la
      // superficie de todas sumada (los buffers de vistas distintas no se
      // solapan, ver planAnalysisViews).
      const merged = [];
      const byKey = new Map();
      for (const e of a.entities) {
        if (e.key == null) { merged.push(e); continue; }
        const prev = byKey.get(e.key);
        if (prev) {
          prev.bufferHa += e.bufferHa;
        } else {
          const copy = { ...e };
          byKey.set(e.key, copy);
          merged.push(copy);
        }
      }
      const count = merged.length;
      const totalHa = l.geom === "polygon" ? unionAreaHectares(a.pieces) : 0;
      const totalM = a.totalM;
      const contact = contactFromMeasures(a.measures);

      // "Cuanto" en % del espacio, para el elemento con mas superficie en
      // el buffer, si el dato de origen trae su superficie total.
      let pctText = "";
      if (l.areaHaField && merged.length) {
        const top = merged.reduce((x, y) => (y.bufferHa > x.bufferHa ? y : x));
        const totalElemHa = Number(top.props && top.props[l.areaHaField]);
        if (top.bufferHa > 0 && totalElemHa > 0) {
          const pct = Math.min(100, (top.bufferHa / totalElemHa) * 100);
          const pctStr = pct.toLocaleString("es-ES", { maximumFractionDigits: pct < 1 ? 2 : 0 });
          pctText = `${pctStr} % de ${top.name || "el espacio"}`;
        }
      }

      const edgeThreshold = bufferEdgeThresholdM(layerBufferM);
      const nearby = [...a.nearbyByKey]
        .filter(([k]) => !a.intersectingKeys.has(k))
        .map(([, e]) => e)
        .sort((x, y) => x.distanceM - y.distanceM)
        .slice(0, NEARBY_MAX_PER_LAYER)
        .map((e) => {
          // El buffer es el trazado desplazado layerBufferM, asi que la
          // distancia al borde es la resta (con 0 como minimo por el
          // pequeno error del muestreo del trazado).
          const edgeM = Math.max(0, e.distanceM - layerBufferM);
          return { ...e, tramoName: multi && e.tramoIdx != null ? tramos[e.tramoIdx].name : "", edgeM, atEdge: edgeM <= edgeThreshold };
        });

      const nearestM = nearby.length ? nearby[0].distanceM : null;
      const nearestName = nearby.length ? nearby[0].name : null;
      const afeccion =
        contact ? contact.kind
        : count > 0 ? "entorno"
        : nearestM != null ? (nearby[0].atEdge ? "borde" : "proxima")
        : null;
      const importancia = l.importancia || "Media";
      const sensitivity = afeccion ? sensitivityFor(importancia, afeccion) : null;
      // Sensibilidad de los elementos solo cercanos de una capa que ademas
      // tiene algo en el buffer (tabla de cercanos).
      const nearSensitivity = sensitivityFor(importancia, "proxima");

      // Por tramo: lo que cae en su buffer y, como en el entorno "a
      // verificar", lo que queda al borde de su buffer.
      const tramoHits = new Map(a.tramoHits);
      for (const e of nearby) {
        if (e.atEdge && e.tramoIdx != null && !tramoHits.has(e.tramoIdx)) {
          tramoHits.set(e.tramoIdx, { afeccion: "borde", contactText: "", names: e.name ? [e.name] : [] });
        }
      }
      const tramoList = multi
        ? [...tramoHits].sort((x, y) => x[0] - y[0]).map(([i, h]) => ({ idx: i, name: tramos[i].name, ...h, sensitivity: sensitivityFor(importancia, h.afeccion) }))
        : [];

      const r = {
        layer: l, count, totalHa, totalM, names: [...a.names].sort(), nearby, nearestM, nearestName,
        bufferM: layerBufferM, importancia, afeccion, contact, pctText, sensitivity, nearSensitivity,
        tramos: tramoList,
        // Capa en linea que no se pudo consultar: sin resultado (no "cero").
        serviceError: a.serviceError,
        truncated: a.truncated,
      };
      r.reason = afeccion ? sensitivityReason(r) : "";
      results.push(r);
    }

    // Resumen por tramo: que toca cada uno, lo mas sensible primero.
    const tramoSummary = multi
      ? tramos.map((t) => {
          const hits = [];
          for (const r of results) {
            const h = r.tramos.find((x) => x.idx === t.idx);
            if (h) hits.push({ layer: r.layer, ...h });
          }
          hits.sort((x, y) => SENSITIVITY_LEVELS.indexOf(y.sensitivity) - SENSITIVITY_LEVELS.indexOf(x.sensitivity));
          return { idx: t.idx, name: t.name, lengthM: t.lengthM, areaHa: t.areaHa, markers: t.markers, hits, maxSensitivity: hits.length ? hits[0].sensitivity : null };
        })
      : null;

    // Las capas se hicieron temporalmente visibles mas arriba solo para
    // poder consultarlas -- SIN este paso, una capa con afeccion real
    // (count > 0) se volvia a ocultar igual que las demas al terminar, y
    // "Exportar cartografia" (que solo pinta/lista lo que esta marcado en
    // el panel, ver export.js) podia acabar mostrando un plano incompleto
    // aunque la tabla de resultados dijera lo contrario -- encontrado
    // probando un caso real de cerramiento (ver
    // investigacion/ejemplos-de-uso/caso-cerramiento-planta-agroindustrial.md
    // §4.1). Fix: una capa con cruce directo confirmado se queda activada;
    // el resto (sin afeccion, o solo "cerca, sin cruce") vuelve a su
    // estado previo, para no llenar el mapa de capas irrelevantes.
    const autoActivated = [];
    for (const l of targetLayers) {
      const r = results.find((row) => row.layer.id === l.id);
      const keepVisible = r && r.count > 0;
      if (keepVisible) {
        if (!prevVisible[l.id]) autoActivated.push(l);
      } else if (layerVisible[l.id] !== prevVisible[l.id]) {
        setLayerVisible(l, prevVisible[l.id]);
      }
    }
    // Reconstruye el panel para que las casillas reales reflejen el nuevo
    // estado -- "Exportar cartografia" lee el checkbox del DOM, no solo
    // layerVisible (ver buildLegendRows en export.js), asi que sin este
    // paso las capas quedarian visibles en el mapa pero la casilla seguiria
    // sin marcar y el problema original seguiria ahi a medias.
    buildLayerPanel();

    // El mapa queda encuadrado al area de BUSQUEDA ampliada (bufferMaxM +
    // NEAREST_SEARCH_MARGIN_M, ver mas arriba) porque hacia falta para
    // consultar "cerca, sin cruce directo" -- pero para el usuario, tanto
    // para ver el resultado en el mapa como para la escala que sugiere
    // "Exportar cartografia" (que se calcula a partir de la vista actual,
    // ver export.js), esa vista tan amplia deja el proyecto como un punto
    // casi invisible salvo que se reencuadre a mano antes de exportar
    // (encontrado probando un caso real de cerramiento, ver
    // investigacion/ejemplos-de-uso/caso-cerramiento-planta-agroindustrial.md
    // §4.2). Fix: al terminar, se reencuadra al area de los buffers
    // REALMENTE usados para el cruce (sin el margen extra de busqueda),
    // que es lo relevante para mirar/exportar el resultado. Con varias
    // vistas, a toda la obra.
    const finalViewPolygon = computeUnifiedBufferPolygon(obra, maxBufferM);
    if (finalViewPolygon) {
      const finalBbox = turf.bbox(finalViewPolygon);
      map.fitBounds([[finalBbox[0], finalBbox[1]], [finalBbox[2], finalBbox[3]]], {
        padding: 60,
        animate: false,
        maxZoom: 17,
      });
    }

    // Buffers por capa distintos del general del tramo, para las capas con
    // cruce directo: se dibujan en el mapa (y salen en la leyenda de la
    // cartografia) para que plano y tabla cuenten lo mismo. Antes el plano
    // solo mostraba el buffer general, y un elemento "afectado" con un
    // buffer de 1 km quedaba fuera del circulo dibujado de 500 m (caso de
    // prueba del puerto de Carboneras, §4.5).
    const ringsByM = new Map();
    for (const r of results) {
      if (r.count === 0 || r.bufferM === u.bufferMeters) continue;
      if (!ringsByM.has(r.bufferM)) ringsByM.set(r.bufferM, []);
      ringsByM.get(r.bufferM).push(r.layer);
    }
    const rings = [];
    for (const [meters, layers] of [...ringsByM].sort((a, b) => a[0] - b[0])) {
      const polygon = computeUnifiedBufferPolygon(obra, meters);
      if (polygon) rings.push({ meters, layerNames: layers.map((l) => l.nombre.replace(/\s*\([^)]*\)\s*$/, "")), polygon });
    }
    setAnalysisBuffers(u, rings);

    u.layerBufferOverrides = overrides;
    u.autoActivatedLayers = autoActivated;
    showAnalysisResults(u, results, {
      incomplete,
      serviceErrors: results.filter((r) => r.serviceError).map((r) => ({ nombre: r.layer.nombre, error: r.serviceError })),
      truncated: results.filter((r) => r.truncated).map((r) => r.layer.nombre),
      tramoSummary,
      markerCount: markers.length,
      viewCount: views.length,
    });
  } catch (e) {
    console.error(e);
    alert("Error analizando afecciones: " + e.message);
  } finally {
    overlay.hidden = true;
    overlayText.textContent = "Analizando afecciones…";
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

// Badge de color del semaforo de sensibilidad (idea #1) -- mismo patron
// visual que .nivel-badge en el panel de capas (main.js/style.css).
function sensitivityBadgeHtml(level) {
  const color = SENSITIVITY_COLOR[level] || SENSITIVITY_COLOR["Media"];
  return `<span class="sensitivity-badge" style="background:${color}">${escapeHtml(level)}</span>`;
}

function formatMeters(m) {
  return Math.round(m).toLocaleString("es-ES", { useGrouping: true });
}

// Texto plano de un elemento cercano, para CSV/Excel/PDF (sin emojis: la
// fuente del PDF no los tiene).
// e.tramoName solo viene con varios tramos: el tramo que le queda mas cerca.
function nearbyPlainText(e) {
  const edge = `${formatMeters(e.edgeM)} m fuera del buffer${e.atEdge ? ", AL BORDE DEL BUFFER" : ""}`;
  const tramo = e.tramoName ? `; tramo ${e.tramoName}` : "";
  return `${e.name || "Sin nombre"} (${formatMeters(e.distanceM)} m; ${edge}${tramo})`;
}

function nearbyHtml(e) {
  const edge = e.atEdge
    ? `<span class="analysis-edge-flag">⚠ al borde: ${formatMeters(e.edgeM)} m fuera del buffer</span>`
    : `<span class="analysis-edge-dist">(${formatMeters(e.edgeM)} m fuera del buffer)</span>`;
  const tramo = e.tramoName ? ` <span class="analysis-muted">· tramo ${escapeHtml(e.tramoName)}</span>` : "";
  return `<div class="analysis-nearby-item"><strong>${escapeHtml(e.name || "Sin nombre")}</strong> · ${formatMeters(e.distanceM)} m ${edge}${tramo}</div>`;
}

// --- Analisis por tramo: presentacion ---

function isMultiTramo(meta) {
  return !!(meta && meta.tramoSummary && meta.tramoSummary.length > 1);
}

// "Tramo 1 (directa) | Tramo 3 (en el entorno)" -- en que tramos esta lo de una capa.
function tramosPlainText(r) {
  return r.tramos.map((t) => `${t.name} (${AFECCION_LABEL[t.afeccion].toLowerCase()})`).join(" | ");
}

function tramoSizeText(t) {
  if (t.lengthM > 0) return `${formatMeters(t.lengthM)} m`;
  if (t.areaHa > 0) return `${formatHa(t.areaHa)} ha`;
  return "punto";
}

function tramoHitPlainText(h) {
  return `${h.layer.nombre}: ${h.sensitivity}, ${AFECCION_LABEL[h.afeccion].toLowerCase()}${h.contactText ? ` (${h.contactText})` : ""}`;
}

function tramoSummaryNote(meta) {
  const ts = meta.tramoSummary;
  const totalM = ts.reduce((s, t) => s + t.lengthM, 0);
  const conAlgo = ts.filter((t) => t.hits.length).length;
  let note = `${ts.length} tramos${totalM > 0 ? `, ${formatMeters(totalM)} m de trazado en total` : ""}; ${conAlgo} con algo en su buffer.`;
  if (meta.markerCount) note += ` Los ${meta.markerCount} puntos a menos de ${TRAMO_MARKER_MAX_M} m de un tramo (sus PK, hitos...) se asocian a ese tramo y no se analizan como obra.`;
  if (meta.viewCount > 1) note += ` Los tramos se han analizado en ${meta.viewCount} zonas, cada una a su propio zoom, para no perder detalle.`;
  return note;
}

function tramoSummaryHtml(meta) {
  let html = `<div class="analysis-nivel-block analysis-tramos-block"><h3>Resumen por tramo</h3>
    <p class="modal-note">${escapeHtml(tramoSummaryNote(meta))}</p>
    <table class="analysis-table analysis-tramos-table"><thead><tr>
      <th>Sensibilidad máx.</th><th>Tramo</th><th>Longitud</th><th>Puntos asociados</th><th>En su buffer</th>
    </tr></thead><tbody>`;
  for (const t of meta.tramoSummary) {
    const hits = t.hits.length
      ? t.hits.map((h) => `<div class="analysis-tramo-hit">${sensitivityBadgeHtml(h.sensitivity)} ${escapeHtml(h.layer.nombre)} · ${escapeHtml(AFECCION_LABEL[h.afeccion].toLowerCase())}${h.contactText ? ` <span class="analysis-muted">(${escapeHtml(h.contactText)})</span>` : ""}</div>`).join("")
      : `<span class="analysis-muted">Sin afecciones en su buffer</span>`;
    html += `<tr>
      <td>${t.maxSensitivity ? sensitivityBadgeHtml(t.maxSensitivity) : "-"}</td>
      <td class="names"><strong>${escapeHtml(t.name)}</strong></td>
      <td class="num">${tramoSizeText(t)}</td>
      <td class="names">${t.markers.length ? escapeHtml(t.markers.join(", ")) : "-"}</td>
      <td>${hits}</td>
    </tr>`;
  }
  return html + `</tbody></table></div>`;
}

// meta: { incomplete } -- ver analyzeUploadedLayer.
function showAnalysisResults(u, results, meta = {}) {
  document.getElementById("analysis-subtitle").textContent =
    `${u.name} · buffer de ${bufferLabel(u.bufferMeters)} · estimación de cribado, no sustituye el análisis en QGIS`;

  const container = document.getElementById("analysis-results");

  const serviceErrors = serviceErrorsText(meta);
  const truncatedText = meta.truncated && meta.truncated.length
    ? `El servicio en línea devolvió el máximo de ${WFS_MAX_FEATURES} elementos para: ${meta.truncated.join(", ")}. Puede faltar alguno; analiza el trazado por tramos.`
    : "";
  const warningsHtml =
    (meta.incomplete ? `<p class="modal-note analysis-incomplete-note">⚠️ ${escapeHtml(ANALYSIS_INCOMPLETE_NOTE)}</p>` : "") +
    (serviceErrors ? `<p class="modal-note analysis-incomplete-note">⚠️ ${escapeHtml(serviceErrors)}</p>` : "") +
    (truncatedText ? `<p class="modal-note analysis-incomplete-note">⚠️ ${escapeHtml(truncatedText)}</p>` : "");
  // Las limitaciones fijas del catalogo van plegadas: salen en todos los
  // analisis y tapaban el semaforo al abrir el resultado. Los avisos de
  // arriba (fallos de este analisis concreto) siguen siempre a la vista.
  const limitsHtml = `<details class="analysis-method analysis-limits">
    <summary>Limitaciones de este análisis</summary>
    <p class="modal-note analysis-coverage-note">ℹ️ ${escapeHtml(ANALYSIS_COVERAGE_NOTE)} ${escapeHtml(ANALYSIS_FLOOD_COVERAGE_NOTE)}</p>
  </details>`;

  // Aviso de transparencia: que capas se acaban de activar en el panel
  // porque tuvieron cruce directo (ver el bloque "autoActivated" en
  // analyzeUploadedLayer) -- para que no sea una sorpresa silenciosa que
  // aparezcan casillas marcadas solas, y para dejar claro que asi la
  // cartografia exportada ahora si va a incluirlas.
  let autoActivatedHtml = "";
  if (u.autoActivatedLayers && u.autoActivatedLayers.length > 0) {
    const nombres = u.autoActivatedLayers.map((l) => escapeHtml(l.nombre)).join(", ");
    autoActivatedHtml = `<p class="modal-note analysis-autoactivated-note">✅ Se han activado en el mapa las capas con algo dentro del buffer que no estaban ya marcadas (${nombres}), para que la cartografía que exportes las incluya. Desactívalas en el panel si no las quieres en el plano.</p>`;
  }

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

  // Como se decide la sensibilidad, a mano en el propio resultado (pedido
  // por Francisco: "que quede mejor explicado").
  const methodHtml = `<details class="analysis-method">
    <summary>¿Cómo se decide la sensibilidad?</summary>
    <p>Se combinan dos cosas: la <strong>importancia</strong> del elemento (según su régimen legal) y <strong>cómo lo toca la obra</strong>.</p>
    <table class="analysis-method-table"><thead><tr><th>Importancia</th><th>Directa<br><small>la obra lo pisa</small></th><th>En el entorno<br><small>dentro del buffer</small></th><th>Próxima<br><small>fuera del buffer</small></th></tr></thead>
    <tbody>
      <tr><th>Alta</th><td>${sensitivityBadgeHtml("Muy Alta")}</td><td>${sensitivityBadgeHtml("Alta")}</td><td>${sensitivityBadgeHtml("Media")}</td></tr>
      <tr><th>Media</th><td>${sensitivityBadgeHtml("Alta")}</td><td>${sensitivityBadgeHtml("Media")}</td><td>${sensitivityBadgeHtml("Baja")}</td></tr>
      <tr><th>Baja</th><td>${sensitivityBadgeHtml("Media")}</td><td>${sensitivityBadgeHtml("Baja")}</td><td>${sensitivityBadgeHtml("Baja")}</td></tr>
    </tbody></table>
    <p><strong>Importancia alta:</strong> Red Natura 2000, espacios naturales protegidos, zonas húmedas, humedales y turberas, zona de flujo preferente, zona inundable T10. <strong>Media:</strong> dominio público hidráulico, cauces, vías pecuarias, zonas inundables T100/T500 y costeras.</p>
    <p>Si la obra lo pisa menos de ${DIRECT_MIN_M} m o ${formatHa(DIRECT_MIN_HA)} ha (<em>roce</em>), o si queda fuera del buffer pero a menos de 50 m o del 10 % de su borde (<em>al borde</em>), cuenta como "en el entorno" y se marca <em>a verificar</em>: la diferencia puede deberse a la precisión del dato. El "cuánto" (ha, m, % del espacio) se da siempre en el porqué de cada fila. Criterio interno de Quadrante, no una clasificación reglamentaria.</p>
  </details>`;

  // Con varios tramos: resumen por tramo delante y columna "Tramos" en las
  // tablas por capa (rama avanzado).
  const multi = isMultiTramo(meta);
  document.getElementById("analysis-modal").classList.toggle("analysis-modal-wide", multi);
  let html = multi ? tramoSummaryHtml(meta) : "";
  for (const nivel of ANALYSIS_NIVELES) {
    const rows = results.filter((r) => r.layer.nivel === nivel);
    const afectadas = rows.filter((r) => r.count > 0);
    const cercanas = rows.filter((r) => r.nearby.length > 0);
    html += `<div class="analysis-nivel-block"><h3>${NIVEL_LABEL[nivel]}</h3>`;
    if (afectadas.length === 0) {
      html += `<p class="analysis-empty">Sin afecciones detectadas en este nivel.</p>`;
    } else {
      html += `<table class="analysis-table"><thead><tr>
        <th>Sensibilidad</th><th>Capa</th><th>Afección</th><th>Nombres / códigos</th>${multi ? "<th>Tramos</th>" : ""}<th>Long. en buffer (m)</th><th>Superficie en buffer (ha)</th><th>Confirmado en campo</th>
      </tr></thead><tbody>`;
      for (const r of afectadas) {
        const nombres = r.names.length ? escapeHtml(r.names.join(", ")) : "-";
        const ha = r.totalHa > 0 ? r.totalHa.toLocaleString("es-ES", { maximumFractionDigits: 2 }) : "-";
        const tramosCell = multi
          ? `<td class="names analysis-tramos-cell">${r.tramos.map((t) => `<div>${escapeHtml(t.name)} <span class="analysis-muted">(${escapeHtml(AFECCION_LABEL[t.afeccion].toLowerCase())})</span></div>`).join("") || "-"}</td>`
          : "";
        html += `<tr>
          <td>${sensitivityBadgeHtml(r.sensitivity)}</td>
          <td>${escapeHtml(r.layer.nombre)}</td>
          <td>${escapeHtml(AFECCION_LABEL[r.afeccion])}</td>
          <td class="names">${nombres}</td>
          ${tramosCell}
          <td class="num">${r.totalM > 0 ? Math.round(r.totalM).toLocaleString("es-ES") : "-"}</td>
          <td class="num">${ha}</td>
          <td>${fieldStatusSelectHtml(u, r.layer.id)}</td>
        </tr>
        <tr class="analysis-reason-row"><td colspan="${multi ? 8 : 7}">Por qué — ${escapeHtml(r.reason)}</td></tr>`;
      }
      html += `</tbody></table>`;
    }
    if (cercanas.length > 0) {
      html += `<p class="analysis-near-title">Cerca, fuera del buffer (hasta ${(NEAREST_SEARCH_MARGIN_M / 1000).toLocaleString("es-ES")} km más allá del buffer aplicado; distancia medida desde el trazado):</p>`;
      html += `<table class="analysis-table analysis-table-near"><thead><tr>
        <th>Sensibilidad</th><th>Capa</th><th>Elementos cercanos</th><th>Confirmado en campo</th>
      </tr></thead><tbody>`;
      for (const r of cercanas) {
        // Una capa con cruce directo ya tiene su fila (y su estado de campo)
        // en la tabla de arriba; aqui solo se listan sus elementos de fuera,
        // con la sensibilidad de "solo cercano".
        const hasHit = r.count > 0;
        html += `<tr>
          <td>${sensitivityBadgeHtml(hasHit ? r.nearSensitivity : r.sensitivity)}</td>
          <td>${escapeHtml(r.layer.nombre)}</td>
          <td class="names">${r.nearby.map(nearbyHtml).join("")}</td>
          <td>${hasHit ? `<span class="analysis-muted">ver tabla de arriba</span>` : fieldStatusSelectHtml(u, r.layer.id)}</td>
        </tr>
        ${hasHit ? "" : `<tr class="analysis-reason-row"><td colspan="4">Por qué — ${escapeHtml(r.reason)}</td></tr>`}`;
      }
      html += `</tbody></table>`;
    }
    html += `</div>`;
  }
  // Primero lo que se quiere ver (resultados y como se decide), y despues los
  // controles para recalcular con otros buffers (prueba del 2026-10-01: con
  // los controles delante, los resultados quedaban fuera de la primera
  // pantalla).
  // El buffer propio por capa (controlsHtml) solo en el modo completo (ver
  // config.js); en el basico se usan el del tramo y los sugeridos por capa.
  container.innerHTML = warningsHtml + methodHtml + limitsHtml + html + (FEATURES.bufferPorCapa ? controlsHtml : "") + autoActivatedHtml;

  container.querySelectorAll(".analysis-field-status").forEach((sel) => {
    sel.addEventListener("change", () => {
      if (!u.fieldStatus) u.fieldStatus = {};
      u.fieldStatus[sel.dataset.layerId] = sel.value;
      // Todos los selects de la misma capa (tabla de afectadas + de
      // cercanas no pueden coincidir a la vez, pero por si acaso) quedan
      // en sync -- solo puede haber uno visible por capa en la practica.
    });
  });

  container.querySelector("#analysis-recalc-btn")?.addEventListener("click", () => {
    const newOverrides = {};
    container.querySelectorAll(".analysis-buffer-select").forEach((sel) => {
      newOverrides[sel.dataset.layerId] = Number(sel.value);
    });
    analyzeUploadedLayer(u, newOverrides);
  });

  lastAnalysisResults = { u, results, meta };
  document.getElementById("analysis-modal-backdrop").hidden = false;
}

document.getElementById("analysis-close-btn").addEventListener("click", () => {
  document.getElementById("analysis-modal-backdrop").hidden = true;
});

// "Elementos cercanos fuera del buffer" lleva el NOMBRE de cada elemento
// con su distancia -- antes solo salia la distancia del mas cercano, sin
// decir a que (caso de prueba del puerto de Carboneras, §4.2).
// Afeccion, Importancia, Contacto con la obra y Motivo: semaforo de
// sensibilidad explicado (rediseno del 2026-09-29, ver sensitivityFor).
const RESULTS_HEADER = [
  "Sensibilidad", "Afección", "Importancia", "Nivel", "Capa", "Fuente", "Buffer aplicado (m)", "Elementos",
  "Nombres/códigos", "Contacto con la obra", "Longitud en el buffer (m)", "Superficie en el buffer (ha)",
  "Elementos cercanos fuera del buffer", "Distancia al más cercano (m)", "Motivo de la sensibilidad",
  "Confirmado en campo",
];
// Con varios tramos se anade "Tramos" justo despues de los nombres.
function resultsHeader(meta) {
  if (!isMultiTramo(meta)) return RESULTS_HEADER;
  const i = RESULTS_HEADER.indexOf("Nombres/códigos") + 1;
  return [...RESULTS_HEADER.slice(0, i), "Tramos", ...RESULTS_HEADER.slice(i)];
}

// Columnas del informe PDF (A4 apaisado, no caben las 16): nombre de la
// columna (de RESULTS_HEADER) y ancho en mm. El contacto con la obra va
// dentro del motivo; con varios tramos, los tramos van en su propia tabla.
// (Longitud y Superficie a 17 mm: con 14 el titulo se partia a media palabra.)
const REPORT_COLUMNS = [
  ["Sensibilidad", 18], ["Capa", 26], ["Afección", 18], ["Nombres/códigos", 33],
  ["Longitud en el buffer (m)", 17], ["Superficie en el buffer (ha)", 17],
  ["Elementos cercanos fuera del buffer", 40], ["Motivo de la sensibilidad", 75], ["Confirmado en campo", 17],
];

// Hoja/tabla "Resumen por tramo" (Excel e informe PDF).
const TRAMO_SUMMARY_HEADER = ["Sensibilidad máx.", "Tramo", "Longitud / superficie", "Puntos asociados", "En su buffer"];

function tramoSummaryRows(meta) {
  return meta.tramoSummary.map((t) => [
    t.maxSensitivity || "-",
    t.name,
    tramoSizeText(t),
    t.markers.join(", "),
    t.hits.length ? t.hits.map(tramoHitPlainText).join("\n") : "Sin afecciones en su buffer",
  ]);
}

// Fila por capa afectada -- o, si no hay cruce directo pero se detecto
// algun elemento cerca (idea #4), una fila con Elementos=0 y los cercanos
// en vez de long./superficie. Una capa con cruce directo lista tambien sus
// cercanos de fuera. Tipos ya listos para CSV (todo texto) o Excel
// (numeros como numeros, no como texto) -- comparten esta funcion para no
// mantener la logica de "que va en cada columna" por duplicado.
function resultsToRows(u, results, meta = {}) {
  const fieldStatus = u.fieldStatus || {};
  const multi = isMultiTramo(meta);
  const tramosIdx = RESULTS_HEADER.indexOf("Nombres/códigos") + 1;
  const rows = [];
  for (const r of results) {
    if (r.count === 0 && r.nearby.length === 0) continue;
    const row = [
      r.sensitivity,
      AFECCION_LABEL[r.afeccion] || "",
      r.importancia,
      r.layer.nivel,
      r.layer.nombre,
      r.layer.fuente || "",
      r.bufferM,
      r.count,
      r.names.join(" | "),
      r.contact ? `${r.contact.text} (${r.contact.names.join(", ") || "sin nombre"})` : "",
      r.totalM > 0 ? Math.round(r.totalM * 10) / 10 : "",
      r.totalHa > 0 ? Math.round(r.totalHa * 1000) / 1000 : "",
      r.nearby.map(nearbyPlainText).join(" | "),
      r.nearestM != null ? Math.round(r.nearestM) : "",
      r.reason,
      fieldStatus[r.layer.id] || FIELD_STATUS_OPTIONS[0],
    ];
    if (multi) row.splice(tramosIdx, 0, tramosPlainText(r));
    rows.push(row);
  }
  return rows;
}

// Notas de metodologia comunes al Excel (hoja "Info") y al informe PDF.
function analysisNotes(u, meta = {}) {
  const notes = [];
  if (meta.incomplete) notes.push(["AVISO", ANALYSIS_INCOMPLETE_NOTE]);
  const serviceErrors = serviceErrorsText(meta);
  if (serviceErrors) notes.push(["AVISO", serviceErrors]);
  if (meta.truncated && meta.truncated.length) {
    notes.push(["AVISO", `El servicio en línea devolvió el máximo de ${WFS_MAX_FEATURES} elementos para: ${meta.truncated.join(", ")}. Puede faltar alguno.`]);
  }
  notes.push(
    ["Nota", "Estimación de cribado a partir de teselas vectoriales — no sustituye el análisis en QGIS."],
    ["Buffer", `Buffer por defecto del tramo: ${bufferLabel(u.bufferMeters)}. Algunas capas pueden usar uno distinto — ver columna 'Buffer aplicado (m)'.`],
    ...(isMultiTramo(meta) ? [["Tramos", `${tramoSummaryNote(meta)} El resumen por tramo dice qué hay en el buffer de cada tramo y cómo lo toca; en el Excel, la columna 'Tramos' lo dice además capa a capa.`]] : []),
    ["Cercanos", `Elementos fuera del buffer hasta ${NEAREST_SEARCH_MARGIN_M / 1000} km más allá de él (como mucho ${NEARBY_MAX_PER_LAYER} por capa). La distancia se mide desde el trazado; se marca "AL BORDE DEL BUFFER" si queda a menos de 50 m o del 10 % del buffer fuera de su borde.`],
    ["Cobertura", ANALYSIS_COVERAGE_NOTE],
    ["Zonas inundables", `${ANALYSIS_FLOOD_COVERAGE_NOTE} Se consultan en vivo al servicio del SNCZI (MITECO) en el momento del análisis; geometría con precisión de ~10 m.`],
    ["Fuente y vigencia", "Cada capa indica su organismo de origen (columna 'Fuente' en el Excel; debajo del nombre de la capa en el informe). Confirmar la fecha de descarga vigente del catálogo con el equipo antes de una entrega final."],
    ["Sensibilidad", `Combina la importancia del elemento (según su régimen legal) con cómo lo toca la obra. Importancia alta: Muy Alta si la obra lo pisa, Alta si solo está en el buffer, Media si está cerca. Importancia media: Alta / Media / Baja. Si la obra lo pisa menos de ${DIRECT_MIN_M} m o ${formatHa(DIRECT_MIN_HA)} ha ("roce"), o queda fuera del buffer a menos de 50 m o del 10 % de su borde ("al borde"), cuenta como en el buffer y se marca "a verificar". Criterio interno de Quadrante, no una clasificación reglamentaria: sirve para priorizar qué revisar primero y no sustituye el criterio del técnico ambiental.`]
  );
  return notes;
}

function csvField(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

document.getElementById("analysis-download-csv").addEventListener("click", () => {
  if (!lastAnalysisResults) return;
  const { u, results, meta } = lastAnalysisResults;
  let csv = resultsHeader(meta).join(",") + "\n";
  for (const row of resultsToRows(u, results, meta)) {
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
  const { u, results, meta } = lastAnalysisResults;
  // Mismo criterio que resultsToRows: afectadas de verdad + "cerca, sin
  // cruce directo" (idea #4) -- en ese mismo orden, para que fila a fila
  // coincida uno a uno con `rows`.
  const exportable = results.filter((r) => r.count > 0 || r.nearby.length > 0);
  const rows = resultsToRows(u, results, meta); // mismo filtro/orden que `exportable`
  const baseHeader = resultsHeader(meta);

  // Color como columna aparte (idea #10: capa + fuente citables sin salir
  // del Excel) -- Buffer/Distancia/Confirmado en campo son las nuevas
  // columnas de las ideas #2/#4/#6 del informe de investigacion. La
  // Sensibilidad (idea #1) va primero, es lo primero que hay que mirar.
  // RESULTS_HEADER con una columna "Color" justo despues de "Capa".
  const CAPA_IDX = baseHeader.indexOf("Capa");
  const header = [...baseHeader.slice(0, CAPA_IDX + 1), "Color", ...baseHeader.slice(CAPA_IDX + 1)];
  const tableRows = rows.map((row) => [...row.slice(0, CAPA_IDX + 1), "", ...row.slice(CAPA_IDX + 1)]);
  const COLOR_COL = CAPA_IDX + 2; // 1-based
  const wrapCols = ["Nombres/códigos", "Tramos", "Contacto con la obra", "Elementos cercanos fuera del buffer", "Motivo de la sensibilidad"]
    .map((h) => header.indexOf(h) + 1)
    .filter((c) => c > 0);

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

  const XLSX_WIDTHS = {
    "Sensibilidad": 14, "Afección": 16, "Importancia": 12, "Nivel": 6, "Capa": 30, "Color": 4, "Fuente": 24,
    "Buffer aplicado (m)": 12, "Elementos": 10, "Nombres/códigos": 40, "Tramos": 45, "Contacto con la obra": 40,
    "Longitud en el buffer (m)": 16, "Superficie en el buffer (ha)": 16, "Elementos cercanos fuera del buffer": 55,
    "Distancia al más cercano (m)": 14, "Motivo de la sensibilidad": 70, "Confirmado en campo": 18,
  };
  header.forEach((h, i) => {
    sheet.getColumn(i + 1).width = XLSX_WIDTHS[h] || 14;
  });

  sheet.getRow(1).eachCell((cell) => {
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XLSX_HEADER_FILL } };
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
  });

  exportable.forEach((r, i) => {
    const row = sheet.getRow(i + 2);
    const layerColor = "FF" + r.layer.color.fill.replace("#", "");
    const sensColor = "FF" + (SENSITIVITY_COLOR[r.sensitivity] || SENSITIVITY_COLOR["Media"]).replace("#", "");
    const band = i % 2 === 1 ? XLSX_BAND_FILL : "FFFFFFFF";
    for (let c = 1; c <= header.length; c++) {
      row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: c === COLOR_COL ? layerColor : band } };
    }
    // Sensibilidad (col. 1) con su propio color de semaforo, texto blanco
    // en negrita para que se lea de un vistazo -- mismo criterio que la
    // columna Color (capa).
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: sensColor } };
    row.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    for (const c of wrapCols) row.getCell(c).alignment = { wrapText: true, vertical: "top" };
    // Fila "cerca, sin cruce directo" (Elementos=0 con cercanos): en
    // cursiva para distinguirla de un cruce real de un vistazo.
    if (r.count === 0) {
      row.eachCell((cell) => { cell.font = { ...(cell.font || {}), italic: true }; });
    }
  });

  sheet.views = [{ state: "frozen", ySplit: 1 }];

  // Con varios tramos: hoja "Tramos", un tramo por fila, con su
  // sensibilidad maxima coloreada y lo que hay en su buffer.
  if (isMultiTramo(meta)) {
    const tSheet = workbook.addWorksheet("Tramos");
    tSheet.addTable({
      name: "TablaTramos",
      ref: "A1",
      headerRow: true,
      style: { showRowStripes: false },
      columns: TRAMO_SUMMARY_HEADER.map((name) => ({ name })),
      rows: tramoSummaryRows(meta),
    });
    [16, 36, 16, 30, 90].forEach((w, i) => { tSheet.getColumn(i + 1).width = w; });
    tSheet.getRow(1).eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: XLSX_HEADER_FILL } };
      cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    });
    meta.tramoSummary.forEach((t, i) => {
      const row = tSheet.getRow(i + 2);
      const band = i % 2 === 1 ? XLSX_BAND_FILL : "FFFFFFFF";
      for (let c = 1; c <= TRAMO_SUMMARY_HEADER.length; c++) {
        row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: band } };
        row.getCell(c).alignment = { wrapText: true, vertical: "top" };
      }
      if (t.maxSensitivity) {
        row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF" + SENSITIVITY_COLOR[t.maxSensitivity].replace("#", "") } };
        row.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      }
    });
    tSheet.views = [{ state: "frozen", ySplit: 1 }];
  }

  const infoSheet = workbook.addWorksheet("Info");
  infoSheet.getColumn(1).width = 16;
  infoSheet.getColumn(1).font = { bold: true };
  infoSheet.getColumn(2).width = 90;
  infoSheet.addRows([["Tramo/punto", u.name], ...analysisNotes(u, lastAnalysisResults.meta)]);
  infoSheet.getColumn(2).alignment = { wrapText: true, vertical: "top" };

  const buf = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `afecciones_${u.name.replace(/\.[^.]+$/, "")}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
});
