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
import functools
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# GDAL escribe metadata.json en UTF-8, pero el paquete "pmtiles" lo abre sin
# especificar encoding -> en Windows en espanol Python usa cp1252 por defecto
# y revienta con cualquier caracter fuera de ese rango en los nombres de
# campo. Esto SOLO se puede arreglar activando el "modo UTF-8" de Python
# (PYTHONUTF8), y ese modo se fija al arrancar el interprete -- no sirve
# monkeypatchear locale.getpreferredencoding en caliente. Si no esta activo,
# el script se relanza a si mismo con la variable puesta.
if os.environ.get("PYTHONUTF8") != "1":
    os.environ["PYTHONUTF8"] = "1"
    sys.exit(subprocess.run([sys.executable, "-X", "utf8", __file__] + sys.argv[1:]).returncode)

import yaml

print = functools.partial(print, flush=True)

PIPELINE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = PIPELINE_DIR.parent

# Carpeta de trabajo FUERA de OneDrive: el teselado MVT genera decenas o
# cientos de miles de archivos .pbf pequenos, y OneDrive intenta
# sincronizar cada uno de ellos si la carpeta temporal esta dentro de la
# carpeta del proyecto (que vive en OneDrive) -- eso vuelve el pipeline
# extremadamente lento. Se usa el temp del sistema en su lugar.
TMP_ROOT = Path(tempfile.gettempdir()) / "geovisor_ambiental_pipeline"


def load_config():
    with open(PIPELINE_DIR / "config.yaml", "r", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    cfg["data_raw_root"] = Path(cfg["data_raw_root"])
    cfg["output_dir"] = (PIPELINE_DIR / cfg["output_dir"]).resolve()
    return cfg


def long_path(p: Path) -> Path:
    """Antepone el prefijo \\\\?\\ de Windows para saltarse el limite
    MAX_PATH (260 caracteres) -- las rutas de OneDrive con nombres de
    carpeta largos (p. ej. "Archivos de Cristian Danilo Hernandez Lopez -
    2 Medio Ambiente") lo superan facilmente. Sin esto, Path.exists() y las
    lecturas de GDAL fallan en silencio con "no encontrado" aunque el
    archivo exista de verdad."""
    s = str(p.resolve())
    if not s.startswith("\\\\?\\"):
        s = "\\\\?\\" + s
    return Path(s)


def ensure_gdal_readable(p: Path, layer_tmp: Path) -> Path:
    """GDAL (ogr2ogr / geopandas-pyogrio) NO entiende el prefijo \\\\?\\ (lo
    trunca mal), asi que nunca se le debe pasar. p debe ser la ruta original
    SIN prefijo. Si es demasiado larga para que GDAL la abra de forma
    fiable, se copia el archivo -- y sus sidecars si es un shapefile
    (.shx/.dbf/.prj/.cpg) -- a una carpeta corta dentro de layer_tmp
    (usando internamente long_path() solo para poder LEER el original), y
    se devuelve esa copia. El valor devuelto NUNCA lleva el prefijo \\\\?\\."""
    s = str(p)
    if len(s) < 240:
        return p
    print(f"  ruta de origen larga ({len(s)} caracteres) — copiando a ruta corta para GDAL...")
    lp = long_path(p)
    dest_dir = layer_tmp / "_src"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / p.name
    for sidecar in lp.parent.iterdir():
        if sidecar.stem == p.stem:
            shutil.copy2(str(sidecar), str(dest_dir / sidecar.name))
    return dest


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

    layer_tmp = tmp_dir / layer_id
    if layer_tmp.exists():
        shutil.rmtree(layer_tmp)
    layer_tmp.mkdir(parents=True)

    raw_sources = [data_raw_root / s for s in layer["fuente"]]
    for s in raw_sources:
        if not long_path(s).exists():
            raise FileNotFoundError(f"Fuente no encontrada: {s}")
    sources = [ensure_gdal_readable(s, layer_tmp) for s in raw_sources]

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

    n_tiles = sum(1 for _ in tiles_dir.rglob("*.pbf"))
    print(f"  teselado: {n_tiles} archivos .pbf — empaquetando a pmtiles...")

    from pmtiles.convert import disk_to_pmtiles

    output_dir.mkdir(parents=True, exist_ok=True)
    out_path = output_dir / f"{layer_id}.pmtiles"
    disk_to_pmtiles(str(tiles_dir), str(out_path), maxzoom=layer["maxzoom"])

    size_mb = out_path.stat().st_size / (1024 * 1024)
    elapsed = time.time() - t0
    print(f"  -> {out_path.name}: {size_mb:.1f} MB en {elapsed:.0f}s")
    if size_mb > 90:
        print(f"  !! AVISO: {out_path.name} supera ~90 MB — revisar limite de "
              f"tamano de archivo de Git/GitHub antes de hacer commit.")

    # La limpieza va DESPUES de registrar el resultado: si falla (p. ej. un
    # archivo bloqueado momentaneamente por el indexador de Windows), la
    # capa no debe reportarse como fallida cuando el .pmtiles ya esta bien.
    try:
        shutil.rmtree(layer_tmp)
    except OSError as e:
        print(f"  (aviso: no se pudo limpiar {layer_tmp}: {e})")

    return out_path, size_mb, elapsed


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="lista de ids separados por coma")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--single-layer", help=argparse.SUPPRESS)  # uso interno
    args = parser.parse_args()

    cfg = load_config()
    layers = cfg["layers"]

    if args.list:
        for l in layers:
            print(f"{l['id']:30s} nivel {l['nivel']}  {l['nombre']}")
        return

    tmp_dir = TMP_ROOT
    tmp_dir.mkdir(parents=True, exist_ok=True)

    # Modo interno: construir UNA sola capa en este proceso (usado por el
    # propio script relanzandose a si mismo por subproceso, ver mas abajo).
    if args.single_layer:
        layer = next((l for l in layers if l["id"] == args.single_layer), None)
        if layer is None:
            print(f"id desconocido: {args.single_layer}")
            sys.exit(2)
        build_layer(layer, cfg["data_raw_root"], cfg["output_dir"], tmp_dir)
        return

    if args.only:
        wanted = set(args.only.split(","))
        layers = [l for l in layers if l["id"] in wanted]
        missing = wanted - {l["id"] for l in layers}
        if missing:
            print(f"Aviso: ids no encontrados en config.yaml: {missing}")

    print(f"Carpeta de trabajo temporal (fuera de OneDrive): {tmp_dir}")

    # Cada capa corre en su propio subproceso: si una capa agota la memoria
    # o el proceso muere, Windows libera toda esa memoria de golpe al
    # terminar el subproceso, y las capas siguientes arrancan limpias —
    # en vez de acumular memoria en un unico proceso Python de larga
    # duracion (lo que causo que el sistema matara el lote entero por falta
    # de memoria en un intento anterior).
    results = []
    errors = []
    for i, layer in enumerate(layers, 1):
        print(f"\n[{i}/{len(layers)}] {layer['id']}")
        t0 = time.time()
        proc = subprocess.run([sys.executable, __file__, "--single-layer", layer["id"]])
        elapsed = time.time() - t0
        out_path = cfg["output_dir"] / f"{layer['id']}.pmtiles"
        if proc.returncode == 0 and out_path.exists():
            size_mb = out_path.stat().st_size / (1024 * 1024)
            results.append((layer["id"], size_mb, elapsed))
        else:
            errors.append((layer["id"], f"exit code {proc.returncode}"))

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
