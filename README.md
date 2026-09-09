# Geovisor Ambiental — Especificación del proyecto

> Documento de arranque y memoria viva del proyecto.
> Léelo al inicio de cada sesión para no perder el contexto.
> Autor: Francisco Hormazábal Veloso · Quadrante (Meta Engineering)

---

## 1. Qué es este proyecto

Conjunto de herramientas geoespaciales web para el trabajo de análisis de
afecciones ambientales y producción de cartografía en licitaciones de obra
lineal (ferroviario ADIF y carretera). Todo con **software libre**, sin
licencias ESRI y sin servidores de pago (arquitectura *zero-server*,
despliegue en GitHub Pages).

El proyecto tiene **tres componentes** independientes pero relacionados:

1. **Geovisor Ambiental de afecciones** *(principal, en desarrollo)*
   Carga de capas ambientales nacionales, subida del tramo/punto de la
   actuación, análisis automático de afecciones y exportación de
   cartografía lista para la memoria.

2. **Geovisor de proyectos / portfolio** *(planificado)*
   Visualización de los proyectos de Quadrante (ganados / presentados a
   licitación / en curso) por temática. Origen: exportación KML/KMZ de
   Google MyMaps → convertido a algo profesional.

3. **Sistematizaciones de Medio Ambiente** *(futuro, otro entorno)*
   Flujos de procesamiento en Python (entorno Miniforge3/conda). Se
   abordará por separado.

Este documento se centra en el **Componente 1**.

---

## 2. Historia y decisiones tomadas

- Se construyeron varias versiones iterando en formato HTML único con datos
  GeoJSON **embebidos**. Funcionó para Andalucía (~50 MB) pero **no escala a
  nivel nacional**.
- Aprendizaje clave: **peticiones `fetch()` a WMS/WFS externos fallan desde
  un `file://` local** por seguridad del navegador. Por eso los datos
  críticos van **locales** (GeoJSON / teselas), y solo se dejan como WMS las
  capas de referencia estables (IGN, PNOA, Catastro).
- Ahora se da el salto de arquitectura: proyecto versionado en **Git +
  GitHub**, con **despliegue en GitHub Pages** y, muy probablemente,
  migración a **MapLibre GL JS + teselas vectoriales** para manejar datos
  nacionales con fluidez.
- **(2026-09-09) Decisión cerrada: MapLibre GL JS + PMTiles.** Leaflet no
  escala bien con datasets nacionales de miles de features (renderiza
  geometría a geometría vía SVG/Canvas); MapLibre renderiza teselas
  vectoriales por WebGL. Se usa **PMTiles** (formato de un solo archivo,
  servido por HTTP range requests) porque encaja exactamente con
  *zero-server*: GitHub Pages sirviendo un `.pmtiles` es toda la
  infraestructura de teselas necesaria, sin servidor de teselas. Pipeline:
  QGIS/GDAL → **tippecanoe** (`.mbtiles`) → `pmtiles convert` (`.pmtiles`).
  Las capas WMS/WMTS de referencia (PNOA, IGN, Catastro) se mantienen como
  *raster source* en MapLibre. Migración de plugins: `leaflet-omnivore` →
  `@tmcw/togeojson` (KML/GPX); dibujo/edición → `mapbox-gl-draw`. `shpjs` y
  `Turf.js` no cambian (agnósticos del motor de mapa).

---

## 3. Arquitectura objetivo

```
DATOS EN BRUTO (fuera de Git)         →  PIPELINE          →  DATOS WEB (ligeros)
catálogo nacional descargado             conversión,          teselas vectoriales
(GeoJSON/GPKG grandes)                    simplificación,      o GeoJSON recortado
                                          reproyección 4326    por zona
                                                                     ↓
                                                            VISOR (MapLibre/Leaflet)
                                                            desplegado en GitHub Pages
```

**Reglas de arquitectura:**

- Los datos pesados **NO entran en Git** (Git no gestiona bien archivos
  grandes). Van en carpeta aparte o en almacenamiento externo.
- A GitHub Pages solo sube el **visor + datos ya optimizados y ligeros**.
- Todo dato para web va reproyectado a **EPSG:4326 (WGS84)**.
- El trabajo técnico y los planos finales siguen en **QGIS con EPSG:25830
  (ETRS89 UTM 30N)**; el visor es para análisis, exploración y borradores.

**Stack tecnológico (código abierto):**

- Motor de mapa: **MapLibre GL JS** (decidido 2026-09-09; sustituye a Leaflet)
- Análisis espacial client-side: **Turf.js**
- Lectura de archivos: shpjs (SHP en ZIP), @tmcw/togeojson (KML/GPX), mapbox-gl-draw (dibujo/edición)
- Datos: teselas vectoriales **PMTiles** (vía tippecanoe + pmtiles CLI) / GeoJSON recortado para capas pequeñas
- Versionado: **Git + GitHub**
- Despliegue: **GitHub Pages**
- Preparación de datos: QGIS + Python (GDAL/ogr2ogr, tippecanoe para teselas)

---

## 4. Estructura de carpetas propuesta

```
Geovisor Ambiental/
├── README.md                ← este documento
├── docs/                    ← metodología, notas, capturas
├── src/                     ← código del visor (HTML/JS/CSS separados)
│   ├── index.html
│   ├── js/
│   ├── css/
│   └── assets/              ← logos SVG Quadrante, flecha norte
├── data-web/                ← datos LIGEROS y optimizados (sí van a Pages)
├── data-raw/                ← catálogo nacional en bruto (NO va a Git → .gitignore)
└── pipeline/                ← scripts de conversión de datos
```

`.gitignore` debe excluir `data-raw/` y cualquier dato > ~50 MB.

---

## 5. Catálogo de datos (nacional, por temática)

Organización recomendada: **agrupación por temática de cara al usuario**, con
el **nivel jurídico como propiedad (metadato) de cada capa**. El análisis de
afecciones usa el nivel jurídico para decidir el comportamiento.

### Nivel 1 — Afección jurídica plena (cruce automático obligatorio)

| Capa | Fuente | Notas |
|---|---|---|
| Red Natura 2000 (ZEC + ZEPA) | MITECO / REDIAM | campo `FIGURA` distingue ZEC/ZEPA/LIC |
| Espacios Naturales Protegidos (ENP) | MITECO / REDIAM | figuras estatales y autonómicas |
| Vías Pecuarias (Red General - RGVP) | MITECO / REDIAM | verificar cobertura por CCAA |
| Montes de Utilidad Pública (CMUP/IEPF) | MITECO | dominio público forestal |
| DPH deslindado | CHG / confederaciones | **validez jurídica plena** |
| Inventario Español de Zonas Húmedas (IEZH) | MITECO | |

### Nivel 2 — Afección estimada / con matiz (cruce con etiqueta metodológica)

| Capa | Fuente | Notas |
|---|---|---|
| DPH cartográfico probable (Proyecto LINDE) | MITECO | estimado, **sin tramitación** — citar como probable |
| Láminas de inundación T10 / T100 / T500 | SNCZI · MITECO | por periodo de retorno |
| Red hidrográfica (Pfafstetter - RiosCompPfafs) | MITECO | base para buffer zona de policía 100 m |
| Hábitats de Interés Comunitario (HIC) | MITECO | **malla 10×10 = presencia, no delimitación** |

### Nivel 3 — Contexto e información complementaria (activable, no cruce automático)

| Capa | Fuente | Notas |
|---|---|---|
| IBA — Áreas Importantes para las Aves | SEO/BirdLife | criterio científico, **no figura legal** |
| Núcleos urbanos | CNIG | contexto |
| Líneas límite municipales | CNIG | contexto |

### Capas WMS de referencia (no locales, requieren conexión)

Cartografía base y consulta puntual: IGN Topográfico (MTN), **PNOA ortofoto
vía WMTS** (`https://tms-pnoa-ma.idee.es/1.0.0/pnoa-ma/{z}/{x}/{-y}.jpeg`),
Esri World Imagery, Catastro (INSPIRE), SIGPAC, MUCVA, municipios/provincias.

### Pendiente / no disponible

- **Patrimonio cultural (BIC):** no existe capa nacional unificada con
  geometría (competencia autonómica). Se resuelve **por comunidad y por
  proyecto**, no como capa nacional. Documentar así en la metodología.

---

## 6. Comportamiento del análisis de afecciones

Flujo objetivo *"sube el tramo y saca cartografía"*:

1. El usuario sube el punto o tramo de la actuación (SHP/GeoJSON/KML).
2. Opcional: genera **buffer** de afección (25/50/100/200/500 m). Para zona
   de policía DPH → 100 m.
3. La app **cruza automáticamente con las capas de Nivel 1**, cruza el
   **Nivel 2 con su etiqueta metodológica**, y deja el **Nivel 3** como
   contexto activable.
4. Devuelve resultados **cuantitativos** (no solo "qué" cruza, también
   "cuánto"): metros de trazado afectados por capa, hectáreas de afección,
   punto kilométrico de entrada/salida.
5. Exporta **tabla de afecciones** (CSV/Excel/Word) para pegar en la memoria.
6. Compone y exporta **cartografía** con cajetín Quadrante.

**DPH:** representar deslindado (borde continuo, validez plena) y probable
(borde discontinuo, etiqueta "estimado") diferenciados en mapa y leyenda.
Donde no haya DPH, buffer de 100 m sobre red hidrográfica = zona de policía
presunta (art. 6 RDPH), documentado como estimación.

---

## 7. Cartografía y cajetín Quadrante

Formato de referencia (plano de localización real de Quadrante):

- **Cajetín en franja inferior** a todo el ancho: logo Quadrante/Meta a la
  izquierda · título del mapa al centro (título en negrita + descripción) ·
  fuente y sistema de referencia a la derecha
  (ej. *"Elaboración propia a partir de ADIF e IGN · ETRS89/UTM 30N ·
  EPSG:25830"*).
- Elementos: flecha norte oficial (SVG en `assets/`), escala gráfica,
  leyenda, e (opcional) insets de localización provincia/municipio.
- Color corporativo: **azul `#182C54`**.
- Activos disponibles: `QDE_META_Blue.svg`, `QDE_META_White.svg`,
  `QDE_META_symbol_blue/white.svg`, `NORTE.svg`.

Realismo de alcance: el visor apunta a cartografía **muy buena para análisis
y borrador** con identidad Quadrante. El **plano de máxima calidad de entrega
sigue saliendo de QGIS**; el visor acelera el paso previo (análisis + datos).

---

## 8. Notas importantes de trabajo

- **OneDrive corporativo:** el proyecto vive en
  `OneDrive - GRUPO QUADRANTE`, así que todo se sincroniza a la nube de
  Quadrante automáticamente. ⚠️ Un repositorio Git dentro de OneDrive puede
  dar conflictos de sincronización (OneDrive y Git vigilan los mismos
  archivos). Si aparecen problemas, considerar mover el repo fuera de
  OneDrive o pausar la sincronización durante operaciones Git.
- **Datos sensibles:** GitHub Pages es **público**. Antes de publicar el
  Componente 2 (proyectos/licitaciones) o cualquier dato de expediente,
  **confirmar con Quadrante** qué puede mostrarse. Los datos de proyectos van
  en repo privado o fuera del repositorio público.
- **Red corporativa:** confirmar que la red del trabajo permite `git push` a
  GitHub (algunas lo bloquean).

---

## 9. Estado y próximos pasos

- [x] Inicializar proyecto: estructura de carpetas + `git init` + `.gitignore`
- [x] Primer commit con este README
- [x] Decidir arquitectura definitiva → **MapLibre GL JS + PMTiles** (ver §2 y §3)
- [ ] Montar pipeline de conversión del catálogo nacional a formato web
- [ ] Migrar el visor actual (v4 Andalucía) a la estructura nueva
- [ ] Construir cajetín Quadrante (logo + flecha norte + escala fija + retícula UTM)
- [ ] Desarrollar análisis **cuantitativo** de afecciones (m, ha, PK)
- [ ] Exportación de tabla de afecciones a Excel/Word
- [ ] Configurar despliegue en GitHub Pages
- [ ] (Después) Componente 2 — geovisor de proyectos desde MyMaps
```
