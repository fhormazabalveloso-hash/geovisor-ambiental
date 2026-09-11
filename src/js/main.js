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

    const colors = NIVEL_COLOR[l.nivel];
    const visibility = l.visibleByDefault ? "visible" : "none";

    if (l.geom === "polygon") {
      layers.push({
        id: `${l.id}-fill`,
        type: "fill",
        source: sourceId,
        "source-layer": l.sourceLayer,
        layout: { visibility },
        paint: { "fill-color": colors.fill, "fill-opacity": 0.35 },
      });
      layers.push({
        id: `${l.id}-line`,
        type: "line",
        source: sourceId,
        "source-layer": l.sourceLayer,
        layout: { visibility },
        paint: { "line-color": colors.line, "line-width": 1 },
      });
    } else {
      layers.push({
        id: `${l.id}-line`,
        type: "line",
        source: sourceId,
        "source-layer": l.sourceLayer,
        layout: { visibility },
        paint: {
          "line-color": colors.line,
          "line-width": ["interpolate", ["linear"], ["zoom"], 4, 0.6, 12, 2.2],
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
    map.once("styledata", syncLayerVisibilityFromPanel);
  });
});

function layerIds(l) {
  return l.geom === "polygon" ? [`${l.id}-fill`, `${l.id}-line`] : [`${l.id}-line`];
}

function setLayerVisible(l, visible) {
  const vis = visible ? "visible" : "none";
  for (const id of layerIds(l)) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
  }
}

function syncLayerVisibilityFromPanel() {
  document.querySelectorAll(".layer-toggle").forEach((cb) => {
    const layer = LAYERS.find((l) => l.id === cb.dataset.id);
    if (layer) setLayerVisible(layer, cb.checked);
  });
}

// --- Panel de capas / leyenda ---
function buildLayerPanel() {
  const panel = document.getElementById("layer-panel");
  const porNivel = { 1: [], 2: [], 3: [] };
  for (const l of LAYERS) porNivel[l.nivel].push(l);

  let html = "";
  for (const nivel of [1, 2, 3]) {
    html += `<div class="nivel-group"><h3>${NIVEL_LABEL[nivel]}</h3>`;
    for (const l of porNivel[nivel]) {
      const swatchColor = NIVEL_COLOR[l.nivel].fill;
      const checked = l.visibleByDefault ? "checked" : "";
      html += `
        <label class="layer-row">
          <input type="checkbox" class="layer-toggle" data-id="${l.id}" ${checked}>
          <span class="swatch" style="background:${swatchColor}"></span>
          ${l.nombre}
        </label>`;
    }
    html += `</div>`;
  }
  panel.innerHTML = html;

  panel.querySelectorAll(".layer-toggle").forEach((cb) => {
    cb.addEventListener("change", () => {
      const layer = LAYERS.find((l) => l.id === cb.dataset.id);
      setLayerVisible(layer, cb.checked);
    });
  });
}

map.on("load", buildLayerPanel);

// --- Panel colapsable ---
document.getElementById("panel-toggle").addEventListener("click", () => {
  document.getElementById("layer-panel-container").classList.toggle("collapsed");
});
