"""
Pipeline de conversion de datos: catalogo nacional (SHP/GPKG/GeoJSON en
distintos CRS) -> teselas vectoriales PMTiles en EPSG:4326, listas para
data-web/ y el visor MapLibre.

Por cada capa de pipeline/config.yaml:
  1. Si tiene una sola fuente: ogr2ogr reproyecta directo a EPSG:4326.
     Si tiene varias fuentes (capa partida en varios ficheros): se fusionan
     con geopandas y se reproyectan en el mismo paso.
  2. ogr2ogr -f MVT genera el arbol de teselas (z/x/y.pbf).
  3. pmtiles.convert.disk_to_pmtiles empaqueta el arbol en un unico .pmtiles.
  4. Se limpia el directorio de teselas intermedio.

Uso:
    python pipeline/build_tiles.py                  # todas las capas
    python pipeline/build_tiles.py --only hic,iba    # solo estas capas
    python pipeline/build_tiles.py --list            # lista capas y sale

Requisitos (entorno miniforge3 'base'): gdal (ogr2ogr, via miniforge3),
geopandas, pyogrio, pyyaml, pmtiles (pip). Ver pipeline/README.md.
"""
import argparse
import shutil
import subprocess
import sys
import time
from pathlib import Path

import yaml

PIPELINE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = PIPELINE_DIR.parent


def load_config():
    with open(PIPELINE_DIR / "config.yaml", "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    cfg["data_raw_root"] = Path(cfg["data_raw_root"])
    cfg["output_dir"] = (PIPELINE_DIR / cfg["output_dir"]).resolve()
    return cfg


def run(cmd, **kwargs):
    print("  $", " ".join(str(c) for c in cmd))
    result = subprocess.run(cmd, capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        print(result.stdout[-3000:])
        print(result.stderr[-3000:])
        raise RuntimeError(f"Comando fallido (exit {result.returncode}): {cmd[0]}")
    return result


def reproject_single(src: Path, dst_gpkg: Path):
    run(["ogr2ogr", "-f", "GPKG", "-t_srs", "EPSG:4326",
         "-nlt", "PROMOTE_TO_MULTI", str(dst_gpkg), str(src)])


def reproject_and_merge(sources: list[Path], dst_gpkg: Path):
    import geopandas as gpd
    import pandas as pd

    frames = []
    for src in sources:
        print(f"  leyendo {src.name} ...")
        gdf = gpd.read_file(src)
        if gdf.crs is None:
            raise RuntimeError(f"{src} no tiene CRS definido (.prj ausente o invalido)")
        gdf = gdf.to_crs("EPSG:4326")
        frames.append(gdf)
    merged = gpd.GeoDataFrame(pd.concat(frames, ignore_index=True), crs="EPSG:4326")
    merged.to_file(dst_gpkg, driver="GPKG")


def build_layer(layer: dict, data_raw_root: Path, output_dir: Path, tmp_dir: Path):
    layer_id = layer["id"]
    print(f"\n=== {layer_id} — {layer['nombre']} ===")
    t0 = time.time()

    sources = [data_raw_root / s for s in layer["fuente"]]
    for s in sources:
        if not s.exists():
            raise FileNotFoundError(f"Fuente no encontrada: {s}")

    layer_tmp = tmp_dir / layer_id
    if layer_tmp.exists():
        shutil.rmtree(layer_tmp)
    layer_tmp.mkdir(parents=True)

    reproj_gpkg = layer_tmp / "reproj.gpkg"
    tiles_dir = layer_tmp / "tiles"

    if len(sources) == 1:
        reproject_single(sources[0], reproj_gpkg)
    else:
        reproject_and_merge(sources, reproj_gpkg)

    run(["ogr2ogr", "-f", "MVT", str(tiles_dir), str(reproj_gpkg),
         "-dsco", f"MINZOOM={layer['minzoom']}",
         "-dsco", f"MAXZOOM={layer['maxzoom']}",
         "-dsco", f"NAME={layer_id}",
         "-dsco", f"DESCRIPTION={layer['nombre']}"])

    from pmtiles.convert import disk_to_pmtiles

    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / f"{layer_id}.pmtiles"
    disk_to_pmtiles(str(tiles_dir), str(out_path), maxzoom=layer["maxzoom"])

    shutil.rmtree(layer_tmp)

    size_mb = out_path.stat().st_size / (1024 * 1024)
    elapsed = time.time() - t0
    print(f"  -> {out_path.name}: {size_mb:.1f} MB en {elapsed:.0f}s")
    if size_mb > 90:
        print(f"  !! AVISO: {out_path.name} supera ~90 MB — revisar limite de "
              f"tamano de archivo de Git/GitHub antes de hacer commit.")
    return out_path, size_mb, elapsed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="lista de ids separados por coma")
    parser.add_argument("--list", action="store_true")
    args = parser.parse_args()

    cfg = load_config()
    layers = cfg["layers"]

    if args.list:
        for l in layers:
            print(f"{l['id']:30s} nivel {l['nivel']}  {l['nombre']}")
        return

    if args.only:
        wanted = set(args.only.split(","))
        layers = [l for l in layers if l["id"] in wanted]
        missing = wanted - {l["id"] for l in layers}
        if missing:
            print(f"Aviso: ids no encontrados en config.yaml: {missing}")

    tmp_dir = PIPELINE_DIR / "_tmp"
    tmp_dir.mkdir(exist_ok=True)

    results = []
    errors = []
    for layer in layers:
        try:
            out_path, size_mb, elapsed = build_layer(
                layer, cfg["data_raw_root"], cfg["output_dir"], tmp_dir)
            results.append((layer["id"], size_mb, elapsed))
        except Exception as e:
            print(f"  !! ERROR en {layer['id']}: {e}")
            errors.append((layer["id"], str(e)))

    shutil.rmtree(tmp_dir, ignore_errors=True)

    print("\n=== Resumen ===")
    for lid, size_mb, elapsed in results:
        print(f"  OK   {lid:30s} {size_mb:8.1f} MB  {elapsed:6.0f}s")
    for lid, err in errors:
        print(f"  FAIL {lid:30s} {err}")

    if errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
