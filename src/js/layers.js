// Catalogo de capas del visor. Debe reflejar pipeline/config.yaml y los
// nombres de "source-layer" reales dentro de cada .pmtiles (GDAL les pone
// el nombre del fichero de origen, no el id de la capa -- verificado con
// pmtiles.reader sobre cada archivo generado).
//
// tematica: agrupacion de cara al usuario en el panel de capas (README
//        §5) -- espacios_protegidos / hidrografia / patrimonio_natural /
//        contexto. Es la clave de agrupacion PRINCIPAL del panel.
// nivel: 1 = afeccion juridica plena (cruce automatico obligatorio)
//        2 = afeccion estimada / con matiz (etiqueta metodologica)
//        3 = contexto (activable, no vinculante)
//        Metadato de cada capa (se muestra como etiqueta en su fila del
//        panel), ya no es la agrupacion principal -- ver TEMATICA_ORDER.
// color: propio de cada capa (no compartido por nivel) -- pensado para que
//        la cartografia exportada distinga cada capa individualmente.
// labelField: campo de atributo con el nombre del elemento concreto (p.ej.
//        el nombre de un espacio Red Natura, un rio, una via pecuaria).
//        null cuando la capa no trae un campo de nombre util -- verificado
//        contra los campos reales de cada .pmtiles (pmtiles.reader).
// fuente: organismo de origen del dato (tabla del README §5), mostrado como
//        columna en el CSV/Excel de afecciones (analysis.js) para que la
//        tabla exportada sea citable sin tener que ir a buscarlo aparte
//        (idea #10 de investigacion/ideas-mejora-geovisores-referencia.md).
// suggestedBufferM: buffer que aparece preseleccionado para esta capa en el
//        analisis de afecciones (analysis.js), en vez del buffer general
//        del tramo -- para criterios con una distancia reglamentaria propia
//        (p.ej. zona de policia de cauces). El usuario puede cambiarlo por
//        capa antes de analizar; si no esta definido, usa el buffer del
//        tramo (idea #2 de investigacion/ideas-mejora-geovisores-referencia.md).
// sensitivityBase: nivel de sensibilidad (ver SENSITIVITY_LEVELS mas abajo)
//        que se muestra por defecto para un hallazgo de esta capa en el
//        analisis de afecciones -- semaforo de sensibilidad (idea #1 de
//        investigacion/ideas-mejora-geovisores-referencia.md). Investigado
//        (2026-09-24) como funciona realmente la herramienta de referencia
//        (South Africa National Web-Based Environmental Screening Tool):
//        NO calcula la sensibilidad en vivo a partir de la geometria del
//        proyecto -- cruza el sitio contra un mapa nacional PRE-clasificado
//        por ecologos (Critical Biodiversity Areas / Ecological Support
//        Areas de SANBI), y reporta un nivel POR TEMA/CAPA, no un unico
//        score agregado para todo el proyecto. Aqui no tenemos ese mapa de
//        sensibilidad independiente, asi que la mejor aproximacion honesta
//        es un valor fijo por capa (no calculado a partir de hectareas/
//        metros cruzados -- eso seria precision falsa que ni la propia
//        herramienta de referencia usa). ES UNA PROPUESTA DE QUADRANTE, no
//        una clasificacion reglamentaria -- ajustar el criterio ambiental
//        real corresponde a Francisco/el equipo, no a este codigo. Dos
//        matices SI se calculan en analysis.js a partir de datos que ya
//        tenemos (ver computeSensitivity): (a) un hallazgo "cerca, sin
//        cruce directo" (idea #4) baja un escalon desde este valor base;
//        (b) en red_natura_2000, un cruce con TIPO=C (ZEC+ZEPA a la vez)
//        sube un escalon (doble designacion = valores combinados mas
//        amplios).
//
// Orden del array = orden de dibujo en el mapa (el ultimo elemento se
// dibuja encima). Agrupado por tematica (para que coincida con el panel:
// ver moveLayerInHierarchy en main.js, que solo permite reordenar dentro
// de la misma tematica) y, dentro de cada tematica, por nivel ascendente.
// El grupo "contexto" queda el ultimo a proposito: son lineas de
// referencia (limites, nucleos) que conviene ver por encima de los
// rellenos de las demas capas.

// wfs: capa EN LINEA, consultada en vivo al servicio WFS de MITECO (ver
//        wfs-layers.js) en vez de teselada en data-web/. { typeName }. En el
//        mapa se carga solo para la vista actual; en el analisis se pide
//        directamente al servicio para el area de busqueda, sin depender de
//        lo dibujado. Las geometrias vienen con 4 decimales (~10 m).

// Zonas inundables del SNCZI (2026-09-29). Las primeras del array para que se
// dibujen por DEBAJO del resto (son manchas grandes que taparian espacios
// protegidos y rios); en el panel van en su propio grupo, despues de
// hidrografia (ver TEMATICA_ORDER). Solo existen para los tramos estudiados
// por el SNCZI -- ver ANALYSIS_FLOOD_COVERAGE_NOTE en analysis.js.
const SNCZI_FUENTE = "MITECO - SNCZI (servicio en línea)";
const FLOOD_LAYERS = [
  {
    id: "zi_costera_t500",
    nombre: "Zona inundable costera T500",
    fuente: SNCZI_FUENTE,
    sensitivityBase: "Baja",
    tematica: "inundabilidad",
    nivel: 2,
    geom: "polygon",
    color: { fill: "#B2EBF2", line: "#4DB6C4" },
    labelField: "zona",
    idField: "id_zona",
    wfs: { typeName: "costas:zim_laminas_q500" },
    visibleByDefault: false,
  },
  {
    id: "zi_costera_t100",
    nombre: "Zona inundable costera T100",
    fuente: SNCZI_FUENTE,
    sensitivityBase: "Media",
    tematica: "inundabilidad",
    nivel: 2,
    geom: "polygon",
    color: { fill: "#00ACC1", line: "#00838F" },
    labelField: "zona",
    idField: "id_zona",
    wfs: { typeName: "costas:zim_laminas_q100" },
    visibleByDefault: false,
  },
  {
    id: "zi_t500",
    nombre: "Zona inundable T500",
    fuente: SNCZI_FUENTE,
    sensitivityBase: "Media", // zona inundable a efectos del RDPH (art. 14)
    tematica: "inundabilidad",
    nivel: 2,
    geom: "polygon",
    color: { fill: "#90CAF9", line: "#5C9BD5" },
    labelField: "zona",
    idField: "id_zona",
    wfs: { typeName: "agua:Zi_laminas_q500" },
    visibleByDefault: false,
  },
  {
    id: "zi_t100",
    nombre: "Zona inundable T100",
    fuente: SNCZI_FUENTE,
    sensitivityBase: "Media",
    tematica: "inundabilidad",
    nivel: 2,
    geom: "polygon",
    color: { fill: "#1E88E5", line: "#1565C0" },
    labelField: "zona",
    idField: "id_zona",
    wfs: { typeName: "agua:Zi_laminas_q100" },
    visibleByDefault: false,
  },
  {
    id: "zi_t10",
    nombre: "Zona inundable T10",
    fuente: SNCZI_FUENTE,
    sensitivityBase: "Alta", // alta probabilidad
    tematica: "inundabilidad",
    nivel: 2,
    geom: "polygon",
    color: { fill: "#283593", line: "#1A237E" },
    labelField: "zona",
    idField: "id_zona",
    wfs: { typeName: "agua:Zi_laminas_q10" },
    visibleByDefault: false,
  },
  {
    id: "zi_zfp",
    nombre: "Zona de flujo preferente",
    fuente: SNCZI_FUENTE,
    sensitivityBase: "Alta", // usos restringidos por el RDPH (art. 9 bis)
    tematica: "inundabilidad",
    nivel: 2,
    geom: "polygon",
    color: { fill: "#AD1457", line: "#880E4F" },
    labelField: "zona",
    idField: "id_zona",
    wfs: { typeName: "agua:ZI_Laminas_ZFP" },
    visibleByDefault: false,
  },
];

const LAYERS = [
  ...FLOOD_LAYERS,
  {
    id: "red_natura_2000",
    nombre: "Red Natura 2000",
    fuente: "MITECO / REDIAM",
    tematica: "espacios_protegidos",
    nivel: 1,
    sourceLayer: "reproj",
    geom: "polygon",
    color: { fill: "#2E7D32", line: "#1B5E20" }, // verde oscuro -- swatch del panel y color por defecto si TIPO trae un valor inesperado
    // El campo TIPO distingue ZEC/ZEPA/ambas. Verificado contra los
    // metadatos completos del .pmtiles (no solo lo visible en pantalla):
    // exactamente 3 valores en todo el catalogo, A/B/C. Correspondencia
    // segun la convencion estandar del dataset europeo Natura 2000 (de
    // donde MITECO/REDIAM deriva el suyo) -- no confirmada con un
    // diccionario de datos explicito de este fichero en concreto, pero
    // es una convencion muy establecida y los 3 valores encajan
    // exactamente (p. ej. "Doñana" = C, ZEC+ZEPA a la vez, como se sabe
    // que es en la realidad). Ver main.js (colorExpression) y export.js
    // (leyenda de la cartografia exportada).
    colorByField: "TIPO",
    colorByValue: {
      A: { fill: "#D84315", line: "#8C2C0D", label: "ZEPA" }, // naranja -- solo Directiva Aves
      B: { fill: "#2E7D32", line: "#1B5E20", label: "ZEC" }, // verde -- solo Directiva Habitats
      // Morado en vez de rojo (decision 2026-09-23: el rojo se leia como
      // alarma/prohibicion, no como "las dos categorias a la vez"). Libre
      // desde que se quito HIC, que era la unica otra capa morada.
      C: { fill: "#6A1B9A", line: "#4A148C", label: "ZEC + ZEPA" },
    },
    labelField: "SITE_NAME",
    idField: "site_code", // ver analysis.js: agrupa fragmentos de la misma entidad
    sensitivityBase: "Alta", // sube a "Muy Alta" si TIPO=C (ver nota junto a sensitivityBase mas arriba)
    visibleByDefault: false,
  },
  {
    id: "enp",
    nombre: "Espacios naturales protegidos",
    fuente: "MITECO / REDIAM",
    sensitivityBase: "Alta",
    tematica: "espacios_protegidos",
    nivel: 1,
    sourceLayer: "Enp2025_p",
    geom: "polygon",
    color: { fill: "#66BB6A", line: "#2E7D32" }, // verde medio
    labelField: "SITE_NAME",
    idField: "SITE_CDDA", // codigo CDDA (base de datos europea de areas designadas)
    visibleByDefault: false,
  },
  {
    id: "dph_deslindado",
    // "deslindado" se mantiene a proposito: la capa solo trae los tramos con
    // deslinde oficial, y sin la palabra se leeria como todo el DPH.
    nombre: "Dominio público hidráulico deslindado",
    fuente: "CHG / confederaciones hidrográficas",
    sensitivityBase: "Media", // vinculante (Nivel 1), pero es un criterio hidrologico/dominio publico, no biodiversidad directa
    tematica: "hidrografia",
    nivel: 1,
    sourceLayer: "DPH_DESLINDADO_20250319",
    geom: "polygon",
    color: { fill: "#1565C0", line: "#0D47A1" }, // azul fuerte
    labelField: "RIO",
    idField: "ID_ZONA",
    visibleByDefault: false,
  },
  {
    id: "iezh",
    nombre: "Zonas húmedas",
    fuente: "MITECO",
    sensitivityBase: "Alta",
    tematica: "hidrografia",
    nivel: 1,
    sourceLayer: "IEZH_P_2025",
    geom: "polygon",
    color: { fill: "#26A69A", line: "#00695C" }, // verde azulado
    labelField: "IEZH_NAME",
    idField: "OBJECTID",
    visibleByDefault: false,
  },
  {
    id: "red_hidrografica",
    nombre: "Red hidrográfica",
    fuente: "MITECO (Pfafstetter)",
    sensitivityBase: "Media", // ya es Nivel 2/estimado en el proyecto
    tematica: "hidrografia",
    nivel: 2,
    sourceLayer: "reproj",
    geom: "line",
    color: { fill: "#42A5F5", line: "#1976D2" }, // azul claro
    labelField: "nom_rio",
    idField: "OBJECTID",
    sortField: "Shape_Leng", // prioriza tramos mas largos: red muy densa, mucha competencia por hueco
    // Buffer sugerido en el analisis de afecciones (ver analysis.js): 100 m
    // = zona de policia presunta (art. 6 RDPH) donde no hay DPH deslindado,
    // ya documentado como criterio del proyecto en README §6. El usuario
    // puede cambiarlo por capa antes de analizar -- esto es solo el valor
    // que aparece preseleccionado.
    suggestedBufferM: 100,
    visibleByDefault: false,
  },
  {
    id: "humedales_turberas",
    nombre: "Humedales y turberas",
    fuente: "MITECO (complementario a IEZH, vigencia/validez por confirmar)",
    sensitivityBase: "Media", // la propia fuente ya la marca como de validez por confirmar -- no le damos "Alta" con un dato que dudamos nosotros mismos
    tematica: "hidrografia",
    nivel: 2,
    sourceLayer: "Humedal_TurberaBCAM2_2025",
    geom: "polygon",
    color: { fill: "#00838F", line: "#004D50" }, // cian oscuro
    labelField: null, // el fichero de origen no trae campo de nombre
    // Sin idField: el origen solo trae "AC" (comunidad autonoma) y
    // "Superficie", ningun campo sirve como identificador de entidad.
    // analysis.js no puede agrupar fragmentos de la misma entidad aqui
    // (ver nota sobre margen de tesela MVT) -- superficie puede estar
    // ligeramente sobreestimada si un humedal grande cae en el borde de
    // varias teselas dentro del buffer.
    visibleByDefault: false,
  },
  {
    id: "vias_pecuarias",
    nombre: "Vías pecuarias",
    fuente: "MITECO / REDIAM",
    sensitivityBase: "Media", // proteccion real, pero de otra naturaleza (servidumbre de paso/patrimonio) que la de un habitat
    tematica: "patrimonio_natural",
    nivel: 1,
    sourceLayer: "RGVP_BDN_2024",
    geom: "line",
    color: { fill: "#A1662F", line: "#6D4520" }, // marron
    labelField: "nb_via",
    idField: "id_cod_vp",
    sortField: "nm_long", // prioriza tramos mas largos cuando compiten por espacio la etiqueta
    visibleByDefault: false,
  },
  {
    id: "iba",
    nombre: "Áreas importantes para las aves",
    fuente: "SEO/BirdLife",
    tematica: "contexto",
    nivel: 3,
    sourceLayer: "IBA España",
    geom: "polygon",
    color: { fill: "#F9A825", line: "#B45F06" }, // ambar
    labelField: "NatName",
    visibleByDefault: false,
  },
  {
    id: "nucleos_urbanos",
    nombre: "Núcleos urbanos",
    fuente: "CNIG",
    tematica: "contexto",
    nivel: 3,
    sourceLayer: "reproj",
    geom: "polygon",
    color: { fill: "#757575", line: "#424242" }, // gris
    labelField: null, // el nombre vive en otra sub-tabla del GPKG de origen
    visibleByDefault: false,
  },
  // Las lineas limite municipales/provinciales/autonomicas se retiraron del
  // visor (2026-09-29, decision de Francisco): aportaban poco sobre la
  // ortofoto. El mapa de situacion de la cartografia usa ahora poligonos de
  // provincia (data-web/situacion_provincias.geojson, generado por
  // pipeline/build_situacion.py) -- ver captureInset en export.js. Los
  // limites_*.pmtiles siguen en data-web/ por si se retoman.
];

// Semaforo de sensibilidad (idea #1, ver nota junto a sensitivityBase mas
// arriba) -- de menor a mayor, para poder comparar/subir-bajar un escalon
// por indice en computeSensitivity (analysis.js).
const SENSITIVITY_LEVELS = ["Baja", "Media", "Alta", "Muy Alta"];

const SENSITIVITY_COLOR = {
  "Baja": "#2E7D32", // verde
  "Media": "#F9A825", // amarillo/ambar
  "Alta": "#EF6C00", // naranja
  "Muy Alta": "#C62828", // rojo
};

const NIVEL_LABEL = {
  1: "Nivel 1 - Afección plena",
  2: "Nivel 2 - Afección estimada",
  3: "Nivel 3 - Contexto",
};

// Etiqueta corta para la insignia de nivel en cada fila del panel (ver
// buildLayerPanel en main.js) -- NIVEL_LABEL es demasiado largo para eso.
const NIVEL_BADGE = {
  1: "N1",
  2: "N2",
  3: "N3",
};

// Orden y etiquetas de los grupos del panel de capas (README §5: se
// agrupa por tematica de cara al usuario, con el nivel juridico como
// metadato). "contexto" va el ultimo a proposito -- ver nota junto a
// LAYERS sobre orden de dibujo.
const TEMATICA_ORDER = ["espacios_protegidos", "hidrografia", "inundabilidad", "patrimonio_natural", "contexto"];

const TEMATICA_LABEL = {
  espacios_protegidos: "Espacios protegidos",
  hidrografia: "Hidrografía",
  inundabilidad: "Zonas inundables (en línea)",
  patrimonio_natural: "Patrimonio natural",
  contexto: "Contexto",
};
