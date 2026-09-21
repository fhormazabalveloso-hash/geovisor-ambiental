// Catalogo de capas del visor. Debe reflejar pipeline/config.yaml y los
// nombres de "source-layer" reales dentro de cada .pmtiles (GDAL les pone
// el nombre del fichero de origen, no el id de la capa -- verificado con
// pmtiles.reader sobre cada archivo generado).
//
// nivel: 1 = afeccion juridica plena (cruce automatico obligatorio)
//        2 = afeccion estimada / con matiz (etiqueta metodologica)
//        3 = contexto (activable, no vinculante)
// color: propio de cada capa (no compartido por nivel) -- pensado para que
//        la cartografia exportada distinga cada capa individualmente.
// labelField: campo de atributo con el nombre del elemento concreto (p.ej.
//        el nombre de un espacio Red Natura, un rio, una via pecuaria).
//        null cuando la capa no trae un campo de nombre util -- verificado
//        contra los campos reales de cada .pmtiles (pmtiles.reader).

const LAYERS = [
  {
    id: "red_natura_2000",
    nombre: "Red Natura 2000 (ZEC + ZEPA)",
    tematica: "espacios_protegidos",
    nivel: 1,
    sourceLayer: "reproj",
    geom: "polygon",
    color: { fill: "#2E7D32", line: "#1B5E20" }, // verde oscuro
    labelField: "SITE_NAME",
    idField: "site_code", // ver analysis.js: agrupa fragmentos de la misma entidad
    visibleByDefault: false,
  },
  {
    id: "enp",
    nombre: "Espacios Naturales Protegidos (ENP)",
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
    id: "vias_pecuarias",
    nombre: "Vías Pecuarias (RGVP)",
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
    id: "dph_deslindado",
    nombre: "DPH deslindado",
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
    tematica: "hidrografia",
    nivel: 2,
    sourceLayer: "reproj",
    geom: "line",
    color: { fill: "#42A5F5", line: "#1976D2" }, // azul claro
    labelField: "nom_rio",
    idField: "OBJECTID",
    sortField: "Shape_Leng", // prioriza tramos mas largos: red muy densa, mucha competencia por hueco
    visibleByDefault: false,
  },
  {
    id: "hic",
    nombre: "Hábitats de Interés Comunitario (HIC)",
    tematica: "espacios_protegidos",
    nivel: 2,
    sourceLayer: "ESArt17_HabitDistrib",
    geom: "polygon",
    color: { fill: "#8E24AA", line: "#4A148C" }, // morado
    labelField: null, // malla de codigos de habitat, sin nombre propio
    visibleByDefault: false, // malla 10x10 = presencia, no delimitacion (README §5)
    // El fichero de origen trae un poligono repetido por cada codigo de
    // habitat presente en una misma celda 10x10 km (una celda con 40
    // codigos = 40 poligonos identicos). Sumar area de interseccion por
    // feature infla la superficie muchas veces (verificado con un caso de
    // prueba: 1.573 ha de "afeccion" en un buffer de 83 ha). analysis.js
    // usa este flag para no calcular superficie de esta capa y listar en
    // su lugar los codigos de habitat presentes (campo "Code").
    presenceOnly: true,
    analysisNameField: "Code",
  },
  {
    id: "humedales_turberas",
    nombre: "Humedales y turberas",
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
    id: "iba",
    nombre: "IBA - Áreas Importantes para las Aves",
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
