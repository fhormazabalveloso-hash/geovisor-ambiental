"""
Zonas inundables del SNCZI -> data-web/<id>.pmtiles + <id>_labels.pmtiles.

Por que (2026-10-20): hasta ahora se consultaban en vivo al WFS de MITECO
(src/js/wfs-layers.js). El 13/10 el servidor empezo a mandar la cabecera CORS
duplicada y los navegadores dejaron de poder leerlo; decision de Francisco:
servirlas desde el propio repositorio, como el resto de capas, para no
depender de ningun servicio externo.

Origen:
  - Fluviales T10/T100/T500: shapefiles del catalogo (03_inundabilidad, 2.º
    ciclo, enero 2026) -- ruta en config.yaml (data_raw_root).
  - Flujo preferente y costeras T100/T500: no estan en el catalogo; se
    descargan UNA vez del WFS de MITECO (desde Python el fallo CORS no
    afecta), por paginas, a data-raw/snczi/<id>.gpkg (fuera de Git). Para
    volver a descargarlas, borrar ese archivo.

Teselado (prueba del 2026-10-19 con T100, README §2):
  - maxzoom 11: el analisis siempre trabaja a zoom >= 11 y MapLibre amplia
    por encima. Error del borde frente al original ~1 m de media (p95 < 5 m)
    tambien en las zonas mas densas (Segura); el WFS daba ~10 m. T100
    nacional = 34,6 MB. z12 pesaria el doble sin ganancia util.
  - Solo los campos id_zona y zona (los que usa el visor: idField y
    labelField en layers.js), en minuscula como los daba el WFS.
  - Capa interna "zonas" (sourceLayer en layers.js) y "labels" en el de
    nombres, un punto por zona (representative_point, dentro del poligono).

Uso:
    python pipeline/build_inundables.py                 # las seis
    python pipeline/build_inundables.py --only zi_t10   # una o varias (coma)
Cada capa corre en su propio subproceso (memoria: ver build_tiles.py).
"""
import argparse
import functools
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

if os.environ.get("PYTHONUTF8") != "1":
    os.environ["PYTHONUTF8"] = "1"
    sys.exit(subprocess.run([sys.executable, "-X", "utf8", __file__] + sys.argv[1:]).returncode)

import yaml

print = functools.partial(print, flush=True)

PIPELINE_DIR = Path(__file__).resolve().parent
PROJECT_DIR = PIPELINE_DIR.parent
OUT_DIR = PROJECT_DIR / "data-web"
WFS_CACHE = PROJECT_DIR / "data-raw" / "snczi"
TMP_ROOT = Path(tempfile.gettempdir()) / "geovisor_inundables"
WFS_URL = "https://gis.miteco.gob.es/geoserver/wfs"
WFS_PAGE = 100
MAXZOOM = 11
LAYER_NAME = "zonas"

FLUVIAL_DIR = "03_inundabilidad"
CAPAS = {
    "zi_t10": {"shp": f"{FLUVIAL_DIR}\\laminasPB-q10\\Q10_2Ciclo_PB_20260114.shp"},
    "zi_t100": {"shp": f"{FLUVIAL_DIR}\\laminasPB-q100\\Q100_2Ciclo_PB_20260114.shp"},
    "zi_t500": {"shp": f"{FLUVIAL_DIR}\\laminasPB-q500\\Q500_2Ciclo_PB_20260114.shp"},
    "zi_zfp": {"wfs": "agua:ZI_Laminas_ZFP"},
    "zi_costera_t100": {"wfs": "costas:zim_laminas_q100"},
    "zi_costera_t500": {"wfs": "costas:zim_laminas_q500"},
}


def run(cmd):
    # Sin tope de tamano por elemento al leer GeoJSON: alguna zona de flujo
    # preferente pasa de 20 MB por si sola y GDAL la rechazaba (2026-10-20).
    env = {**os.environ, "OGR_GEOJSON_MAX_OBJ_SIZE": "0"}
    r = subprocess.run(cmd, capture_output=True, text=True, env=env)
    if r.returncode:
        print(r.stderr[-3000:])
        raise RuntimeError(f"fallo: {cmd[0]} {cmd[1:4]}")
    return r


def wfs_download(type_name: str, dest: Path):
    """Descarga la capa entera del WFS por paginas a un GPKG (EPSG:4326)."""
    params = {"service": "WFS", "version": "2.0.0", "request": "GetFeature", "typeNames": type_name}
    hits = urllib.request.urlopen(f"{WFS_URL}?{urllib.parse.urlencode({**params, 'resultType': 'hits'})}", timeout=120).read().decode()
    total = int(hits.split('numberMatched="')[1].split('"')[0])
    print(f"  WFS {type_name}: {total} elementos, paginas de {WFS_PAGE}")
    tmp = dest.with_suffix(".partial.gpkg")
    page_dir = TMP_ROOT / "wfs_pages"
    page_dir.mkdir(parents=True, exist_ok=True)
    # Retomar una descarga cortada: las paginas van ordenadas por id_zona, asi
    # que lo ya guardado son las primeras N (siempre paginas completas).
    got = 0
    if tmp.exists():
        info = run(["ogrinfo", "-so", str(tmp), "zonas"]).stdout
        got = int(info.split("Feature Count: ")[1].split()[0])
        if got % WFS_PAGE:
            tmp.unlink()
            got = 0
        else:
            print(f"  retomando la descarga desde el elemento {got}")
    for start in range(got, total, WFS_PAGE):
        q = {**params, "outputFormat": "application/json", "srsName": "urn:ogc:def:crs:OGC:1.3:CRS84",
             "count": str(WFS_PAGE), "startIndex": str(start), "sortBy": "id_zona",
             "propertyName": "id_zona,zona,shape"}
        for intento in range(4):
            try:
                body = urllib.request.urlopen(f"{WFS_URL}?{urllib.parse.urlencode(q)}", timeout=300).read()
                fc = json.loads(body)
                break
            except Exception as e:  # red/servidor: reintentar
                if intento == 3:
                    raise
                print(f"    reintento pagina {start}: {e}")
                time.sleep(10 * (intento + 1))
        got += len(fc["features"])
        page = page_dir / f"p{start}.geojson"
        page.write_text(json.dumps(fc), encoding="utf-8")
        run(["ogr2ogr", "-f", "GPKG", "-append" if tmp.exists() else "-overwrite", str(tmp), str(page),
             "-nln", "zonas", "-nlt", "PROMOTE_TO_MULTI", "-a_srs", "EPSG:4326"])
        page.unlink()
        print(f"    {got}/{total}")
    if got != total:
        raise RuntimeError(f"descargados {got} de {total} elementos")
    tmp.replace(dest)


def build(layer_id: str, cfg: dict):
    spec = CAPAS[layer_id]
    print(f"\n=== {layer_id} ===")
    t0 = time.time()
    work = TMP_ROOT / layer_id
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)

    # 1. Origen -> GPKG en EPSG:4326 con solo id_zona y zona, capa "zonas".
    clean = work / "zonas.gpkg"
    if "shp" in spec:
        src = Path(cfg["data_raw_root"]) / spec["shp"]
        src_layer = src.stem
        run(["ogr2ogr", "-f", "GPKG", str(clean), str(src), "-t_srs", "EPSG:4326", "-nlt", "PROMOTE_TO_MULTI",
             "-nln", LAYER_NAME, "-sql", f'SELECT ID_ZONA AS id_zona, ZONA AS zona FROM "{src_layer}"'])
    else:
        WFS_CACHE.mkdir(parents=True, exist_ok=True)
        cached = WFS_CACHE / f"{layer_id}.gpkg"
        if not cached.exists():
            wfs_download(spec["wfs"], cached)
        else:
            print(f"  usando descarga previa: {cached}")
        # Con GPKG la consulta va directa a SQLite, que solo copia la
        # geometria si se pide (con un shapefile, el SQL de OGR la incluye solo).
        run(["ogr2ogr", "-f", "GPKG", str(clean), str(cached), "-nlt", "PROMOTE_TO_MULTI",
             "-nln", LAYER_NAME, "-sql", "SELECT id_zona, zona, geom FROM zonas"])
    print(f"  origen listo ({time.time() - t0:.0f} s)")

    # 2. Teselas de las zonas.
    from pmtiles.convert import disk_to_pmtiles
    tiles = work / "tiles"
    run(["ogr2ogr", "-f", "MVT", str(tiles), str(clean), "-dsco", "MINZOOM=0", "-dsco", f"MAXZOOM={MAXZOOM}",
         "-dsco", f"NAME={layer_id}"])
    out = OUT_DIR / f"{layer_id}.pmtiles"
    disk_to_pmtiles(str(tiles), str(out), maxzoom=MAXZOOM)
    print(f"  -> {out.name}: {out.stat().st_size / 1048576:.1f} MB ({time.time() - t0:.0f} s)")

    # 3. Un punto de nombre por zona.
    import geopandas as gpd
    gdf = gpd.read_file(clean)
    pts = gpd.GeoDataFrame(gdf[["id_zona", "zona"]].copy(), geometry=gdf.geometry.representative_point(), crs=gdf.crs)
    pts_gpkg = work / "labels.gpkg"
    pts.to_file(pts_gpkg, driver="GPKG", layer="labels")
    ltiles = work / "ltiles"
    run(["ogr2ogr", "-f", "MVT", str(ltiles), str(pts_gpkg), "-dsco", "MINZOOM=0", "-dsco", f"MAXZOOM={MAXZOOM}",
         "-dsco", f"NAME={layer_id}_labels", "-nln", "labels"])
    lout = OUT_DIR / f"{layer_id}_labels.pmtiles"
    disk_to_pmtiles(str(ltiles), str(lout), maxzoom=MAXZOOM)
    print(f"  -> {lout.name}: {lout.stat().st_size / 1048576:.2f} MB, {len(pts)} zonas")

    if out.stat().st_size > 90 * 1048576:
        print(f"  !! AVISO: {out.name} supera 90 MB (limite de GitHub: 100 MB)")
    try:
        shutil.rmtree(work)
    except OSError as e:
        print(f"  (aviso: no se pudo limpiar {work}: {e})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only")
    ap.add_argument("--single", help=argparse.SUPPRESS)
    args = ap.parse_args()
    with open(PIPELINE_DIR / "config.yaml", encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    if args.single:
        build(args.single, cfg)
        return
    ids = args.only.split(",") if args.only else list(CAPAS)
    resumen = []
    for lid in ids:
        if lid not in CAPAS:
            print(f"id desconocido: {lid}")
            continue
        t0 = time.time()
        rc = subprocess.run([sys.executable, __file__, "--single", lid]).returncode
        resumen.append((lid, rc, time.time() - t0))
    print("\n=== Resumen ===")
    for lid, rc, dt in resumen:
        out = OUT_DIR / f"{lid}.pmtiles"
        size = f"{out.stat().st_size / 1048576:.1f} MB" if out.exists() and rc == 0 else "-"
        print(f"  {'OK  ' if rc == 0 else 'FAIL'} {lid:18s} {size:>9s} {dt / 60:6.1f} min")
    if any(rc for _, rc, _ in resumen):
        sys.exit(1)


if __name__ == "__main__":
    main()
