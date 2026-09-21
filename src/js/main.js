// Geovisor Ambiental -- visor MapLibre GL JS + PMTiles.
//
// Requiere servirse por HTTP con soporte de peticiones de rango (HTTP Byte
// Serving) -- PMTiles falla si el servidor no lo soporta. El modulo
// "http.server" normal de Python NO sirve rangos (devuelve el archivo
// completo siempre) y rompe la carga de capas con el error "Server
// returned no content-length header...". Usar en su lugar:
//   pip install rangehttpserver
//   python -m RangeHTTPServer 8000
// desde la raiz del proyecto, y abrir http://localhost:8000/src/index.html
// GitHub Pages sí soporta rangos de forma nativa, sin necesidad de nada de
// esto en producción.

const protocol = new pmtiles.Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);

const BASEMAPS = {
  osm: {
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    attribution: "© OpenStreetMap",
  },
  pnoa: {
    tiles: ["https://tms-pnoa-ma.idee.es/1.0.0/pnoa-ma/{z}/{x}/{y}.jpeg"],
    scheme: "tms", // el "{-y}" de Leaflet no es un token valido en MapLibre
    attribution: "PNOA © Instituto Geográfico Nacional",
  },
};

// Opacidad actual por capa (0-1). Arranca en el mismo valor por defecto que
// se usaba antes de tener el control: 0.35 para relleno de poligono, 1
// para lineas (el trazo ya es fino, no hace falta atenuarlo de entrada).
const layerOpacity = {};
for (const l of LAYERS) layerOpacity[l.id] = l.geom === "polygon" ? 0.35 : 1;

// Visibilidad actual por capa -- separado de "visibleByDefault" (que es
// solo el valor inicial) porque el panel se reconstruye al reordenar
// capas, y sin este seguimiento se perderian los checkboxes que el
// usuario haya cambiado durante la sesion.
const layerVisible = {};
for (const l of LAYERS) layerVisible[l.id] = l.visibleByDefault;

// Visibilidad de las ETIQUETAS de cada capa, independiente de si la capa
// en si esta encendida -- se puede querer ver el relleno/linea de una
// capa sin sus nombres (o al reves, aunque sin la capa visible el nombre
// no tendria mucho sentido, así que se aplica siempre en combinacion con
// layerVisible, nunca solo).
const labelVisible = {};
for (const l of LAYERS) labelVisible[l.id] = true;

function buildStyle(basemapKey) {
  const basemap = BASEMAPS[basemapKey];
  const sources = {
    basemap: {
      type: "raster",
      tiles: basemap.tiles,
      tileSize: 256,
      scheme: basemap.scheme || "xyz",
      attribution: basemap.attribution,
    },
  };
  const layers = [{ id: "basemap", type: "raster", source: "basemap" }];

  for (const l of LAYERS) {
    const sourceId = `src-${l.id}`;
    sources[sourceId] = {
      type: "vector",
      url: `pmtiles://../data-web/${l.id}.pmtiles`,
    };

    const visibility = layerVisible[l.id] ? "visible" : "none";
    const opacity = layerOpacity[l.id];

    if (l.geom === "polygon") {
      layers.push({
        id: `${l.id}-fill`,
        type: "fill",
        source: sourceId,
        "source-layer": l.sourceLayer,
        layout: { visibility },
        paint: { "fill-color": l.color.fill, "fill-opacity": opacity },
      });
      layers.push({
        id: `${l.id}-line`,
        type: "line",
        source: sourceId,
        "source-layer": l.sourceLayer,
        layout: { visibility },
        paint: { "line-color": l.color.line, "line-width": 1, "line-opacity": opacity },
      });
    } else {
      layers.push({
        id: `${l.id}-line`,
        type: "line",
        source: sourceId,
        "source-layer": l.sourceLayer,
        layout: { visibility },
        paint: {
          "line-color": l.color.line,
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 12, 2.2],
          "line-opacity": opacity,
        },
      });
    }

    if (l.labelField) {
      layers.push({
        id: `${l.id}-label`,
        type: "symbol",
        source: sourceId,
        "source-layer": l.sourceLayer,
        minzoom: 7,
        // Cuando hay demasiadas etiquetas candidatas compitiendo por el
        // mismo hueco (redes muy densas como la hidrografica), MapLibre
        // oculta las que no caben -- symbol-sort-key decide cuales ganan
        // esa pugna. Valor mas BAJO = mas prioridad, así que se usa el
        // campo de longitud en negativo para que los tramos mas largos
        // (mas relevantes) se muestren antes que los cortos.
        ...(l.sortField ? { "symbol-sort-key": ["-", 0, ["to-number", ["get", l.sortField]]] } : {}),
        layout: {
          visibility: layerVisible[l.id] && labelVisible[l.id] ? "visible" : "none",
          // Varias capas de origen usan un valor de relleno tipo "SIN
          // NOMBRE" en vez de dejar el campo vacio cuando el elemento no
          // tiene nombre propio (p. ej. ~49% de los tramos de la red
          // hidrografica). Sin este filtro, esos tramos mostrarian el
          // texto literal "SIN NOMBRE" en vez de no mostrar etiqueta.
          "text-field": [
            "case",
            ["in", ["downcase", ["to-string", ["coalesce", ["get", l.labelField], ""]]],
              ["literal", ["sin nombre", "s/n", "sin identificar", ""]]],
            "",
            ["get", l.labelField],
          ],
          "text-font": ["Noto Sans Regular"],
          "text-size": 11,
          // "point" en vez de "line" tambien para las capas de linea (rios,
          // vias pecuarias): con "line" el texto tiene que caber A LO
          // LARGO del propio tramo, así que un tramo corto (muy comun en
          // rios) no mostraba nombre hasta hacer mucho zoom. Con "point"
          // se ancla en el centro del tramo sin depender de su longitud en
          // pantalla -- aparece igual de "sin nombre real" o "con nombre"
          // que antes, solo que ya no exige que el tramo sea largo.
          "symbol-placement": "point",
          "text-max-width": 8,
        },
        paint: {
          "text-color": l.color.line,
          "text-halo-color": "#ffffff",
          "text-halo-width": 1.4,
          "text-opacity": opacity,
        },
      });
    }
  }

  return {
    version: 8,
    glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
    sources,
    layers,
  };
}

const map = new maplibregl.Map({
  container: "map",
  style: buildStyle("pnoa"),
  center: [-3.7, 40.2],
  zoom: 5.3,
  attributionControl: false,
  preserveDrawingBuffer: true, // necesario para poder exportar el canvas como imagen
});

map.addControl(new maplibregl.NavigationControl(), "top-right");
map.addControl(
  new maplibregl.ScaleControl({ maxWidth: 150, unit: "metric" }),
  "bottom-left"
);
map.addControl(
  new maplibregl.AttributionControl({
    customAttribution: "Elaboración propia a partir de MITECO/IGN · Quadrante",
  }),
  "bottom-right"
);

// --- Cambio de mapa base ---
document.querySelectorAll('input[name="basemap"]').forEach((el) => {
  el.addEventListener("change", (e) => {
    const key = e.target.value;
    map.setStyle(buildStyle(key));
    map.once("styledata", syncPanelToMap);
  });
});

function layerIds(l) {
  return l.geom === "polygon" ? [`${l.id}-fill`, `${l.id}-line`] : [`${l.id}-line`];
}

function applyLabelVisibility(l) {
  if (!l.labelField || !map.getLayer(`${l.id}-label`)) return;
  const vis = layerVisible[l.id] && labelVisible[l.id] ? "visible" : "none";
  map.setLayoutProperty(`${l.id}-label`, "visibility", vis);
}

function setLayerVisible(l, visible) {
  layerVisible[l.id] = visible;
  const vis = visible ? "visible" : "none";
  for (const id of layerIds(l)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
  }
  applyLabelVisibility(l);
}

function setLabelVisible(l, visible) {
  labelVisible[l.id] = visible;
  applyLabelVisibility(l);
}

function currentBasemapKey() {
  return document.querySelector('input[name="basemap"]:checked').value;
}

// Cambia el orden de dibujo de una capa dentro de su propia tematica (no
// se puede sacar del grupo del panel -- ver buildLayerPanel). direction:
// -1 sube (se dibuja mas encima), +1 baja. Reconstruye el estilo entero
// porque es la forma mas simple y fiable de reordenar en MapLibre sin
// tener que mover a mano cada sub-capa (fill/line/label) una por una con
// moveLayer().
function moveLayerInHierarchy(layerId, direction) {
  const idx = LAYERS.findIndex((l) => l.id === layerId);
  if (idx === -1) return;
  const swapIdx = idx + direction;
  if (swapIdx < 0 || swapIdx >= LAYERS.length) return;
  if (LAYERS[swapIdx].tematica !== LAYERS[idx].tematica) return;

  [LAYERS[idx], LAYERS[swapIdx]] = [LAYERS[swapIdx], LAYERS[idx]];

  map.setStyle(buildStyle(currentBasemapKey()));
  map.once("styledata", buildLayerPanel);
}

function setLayerOpacity(l, opacity) {
  layerOpacity[l.id] = opacity;
  if (l.geom === "polygon" && map.getLayer(`${l.id}-fill`)) {
    map.setPaintProperty(`${l.id}-fill`, "fill-opacity", opacity);
  }
  if (map.getLayer(`${l.id}-line`)) {
    map.setPaintProperty(`${l.id}-line`, "line-opacity", opacity);
  }
  if (l.labelField && map.getLayer(`${l.id}-label`)) {
    map.setPaintProperty(`${l.id}-label`, "text-opacity", opacity);
  }
}

function syncPanelToMap() {
  document.querySelectorAll(".layer-toggle").forEach((cb) => {
    const layer = LAYERS.find((l) => l.id === cb.dataset.id);
    if (layer) setLayerVisible(layer, cb.checked);
  });
  document.querySelectorAll(".layer-opacity").forEach((sl) => {
    const layer = LAYERS.find((l) => l.id === sl.dataset.id);
    if (layer) setLayerOpacity(layer, Number(sl.value) / 100);
  });
  document.querySelectorAll(".layer-label-toggle").forEach((cb) => {
    const layer = LAYERS.find((l) => l.id === cb.dataset.id);
    if (layer) setLabelVisible(layer, cb.checked);
  });
}

// --- Panel de capas / leyenda ---
// Agrupado por TEMATICA de cara al usuario (README §5), con el nivel
// juridico como insignia informativa en cada fila -- no como agrupacion
// principal. Orden de dibujo en el mapa: la ultima capa del array LAYERS
// se dibuja encima; el array esta agrupado por tematica en ese mismo
// orden (ver layers.js) para que el reordenado "arriba/abajo" del panel
// coincida con el array real. Dentro de cada grupo se lista al REVES (la
// que esta mas arriba en el panel = la que se dibuja mas encima en el
// mapa), convencion habitual (QGIS, Photoshop...).
function buildLayerPanel() {
  const panel = document.getElementById("layer-panel");
  const porTematica = {};
  for (const t of TEMATICA_ORDER) porTematica[t] = [];
  for (const l of LAYERS) porTematica[l.tematica].push(l);

  let html = "";
  for (const tematica of TEMATICA_ORDER) {
    const capas = porTematica[tematica].slice().reverse();
    if (capas.length === 0) continue;
    html += `<div class="tematica-group"><h3>${TEMATICA_LABEL[tematica]}</h3>`;
    capas.forEach((l, i) => {
      const checked = layerVisible[l.id] ? "checked" : "";
      const opacityPct = Math.round(layerOpacity[l.id] * 100);
      const disabledUp = i === 0 ? "disabled" : "";
      const disabledDown = i === capas.length - 1 ? "disabled" : "";
      html += `
        <div class="layer-row">
          <div class="layer-row-main">
            <label>
              <input type="checkbox" class="layer-toggle" data-id="${l.id}" ${checked}>
              <span class="swatch" style="background:${l.color.fill}"></span>
              <span class="nivel-badge nivel-badge-${l.nivel}" title="${NIVEL_LABEL[l.nivel]}">${NIVEL_BADGE[l.nivel]}</span>
              <span class="layer-name">${l.nombre}</span>
            </label>
            <span class="layer-order-btns">
              ${l.labelField ? `<label class="label-toggle-btn" title="Mostrar/ocultar nombres">
                <input type="checkbox" class="layer-label-toggle" data-id="${l.id}" ${labelVisible[l.id] ? "checked" : ""}>Aa
              </label>` : ""}
              <button class="layer-order-btn" data-id="${l.id}" data-dir="up" ${disabledUp} title="Dibujar más encima">▲</button>
              <button class="layer-order-btn" data-id="${l.id}" data-dir="down" ${disabledDown} title="Dibujar más debajo">▼</button>
            </span>
          </div>
          <input type="range" class="layer-opacity" data-id="${l.id}" min="0" max="100" value="${opacityPct}" title="Transparencia">
        </div>`;
    });
    html += `</div>`;
  }
  panel.innerHTML = html;

  panel.querySelectorAll(".layer-toggle").forEach((cb) => {
    cb.addEventListener("change", () => {
      const layer = LAYERS.find((l) => l.id === cb.dataset.id);
      setLayerVisible(layer, cb.checked);
    });
  });
  panel.querySelectorAll(".layer-opacity").forEach((sl) => {
    sl.addEventListener("input", () => {
      const layer = LAYERS.find((l) => l.id === sl.dataset.id);
      setLayerOpacity(layer, Number(sl.value) / 100);
    });
  });
  panel.querySelectorAll(".layer-label-toggle").forEach((cb) => {
    cb.addEventListener("change", () => {
      const layer = LAYERS.find((l) => l.id === cb.dataset.id);
      setLabelVisible(layer, cb.checked);
    });
  });
  panel.querySelectorAll(".layer-order-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      // "up" en el panel (mas encima en el mapa) = avanzar hacia el final
      // del array LAYERS, que es lo ultimo que se dibuja.
      const direction = btn.dataset.dir === "up" ? 1 : -1;
      moveLayerInHierarchy(btn.dataset.id, direction);
    });
  });
}

map.on("load", buildLayerPanel);

// --- Panel colapsable ---
document.getElementById("panel-toggle").addEventListener("click", () => {
  document.getElementById("layer-panel-container").classList.toggle("collapsed");
});
