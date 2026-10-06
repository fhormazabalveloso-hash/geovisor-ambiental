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
// importancia: "Alta" / "Media" / "Baja" -- valor del elemento segun su
//        regimen legal, primer eje del semaforo de sensibilidad (ver
//        sensitivityFor en analysis.js). importanciaMotivo: el porque en
//        pocas palabras, que sale en la explicacion de cada resultado.
//        Rediseno del 2026-09-29, pedido por Francisco: la version anterior
//        (un nivel fijo por capa con dos ajustes) no se entendia -- no tenia
//        en cuenta cuanto se afecta ni si la obra PISA el elemento o solo
//        cae en su buffer. Ahora: sensibilidad = importancia x como lo toca
//        la obra (directa / en el entorno / proxima), con el "cuanto"
//        siempre visible (ha, m, % del espacio). Se inspira en la matriz
//        valor x magnitud de las EIA en Espana (Conesa) y en PMST
//        (Australia), que separa "en el area del proyecto" de "solo en el
//        buffer". ES CRITERIO DE QUADRANTE, no una clasificacion
//        reglamentaria: ajustar estas importancias corresponde al equipo
//        ambiental.
//        - Alta: proteccion estricta, casi siempre obliga a una evaluacion
//          especifica (Red Natura, ENP, zonas humedas, humedales -- estos a
//          peticion de Francisco --, zona de flujo preferente, T10).
//        - Media: dominio publico o limitacion de usos, pide autorizacion de
//          un organismo (DPH, cauces, vias pecuarias, T100/T500, costeras).
//        - Baja: informativo (hoy ninguna capa analizada).
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
const SNCZI_FUENTE = "MITECO - SNCZI, servicio en línea";
const FLOOD_LAYERS = [
  {
    id: "zi_costera_t500",
    nombre: "Zona inundable costera T500",
    fuente: SNCZI_FUENTE,
    importancia: "Media",
    importanciaMotivo: "inundable desde el mar, probabilidad baja",
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
    importancia: "Media",
    importanciaMotivo: "inundable desde el mar, probabilidad media",
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
    importancia: "Media",
    importanciaMotivo: "zona inundable a efectos del RDPH",
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
    importancia: "Media",
    importanciaMotivo: "inundable con probabilidad media",
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
    importancia: "Alta",
    importanciaMotivo: "inundable con alta probabilidad",
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
    importancia: "Alta",
    importanciaMotivo: "usos muy restringidos por el RDPH",
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

// Infraestructuras (rama avanzado, 2026-10-05): red ferroviaria y carreteras
// del Estado con sus PK, de la Red de Transporte del IGN (ver
// pipeline/build_infraestructuras.py). Nivel 3: son contexto, no afecciones
// ambientales, asi que el analisis no las cruza (ANALYSIS_NIVELES en
// analysis.js). Al final del array: se dibujan por encima de todo, como en un
// plano de proyecto.
// pk: puntos kilometricos, en el mismo .pmtiles (source-layer "pk"), con
//   circulo desde PK_MIN_ZOOM y etiqueta ("L100 PK 17+500") desde
//   PK_LABEL_MIN_ZOOM (main.js). El nombre de la linea va A LO LARGO de la
//   propia linea (lineLabelField), no en un punto aparte como el resto.
// dash: trazo discontinuo (el ferrocarril, para distinguirlo de la carretera).
const INFRA_LAYERS = [
  {
    id: "ffcc",
    nombre: "Red ferroviaria",
    fuente: "IGN - Red de Transporte (PK de ADIF)",
    tematica: "infraestructuras",
    nivel: 3,
    sourceLayer: "lineas",
    geom: "line",
    color: { fill: "#546E7A", line: "#263238" }, // gris pizarra
    labelField: "nombre",
    lineLabelField: "nombre",
    dash: [3, 1.5],
    pk: { sourceLayer: "pk", labelField: "etiqueta" },
    visibleByDefault: false,
  },
  {
    id: "carreteras_estado",
    nombre: "Carreteras del Estado",
    fuente: "IGN - Red de Transporte (PK de la DGC y la DGT)",
    tematica: "infraestructuras",
    nivel: 3,
    sourceLayer: "lineas",
    geom: "line",
    color: { fill: "#E57373", line: "#B71C1C" }, // rojo oscuro, como en los mapas de carreteras
    labelField: "nombre",
    lineLabelField: "nombre",
    pk: { sourceLayer: "pk", labelField: "etiqueta" },
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
    importancia: "Alta",
    importanciaMotivo: "exige evaluar las repercusiones sobre el espacio",
    // areaHaField: superficie total del elemento en ha segun el dato de
    // origen, para dar el "cuanto" tambien en % del espacio (ver
    // analysis.js). Solo en capas que la traen.
    areaHaField: "HECTAREAS",
    visibleByDefault: false,
  },
  {
    id: "enp",
    nombre: "Espacios naturales protegidos",
    fuente: "MITECO / REDIAM",
    importancia: "Alta",
    importanciaMotivo: "régimen de protección propio",
    areaHaField: "Sup_ha",
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
    importancia: "Media",
    importanciaMotivo: "dominio público: autorización del organismo de cuenca",
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
    importancia: "Alta",
    importanciaMotivo: "zona húmeda inventariada",
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
    importancia: "Media",
    importanciaMotivo: "cauce con zona de policía de 100 m",
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
    importancia: "Alta",
    importanciaMotivo: "hábitat húmedo sensible; vigencia del dato por confirmar",
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
    importancia: "Media",
    importanciaMotivo: "dominio público pecuario: autorización de la comunidad autónoma",
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
  ...(FEATURES.infraestructuras ? INFRA_LAYERS : []),
];

// Semaforo de sensibilidad (ver nota junto a "importancia" mas arriba) --
// de menor a mayor, para poder subir/bajar un escalon por indice en
// sensitivityFor (analysis.js).
const SENSITIVITY_LEVELS = ["Baja", "Media", "Alta", "Muy Alta"];
const IMPORTANCIA_LEVELS = ["Baja", "Media", "Alta"];

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
const TEMATICA_ORDER = ["espacios_protegidos", "hidrografia", "inundabilidad", "patrimonio_natural", "contexto", "infraestructuras"];

const TEMATICA_LABEL = {
  espacios_protegidos: "Espacios protegidos",
  hidrografia: "Hidrografía",
  inundabilidad: "Zonas inundables (en línea)",
  patrimonio_natural: "Patrimonio natural",
  contexto: "Contexto",
  infraestructuras: "Infraestructuras",
};
