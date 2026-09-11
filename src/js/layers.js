// Catalogo de capas del visor. Debe reflejar pipeline/config.yaml y los
// nombres de "source-layer" reales dentro de cada .pmtiles (GDAL les pone
// el nombre del fichero de origen, no el id de la capa -- verificado con
// pmtiles.reader sobre cada archivo generado).
//
// nivel: 1 = afeccion juridica plena (cruce automatico obligatorio)
//        2 = afeccion estimada / con matiz (etiqueta metodologica)
//        3 = contexto (activable, no vinculante)

const NIVEL_COLOR = {
  1: { fill: "#C0392B", line: "#7B241C" }, // rojo -- afeccion plena
  2: { fill: "#E08E1D", line: "#9C6110" }, // ambar -- estimada
  3: { fill: "#5D7A99", line: "#3B4F63" }, // gris-azulado -- contexto
};

const LAYERS = [
  {
    id: "red_natura_2000",
    nombre: "Red Natura 2000 (ZEC + ZEPA)",
    tematica: "espacios_protegidos",
    nivel: 1,
    sourceLayer: "reproj",
    geom: "polygon",
    visibleByDefault: true,
  },
  {
    id: "enp",
    nombre: "Espacios Naturales Protegidos (ENP)",
    tematica: "espacios_protegidos",
    nivel: 1,
    sourceLayer: "Enp2025_p",
    geom: "polygon",
    visibleByDefault: true,
  },
  {
    id: "vias_pecuarias",
    nombre: "Vías Pecuarias (RGVP)",
    tematica: "patrimonio_natural",
    nivel: 1,
    sourceLayer: "RGVP_BDN_2024",
    geom: "line",
    visibleByDefault: true,
  },
  {
    id: "dph_deslindado",
    nombre: "DPH deslindado",
    tematica: "hidrografia",
    nivel: 1,
    sourceLayer: "DPH_DESLINDADO_20250319",
    geom: "polygon",
    visibleByDefault: true,
  },
  {
    id: "iezh",
    nombre: "Zonas Húmedas (IEZH)",
    tematica: "hidrografia",
    nivel: 1,
    sourceLayer: "IEZH_P_2025",
    geom: "polygon",
    visibleByDefault: true,
  },
  {
    id: "red_hidrografica",
    nombre: "Red hidrográfica (Pfafstetter)",
    tematica: "hidrografia",
    nivel: 2,
    sourceLayer: "reproj",
    geom: "line",
    visibleByDefault: true,
  },
  {
    id: "hic",
    nombre: "Hábitats de Interés Comunitario (HIC)",
    tematica: "espacios_protegidos",
    nivel: 2,
    sourceLayer: "ESArt17_HabitDistrib",
    geom: "polygon",
    visibleByDefault: false, // malla 10x10 = presencia, no delimitacion (README §5)
  },
  {
    id: "humedales_turberas",
    nombre: "Humedales y turberas",
    tematica: "hidrografia",
    nivel: 2,
    sourceLayer: "Humedal_TurberaBCAM2_2025",
    geom: "polygon",
    visibleByDefault: true,
  },
  {
    id: "iba",
    nombre: "IBA — Áreas Importantes para las Aves",
    tematica: "contexto",
    nivel: 3,
    sourceLayer: "IBA España",
    geom: "polygon",
    visibleByDefault: false,
  },
  {
    id: "nucleos_urbanos",
    nombre: "Núcleos urbanos",
    tematica: "contexto",
    nivel: 3,
    sourceLayer: "reproj",
    geom: "polygon",
    visibleByDefault: false,
  },
  {
    id: "limites_municipales",
    nombre: "Límites municipales",
    tematica: "contexto",
    nivel: 3,
    sourceLayer: "reproj",
    geom: "line",
    visibleByDefault: false,
  },
  {
    id: "limites_provinciales",
    nombre: "Límites provinciales",
    tematica: "contexto",
    nivel: 3,
    sourceLayer: "reproj",
    geom: "line",
    visibleByDefault: true,
  },
  {
    id: "limites_autonomicos",
    nombre: "Límites autonómicos",
    tematica: "contexto",
    nivel: 3,
    sourceLayer: "reproj",
    geom: "line",
    visibleByDefault: true,
  },
];

const NIVEL_LABEL = {
  1: "Nivel 1 — Afección plena",
  2: "Nivel 2 — Afección estimada",
  3: "Nivel 3 — Contexto",
};
