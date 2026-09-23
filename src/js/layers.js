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
//
// Orden del array = orden de dibujo en el mapa (el ultimo elemento se
// dibuja encima). Agrupado por tematica (para que coincida con el panel:
// ver moveLayerInHierarchy en main.js, que solo permite reordenar dentro
// de la misma tematica) y, dentro de cada tematica, por nivel ascendente.
// El grupo "contexto" queda el ultimo a proposito: son lineas de
// referencia (limites, nucleos) que conviene ver por encima de los
// rellenos de las demas capas.

const LAYERS = [
  {
    id: "red_natura_2000",
    nombre: "Red Natura 2000 (ZEC + ZEPA)",
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
    visibleByDefault: false,
  },
  {
    id: "enp",
    nombre: "Espacios Naturales Protegidos (ENP)",
    fuente: "MITECO / REDIAM",
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
    nombre: "DPH deslindado",
    fuente: "CHG / confederaciones hidrográficas",
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
    nombre: "Zonas Húmedas (IEZH)",
    fuente: "MITECO",
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
    nombre: "Red hidrográfica (Pfafstetter)",
    fuente: "MITECO (Pfafstetter)",
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
    nombre: "Vías Pecuarias (RGVP)",
    fuente: "MITECO / REDIAM",
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
    nombre: "IBA - Áreas Importantes para las Aves",
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
  {
    id: "limites_municipales",
    nombre: "Límites municipales",
    fuente: "CNIG",
    tematica: "contexto",
    nivel: 3,
    sourceLayer: "reproj",
    geom: "line",
    color: { fill: "#BDBDBD", line: "#9E9E9E" }, // gris claro
    labelField: null, // son lineas de limite, no poligonos de unidad -- etiquetar el borde no aporta
    visibleByDefault: false,
  },
  {
    id: "limites_provinciales",
    nombre: "Límites provinciales",
    fuente: "CNIG",
    tematica: "contexto",
    nivel: 3,
    sourceLayer: "reproj",
    geom: "line",
    color: { fill: "#9E9E9E", line: "#757575" }, // gris medio
    labelField: null,
    visibleByDefault: false,
  },
  {
    id: "limites_autonomicos",
    nombre: "Límites autonómicos",
    fuente: "CNIG",
    tematica: "contexto",
    nivel: 3,
    sourceLayer: "reproj",
    geom: "line",
    color: { fill: "#616161", line: "#424242" }, // gris oscuro
    labelField: null,
    visibleByDefault: false,
  },
];

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
const TEMATICA_ORDER = ["espacios_protegidos", "hidrografia", "patrimonio_natural", "contexto"];

const TEMATICA_LABEL = {
  espacios_protegidos: "Espacios protegidos",
  hidrografia: "Hidrografía",
  patrimonio_natural: "Patrimonio natural",
  contexto: "Contexto",
};
