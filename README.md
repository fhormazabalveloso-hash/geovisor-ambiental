# Geovisor Ambiental - Especificación del proyecto

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

El proyecto tiene **cuatro componentes** independientes pero relacionados:

1. **Geovisor Ambiental de afecciones** *(principal, en desarrollo)*
   Carga de capas ambientales nacionales, subida del tramo/punto de la
   actuación, análisis automático de afecciones y exportación de
   cartografía lista para la memoria.

2. **Geovisor de proyectos / portfolio** *(planificado)*
   Visualización de los proyectos de Quadrante (ganados / presentados a
   licitación / en curso) por temática. Origen: exportación KML/KMZ de
   Google MyMaps → convertido a algo profesional.

3. **Geovisor de arqueología** *(nuevo, planificado - 2026-09-21)*
   Mismo enfoque zero-server que el Componente 1, aplicado a capas y
   afecciones de patrimonio arqueológico. Sin especificar todavía
   (catálogo de datos, alcance del análisis); se detallará cuando se
   aborde.

4. **Sistematizaciones de Medio Ambiente** *(futuro, otro entorno)*
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
- **(2026-09-18) Cruce cuantitativo de afecciones probado de punta a punta**
  por primera vez (`src/js/analysis.js`), con un tramo de prueba real sobre
  Doñana. Bug encontrado y corregido en esa misma sesión: la capa HIC
  inflaba la superficie de afección ~15x (1.573 ha calculadas en un buffer
  de 83 ha) porque su fichero de origen guarda **un polígono repetido por
  cada código de hábitat presente en una misma celda de malla 10×10 km**;
  sumar área por *feature* sin deduplicar cuenta la misma celda una vez por
  código. Fix: la capa HIC ya no calcula superficie (`presenceOnly: true`
  en `layers.js`), en su lugar lista los códigos de hábitat presentes. De
  paso se añadieron a la tabla de resultados y al CSV exportable los
  **nombres reales** de los elementos afectados (usando el `labelField` de
  cada capa), no solo el conteo agregado.
- **(2026-09-21) Causa raíz del bug de teselas, corregida en general.**
  El bug de HIC del 2026-09-18 no era exclusivo de esa capa: el pipeline
  tesela con el driver MVT de GDAL, que por defecto deja un margen de
  solape entre teselas vecinas (para que el renderizado no se corte en el
  borde) - cualquier capa poligonal cuya geometría cruce varias teselas
  dentro del buffer puede duplicar área. Fix general: las capas con un
  identificador de entidad real (`idField` en `layers.js`: `site_code`,
  `OBJECTID`, `ID_ZONA`, etc.) agrupan sus fragmentos por ese id y los
  unen con `turf.union` antes de medir. Validado con un tramo sintético de
  30 km y buffer de 500 m (cruza muchas teselas): ningún resultado supera
  ya el área total del buffer. `humedales_turberas` no trae un id fiable
  en el dato de origen y queda como limitación conocida y documentada.
  De paso: nuevo componente planificado, **geovisor de arqueología**
  (ver §1), y decisión cerrada de mantener el repo en la cuenta personal
  de GitHub (contenido público, no requiere cuenta de empresa).
- **(2026-09-21) Panel de capas reagrupado por temática.** Coincidiendo
  con la recomendación ya existente en §5, el panel pasó de agruparse por
  nivel jurídico a agruparse por temática (espacios protegidos,
  hidrografía, patrimonio natural, contexto), con el nivel como insignia
  informativa por fila. El array `LAYERS` se reordenó en el mismo sentido
  para que el orden de dibujo en el mapa coincida con la agrupación del
  panel.
- **(2026-09-21) Punto kilométrico (PK) y buffers más grandes.** Se
  amplió el rango de buffer (hasta 1/2/5 km, antes 500 m como máximo) -
  seguro de hacer ya con el fix de deduplicación entre teselas. Se añadió
  el cálculo de PK de entrada/salida: por cada entidad afectada se expande
  su geometría por el buffer aplicado y se busca en qué tramo del trazado
  **original** cae dentro, reportando el rango PK mínimo-máximo
  (envolvente - no distingue cruces múltiples de la misma afección).
- **(2026-09-22) Exportación a Excel.** Vía SheetJS (cliente, sin
  servidor), mismas columnas que el CSV pero con tipos numéricos reales.
  De paso, aclarado con Francisco que el PK que calcula la app es
  **relativo a la geometría subida** (PK 0 = primer vértice del archivo),
  no el PK oficial del proyecto - documentado como limitación conocida.
- **(2026-09-22) PK retirado.** Al plantear la pregunta anterior en voz
  alta, Francisco decidió que el riesgo de confusión (un PK que parece
  preciso pero no coincide con el oficial si se sube un extracto parcial)
  no compensaba tenerlo activo todavía. Se quitó el cálculo de PK por
  completo (helpers `buildPkLine`/`computePkRange`/`accumulatePkRange`/
  `formatPK`, columna en la tabla/CSV/Excel) en vez de dejarlo oculto a
  medias - el código sigue disponible en el historial de Git
  (`c644f9f6`, `25daf9ad`) si se retoma más adelante, idealmente con un
  campo de PK inicial manual.
- **(2026-09-23) Varias decisiones de alcance.** (1) Las 5 capas grandes
  pendientes se dejan para el final - no bloquean nada más. (2) El
  `.docx` de estado se sigue actualizando pero **nunca entra a Git**
  (`.gitignore`) - solo vive en la carpeta local. (3) **Word descartado**
  como formato de exportación - con que el Excel se lea bien alcanza. (4)
  Formato del Excel mejorado: tabla nativa de Excel, cabecera en azul
  corporativo, columna de color por capa (igual que en el panel/mapa),
  filas alternadas y cabecera congelada - cambiada la librería de SheetJS
  a **ExcelJS** porque la version libre de SheetJS no escribe estilos
  (ver §9). (5) Push sigue en pausa hasta tener todo bien armado - sin
  fecha concreta todavía.
- **(2026-09-23) Simulacro de licitación real y fix de etiquetas
  pequeñas.** Se probó el flujo completo (subir → buffer → cruce → CSV →
  Excel → cartografía) con un trazado curvo de ~45 km simulando un
  acceso a zona portuaria cerca de Huelva - resultados coherentes y
  nombres reales reconocibles (Marismas del Odiel, Acantilado del
  Asperillo...), sin superar nunca el área del buffer. Francisco detectó
  que los **nombres de elemento en la cartografía exportada salían
  diminutos** - causa raíz: `text-size` de las capas de etiqueta
  (`main.js`) está en píxeles CSS fijos (11), pensado para pantalla
  normal, pero el canvas de exportación se renderiza a `EXPORT_DPI` (200,
  más del doble de denso) - el resto de la cartografía (cajetín, leyenda,
  escala) ya convertía mm→píxeles correctamente para esto, pero el texto
  que dibuja el propio MapLibre no. Fix en `export.js`
  (`captureMapAtScale`): antes de capturar, escala temporalmente el
  `text-size` de cada capa de etiqueta para que el texto ocupe el mismo
  tamaño físico en el papel (~2,9 mm) sea cual sea la escala elegida, y
  lo restaura después. Verificado visualmente en el canvas exportado.
- **(2026-09-23) ZEC/ZEPA y opacidad de etiquetas.** Probando el visor,
  Francisco preguntó si se podía distinguir ZEC de ZEPA dentro de Red
  Natura 2000 - se confirmó que sí (campo `TIPO`, A/B/C) y se coloreó
  cada polígono según su tipo, con la leyenda de exportación listando
  solo las variantes presentes en cada vista. De paso, encontró que la
  opacidad del nombre de un elemento estaba ligada a la del propio
  polígono/línea (bajar la transparencia del relleno también desvanecía
  su etiqueta) - ahora son independientes, el texto va siempre a
  opacidad máxima.

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

### Nivel 1 - Afección jurídica plena (cruce automático obligatorio)

| Capa | Fuente | Notas |
|---|---|---|
| Red Natura 2000 (ZEC + ZEPA) | MITECO / REDIAM | campo `TIPO` distingue ZEC/ZEPA/ambas (A/B/C - ver §9 2026-09-23; corrige una nota anterior que decía `FIGURA`, campo que no existe en el `.pmtiles` generado) |
| Espacios Naturales Protegidos (ENP) | MITECO / REDIAM | figuras estatales y autonómicas |
| Vías Pecuarias (Red General - RGVP) | MITECO / REDIAM | verificar cobertura por CCAA |
| Montes de Utilidad Pública (CMUP/IEPF) | MITECO | dominio público forestal |
| DPH deslindado | CHG / confederaciones | **validez jurídica plena** |
| Inventario Español de Zonas Húmedas (IEZH) | MITECO | |

### Nivel 2 - Afección estimada / con matiz (cruce con etiqueta metodológica)

| Capa | Fuente | Notas |
|---|---|---|
| DPH cartográfico probable (Proyecto LINDE) | MITECO | estimado, **sin tramitación** - citar como probable |
| Láminas de inundación T10 / T100 / T500 | SNCZI · MITECO | por periodo de retorno |
| Red hidrográfica (Pfafstetter - RiosCompPfafs) | MITECO | base para buffer zona de policía 100 m |
| Hábitats de Interés Comunitario (HIC) | MITECO | **malla 10×10 = presencia, no delimitación** |

### Nivel 3 - Contexto e información complementaria (activable, no cruce automático)

| Capa | Fuente | Notas |
|---|---|---|
| IBA - Áreas Importantes para las Aves | SEO/BirdLife | criterio científico, **no figura legal** |
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
   y los **nombres reales de los elementos afectados** (p. ej. "Doñana",
   "Arroyo de Soto Chico"). Punto kilométrico de entrada/salida: **se
   implementó y se retiró** (ver §2 2026-09-22) - el PK que se podía
   calcular era relativo al primer vértice del archivo subido, no el PK
   oficial del proyecto, con riesgo real de confundirse en una memoria si
   se sube un extracto parcial de un trazado. Pendiente de retomar con un
   campo de PK inicial manual (ver §9).
5. Exporta **tabla de afecciones** a CSV y a Excel (con formato: colores
   del geovisor, cabecera corporativa, filtro automático). Word se
   descartó - no hace falta.
6. Compone y exporta **cartografía** con cajetín Quadrante.

**DPH:** representar deslindado (borde continuo, validez plena) y probable
(borde discontinuo, etiqueta "estimado") diferenciados en mapa y leyenda.
Donde no haya DPH, buffer de 100 m sobre red hidrográfica = zona de policía
presunta (art. 6 RDPH), documentado como estimación.

**Excepción HIC:** al ser una malla de presencia 10×10 km (no delimitación
real - ver §5), el cruce no calcula superficie para esta capa; en su lugar
lista los códigos de hábitat de interés comunitario presentes en las celdas
tocadas por el buffer.

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
- **`Geovisor Ambiental - Estado del proyecto.docx` nunca entra a Git**
  (decisión 2026-09-23, `.gitignore`). Se mantiene actualizado como apoyo
  de trabajo, pero solo vive en la carpeta local - no se versiona ni se
  sube, por la misma razón de arriba (repo público).
- **Red corporativa:** confirmar que la red del trabajo permite `git push` a
  GitHub (algunas lo bloquean).
- **Git sin `git.exe`:** este equipo no tiene Git nativo instalado; el
  histórico local se maneja con **dulwich** (reimplementación de Git en
  Python puro, entorno miniforge3). `add`/`commit`/`log`/`status`
  funcionan igual; solo vigilar operaciones más avanzadas (rebase
  interactivo, algunos hooks) que pueden tener menos soporte.
- **Servidor de desarrollo local:** PMTiles necesita peticiones HTTP por
  rangos (`Range`), que `python -m http.server` **no soporta bien** - usar
  `python -m RangeHTTPServer 8000` (paquete `RangeHTTPServer`, ya
  instalado) desde la **raíz del proyecto** (no desde `src/`, porque
  `main.js` referencia las capas como `../data-web/*.pmtiles`, relativo a
  `index.html`). URL de trabajo: `http://localhost:8000/src/index.html`.
  Configurado como tarea `geovisor-dev` en `.claude/launch.json`.
  - El servidor no manda cabeceras `Cache-Control`: tras editar un `.js`,
    el navegador a veces sigue sirviendo la versión vieja - recarga forzada
    (Ctrl+Shift+R) si un cambio no se refleja.
  - Es de un solo hilo: tras muchas peticiones seguidas en una sesión de
    pruebas intensiva puede quedar lento/colgado - reiniciarlo si el mapa
    deja de cargar capas.

---

## 9. Estado y próximos pasos

- [x] Inicializar proyecto: estructura de carpetas + `git init` + `.gitignore`
- [x] Primer commit con este README
- [x] Decidir arquitectura definitiva → **MapLibre GL JS + PMTiles** (ver §2 y §3)
- [x] Montar pipeline de conversión del catálogo nacional a formato web
      (`pipeline/build_tiles.py` + `config.yaml`) - 13 de 18 capas generadas
      en `data-web/*.pmtiles`; quedan pendientes las 5 capas grandes
      (inundabilidad T10/T100/T500, DPH cartográfico probable, montes de
      utilidad pública), en tanda aparte por su tamaño de origen (1-1.9 GB)
- [x] Primer visor funcional: MapLibre GL JS + PMTiles, mapa base
      conmutable (PNOA/OSM), panel de capas por nivel, cajetín Quadrante
      (logo + flecha norte + escala + fuente/CRS). Falta migrar el resto
      de comportamiento del visor v4 Andalucía (subida de tramo, buffer,
      análisis).
- [x] Configurar despliegue en GitHub Pages -
      https://fhormazabalveloso-hash.github.io/geovisor-ambiental/src/index.html
      (repo público, rama `main`). Peticiones de rango HTTP verificadas
      funcionando en el CDN real de GitHub Pages (Fastly), no solo en
      local.
- [x] Colores propios por capa (no por nivel), etiquetas de nombre por
      elemento en las 7 capas que traen ese dato, control de transparencia
      y orden de dibujo manual por capa (ver `src/js/layers.js`)
- [x] Exportación de cartografía a A3 (PNG/PDF) con leyenda, flecha norte,
      escala gráfica y cajetín Quadrante (`src/js/export.js`) - lista para
      pegar en memoria/condicionantes ambientales de una licitación
- [x] Subida de tramo/punto: GeoJSON, SHP (.zip) y KML/KMZ
      (`src/js/upload.js`). GPKG pendiente (necesita SQLite-WASM, más
      pesado - se añade si hace falta)
- [x] Buffer de afección (25/50/100/200/500 m; 100 m fijo para zona de
      policía DPH) sobre el tramo subido (`src/js/upload.js`)
- [x] Cruce automático cuantitativo con las capas (m, ha) - el corazón del
      proyecto, implementado y probado de punta a punta
      (`src/js/analysis.js`, ver §2 2026-09-18). Devuelve metros/hectáreas
      afectados y los **nombres reales** de los elementos (no solo
      conteo). Capas de presencia tipo malla (HIC) se tratan aparte: sin
      superficie, con lista de códigos.
- [x] Exportación CSV de la tabla de afecciones, con nombres de los
      elementos afectados (`src/js/analysis.js`)
- [x] Deduplicación de geometría entre teselas MVT en el cruce
      cuantitativo (2026-09-21). Causa raíz: el pipeline tesela con GDAL
      MVT, que por defecto anade un margen de solape entre teselas
      vecinas - cualquier capa poligonal cuya geometria cruce varias
      teselas dentro del buffer podia duplicar area (no solo HIC, que fue
      donde se detecto el primer caso). Fix: `layers.js` marca un
      `idField` (identificador real de cada capa - `site_code`,
      `OBJECTID`, `ID_ZONA`, etc.) para las capas con uno disponible;
      `analysis.js` agrupa los fragmentos de una misma entidad por ese id
      y los une con `turf.union` antes de medir, en vez de sumar
      fragmento a fragmento. Probado con un tramo sintético de 30 km y
      buffer de 500 m (spanning muchas teselas): ningún resultado supera
      ya el area total del buffer. `humedales_turberas` sigue sin id
      fiable en el dato de origen - queda documentado como limitación
      conocida en `layers.js`.
- [x] Panel de capas reorganizado por **temática** (2026-09-21), como
      recomienda §5, en vez de por nivel jurídico. El nivel pasa a ser una
      insignia (N1/N2/N3) en cada fila, no la agrupación principal. El
      orden de dibujo del array `LAYERS` (`src/js/layers.js`) también se
      reagrupó por temática para que coincida con el panel - el
      reordenado ▲/▼ ahora se limita a la temática de la fila, no al
      nivel (`moveLayerInHierarchy` en `src/js/main.js`).
- [ ] Punto kilométrico (PK) de entrada/salida - **implementado y
      retirado el mismo día (2026-09-21→22)**. Funcionaba (expandía la
      geometría de cada entidad por el buffer y buscaba en qué tramo del
      trazado original caía dentro), pero el PK 0 era el primer vértice
      del **archivo subido**, no el PK oficial del proyecto - riesgo real
      de que un extracto parcial diera un PK engañoso en una memoria real.
      Retirado a petición de Francisco hasta tener una forma fiable de
      ajustarlo (candidato: campo de PK inicial manual que desplace todos
      los PK calculados). Código aún en el historial de Git si se retoma
      (commits `c644f9f6` y `25daf9ad`).
- [x] Rango de buffer ampliado (2026-09-21): antes 25-500 m, ahora hasta
      1/2/5 km para el ámbito real de una EIA (avifauna, cuenca
      hidrográfica) sobre trazados largos (`src/js/upload.js`). Solo fue
      seguro hacerlo después del fix de deduplicación entre teselas.
- [x] Exportación de tabla de afecciones a Excel (cliente, sin
      servidor). Números reales (no texto). Una segunda pestaña "Info"
      con el tramo, el buffer aplicado y la nota de cribado. (2026-09-22)
- [x] Formato de la tabla Excel (2026-09-23, a petición de Francisco):
      **tabla nativa de Excel** (con desplegables de filtro incluidos),
      cabecera en azul corporativo Quadrante, columna de color por fila
      igual al color de esa capa en el panel/mapa, filas alternadas, y
      cabecera congelada. **Word queda descartado** - no hace falta, con
      que el Excel se lea bien es suficiente.
      **Cambio de librería:** se empezó con SheetJS (`xlsx@0.18.5`, usada
      el 2026-09-22 solo para la exportación sin formato) pero su versión
      libre no escribe estilos/colores en el archivo - se probó
      explícitamente (round-trip: el color desaparecía al releer el
      archivo guardado) antes de darlo por bueno. Se cambió a **ExcelJS**
      (`exceljs@4`, MIT, también libre), que sí escribe colores, tablas
      nativas y congelar paneles correctamente - verificado con el mismo
      tipo de prueba round-trip.
- [ ] Probar el cruce de afecciones con un tramo/caso **real** (las
      pruebas hechas hasta ahora usan tramos sintéticos sobre Doñana)
- [ ] Generar las 5 capas grandes pendientes (inundabilidad T10/T100/T500,
      DPH cartográfico probable, montes de utilidad pública) - **dejado
      para el final** (decisión 2026-09-23), no bloquea nada más del
      proyecto
- [x] Decidir cuenta de GitHub para el push → **cuenta personal**
      (`fhormazabalveloso-hash`), confirmado 2026-09-21: todo el
      contenido del repo es información pública, no hace falta esperar a
      una cuenta/organización de empresa
- [x] Tamaño de los nombres de elemento en la cartografía exportada
      (2026-09-23, detectado por Francisco en un simulacro con un caso
      parecido a una licitación real). El `text-size` fijo en px CSS
      (11, pensado para pantalla) no se escalaba para `EXPORT_DPI` -
      salía diminuto en el papel. `export.js` ahora lo ajusta
      temporalmente antes de capturar para que ocupe un tamaño físico
      constante (~2,9 mm) en cualquier escala de exportación.
- [x] Red Natura 2000: distinguir ZEC/ZEPA/ambas (2026-09-23, pedido por
      Francisco probando el visor). El campo `TIPO` (A=ZEPA, B=ZEC,
      C=ambas - verificado contra los metadatos completos del `.pmtiles`,
      3 valores en todo el catálogo) ahora colorea cada polígono según su
      tipo (`layerColorExpression` en `main.js`, vía expresión `match` de
      MapLibre) en vez de un único verde. La leyenda de la cartografía
      exportada lista las variantes como filas separadas, pero **solo
      las que aparecen de verdad en la vista exportada** (misma lógica
      que ya se aplicaba a nivel de capa completa).
- [x] Opacidad del nombre de elemento independiente del relleno/línea
      (2026-09-23, detectado por Francisco). Antes `setLayerOpacity`
      aplicaba el mismo valor a `fill-opacity`/`line-opacity` y a
      `text-opacity`, así que bajar la transparencia del polígono también
      desvanecía su nombre. Ahora el texto va siempre a opacidad máxima,
      independiente del control de transparencia de la capa.
- [ ] (Después) Componente 2 - geovisor de proyectos desde MyMaps
- [ ] (Después) Componente 3 - geovisor de arqueología (nuevo,
      2026-09-21, sin especificar todavía)
