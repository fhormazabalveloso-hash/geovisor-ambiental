"""
Capas de infraestructuras (rama avanzado, 2026-10-05): red ferroviaria y
carreteras del Estado con sus puntos kilometricos (PK), para el panel de
capas (grupo "Infraestructuras", contexto: no entran en el analisis de
afecciones) y como base del PK aproximado en los resultados.

Origen: Red de Transporte del IGN, en la carpeta 17-ferrocarriles-espana
(junto a la del catalogo ambiental, data_raw_root de config.yaml):
  - ferrocarril: tramofc_linea.gpkg (tramos) + pkffcc.gpkg (PK, casi todos de
    ADIF). Solo tipo "Tren" (sin metro, tranvia ni funicular).
  - carreteras: rt_viaria.gpkg (1,55 GB, dentro de un zip), solo titular
    "Administracion General del Estado" y tipo "Carretera". Los PK vienen
    repetidos por sentido en las autovias: se deja uno por carretera y km.

Salida, un .pmtiles por red con dos capas (source-layer):
  - "lineas": la red, con los tramos de una misma linea/carretera unidos
    (line_merge) para que su nombre quepa a lo largo de la linea.
  - "pk": un punto por PK, con km (numero) y etiqueta ("L100 PK 17+500").

Uso:
    python pipeline/build_infraestructuras.py            # las dos redes
    python pipeline/build_infraestructuras.py --only ffcc
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile
from pathlib import Path

# Mismo motivo que en build_tiles.py: el paquete pmtiles abre metadata.json
# sin encoding y en Windows en espanol revienta sin el modo UTF-8.
if os.environ.get("PYTHONUTF8") != "1":
    os.environ["PYTHONUTF8"] = "1"
    sys.exit(subprocess.run([sys.executable, "-X", "utf8", __file__] + sys.argv[1:]).returncode)

import warnings

warnings.filterwarnings("ignore")

import geopandas as gpd
import pandas as pd
import pyogrio
import shapely

from build_tiles import TMP_ROOT, load_config, long_path, run

MAXZOOM = 12
LINE_MINZOOM = 4
PK_MINZOOM = 10


def raw_root(cfg) -> Path:
    return cfg["data_raw_root"].parent / "17-ferrocarriles-espana"


def km_label(km: float) -> str:
    """17.0 -> "17"; 7.9 -> "7+900" (notacion habitual de PK en proyecto)."""
    m = int(round(km * 1000))
    return str(m // 1000) if m % 1000 == 0 else f"{m // 1000}+{m % 1000:03d}"


def merge_by(gdf: gpd.GeoDataFrame, keys: list[str]) -> gpd.GeoDataFrame:
    """Une los tramos de cada grupo en lineas continuas (sin re-nodar: solo
    empalma extremos que coinciden), en vez de miles de trozos de ~100 m."""
    gdf = gdf.copy()
    gdf["geometry"] = shapely.force_2d(gdf.geometry.values)
    rows = []
    for vals, g in gdf.groupby(keys, dropna=False):
        parts = []
        for geom in g.geometry:
            parts.extend(geom.geoms if geom.geom_type == "MultiLineString" else [geom])
        merged = shapely.line_merge(shapely.MultiLineString(parts))
        rows.append({**dict(zip(keys, vals if isinstance(vals, tuple) else (vals,))), "geometry": merged})
    return gpd.GeoDataFrame(rows, geometry="geometry", crs=gdf.crs)


def build_ffcc(root: Path):
    lin = pyogrio.read_dataframe(root / "tramofc_linea.gpkg", columns=["id_tramo", "nombre", "titulard", "estadofisd", "tipo_lined"])
    lin = lin[lin["tipo_lined"] == "Tren"]
    # "100 - MADRID-CHAMARTIN-HENDAYA" -> "L100"; sin codigo (alta velocidad,
    # cercanias de otras redes, playas de vias...) se queda sin abreviatura.
    lin["corto"] = lin["nombre"].str.extract(r"^(\d+)\s*-", expand=False).radd("L")
    lin = lin.rename(columns={"titulard": "titular", "estadofisd": "estado"})

    pk = pyogrio.read_dataframe(root / "pkffcc.gpkg", columns=["id_tramo", "numero", "fuented"])
    pk = pk.merge(lin[["id_tramo", "nombre", "corto"]], on="id_tramo", how="inner")
    pk["km"] = pk["numero"].astype(float)
    pk["etiqueta"] = [f"{c} PK {km_label(k)}" if isinstance(c, str) else f"PK {km_label(k)}" for c, k in zip(pk["corto"], pk["km"])]
    pk["linea"] = pk["nombre"]
    pk["geometry"] = shapely.force_2d(pk.geometry.values)
    pk = gpd.GeoDataFrame(pk[["linea", "corto", "km", "etiqueta", "geometry"]], geometry="geometry", crs=pk.crs)

    lineas = merge_by(lin[["nombre", "corto", "titular", "estado", "geometry"]], ["nombre", "corto", "titular", "estado"])
    return lineas, pk


def viaria_gpkg(root: Path) -> Path:
    """rt_viaria.gpkg viene dentro de un zip con una ruta demasiado larga para
    GDAL: se extrae una vez a la carpeta temporal (fuera de OneDrive)."""
    dst = TMP_ROOT / "_src" / "rt_viaria.gpkg"
    if dst.exists():
        return dst
    z = root / "RT_Espana_PorModos_gpkg" / "IGR_RT_Espana_pormodos_gpkg" / "IGR_RT_Espana_por_modos_gpkg_RT_VIARIA_CARRETERAS.zip"
    dst.parent.mkdir(parents=True, exist_ok=True)
    print(f"  extrayendo rt_viaria.gpkg a {dst.parent} ...")
    with zipfile.ZipFile(long_path(z)) as zf, zf.open("rt_viaria.gpkg") as src, open(dst, "wb") as out:
        shutil.copyfileobj(src, out, 16 * 1024 * 1024)
    return dst


def build_carreteras(root: Path):
    g = viaria_gpkg(root)
    tv = pyogrio.read_dataframe(g, layer="rt_tramo_vial", columns=["id_vial", "nombre", "tipo_viald", "estadofisd"], where="titular = 1")
    tv = tv[tv["tipo_viald"] == "Carretera"].rename(columns={"estadofisd": "estado"})

    pk = pyogrio.read_dataframe(g, layer="rt_ppkk_p", columns=["id_vial", "nombre", "numero"])
    pk = pk[pk["id_vial"].isin(set(tv["id_vial"]))]
    # Un PK por carretera y km: en las autovias viene uno por sentido.
    pk = pk.drop_duplicates(["nombre", "numero"])
    pk["km"] = pk["numero"].str.replace(",", ".").astype(float)
    pk["etiqueta"] = [f"{n} PK {km_label(k)}" for n, k in zip(pk["nombre"], pk["km"])]
    pk["geometry"] = shapely.force_2d(pk.geometry.values)
    pk = gpd.GeoDataFrame(pk[["nombre", "km", "etiqueta", "geometry"]], geometry="geometry", crs=pk.crs)

    lineas = merge_by(tv[["nombre", "estado", "geometry"]], ["nombre", "estado"])
    return lineas, pk


NETWORKS = {
    "ffcc": ("Red ferroviaria", build_ffcc),
    "carreteras_estado": ("Carreteras del Estado", build_carreteras),
}


def tile(layer_id: str, nombre: str, lineas: gpd.GeoDataFrame, pk: gpd.GeoDataFrame, output_dir: Path):
    work = TMP_ROOT / layer_id
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    gpkg = work / "datos.gpkg"
    lineas.to_crs("EPSG:4326").to_file(gpkg, layer="lineas", driver="GPKG")
    pk.to_crs("EPSG:4326").to_file(gpkg, layer="pk", driver="GPKG")

    conf = {"lineas": {"target_name": "lineas", "minzoom": LINE_MINZOOM}, "pk": {"target_name": "pk", "minzoom": PK_MINZOOM}}
    tiles_dir = work / "tiles"
    run(["ogr2ogr", "-f", "MVT", str(tiles_dir), str(gpkg),
         "-dsco", f"MINZOOM={LINE_MINZOOM}", "-dsco", f"MAXZOOM={MAXZOOM}",
         "-dsco", f"NAME={layer_id}", "-dsco", f"DESCRIPTION={nombre}",
         "-dsco", f"CONF={json.dumps(conf)}"])

    from pmtiles.convert import disk_to_pmtiles

    out = output_dir / f"{layer_id}.pmtiles"
    disk_to_pmtiles(str(tiles_dir), str(out), maxzoom=MAXZOOM)
    size_mb = out.stat().st_size / (1024 * 1024)
    print(f"  -> {out.name}: {size_mb:.1f} MB ({len(lineas)} lineas, {len(pk)} PK)")
    if size_mb > 90:
        print("  !! AVISO: supera ~90 MB - revisar el limite de Git/GitHub antes de hacer commit.")
    shutil.rmtree(work, ignore_errors=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", choices=list(NETWORKS))
    args = parser.parse_args()
    cfg = load_config()
    root = raw_root(cfg)
    for layer_id, (nombre, build) in NETWORKS.items():
        if args.only and layer_id != args.only:
            continue
        print(f"\n=== {layer_id} - {nombre} ===")
        t0 = time.time()
        lineas, pk = build(root)
        tile(layer_id, nombre, lineas, pk, cfg["output_dir"])
        print(f"  {time.time() - t0:.0f} s")


if __name__ == "__main__":
    main()
