"""Poligonos de provincias y comunidades autonomas para el MAPA DE SITUACION
de la cartografia exportada (src/js/export.js).

Sustituye a las lineas limite (limites_*.pmtiles), que se retiraron del
visor (2026-09-29, decision de Francisco): con poligonos el mapa de
situacion puede resaltar la provincia del proyecto y rotular su nombre, y
las lineas sueltas apenas se distinguian sobre la ortofoto a 1:2.500.000.

Genera un GeoJSON pequeno (se carga entero en el navegador, no como
teselas): data-web/situacion_provincias.geojson, con {prov, ccaa} por
provincia. No hace falta un archivo aparte de comunidades autonomas: el mapa
de situacion cubre ~175 km y casi nunca muestra un limite autonomico, asi que
la comunidad del proyecto se senala aclarando todas sus provincias (y se
ahorra la mitad del peso). Los recintos autonomicos se leen solo para sacar
el nombre de cada comunidad.

Fuente: recintos de la BDDAE del IGN en la misma carpeta origen que el resto
del catalogo (config.yaml -> data_raw_root, 01_base_territorial). La carpeta
de recintos PROVINCIALES de Canarias viene vacia en el origen, asi que las
dos provincias canarias se reconstruyen uniendo sus municipios por el codigo
de provincia (posiciones 5-6 de NATCODE: 35 Las Palmas, 38 Santa Cruz de
Tenerife).

Geometria simplificada a ~400 m (SIMPLIFY_DEG): a 1:2.500.000 un milimetro
del papel son 2,5 km, asi que no se nota (0,16 mm), y los archivos quedan en
cientos de KB en vez de decenas de MB (con ~200 m pesaban 1,7 MB entre los
dos, demasiado para algo que solo usa el mapa de situacion). NO usar estos poligonos para nada que
necesite precision (el cruce de afecciones no los usa).

Uso (entorno miniforge3 'base', mismo que build_tiles.py):
    python pipeline\\build_situacion.py
"""
from pathlib import Path

import geopandas as gpd
import yaml

HERE = Path(__file__).resolve().parent
SIMPLIFY_DEG = 0.004  # ~400 m en latitudes de Espana
COORD_DECIMALS = 4  # ~10 m, de sobra para la escala del mapa de situacion

LIMITES = Path("01_base_territorial") / "lineas_limite"
PROV_PB = LIMITES / "SHP_ETRS89" / "recintos_provinciales" / "recintos_provinciales_inspire_peninbal_etrs89.shp"
CCAA_PB = LIMITES / "SHP_ETRS89" / "recintos_autonomicas_" / "recintos_autonomicas_inspire_peninbal_etrs89.shp"
CCAA_CAN = LIMITES / "SHP_REGCAN95" / "recintos_autonomicas" / "recintos_autonomicas_inspire_canarias_regcan95.shp"
MUN_CAN = LIMITES / "SHP_REGCAN95" / "recintos_municipales" / "recintos_municipales_inspire_canarias_regcan95.shp"

CANARIAS_PROVINCIAS = {"35": "Las Palmas", "38": "Santa Cruz de Tenerife"}
# Islotes sin provincia ni comunidad (p. ej. Alboran, Chafarinas): diminutos a
# esta escala y sin nombre util para rotular.
EXCLUDED_CODE = "20"


def ccaa_code(natcode: str) -> str:
    return natcode[2:4]


def prov_code(natcode: str) -> str:
    return natcode[4:6]


def main():
    config = yaml.safe_load((HERE / "config.yaml").read_text(encoding="utf-8"))
    root = Path(config["data_raw_root"])
    out_dir = (HERE / config["output_dir"]).resolve()

    ccaa_pb = gpd.read_file(root / CCAA_PB).to_crs(4326)
    ccaa_can = gpd.read_file(root / CCAA_CAN).to_crs(4326)
    ccaa = gpd.GeoDataFrame(
        {
            "code": [ccaa_code(c) for c in list(ccaa_pb["NATCODE"]) + list(ccaa_can["NATCODE"])],
            "ccaa": list(ccaa_pb["NAMEUNIT"]) + list(ccaa_can["NAMEUNIT"]),
        },
        geometry=list(ccaa_pb.geometry) + list(ccaa_can.geometry),
        crs=4326,
    )
    ccaa = ccaa[ccaa["code"] != EXCLUDED_CODE]
    ccaa_name = dict(zip(ccaa["code"], ccaa["ccaa"]))

    prov_pb = gpd.read_file(root / PROV_PB).to_crs(4326)
    prov_pb = prov_pb[prov_pb["NATCODE"].map(ccaa_code) != EXCLUDED_CODE]
    prov_pb = gpd.GeoDataFrame(
        {"prov": prov_pb["NAMEUNIT"], "ccaa": prov_pb["NATCODE"].map(lambda c: ccaa_name[ccaa_code(c)])},
        geometry=prov_pb.geometry,
        crs=4326,
    )

    mun_can = gpd.read_file(root / MUN_CAN).to_crs(4326)
    mun_can["pcode"] = mun_can["NATCODE"].map(prov_code)
    unknown = set(mun_can["pcode"]) - set(CANARIAS_PROVINCIAS)
    if unknown:
        raise SystemExit(f"Codigos de provincia canarios inesperados: {unknown}")
    prov_can = mun_can.dissolve(by="pcode").reset_index()
    prov_can = gpd.GeoDataFrame(
        {"prov": prov_can["pcode"].map(CANARIAS_PROVINCIAS), "ccaa": ccaa_name["05"]},
        geometry=prov_can.geometry,
        crs=4326,
    )

    provincias = gpd.GeoDataFrame(
        {"prov": list(prov_pb["prov"]) + list(prov_can["prov"]), "ccaa": list(prov_pb["ccaa"]) + list(prov_can["ccaa"])},
        geometry=list(prov_pb.geometry) + list(prov_can.geometry),
        crs=4326,
    )

    provincias["geometry"] = provincias.geometry.simplify(SIMPLIFY_DEG, preserve_topology=True)

    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / "situacion_provincias.geojson"
    provincias[["prov", "ccaa", "geometry"]].to_file(path, driver="GeoJSON", COORDINATE_PRECISION=COORD_DECIMALS)
    print(f"{path.name}: {len(provincias)} poligonos, {path.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
