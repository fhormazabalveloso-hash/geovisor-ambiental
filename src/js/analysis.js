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

// Semaforo de sensibilidad (idea #1) -- parte de layer.sensitivityBase
// (propuesta de Quadrante, no reglamentaria, ver nota junto al campo en
// layers.js) y aplica como mucho UN escalon de ajuste, nunca una formula a
// partir de hectareas/metros cruzados: la herramienta de referencia
// (South Africa Screening Tool) tampoco calcula asi la sensibilidad,
// cruza el sitio contra un mapa ya clasificado por ecologos. Los dos
// ajustes que SI hacemos usan datos que ya calculamos en este mismo
// analisis, no datos nuevos inventados.
function computeSensitivity(layer, { count, nearestM, hasTipoC }) {
  const base = layer.sensitivityBase || "Media";
  let idx = SENSITIVITY_LEVELS.indexOf(base);
  if (idx === -1) idx = SENSITIVITY_LEVELS.indexOf("Media");
  if (count === 0 && nearestM != null) {
    // "Cerca, sin cruce directo" (idea #4): un escalon menos, no es una
    // afeccion confirmada todavia.
    idx = Math.max(0, idx - 1);
  } else if (hasTipoC) {
    // Red Natura 2000 con ZEC+ZEPA a la vez: un escalon mas.
    idx = Math.min(SENSITIVITY_LEVELS.length - 1, idx + 1);
  }
  return SENSITIVITY_LEVELS[idx];
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
    const incomplete = waitOutcome !== "idle";

    const trazadoSamples = sampleTrazadoPoints(u.geojson, NEAREST_SAMPLE_KM);

    const results = [];
    for (const l of targetLayers) {
      const layerBufferM = effectiveBufferM[l.id];
      const bufferPolygon =
        layerBufferM === u.bufferMeters ? globalBufferPolygon : computeUnifiedBufferPolygon(u.geojson, layerBufferM);

      const idsToCheck = l.geom === "polygon" ? [`${l.id}-fill`] : [`${l.id}-line`];
      const existing = bufferPolygon ? idsToCheck.filter((id) => map.getLayer(id)) : [];
      let count = 0;
      let totalHa = 0;
      let totalM = 0;
      const names = new Set();
      let nearby = [];

      // Para el semaforo de sensibilidad (idea #1): un cruce con Red Natura
      // 2000 TIPO=C (ZEC+ZEPA a la vez) sube un escalon la sensibilidad
      // base de la capa -- ver nota junto a sensitivityBase en layers.js.
      let hasTipoC = false;

      if (existing.length) {
        const feats = map.queryRenderedFeatures(undefined, { layers: existing });
        const intersecting = feats.filter((f) => f.geometry && turf.booleanIntersects(f, bufferPolygon));

        if (l.id === "red_natura_2000") {
          hasTipoC = intersecting.some((f) => f.properties.TIPO === "C");
        }

        const addName = (f) => {
          const clean = featureName(l, f);
          if (clean) names.add(clean);
        };
        // Trozos de cada elemento dentro del buffer; la superficie se mide
        // al final sobre su union (ver unionAreaHectares).
        const pieces = [];
        const addPiece = (f) => {
          const piece = polygonIntersection(f, bufferPolygon);
          if (piece) pieces.push(piece);
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
            addPiece(unionFeatureGroup(group));
          }
          // Fragmentos sin id legible (dato de origen incompleto): se
          // cuentan por separado -- caso raro, no el camino normal. La
          // union final evita al menos que su superficie se sume dos veces.
          for (const f of noId) {
            addName(f);
            count++;
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
            addName(f);
            count++;
            if (l.geom === "polygon") {
              addPiece(f);
            } else {
              totalM += lineLengthInsidePolygonMeters(f, bufferPolygon);
            }
          }
        }
        if (l.geom === "polygon") totalHa = unionAreaHectares(pieces);

        // Elementos cercanos FUERA del buffer, tambien cuando la capa ya
        // tiene cruce directo: hasta NEARBY_MAX_PER_LAYER, el mas cercano
        // primero, con la distancia al TRAZADO y al borde del buffer.
        // Antes solo se daba el mas cercano, y solo si no habia cruce
        // (caso de prueba del puerto de Carboneras, §4.3). Los fragmentos
        // de un mismo elemento se agrupan (entityKey) y un elemento que
        // cruza el buffer no se repite aqui aunque otro trozo suyo quede
        // fuera.
        const intersectingSet = new Set(intersecting);
        const intersectingKeys = new Set(intersecting.map((f) => entityKey(l, f)).filter((k) => k != null));
        const nearestByKey = new Map();
        for (const f of feats) {
          if (!f.geometry || intersectingSet.has(f)) continue;
          // Sin nombre ni id no hay forma de agrupar fragmentos: todos van
          // a una misma clave y solo se lista el mas cercano de ellos.
          const key = entityKey(l, f) ?? "__sin_nombre";
          if (intersectingKeys.has(key)) continue;
          const d = minDistanceMetersToFeature(trazadoSamples, f);
          if (!(d <= layerBufferM + NEAREST_SEARCH_MARGIN_M)) continue;
          const prev = nearestByKey.get(key);
          if (!prev || d < prev.distanceM) nearestByKey.set(key, { name: featureName(l, f), distanceM: d });
        }
        const edgeThreshold = bufferEdgeThresholdM(layerBufferM);
        nearby = [...nearestByKey.values()]
          .sort((a, b) => a.distanceM - b.distanceM)
          .slice(0, NEARBY_MAX_PER_LAYER)
          .map((e) => {
            // El buffer es el trazado desplazado layerBufferM, asi que la
            // distancia al borde es la resta (con 0 como minimo por el
            // pequeno error del muestreo del trazado).
            const edgeM = Math.max(0, e.distanceM - layerBufferM);
            return { ...e, edgeM, atEdge: edgeM <= edgeThreshold };
          });
      }
      const nearestM = nearby.length ? nearby[0].distanceM : null;
      const nearestName = nearby.length ? nearby[0].name : null;
      const sensitivity = computeSensitivity(l, { count, nearestM, hasTipoC });
      // Sensibilidad de un elemento solo cercano (un escalon por debajo de
      // la base), para la tabla de cercanos de una capa que ademas tiene
      // cruce directo.
      const nearSensitivity = computeSensitivity(l, { count: 0, nearestM: 0, hasTipoC: false });
      results.push({
        layer: l, count, totalHa, totalM, names: [...names].sort(), nearby, nearestM, nearestName,
        bufferM: layerBufferM, sensitivity, nearSensitivity,
      });
    }

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
    // que es lo relevante para mirar/exportar el resultado.
    const finalViewPolygon = computeUnifiedBufferPolygon(u.geojson, maxBufferM);
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
      const polygon = computeUnifiedBufferPolygon(u.geojson, meters);
      if (polygon) rings.push({ meters, layerNames: layers.map((l) => l.nombre.replace(/\s*\([^)]*\)\s*$/, "")), polygon });
    }
    setAnalysisBuffers(u, rings);

    u.layerBufferOverrides = overrides;
    u.autoActivatedLayers = autoActivated;
    showAnalysisResults(u, results, { incomplete });
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
function nearbyPlainText(e) {
  const edge = `${formatMeters(e.edgeM)} m fuera del buffer${e.atEdge ? ", AL BORDE DEL BUFFER" : ""}`;
  return `${e.name || "Sin nombre"} (${formatMeters(e.distanceM)} m; ${edge})`;
}

function nearbyHtml(e) {
  const edge = e.atEdge
    ? `<span class="analysis-edge-flag">⚠ al borde: ${formatMeters(e.edgeM)} m fuera del buffer</span>`
    : `<span class="analysis-edge-dist">(${formatMeters(e.edgeM)} m fuera del buffer)</span>`;
  return `<div class="analysis-nearby-item"><strong>${escapeHtml(e.name || "Sin nombre")}</strong> · ${formatMeters(e.distanceM)} m ${edge}</div>`;
}

// meta: { incomplete } -- ver analyzeUploadedLayer.
function showAnalysisResults(u, results, meta = {}) {
  document.getElementById("analysis-subtitle").textContent =
    `${u.name} · buffer de ${bufferLabel(u.bufferMeters)} · estimación de cribado, no sustituye el análisis en QGIS`;

  const container = document.getElementById("analysis-results");

  const warningsHtml =
    (meta.incomplete ? `<p class="modal-note analysis-incomplete-note">⚠️ ${escapeHtml(ANALYSIS_INCOMPLETE_NOTE)}</p>` : "") +
    `<p class="modal-note analysis-coverage-note">ℹ️ ${escapeHtml(ANALYSIS_COVERAGE_NOTE)}</p>`;

  // Aviso de transparencia: que capas se acaban de activar en el panel
  // porque tuvieron cruce directo (ver el bloque "autoActivated" en
  // analyzeUploadedLayer) -- para que no sea una sorpresa silenciosa que
  // aparezcan casillas marcadas solas, y para dejar claro que asi la
  // cartografia exportada ahora si va a incluirlas.
  let autoActivatedHtml = "";
  if (u.autoActivatedLayers && u.autoActivatedLayers.length > 0) {
    const nombres = u.autoActivatedLayers.map((l) => escapeHtml(l.nombre)).join(", ");
    autoActivatedHtml = `<p class="modal-note analysis-autoactivated-note">✅ Se han activado en el mapa (panel de capas) las que tienen cruce directo y no estaban ya marcadas: ${nombres} -- así la cartografía que exportes las va a incluir. Desactívalas a mano si no las quieres en el plano.</p>`;
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

  let html = "";
  for (const nivel of ANALYSIS_NIVELES) {
    const rows = results.filter((r) => r.layer.nivel === nivel);
    const afectadas = rows.filter((r) => r.count > 0);
    const cercanas = rows.filter((r) => r.nearby.length > 0);
    html += `<div class="analysis-nivel-block"><h3>${NIVEL_LABEL[nivel]}</h3>`;
    if (afectadas.length === 0) {
      html += `<p class="analysis-empty">Sin afecciones detectadas en este nivel.</p>`;
    } else {
      html += `<table class="analysis-table"><thead><tr>
        <th>Sensibilidad</th><th>Capa</th><th>Elementos</th><th>Nombres / códigos</th><th>Long. afectada (m)</th><th>Superficie afectada (ha)</th><th>Confirmado en campo</th>
      </tr></thead><tbody>`;
      for (const r of afectadas) {
        const nombres = r.names.length ? escapeHtml(r.names.join(", ")) : "-";
        const ha = r.totalHa > 0 ? r.totalHa.toLocaleString("es-ES", { maximumFractionDigits: 2 }) : "-";
        html += `<tr>
          <td>${sensitivityBadgeHtml(r.sensitivity)}</td>
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
        </tr>`;
      }
      html += `</tbody></table>`;
    }
    html += `</div>`;
  }
  container.innerHTML = warningsHtml + autoActivatedHtml + controlsHtml + html;

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

  lastAnalysisResults = { u, results, meta };
  document.getElementById("analysis-modal-backdrop").hidden = false;
}

document.getElementById("analysis-close-btn").addEventListener("click", () => {
  document.getElementById("analysis-modal-backdrop").hidden = true;
});

// "Elementos cercanos fuera del buffer" lleva el NOMBRE de cada elemento
// con su distancia -- antes solo salia la distancia del mas cercano, sin
// decir a que (caso de prueba del puerto de Carboneras, §4.2).
const RESULTS_HEADER = [
  "Sensibilidad", "Nivel", "Capa", "Fuente", "Buffer aplicado (m)", "Elementos", "Nombres/códigos",
  "Longitud afectada (m)", "Superficie afectada (ha)", "Elementos cercanos fuera del buffer",
  "Distancia al más cercano (m)", "Confirmado en campo",
];

// Fila por capa afectada -- o, si no hay cruce directo pero se detecto
// algun elemento cerca (idea #4), una fila con Elementos=0 y los cercanos
// en vez de long./superficie. Una capa con cruce directo lista tambien sus
// cercanos de fuera. Tipos ya listos para CSV (todo texto) o Excel
// (numeros como numeros, no como texto) -- comparten esta funcion para no
// mantener la logica de "que va en cada columna" por duplicado.
function resultsToRows(u, results) {
  const fieldStatus = u.fieldStatus || {};
  const rows = [];
  for (const r of results) {
    if (r.count === 0 && r.nearby.length === 0) continue;
    rows.push([
      r.sensitivity,
      r.layer.nivel,
      r.layer.nombre,
      r.layer.fuente || "",
      r.bufferM,
      r.count,
      r.names.join(" | "),
      r.totalM > 0 ? Math.round(r.totalM * 10) / 10 : "",
      r.totalHa > 0 ? Math.round(r.totalHa * 1000) / 1000 : "",
      r.nearby.map(nearbyPlainText).join(" | "),
      r.nearestM != null ? Math.round(r.nearestM) : "",
      fieldStatus[r.layer.id] || FIELD_STATUS_OPTIONS[0],
    ]);
  }
  return rows;
}

// Notas de metodologia comunes al Excel (hoja "Info") y al informe PDF.
function analysisNotes(u, meta = {}) {
  const notes = [];
  if (meta.incomplete) notes.push(["AVISO", ANALYSIS_INCOMPLETE_NOTE]);
  notes.push(
    ["Nota", "Estimación de cribado a partir de teselas vectoriales — no sustituye el análisis en QGIS."],
    ["Buffer", `Buffer por defecto del tramo: ${bufferLabel(u.bufferMeters)}. Algunas capas pueden usar uno distinto — ver columna 'Buffer aplicado (m)'.`],
    ["Cercanos", `Elementos fuera del buffer hasta ${NEAREST_SEARCH_MARGIN_M / 1000} km más allá de él (como mucho ${NEARBY_MAX_PER_LAYER} por capa). La distancia se mide desde el trazado; se marca "AL BORDE DEL BUFFER" si queda a menos de 50 m o del 10 % del buffer fuera de su borde.`],
    ["Cobertura", ANALYSIS_COVERAGE_NOTE],
    ["Fuente y vigencia", "Cada capa indica su organismo de origen en la columna 'Fuente'. Confirmar la fecha de descarga vigente del catálogo con el equipo antes de una entrega final."],
    ["Sensibilidad", "Criterio interno de Quadrante (Muy Alta/Alta/Media/Baja), no una clasificación reglamentaria — pensado para priorizar qué hallazgo revisar primero, no sustituye el criterio del técnico ambiental."]
  );
  return notes;
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
  const exportable = results.filter((r) => r.count > 0 || r.nearby.length > 0);
  const rows = resultsToRows(u, results); // mismo filtro/orden que `exportable`

  // Color como columna aparte (idea #10: capa + fuente citables sin salir
  // del Excel) -- Buffer/Distancia/Confirmado en campo son las nuevas
  // columnas de las ideas #2/#4/#6 del informe de investigacion. La
  // Sensibilidad (idea #1) va primero, es lo primero que hay que mirar.
  const header = [
    "Sensibilidad", "Nivel", "Capa", "Color", "Fuente", "Buffer aplicado (m)", "Elementos", "Nombres/códigos",
    "Longitud afectada (m)", "Superficie afectada (ha)", "Elementos cercanos fuera del buffer",
    "Distancia al más cercano (m)", "Confirmado en campo",
  ];
  const tableRows = rows.map(([sensibilidad, nivel, capa, fuente, bufferM, count, nombres, m, ha, cercanos, dist, estado]) => [
    sensibilidad, nivel, capa, "", fuente, bufferM, count, nombres, m, ha, cercanos, dist, estado,
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

  [14, 6, 34, 4, 24, 12, 10, 45, 16, 16, 60, 16, 20].forEach((w, i) => {
    sheet.getColumn(i + 1).width = w;
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
      row.getCell(c).fill = { type: "pattern", pattern: "solid", fgColor: { argb: c === 4 ? layerColor : band } };
    }
    // Sensibilidad (col. 1) con su propio color de semaforo, texto blanco
    // en negrita para que se lea de un vistazo -- mismo criterio que la
    // columna Color (capa).
    row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: sensColor } };
    row.getCell(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    row.getCell(8).alignment = { wrapText: true, vertical: "top" };
    row.getCell(11).alignment = { wrapText: true, vertical: "top" };
    // Fila "cerca, sin cruce directo" (Elementos=0 con cercanos): en
    // cursiva para distinguirla de un cruce real de un vistazo.
    if (r.count === 0) {
      row.eachCell((cell) => { cell.font = { ...(cell.font || {}), italic: true }; });
    }
  });

  sheet.views = [{ state: "frozen", ySplit: 1 }];

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
