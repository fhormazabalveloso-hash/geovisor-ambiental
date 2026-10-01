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
- **(2026-09-23) HIC fuera, "ambas" cambia de color, panel con varios
  swatches.** Tres ajustes rápidos tras probar lo anterior en vivo: (1)
  se decidió retirar HIC del catálogo (malla de presencia, sin
  delimitación real, con un historial de bugs propio); (2) el color de
  "ZEC + ZEPA" pasó de rojo a morado - Francisco lo vio como una alarma
  fuera de lugar, y el morado quedó libre justo al quitar HIC (era la
  única otra capa de ese color); (3) el panel de capas ahora muestra los
  3 colores de Red Natura 2000 como mini-swatches en vez de un único
  verde "de resumen" que ya no reflejaba la realidad del mapa - lo pidió
  Francisco explícitamente al notar la inconsistencia.
- **(2026-09-23) Nombres de elemento repetidos al alejar el zoom, causa
  raíz y fix a nivel de pipeline.** Francisco detectó que, en zonas muy
  grandes (p. ej. Doñana), el mismo nombre aparecía varias veces sobre el
  mismo polígono al alejar la vista. Causa raíz: MapLibre coloca **un
  símbolo de texto por cada tesela** que una geometría cruza - no hay
  deduplicación entre teselas para etiquetas ancladas a punto (a
  diferencia de las líneas, que sí continúan el texto de forma nativa).
  Una entidad grande que cruza 4-5 teselas mostraba su nombre 4-5 veces
  en el mismo sitio. Fix: en vez de anclar la etiqueta a la geometría
  propia de la capa (fragmentada por tesela), `pipeline/build_tiles.py`
  genera una **fuente de puntos dedicada** por cada capa con
  `label_field` (`--labels-only`, nuevo flag): un único
  `geometry.representative_point()` por entidad real (punto garantizado
  dentro del polígono, no un centroide que puede caer fuera en formas
  cóncavas; para líneas, un punto sobre la propia línea), calculado
  **antes** de la tesela, cuando la geometría aún no está fragmentada.
  Cada capa pasa a tener dos `.pmtiles`: el propio (geometría real, para
  el cruce/relleno/línea) y uno `_labels.pmtiles` (solo puntos, para el
  símbolo de texto). Caso especial: **ENP** ya traía un fichero oficial
  de centroides del proveedor (`Enp2025_c.json`) - se usa directamente
  (`label_source_override` en `config.yaml`) en vez de calcular uno
  propio, por ser más fiable que una aproximación geométrica nuestra.
  Verificado en el navegador vía `queryRenderedFeatures`: "Doñana" pasa
  de aparecer 4-5 veces a exactamente 1 vez entre los 6 nombres
  distintos visibles en esa zona. Para las capas de **línea** (vías
  pecuarias, red hidrográfica) se dejó explícitamente que un tramo muy
  largo repita su nombre varias veces a lo largo de su trazado (se añadió
  `sort_field` para que, si compiten por hueco, gane el tramo más largo
  vía `symbol-sort-key`) - es el comportamiento esperado tipo atlas de
  carreteras, no el mismo bug que en polígonos compactos. Capas
  afectadas por el fix: `red_natura_2000`, `enp`, `vias_pecuarias`,
  `dph_deslindado`, `iezh`, `red_hidrografica`, `iba`. Detalle menor:
  al primer pase se olvidó añadir `label_field` a `iba` en
  `config.yaml` (capa de Nivel 3/contexto, menos visible durante las
  pruebas) - detectado por un 404 en la consola del navegador y
  corregido aparte.
- **(2026-09-23) Investigación de geovisores de referencia + 5 mejoras
  del análisis de afecciones.** A petición de Francisco, dos agentes en
  paralelo investigaron (1) nombres posibles para el proyecto (guardado
  en `investigacion/propuesta-nombre-geovisor.md`, **nunca entra a
  Git** - misma razón que el `.docx`) y (2) geovisores de referencia
  (MITECO, MAGIC, IPaC, South Africa Screening Tool, AERIUS...) y
  literatura académica sobre cribado ambiental de infraestructura
  lineal, con 10 ideas priorizadas (`investigacion/ideas-mejora-
  geovisores-referencia.md`, tampoco entra a Git). Tras revisarlas
  juntos, se implementaron las 5 de menor/medio esfuerzo (el semáforo
  de sensibilidad, la más ambiciosa, se deja para el final):
  - **Fuente por capa en la exportación** (idea #10): cada capa declara
    su organismo de origen (`fuente` en `layers.js`, tabla del README
    §5) y aparece como columna en el CSV/Excel de afecciones, más una
    nota en la hoja "Info" sobre vigencia del catálogo.
  - **Verificación en campo** (idea #6): columna "Confirmado en campo"
    (Sin confirmar / Confirmado / Descartado) editable por hallazgo en
    el modal de resultados, exportada también al CSV/Excel. El estado
    vive en `u.fieldStatus` (por tramo subido), no en el resultado, para
    sobrevivir a un recálculo con otro buffer.
  - **Distancia al elemento más cercano cuando no hay cruce** (idea #4):
    antes, `analysis.js` descartaba en silencio (`turf.booleanIntersects`)
    todo lo que no cruzaba el buffer. Ahora, para una capa sin cruce
    directo, se busca el elemento renderizado más cercano dentro de un
    margen de 2 km más allá del buffer (`NEAREST_SEARCH_MARGIN_M`) y se
    reporta su distancia aproximada, muestreando el trazado cada 100 m
    (`sampleTrazadoPoints`/`minDistanceMetersToFeature`, vía
    `turf.pointToLineDistance`/`turf.polygonToLine`). El mapa se
    encuadra a esa zona ampliada antes de consultar, porque MapLibre
    solo tiene datos consultables para lo que está renderizado.
  - **Buffer configurable por capa** (idea #2): antes había un único
    `bufferMeters` global por tramo, aplicado igual a las 7 capas del
    cruce. Ahora el modal de resultados muestra un selector de buffer
    por capa (override > `l.suggestedBufferM` en `layers.js` > buffer
    del tramo) con un botón "Recalcular". De fábrica, `red_hidrografica`
    sugiere 100 m (zona de policía presunta art. 6 RDPH, ya
    documentada en README §6) - el resto usa el buffer del tramo salvo
    que el usuario lo cambie.
  - **Solapamiento entre tramos propios** (idea #9): con 2+ tramos/
    puntos subidos con buffer, un botón "Ver solapamientos entre
    buffers" en el panel calcula la intersección dos a dos
    (`turf.intersect`) y resalta el área en rojo sobre el mapa, con el
    total en hectáreas por par - insumo directo para el apartado de
    "efectos sinérgicos y acumulativos" de una EIA.
  - **Bug encontrado de paso (no en el alcance pedido):** al probar el
    flujo de quitar todos los tramos subidos, `buildUploadPanel()`
    lanzaba `TypeError` (`appendChild(null)`) - el nodo original
    `#upload-panel-empty` del HTML se destruye la primera vez que se
    sube algo (`panel.innerHTML` se reemplaza entero), así que
    `document.getElementById` ya no lo encontraba la segunda vez que se
    volvía a 0 tramos. Corregido en `upload.js` reconstruyendo ese
    mensaje como texto fijo en vez de reutilizar el nodo original.
- **(2026-09-24) Semáforo de sensibilidad (idea #1, la que se dejó para
  el final el día anterior).** Antes de implementar, se investigó cómo
  funciona realmente la herramienta de referencia (South Africa
  National Web-Based Environmental Screening Tool, obligatoria desde
  2019): **no calcula la sensibilidad en vivo a partir de la geometría
  del proyecto** - cruza el sitio contra un mapa nacional
  **pre-clasificado por ecólogos** (Critical Biodiversity Areas /
  Ecological Support Areas de SANBI, con planificación de conservación
  sistemática), y reporta un nivel **por tema/capa por separado**, no
  un único score agregado para todo el proyecto. Esto descartó la idea
  de calcular la sensibilidad a partir de hectáreas/metros cruzados
  (precisión falsa que ni la propia herramienta de referencia usa) y
  confirmó que un valor fijo por capa - coherente con que la tabla de
  resultados ya es una fila por capa - es la aproximación más honesta
  con los datos disponibles. Implementado:
  - `sensitivityBase` en `layers.js` (Alta/Media, propuesta de
    Quadrante para las 7 capas del cruce, **no una clasificación
    reglamentaria** - documentado así en el propio código y en el
    Excel exportado).
  - Dos matices calculados en `analysis.js` (`computeSensitivity`), sin
    datos nuevos: un hallazgo "cerca, sin cruce directo" (idea #4) baja
    un escalón; un cruce de Red Natura 2000 con `TIPO=C` (ZEC+ZEPA a la
    vez) sube un escalón - verificado con el caso de prueba de Doñana
    (queda en "Muy Alta").
  - Badge de color (Muy Alta=rojo, Alta=naranja, Media=amarillo,
    Baja=verde) como primera columna en el modal de resultados y en el
    Excel exportado (con su propio color de fondo por fila, igual que
    la columna Color de capa).
- **(2026-09-24) Caso de prueba real como usuario + fix de cartografía
  incompleta tras analizar.** Se probó el geovisor de punta a punta en
  el papel de un técnico preparando la licitación de un **cerramiento
  perimetral** (caso completo documentado en
  `investigacion/ejemplos-de-uso/caso-cerramiento-planta-agroindustrial.md`,
  fuera de Git). Hallazgo principal: tras "Analizar afecciones", la
  tabla de resultados podía mostrar 6 capas con afección real, pero al
  ir directo a "Exportar cartografía" **el plano y la leyenda solo
  mostraban las 2 capas que ya estaban marcadas a mano de antes** - las
  demás se activaban solo temporalmente para poder consultarlas
  (`analyzeUploadedLayer`) y volvían a su estado anterior al terminar,
  sin avisar. Riesgo real para un expediente: el Excel podía decir una
  cosa y el plano exportado otra. **Fix:** las capas con cruce directo
  (`count > 0`) se quedan activadas de verdad (estado interno **y**
  casilla del panel, vía `buildLayerPanel()` - la exportación de
  cartografía lee la casilla del DOM, no solo el estado interno) tras
  el análisis, con un aviso verde en el propio modal de resultados
  listando qué se activó y por qué, para que no sea una sorpresa
  silenciosa. Verificado exportando cartografía justo después de
  analizar, sin tocar ninguna casilla: la leyenda salió completa con
  las 6 capas. De paso quedaron documentados (mismo caso de prueba,
  sin corregir todavía por ser de menor prioridad o sin solución
  obvia): la escala de exportación puede salir mal ajustada si se
  exporta justo tras analizar (el mapa queda encuadrado al margen de
  búsqueda ampliado del análisis, no al tamaño real del proyecto), y
  el mapa se vuelve difícil de leer cuando varias capas de polígono se
  solapan físicamente (queda todo del mismo tono, sin distinguir
  colores) - ver el documento del caso de prueba para el detalle
  completo.
- **(2026-09-24) Segundo caso de prueba (carretera) - fix reverificado +
  nombres/leyenda confirmados.** A petición de Francisco de probar "otro
  ejemplo más realista" con nombres visibles en la cartografía, se probó
  una variante de carretera (línea, 2,5 km) cruzando el deslinde oficial
  de DPH del Río Manzanares (caso completo en
  `investigacion/ejemplos-de-uso/caso-carretera-cruce-rio.md`, fuera de
  Git). Confirmado con datos reales: (1) el fix del punto anterior se
  sostiene con geometría de línea, no solo polígono; (2) los nombres de
  elemento SÍ aparecen como texto en el plano exportado cuando el punto
  de etiqueta de la entidad cae dentro del recuadro (mucho más probable
  en un proyecto lineal de varios km que en un cerramiento puntual -
  documentado como limitación esperada, no bug, en el caso anterior);
  (3) la leyenda exportada solo lista las capas con elementos de verdad
  en esa vista, no todo lo que esté marcado en el panel. De paso se
  investigó y descartó otro falso bug (la escala de exportación parecía
  "pegada" al reencuadrar - era el render en pausa del propio entorno de
  pruebas, no la aplicación) y se regeneraron las capturas del primer
  caso que habían desaparecido de la carpeta entre sesiones (posible
  sincronización de OneDrive - ver nota en ese mismo documento).
- **(2026-09-24) Fix del hallazgo §4.2: reencuadre automático tras
  analizar.** `analyzeUploadedLayer()` dejaba el mapa encuadrado al área
  de búsqueda ampliada (buffer + 2 km, necesaria para detectar "cerca,
  sin cruce directo") también DESPUÉS de terminar, así que la escala que
  sugiere "Exportar cartografía" (calculada a partir de la vista actual)
  salía muy alejada si se exportaba justo después de analizar, sin
  reencuadrar a mano - el cerramiento de prueba llegó a verse como un
  punto casi invisible en el plano. **Fix:** al terminar el análisis, el
  mapa se reencuadra al área de los buffers realmente usados para el
  cruce (sin el margen extra de búsqueda) - lo relevante para mirar/
  exportar el resultado. Verificado: tras analizar el mismo caso de
  prueba, sin tocar nada, la escala sugerida salió directamente en
  1:2.500 (antes 1:25.000) y la cartografía generada mostró el
  cerramiento y su entorno correctamente, sin ningún paso manual de por
  medio.
- **(2026-09-24) 3 mejoras de cartografía a partir de un caso real de
  Francisco.** Probando el visor con un proyecto real propio (no un caso
  sintético mío), Francisco pidió tres ajustes concretos sobre la
  cartografía exportada:
  1. **Grosor de línea personalizable.** El trazado subido siempre
     dibujaba a 4px fijos - se veía demasiado fino en la cartografía
     impresa. Nuevo control "Grosor de línea" en el panel de
     "Tramos y puntos subidos" (`upload.js`, 1-10px), por tramo. De
     paso se encontró la causa raíz de que se viera tan fino: igual que
     ya pasaba con el texto (ver §2 2026-09-23), un grosor en px CSS
     pensado para pantalla (96 DPI) sale proporcionalmente más fino al
     exportar a `EXPORT_DPI` (200) - `export.js` ahora escala
     automáticamente el `line-width` de **todas** las capas de línea del
     estilo (ambientales y del trazado subido) antes de capturar, con el
     mismo criterio que ya se aplicaba al texto. Detalle técnico: no se
     puede envolver una expresión de zoom (el `interpolate` que usan las
     capas de línea ambientales) dentro de otra expresión - MapLibre
     exige que quede como expresión de nivel superior - así que se
     reescribe la misma expresión con sus valores de salida
     multiplicados, en vez de envolverla (`scaleLineWidthExpr`).
  2. **La línea/capa del proyecto en la leyenda.** La leyenda exportada
     solo listaba capas ambientales, nunca el propio trazado subido.
     Ahora añade una fila por cada tramo/punto visible con algo
     realmente dibujado en la vista exportada (mismo criterio de "solo
     lo visible de verdad" que ya se aplicaba a las capas ambientales),
     con su nombre de archivo y su color.
  3. **Nombres de elemento en la leyenda como respaldo.** Cuando el
     nombre de un elemento no llega a verse como texto sobre el propio
     mapa (su punto de etiqueta puede caer fuera del recuadro exportado
     - limitación documentada en
     `investigacion/ejemplos-de-uso/caso-cerramiento-planta-agroindustrial.md`
     §4.3-bis), ahora aparece bajo el nombre de la capa en la leyenda
     (p. ej. "Río Manzanares" bajo "DPH deslindado"), hasta 3 nombres
     distintos por fila. Reutiliza la misma consulta de features que ya
     se hacía para decidir qué capas incluir en la leyenda, sin
     consultas nuevas.

  Verificado con el mismo caso de la carretera: los tres cambios juntos
  en una única cartografía exportada (`investigacion/ejemplos-de-uso/`).
- **(2026-09-25) 5 mejoras de cartografía propuestas tras revisar la
  cartografía real de Francisco (aceptadas todas).**
  1. **Buffer como contorno discontinuo.** En su plano real, el relleno
     del buffer tapaba las capas ambientales que tenía debajo. Nuevo
     selector "Estilo" por tramo (`upload.js`): contorno (por defecto),
     relleno, o ambos - capa nueva `<id>-buffer-line` con
     `line-dasharray`.
  2. **El buffer en la leyenda** ("Buffer 500 m"), con un símbolo que
     imita su estilo (recuadro discontinuo y/o relleno). De paso la
     leyenda dibuja ahora un símbolo según el tipo de elemento: trazo
     para las líneas (red hidrográfica, vías pecuarias, el trazado
     subido con su grosor real), círculo para los puntos, cuadrado para
     los polígonos.
  3. **Mapa de situación** (ver §7): recuadro abajo a la derecha, a
     escala fija 1:2.500.000, con el mapa base y los límites
     provinciales/autonómicos, y la zona del plano marcada en rojo (o
     un punto si a esa escala es demasiado pequeña). Es una segunda
     captura del mismo mapa (`captureInset` en `export.js`) con el resto
     de capas ocultas un momento - sin datos ni servicios nuevos.
  4. **Cuadrícula UTM** en el marco, con coordenadas rotuladas en el
     borde (`computeUtmGrid`, vía `proj4`). Huso según la longitud del
     centro (29-31 en península/Baleares, 27-28 en Canarias - rotulado
     como REGCAN95, su sistema oficial). El cajetín indica el sistema de
     la cuadrícula. Los rótulos se dibujan al final y se descartan los
     que chocan con leyenda, flecha, escala o mapa de situación
     (encontrado en la primera prueba: "4.479.000" quedaba medio tapado
     por la leyenda). Las líneas se muestrean en 16 puntos en vez de
     trazarse rectas, por la convergencia de meridianos sobre Web
     Mercator.
  5. **Informe PDF único** ("Descargar informe (PDF)"): página 1 la
     cartografía A3; siguientes (A4 apaisado) la tabla de afecciones del
     último análisis con el semáforo coloreado y las notas de
     metodología del Excel, con pie y número de página. Tabla con
     `jspdf-autotable` para que el texto sea seleccionable, y
     cartografía en JPEG para que el informe pese ~3 MB en vez de ~15
     MB. Desactivado (con aviso) si no se ha analizado ningún tramo.

  Cada una se puede activar/desactivar desde el modal de exportación
  (mapa de situación y cuadrícula, activados por defecto). Verificado de
  punta a punta con el caso de la carretera del Manzanares: cartografía
  PNG + informe PDF revisados página a página
  (`investigacion/ejemplos-de-uso/`). Nota de prueba: el primer intento
  sugirió una escala 1:50.000 en vez de 1:10.000 - no era un fallo de la
  app, sino que el navegador de pruebas no había avisado a MapLibre de
  un cambio de tamaño del contenedor (lienzo de 400 px dentro de un
  contenedor de 1.280 px); tras `map.resize()` la escala salió correcta.

- **2026-09-25 - Segunda ronda de investigación de geovisores (Europa y
  resto del mundo).** Dos investigaciones web en paralelo, verificadas en
  webs oficiales, manuales e informes de ejemplo reales. En los servicios
  que podrían consultarse desde el navegador se comprobó con una petición
  real si aceptan CORS, porque de eso depende que encajen en la
  arquitectura sin servidor. Conclusiones principales:
  - Lo que distingue a las mejores herramientas de cribado (NEPAssist en
    EE. UU., PMST en Australia, Impact Risk Zones en Reino Unido, Análisis
    Territorial del SEA en Chile) es **cómo presentan las conclusiones**:
    preguntas de sí/no ("¿atraviesa Red Natura? Sí: Doñana, 22,6 ha"),
    distinción "intersecta el trazado" / "solo en el buffer" y **qué
    implica** cada hallazgo. Nuestra app ya calcula casi todo eso; falta
    sobre todo presentarlo así.
  - Las zonas inundables del **SNCZI se pueden consultar en vivo por WFS**
    (CORS abierto, verificado). Evitaría teselar 3 de las 5 capas grandes
    pendientes (T10/T100/T500).
  - **WDPA, KBA y Lista Roja de la UICN quedan descartadas** por licencia
    (prohíben o limitan el uso comercial y la redistribución en mapas
    web). Por el mismo motivo hay que **revisar la licencia de nuestra
    capa IBA** (ecosistema BirdLife) antes de publicar el visor.

  Se proponen 12 ideas priorizadas. Informe completo en
  `investigacion/ideas-mejora-geovisores-ronda2.md` (fuera de git, como
  todo `investigacion/`).

- **2026-09-28/29 - Tercer caso de prueba (puerto) y 8 arreglos.** Prueba
  como usuario con el tercer tipo de obra habitual, que faltaba: un dique
  exterior de ~540 m en el puerto pesquero de Carboneras (Almería), junto
  a la ZEC Islote de San Andrés y la ZEC marina Fondos Marinos Levante
  Almeriense. Detalle en
  `investigacion/ejemplos-de-uso/caso-puerto-dique-carboneras.md`.
  Arreglos:
  1. **Análisis incompleto sin aviso** (causa confirmada con una prueba
     instrumentada). El cruce consulta lo que MapLibre tiene *dibujado*
     (`queryRenderedFeatures`) tras esperar al evento `idle`, con un tope
     de 8 s. Si el tope se agotaba, la consulta salía igual y una capa
     recién encendida podía salir vacía: dos pasadas iguales dieron
     resultados distintos. Ahora hay repintado forzado (`triggerRepaint`,
     para que `idle` llegue siempre), un tope de 20 s y, si se agota, un
     **aviso** en el modal, el Excel y el informe. Lo mismo al capturar la
     cartografía, con aviso en el modal de exportación.
  2. **El nombre del elemento cercano no llegaba a las exportaciones.** En
     pantalla salía "RAMBLA DEL POZO, 417 m"; en CSV, Excel y PDF solo
     "417". Nueva columna "Elementos cercanos fuera del buffer", con el
     nombre y las distancias.
  3. **Solo se listaba el elemento más cercano de cada capa, y solo si no
     había cruce.** Una ZEC marina a 1,1 km quedaba oculta detrás de otra a
     500 m. Ahora se listan hasta 5 por capa, ordenados por distancia,
     también en capas con cruce directo. Los fragmentos se agrupan por
     nombre, porque un mismo río viene en muchos tramos con distinto
     `OBJECTID`.
  4. **Casos al borde del buffer.** Cada elemento cercano indica los metros
     que quedan fuera del borde del buffer. Se marca **"al borde"** si son
     menos de 50 m o del 10 % del buffer (la ZEC del ejemplo estaba a 7 m).
  5. **Plano y tabla no cuadraban.** Si una capa usaba un buffer propio
     (p. ej. Red Natura a 1 km con el tramo a 500 m), el plano solo dibujaba
     el general. Ahora los buffers por capa con cruce directo se dibujan
     punteados (`setAnalysisBuffers` en `upload.js`) y salen en la leyenda,
     con las capas que los usaron.
  6. **Hectáreas duplicadas entre figuras solapadas.** En ENP, el Parque
     Natural y la ZEC de Cabo de Gata tienen la misma geometría y se
     sumaban. Ahora la superficie es la de la **unión** de los trozos
     dentro del buffer (`unionAreaHectares`). Si una unión falla, ese trozo
     se suma aparte: mejor pasarse que perder superficie en silencio. En el
     caso de la carretera del Manzanares, DPH pasa de 3,13 a 3,00 ha por el
     solape entre deslindes.
  7. **Nota de cobertura en cada resultado.** El catálogo aún no tiene el
     Dominio Público Marítimo-Terrestre ni hábitats marinos (posidonia): en
     obras de costa o mar, "sin afecciones" puede ser falta de dato. Se dice
     en el modal, el Excel y el informe.
  8. **Leyenda:** ancho según el contenido (60-100 mm, antes fijo en 75) y
     texto recortado con "…" en vez de estrechado hasta hacerse ilegible.

  De paso salió un fallo anterior: **subir un archivo con el estilo del
  mapa aún cargando** fallaba ("Style is not done loading") y dejaba un
  tramo fantasma, dibujado en el mapa pero ausente del panel. Ahora la
  subida reintenta solo ese error (con tope de 15 s) y el tramo se añade a
  la lista después de dibujarse. No sirve esperar a `map.isStyleLoaded()`,
  que devuelve `false` mientras quede cualquier tesela por cargar.

  Verificado de punta a punta con los casos del puerto y de la carretera
  (modal, CSV/Excel, cartografía PNG e informe PDF revisados), sin errores
  nuevos en consola.

- **2026-09-29 - "Redactar con IA" (redacción asistida del apartado
  ambiental).** Nuevo botón en el modal de resultados del análisis
  (`src/js/ai-prompt.js`). Genera un texto con instrucciones y con los
  resultados del último análisis, listo para pegar en la herramienta de IA
  que use la empresa (Claude, Copilot…) y obtener un borrador del apartado
  "Condicionantes ambientales" de una oferta. Decisiones:
  - **El visor no llama a ninguna IA ni envía datos.** Solo arma el texto,
    lo muestra entero en pantalla (se ve qué se va a compartir) y lo copia
    al portapapeles. Así no hace falta servidor ni clave de API: el visor es
    estático y el repo público, y una clave en el código quedaría expuesta.
    Se valoraron otras dos opciones: clave propia de cada usuario y llamada
    directa, o un intermediario en la nube con la clave de la empresa. Se
    dejan para después, si la función resulta útil. La ventana avisa de que
    el texto contiene datos de la licitación y solo debe usarse en
    herramientas autorizadas por Quadrante.
  - **La IA solo redacta.** Cifras, nombres y distancias salen del análisis
    determinista. Las instrucciones le prohíben añadir datos o normativa
    propios (lo normativo va como "[VERIFICAR: …]") y le piden mencionar los
    elementos "al borde del buffer", tratar como tales los hallazgos
    descartados en campo y, en obras de costa o mar, avisar de que faltan el
    Dominio Público Marítimo-Terrestre y los hábitats marinos.
  - Campos editables: nombre del proyecto (por defecto, el título del mapa
    o el nombre del archivo) y tipo de obra. Se recuerdan por tramo al
    recalcular.

  Verificado: botón y ventana con clics reales, texto completo revisado,
  copia comprobada en el portapapeles de Windows y casos límite (sin
  hallazgos, análisis incompleto, polígono + puntos). Ejemplo del borrador
  que devuelve una IA con este texto en
  `investigacion/ejemplos-de-uso/ejemplo-redaccion-ia-puerto.md`.

- **2026-09-29 - Nombres de capa sencillos y mapa de situación con
  polígonos** (pedido por Francisco).
  - **Nombres:** sin siglas ni paréntesis que no aportan: "Red hidrográfica"
    (antes "(Pfafstetter)"), "Red Natura 2000", "Espacios naturales
    protegidos", "Zonas húmedas", "Vías pecuarias", "Áreas importantes para
    las aves". "Dominio público hidráulico deslindado" conserva
    "deslindado" a propósito: la capa solo trae los tramos con deslinde
    oficial, y sin la palabra se leería como todo el DPH. Las siglas
    técnicas siguen donde sirven: variantes ZEC/ZEPA de la leyenda y
    columna "Fuente".
  - **Panel de capas:** el nombre ocupa ahora la primera línea, con todo el
    ancho, y la transparencia y los botones (Aa, subir/bajar) la segunda.
    Compartiendo línea con los botones, el nombre solo tenía unos 110 px y
    se cortaba ("Espacios natur…"). Al pasar el ratón se ven el nombre y la
    fuente.
  - **Líneas límite fuera del panel.** El mapa de situación usa polígonos de
    provincia (`pipeline/build_situacion.py`, a partir de los recintos de la
    BDDAE del IGN, simplificados a ~400 m, 709 KB, que se cargan solo al
    exportar con mapa de situación). Resalta la provincia del proyecto,
    aclara el resto de su comunidad y rotula "Almería, Andalucía" (solo la
    comunidad si es uniprovincial: "Comunidad de Madrid"). Si el centro del
    plano cae fuera de toda provincia (una obra en el mar), se elige la más
    cercana a menos de 30 km.
  - **Hueco en el origen:** la carpeta de recintos *provinciales* de Canarias
    está vacía. Las dos provincias canarias se reconstruyen uniendo sus
    municipios por el código de provincia de `NATCODE` (35 Las Palmas, 38
    Santa Cruz de Tenerife).

  Verificado: panel (nombres, encender, Aa, reordenar), mapa de situación
  exportado en Carboneras (centro en el mar → Almería), y rótulos de
  Madrid, Tenerife, Baleares, Ceuta, Cantabria, Valencia, Bizkaia, alta mar
  y Portugal (los dos últimos sin rótulo, correcto).

- **2026-09-29 - Prueba de trazado largo (58 km, Córdoba - Sierra Morena):
  un fallo que abortaba el análisis y dos cuellos de botella.** Detalle en
  `investigacion/ejemplos-de-uso/caso-carretera-larga-sierra-morena.md`.
  1. **El análisis abortaba** ("must be a LineString, given
     MultiLineString"). El borde de un espacio multiparte con huecos no se
     descomponía bien antes de medir distancias. El fallo era anterior, pero
     la lista de cercanos del 28/09 lo hacía casi seguro en trazados largos.
     Arreglo: `turf.flatten`.
  2. **156 s con la página congelada** midiendo distancias a los elementos
     cercanos. Ahora se mide en una proyección local en metros (error
     inferior al 0,5 %) y se acota primero con el rectángulo envolvente de
     cada elemento (`minDistanceMetersToFeature`, `buildDistanceContext`).
  3. **18 s midiendo la longitud de líneas dentro del buffer**, con trozos
     de 10 m. Ahora es un cálculo exacto, por cruces de cada segmento con el
     borde del buffer (`lineLengthInsidePolygonMeters`): 42 ms, y el mismo
     resultado que el método anterior (+0,08 % en 67 elementos).

  Resultado: **~7 s** en total. Analizado entero frente a en 6 tramos:
  mismos elementos en todas las capas, superficies iguales (descontado el
  solape de buffers en las uniones) y la red hidrográfica un 2 % más larga
  (a zoom 9 sus teselas vienen algo más simplificadas). No probado por
  encima de ~60 km; si hiciera falta, el análisis podría dividir él solo los
  trazados largos. Regresión: Carboneras y Manzanares dan lo mismo (±1-2 m
  en distancias; Manzanares 507 m de río en vez de 500 m, porque el método
  antiguo redondeaba a trozos de 10 m).

- **2026-09-29 - Zonas inundables del SNCZI en línea** (pedido por
  Francisco: probarlas en vivo y ver sus limitaciones). Seis capas nuevas
  en el grupo "Zonas inundables (en línea)": **zona de flujo preferente,
  T10, T100, T500** (fluviales) y **costera T100 / T500** (origen marino).
  Se consultan al WFS de MITECO (`https://gis.miteco.gob.es/geoserver/wfs`,
  capas `agua:ZI_Laminas_ZFP`, `agua:Zi_laminas_q10/q100/q500`,
  `costas:zim_laminas_q100/q500`) en vez de teselarlas. Sustituyen a 3 de
  las 5 capas grandes pendientes (láminas de 1-1,9 GB cada una).
  - **Cómo funciona** (`src/js/wfs-layers.js`, `l.wfs` en `layers.js`): en
    el mapa se cargan solo para la vista actual, al mover el mapa y solo si
    la vista mide menos de 60 km de diagonal. En el panel se ve el estado:
    "En línea · MITECO", "Cargando…", "Acerca el mapa", "Servicio no
    disponible". En el **análisis** se piden directamente al servicio para
    el área de búsqueda, en paralelo con la carga del mapa: no dependen de
    lo dibujado. En la exportación se cargan para el encuadre del plano.
  - **Si el servicio falla**, la capa queda **SIN RESULTADO**, nunca como
    "sin afecciones", con aviso en el modal, el Excel, el informe y el
    texto para la IA ("CAPAS SIN DATOS"). Probado simulando una caída.
  - **Probado:** carretera de Córdoba (Guadalquivir: T10 15,5 ha ≤ T100
    16,6 ha ≤ T500 32,1 ha; zona de flujo preferente 16,4 ha), Manzanares
    (T500 1,93 ha, zona de flujo preferente 0,73 ha, T10 0,38 ha) y
    Carboneras (costera "Carboneras (56-a)"). El análisis de 58 km sigue en
    ~5 s. Cartografía exportada con las zonas en la leyenda y dibujadas por
    debajo del resto de capas.
  - **Limitaciones medidas:**
    1. **Cobertura:** solo hay zona donde el SNCZI hizo el estudio (sobre
       todo las ARPSI). En la carretera de 58 km, de 22 cauces con nombre
       solo el Guadalquivir tenía zona. Se avisa en cada resultado
       (`ANALYSIS_FLOOD_COVERAGE_NOTE`).
    2. **Peso:** cada elemento es la zona entera de un tramo estudiado
       (Guadalquivir en Córdoba: ~0,5 MB). La carretera de 58 km son ~0,7
       MB por capa. Por eso el límite de vista de 60 km.
    3. **Precisión:** coordenadas con 4 decimales (~10 m).
    4. **Dependencia del servicio:** sin conexión o con MITECO caído, no hay
       dato (avisado, ver arriba). CORS abierto (`*`), 0,1-0,3 s por
       consulta y máximo de 1.000.000 de elementos por petición en el
       servidor (usamos 500).
    5. **Nombres:** algunas demarcaciones anteponen el código del tramo
       ("ES030-12-04-1-01 Río Manzanares"). Se quita para mostrarlo; el
       código queda en `id_zona`.
  - **Hallazgo extra en el mismo servidor, también abierto:**
    `costas:dominio_publico_maritimo_terrestre` (líneas de deslinde con
    expediente, municipio, estado y orden ministerial),
    `costas:Servidumbre_Proteccion` y, en `evaluacionambiental`, los
    indicadores de la zonificación ambiental para renovables y los mapas
    estratégicos de ruido. El DPMT cubriría el hueco de datos para puertos
    con el mismo mecanismo.

- **2026-09-29 - Semáforo de sensibilidad rediseñado** (pedido por
  Francisco: "que me diga si toco o no algo ambiental, cuánto, y qué
  importancia tiene"). El anterior (un nivel fijo por capa con dos ajustes)
  no distinguía que la obra **pise** un elemento de que solo caiga en su
  buffer, no usaba el "cuánto" y no explicaba el porqué. Ahora son tres
  preguntas (`sensitivityFor`, `directContactForLayer` y
  `sensitivityReason` en `analysis.js`):
  1. **Importancia** del elemento por su régimen legal (`importancia` e
     `importanciaMotivo` en `layers.js`). **Alta:** Red Natura, ENP, zonas
     húmedas, humedales y turberas (subidos a Alta por decisión de
     Francisco), zona de flujo preferente, T10. **Media:** DPH, cauces,
     vías pecuarias (Media, decisión de Francisco), T100/T500, costeras.
  2. **Cómo lo toca la obra:** **directa** (el trazado o la huella lo pisa:
     metros de trazado dentro, ha de la huella dentro o veces que lo cruza),
     **en el entorno** (solo dentro del buffer) o **próxima** (fuera del
     buffer, a menos de 2 km). Un contacto directo de menos de 25 m o 0,1 ha
     es **"roce, a verificar"** y cuenta como en el entorno: puede deberse a
     la precisión del dato.
  3. **Sensibilidad = importancia × afección.** Alta: Muy Alta / Alta /
     Media. Media: Alta / Media / Baja. Baja: Media / Baja / Baja.

  El "cuánto" (ha y m dentro del buffer, y % del espacio en Red Natura y ENP,
  que traen su superficie total) no cambia el color salvo en el roce: no hay
  umbrales legales de superficie para un cribado. Siempre se ve en el
  **porqué** de cada fila (modal, Excel, informe, texto para la IA), p. ej.
  *"Muy Alta: importancia alta (usos muy restringidos por el RDPH) · la obra
  lo pisa: 67 m de trazado dentro · 0,73 ha dentro del buffer"*. El modal
  incluye un desplegable "¿Cómo se decide la sensibilidad?" con la matriz.
  Se quitó el ajuste "+1 si ZEC y ZEPA a la vez", que no encaja en el nuevo
  esquema. Columnas nuevas en CSV y Excel: Afección, Importancia, Contacto
  con la obra y Motivo; el informe PDF muestra un subconjunto
  (`REPORT_COLUMNS`).

  Probado a medias (la ventana estaba minimizada y el mapa no dibujaba, así
  que solo salieron completas las capas en línea y las ya cargadas):
  Manzanares da las zonas inundables y el DPH como afección directa, y
  Carboneras las zonas inundables cercanas como "en el entorno".

  **Prueba completa (2026-10-01)** de cerramiento, Manzanares, Carboneras
  (500 m y 1 km) y Córdoba 58 km: sin errores y con resultados coherentes
  (p. ej. Córdoba: Red Natura Muy Alta, "17.493 m de trazado dentro · 0,42 %
  de Guadiato-Bembézar"; Carboneras 1 km: Islote Alta, "en el entorno · 70 %
  del espacio"). Ajustes que salieron de la prueba:
  - Nuevo caso **"al borde del buffer (a verificar)"**: fuera del buffer
    pero a menos de 50 m o del 10 % de su borde cuenta como en el entorno,
    simétrico al roce (el Islote, a 7 m del borde con 500 m, salía Media).
  - En el modal, los resultados van antes que los controles de buffer.
  - En el informe, la fuente va bajo el nombre de la capa, las columnas de
    longitud y superficie se ensanchan y la fecha sale como 01/10/2026.
  - Excel verificado: 17 columnas, con los colores de capa y de semáforo.

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

**Hábitats de Interés Comunitario (HIC):** estuvo en el catálogo y se
retiró (2026-09-23, decisión de Francisco) - era una malla 10×10 km de
presencia, no delimitación real, y traía consigo un bug de fondo (mismo
polígono repetido por cada código de hábitat en una celda, ver §2
2026-09-18). El código y los datos (`data-web/hic.pmtiles`) siguen en el
repositorio por si se retoma en el futuro con un origen de datos mejor.

### Nivel 3 - Contexto e información complementaria (activable, no cruce automático)

| Capa | Fuente | Notas |
|---|---|---|
| IBA - Áreas Importantes para las Aves | SEO/BirdLife | criterio científico, **no figura legal** |
| Núcleos urbanos | CNIG | contexto |

Las **líneas límite** municipales, provinciales y autonómicas se retiraron
del visor (2026-09-29, decisión de Francisco). El mapa de situación de la
cartografía usa en su lugar **polígonos de provincia**
(`data-web/situacion_provincias.geojson`, generado con
`pipeline/build_situacion.py`). Los `limites_*.pmtiles` siguen en
`data-web/` por si se retoman.

Los nombres de este catálogo son los técnicos del origen. En el visor, la
leyenda y las exportaciones se usan nombres más sencillos (`nombre` en
`src/js/layers.js`), p. ej. "Red hidrográfica" en vez de "Red hidrográfica
(Pfafstetter)".

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
   La superficie de cada capa es la de la unión de sus elementos dentro del
   buffer, sin contar dos veces las figuras solapadas. Además se listan
   hasta 5 **elementos cercanos fuera del buffer** por capa (hasta 2 km más
   allá), con la distancia al trazado y al borde del buffer y un aviso si
   quedan "al borde" (ver §2 2026-09-28/29).
5. Exporta **tabla de afecciones** a CSV y a Excel (con formato: colores
   del geovisor, cabecera corporativa, filtro automático). Word se
   descartó - no hace falta.
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
  leyenda, mapa de situación (inset a 1:2.500.000, implementado
  2026-09-25; desde el 2026-09-29 con polígonos de provincia, la del
  proyecto resaltada, su comunidad aclarada y rotulada "Provincia,
  Comunidad") y cuadrícula UTM
  rotulada en el marco (ETRS89, o REGCAN95 en Canarias) - ambos
  opcionales desde el modal de exportación.
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
  - El servidor no manda cabeceras `Cache-Control`: tras editar un `.js`
    **o un `.css`**, el navegador a veces sigue sirviendo la versión
    vieja - recarga forzada (Ctrl+Shift+R) si un cambio no se refleja.
    (2026-09-23: un cambio de CSS que parecía no aplicarse resultó ser
    justo esto, no un error del propio CSS.)
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
      afectados y los **nombres reales** de los elementos.
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
- [x] Probar el cruce de afecciones con un tramo/caso **real**
      (2026-09-24/25): dos casos realistas de punta a punta, un
      cerramiento de planta agroindustrial y una carretera que cruza el
      río Manzanares, más un proyecto real de Francisco. Los fallos que
      salieron se corrigieron (ver las entradas del 24 y 25/09).
      Documentado en `investigacion/ejemplos-de-uso/`.
- [ ] Generar las capas grandes pendientes - **dejado para el final**
      (decisión 2026-09-23), no bloquea nada más del proyecto. Desde el
      2026-09-29 quedan 2 de 5: DPH cartográfico probable y montes de
      utilidad pública. Las 3 de inundabilidad (T10/T100/T500) se resolvieron
      con el servicio en línea del SNCZI (ver §2).
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
      MapLibre) en vez de un único verde: **verde = ZEC, naranja = ZEPA,
      morado = ambas** (el rojo inicial se descartó por parecer una
      alarma/prohibición en vez de "las dos categorías a la vez"). La
      leyenda de la cartografía exportada lista las variantes como filas
      separadas, pero **solo las que aparecen de verdad en la vista
      exportada** (misma lógica que ya se aplicaba a nivel de capa
      completa). El panel de capas también muestra los 3 colores como
      mini-swatches junto al checkbox, en vez de un único color de
      "resumen" que ya no reflejaba lo que se ve en el mapa.
- [x] Opacidad del nombre de elemento independiente del relleno/línea
      (2026-09-23, detectado por Francisco). Antes `setLayerOpacity`
      aplicaba el mismo valor a `fill-opacity`/`line-opacity` y a
      `text-opacity`, así que bajar la transparencia del polígono también
      desvanecía su nombre. Ahora el texto va siempre a opacidad máxima,
      independiente del control de transparencia de la capa.
- [x] Capa HIC retirada (2026-09-23, decisión de Francisco). Era una
      malla de presencia 10×10 km, no delimitación real, con un bug de
      fondo propio (ver §2 2026-09-18). Fuera del catálogo (`layers.js`)
      y del código de análisis específico para ella (`presenceOnly` en
      `analysis.js`, ya sin uso tras quitar HIC). El dato
      (`data-web/hic.pmtiles`) sigue en el repo por si se retoma.
- [x] Nombres de elemento repetidos al alejar el zoom en polígonos/líneas
      grandes (2026-09-23, detectado por Francisco). Fuente de puntos de
      etiqueta dedicada por capa (`_labels.pmtiles`, generada con
      `pipeline/build_tiles.py --labels-only`), con un único punto por
      entidad real en vez de un símbolo por tesela cruzada (ver §2 para
      el detalle completo). Verificado en las 7 capas con `labelField`:
      `red_natura_2000`, `enp`, `vias_pecuarias`, `dph_deslindado`,
      `iezh`, `red_hidrografica`, `iba`.
- [x] 5 mejoras del análisis de afecciones a partir de la investigación
      de geovisores de referencia (2026-09-23, ver §2 y
      `investigacion/ideas-mejora-geovisores-referencia.md`): fuente por
      capa en el export, checklist de verificación en campo, distancia
      al elemento más cercano cuando no hay cruce directo, buffer
      configurable por capa (con 100 m sugerido para la red
      hidrográfica), y detección de solapamiento entre varios tramos
      propios subidos.
- [x] Semáforo de sensibilidad (Muy Alta/Alta/Media/Baja) por hallazgo
      (2026-09-24, idea #1). Investigado primero cómo lo hace la
      herramienta de referencia (South Africa Screening Tool: mapa
      pre-clasificado por ecólogos, sensibilidad por tema, no una
      fórmula a partir de la geometría del proyecto) - ver §2. Valor
      base por capa en `layers.js` (`sensitivityBase`, propuesta de
      Quadrante, no reglamentaria) con dos matices calculados en
      `analysis.js` (cercanía sin cruce baja un escalón; Red Natura
      2000 con ZEC+ZEPA sube uno), mostrado como badge de color en el
      modal de resultados y en el Excel exportado.
- [x] Cartografía incompleta si se exporta justo tras analizar
      (2026-09-24, encontrado probando un caso real de cerramiento -
      ver `investigacion/ejemplos-de-uso/`). Las capas con afección
      directa se quedan activadas (estado + casilla) después de
      "Analizar afecciones", con aviso en el propio modal, en vez de
      volver a ocultarse en silencio.
- [x] Escala de exportación mal ajustada si se exporta justo tras
      analizar (2026-09-24, mismo caso de prueba) - el mapa quedaba
      encuadrado al margen de búsqueda ampliado del análisis (buffer +
      2 km), no al tamaño real del proyecto. Corregido: al terminar el
      análisis, el mapa se reencuadra al área de los buffers realmente
      usados para el cruce.
- [ ] Legibilidad del mapa con varias capas de polígono solapadas
      (2026-09-24, mismo caso de prueba) - sin solución obvia, ver
      `investigacion/ejemplos-de-uso/caso-cerramiento-planta-agroindustrial.md` §4.3.
      En parte mitigado (2026-09-25): el buffer ya no suma otro relleno
      encima por defecto (solo contorno); el solape entre capas
      ambientales sigue pendiente.
- [x] 3 mejoras de cartografía pedidas por Francisco probando el visor
      con un proyecto real (2026-09-24): grosor de línea personalizable
      por tramo (con el mismo fix de escalado por DPI que ya tenía el
      texto), la línea/capa del proyecto en la leyenda exportada, y los
      nombres de elemento como respaldo en la leyenda cuando no llegan a
      verse como texto sobre el mapa.
- [x] 5 mejoras de cartografía (2026-09-25): buffer como contorno
      discontinuo (estilo configurable), buffer en la leyenda con
      símbolos según tipo de elemento, mapa de situación, cuadrícula UTM
      ETRS89 rotulada en el marco, e informe PDF único (cartografía +
      tabla de afecciones con semáforo + notas de metodología).
- [x] Tercer caso de prueba, un puerto (2026-09-28/29): 8 arreglos del
      análisis, las exportaciones y la cartografía, más el fallo de subida
      con el estilo aún cargando (ver §2 y
      `investigacion/ejemplos-de-uso/caso-puerto-dique-carboneras.md`).
- [x] "Redactar con IA" (2026-09-29): texto para pegar en una herramienta de
      IA y obtener un borrador del apartado ambiental. Sin llamadas externas
      ni clave de API (ver §2). Pendiente de decidir con Quadrante qué
      herramientas de IA se autorizan con datos de licitación y si merece la
      pena integrar la llamada directa.
- [x] Zonas inundables del SNCZI en línea (2026-09-29): zona de flujo
      preferente, T10/T100/T500 y costeras T100/T500, consultadas al WFS de
      MITECO. Sustituyen a las 3 láminas grandes pendientes (ver §2).
- [ ] Dominio Público Marítimo-Terrestre en línea: localizado en el mismo
      servidor (`costas:dominio_publico_maritimo_terrestre`, líneas de
      deslinde), probado desde el navegador; falta integrarlo con el mismo
      mecanismo que las zonas inundables (2026-09-29).
- [ ] Capas para obra marítima: Dominio Público Marítimo-Terrestre
      (deslinde de Costas) y hábitats marinos / posidonia (idea 10 de la
      ronda 2, EMODnet). Hoy es un hueco de datos, avisado en cada
      resultado (2026-09-29).
- [ ] Revisar la licencia de la capa IBA (`IBA_España_2025_11_05.gpkg`,
      ecosistema BirdLife) antes de publicar el visor (2026-09-25, ver
      §2)
- [ ] Ideas de la segunda ronda de investigación (2026-09-25,
      `investigacion/ideas-mejora-geovisores-ronda2.md`). Recomendado
      para la próxima semana:
      1. Portada de conclusiones del informe (preguntas de sí/no,
         "intersecta" / "solo en el buffer").
      2. Guardar y compartir el proyecto (`.json` + vista en la URL).
      3. Exportar el recorte de capas para QGIS (GeoJSON/KML).
      4. Ortofotos históricas del IGN con cortinilla.

      Después: tipo de obra + "¿qué implica?", y zonas inundables SNCZI
      por WFS.
- [ ] (Después) Componente 2 - geovisor de proyectos desde MyMaps
- [ ] (Después) Componente 3 - geovisor de arqueología (nuevo,
      2026-09-21, sin especificar todavía)
